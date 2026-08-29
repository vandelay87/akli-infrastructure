import type { StackProps } from 'aws-cdk-lib'
import { Stack } from 'aws-cdk-lib'
import type * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'
import { createSecurityHeadersPolicy } from './cdn-policies'
import { createCrossStackOacOrigin, grantCloudFrontReadCrossStack } from './s3-policies'
import { applyStackTags } from './utils'

export interface AppSiteStackProps extends StackProps {
  /** e.g. 'Pokedex' | 'Sandbox' — used to build descriptive construct IDs */
  appName: string
  /** Route53 recordName (subdomain label), e.g. 'pokedex' | 'sandbox' */
  recordName: string
  hostedZone: route53.IHostedZone
  certificate: certificatemanager.ICertificate
  /** Cross-stack bucket reference (PokedexBucket/SandboxBucket) */
  bucket: s3.IBucket
  /** Cross-stack deploy role reference (PokedexDeployRole/SandboxDeployRole) — granted invalidation rights on this stack's own distribution below */
  deployRole: iam.IRole
  /**
   * X-Frame-Options override for the response headers policy. Defaults to
   * DENY (createSecurityHeadersPolicy's default). Storybook needs SAMEORIGIN
   * since its manager UI frames its own iframe.html — see #255.
   */
  frameOption?: cloudfront.HeadersFrameOption
}

/**
 * Per-app CloudFront distribution serving a single-page app from its own S3
 * bucket, replacing the old shared-distribution `apps/<name>` path routing
 * (Deploy A of the subdomain-per-app migration — see issue #214).
 */
export class AppSiteStack extends Stack {
  constructor(scope: Construct, id: string, props: AppSiteStackProps) {
    super(scope, id, props)

    const { appName, recordName, hostedZone, certificate, bucket, deployRole, frameOption } = props
    const domainName = `${recordName}.${hostedZone.zoneName}`

    // See `createCrossStackOacOrigin` in s3-policies.ts for the
    // cross-stack-reimport / cyclic-dependency rationale.
    const origin = createCrossStackOacOrigin(
      this,
      `${appName}OAC`,
      `Imported${appName}Bucket`,
      bucket,
    )

    const securityHeadersPolicy = createSecurityHeadersPolicy(this, 'SecurityHeaders', frameOption)

    const distribution = new cloudfront.Distribution(this, `${appName}Distribution`, {
      domainNames: [domainName],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeadersPolicy,
      },
      // SPA fallback via errorResponses (not a CloudFront Function) — this
      // stack has no path-based routing, so a plain 200 rewrite to
      // /index.html on both 403 (no such key, private bucket) and 404 is
      // sufficient and avoids the extra Function resource ImagesStack needs.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    })

    // Standalone Policy construct (not deployRole.addToPolicy / grantCreateInvalidation)
    // so the resulting AWS::IAM::Policy is parented under this stack, not the role's
    // home stack. addToPolicy always attaches the Policy resource to the scope the Role
    // was originally `new`'d in — using it here would create a reference from the main
    // stack back to this distribution's ARN, forming a cycle with the existing
    // main-stack -> site-stack bucket dependency.
    new iam.Policy(this, `${appName}DistributionInvalidationPolicy`, {
      roles: [deployRole],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['cloudfront:CreateInvalidation'],
          resources: [distribution.distributionArn],
        }),
      ],
    })

    // See `grantCloudFrontReadCrossStack` in s3-policies.ts for the
    // wildcard-SourceArn / cyclic-dependency rationale.
    grantCloudFrontReadCrossStack(bucket, this.account)

    const aliasTarget = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))

    new route53.ARecord(this, `${appName}AliasRecord`, {
      zone: hostedZone,
      recordName,
      target: aliasTarget,
    })

    new route53.AaaaRecord(this, `${appName}AaaaAliasRecord`, {
      zone: hostedZone,
      recordName,
      target: aliasTarget,
    })

    applyStackTags(this, props)
  }
}

import type { StackProps } from 'aws-cdk-lib'
import { Stack } from 'aws-cdk-lib'
import type * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'
import { createSecurityHeadersPolicy } from './cdn-policies'
import { applyStackTags } from './utils'

export interface AppSiteStackProps extends StackProps {
  /** e.g. 'Pokedex' | 'Sandbox' — used to build descriptive construct IDs */
  appName: string
  /** e.g. 'pokedex.akli.dev' | 'sandbox.akli.dev' */
  domainName: string
  /** Route53 recordName (subdomain label), e.g. 'pokedex' | 'sandbox' */
  recordName: string
  hostedZone: route53.IHostedZone
  certificate: certificatemanager.ICertificate
  /** Cross-stack bucket reference (PokedexBucket/SandboxBucket) */
  bucket: s3.IBucket
}

/**
 * Per-app CloudFront distribution serving a single-page app from its own S3
 * bucket, replacing the old shared-distribution `apps/<name>` path routing
 * (Deploy A of the subdomain-per-app migration — see issue #214).
 */
export class AppSiteStack extends Stack {
  constructor(scope: Construct, id: string, props: AppSiteStackProps) {
    super(scope, id, props)

    const { appName, domainName, recordName, hostedZone, certificate, bucket } = props

    const originAccessControl = new cloudfront.S3OriginAccessControl(this, `${appName}OAC`)

    // Re-import the cross-stack bucket so `S3BucketOrigin.withOriginAccessControl`
    // treats it as imported and skips its auto-attached bucket policy. Auto-attach
    // would scope `aws:SourceArn` to `distribution.distributionId` and create a
    // cycle between the owning stack's policy and this distribution. Policy is
    // re-attached below (on the original `bucket` prop) with a wildcard
    // SourceArn to break the cycle — same pattern as ImagesStack.
    const importedBucket = s3.Bucket.fromBucketAttributes(this, `Imported${appName}Bucket`, {
      bucketArn: bucket.bucketArn,
      region: bucket.env.region,
    })

    const origin = origins.S3BucketOrigin.withOriginAccessControl(importedBucket, {
      originAccessControl,
    })

    const securityHeadersPolicy = createSecurityHeadersPolicy(this)

    const distribution = new cloudfront.Distribution(this, `${appName}Distribution`, {
      domainNames: [domainName],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
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

    // Wildcard SourceArn (account-scoped) avoids a cyclic dependency between
    // the owning stack (policy) and this stack (distribution). The OAC
    // association on the distribution side still gates which CloudFront
    // principals reach the bucket; the wildcard limits the grant to this
    // account's CloudFront distributions. Must be applied to the original
    // `bucket` prop — `importedBucket` (fromBucketAttributes) silently no-ops
    // on addToResourcePolicy.
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [`${bucket.bucketArn}/*`],
      conditions: {
        // StringLike (not StringEquals) is required for the trailing `*` to be
        // treated as a wildcard. CloudFront sends the specific distribution
        // ARN as aws:SourceArn; StringEquals would require exact match against
        // the literal `…/distribution/*` string and the Allow would never fire.
        StringLike: {
          'aws:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/*`,
        },
      },
    }))

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

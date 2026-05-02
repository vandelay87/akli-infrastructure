import type { StackProps } from 'aws-cdk-lib'
import { Stack } from 'aws-cdk-lib'
import type * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as s3 from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'
import { createImageCachePolicy, createSecurityHeadersPolicy } from './cdn-policies'
import { applyStackTags } from './utils'

const IMAGES_DOMAIN_NAME = 'images.akli.dev'

interface ImagesStackProps extends StackProps {
  hostedZone: route53.IHostedZone
  imagesCertificate: certificatemanager.ICertificate
  recipeImageBucket: s3.IBucket
}

/**
 * CloudFront distribution for images.akli.dev.
 *
 * Phase 1: serves the recipe-images S3 bucket via OAC under `recipes/*`.
 * Default behaviour returns a synthetic 404 via a viewer-request CloudFront
 * Function so non-routed paths never hit the origin.
 */
export class ImagesStack extends Stack {
  constructor(scope: Construct, id: string, props: ImagesStackProps) {
    super(scope, id, props)

    const { hostedZone, imagesCertificate, recipeImageBucket } = props

    // Origin Access Control for the recipe-images bucket.
    const originAccessControl = new cloudfront.S3OriginAccessControl(this, 'ImagesOAC')

    // Re-import the cross-stack bucket as an IBucket reference within this
    // stack. This is important: `S3BucketOrigin.withOriginAccessControl`
    // tries to auto-attach a bucket policy that scopes `aws:SourceArn` to
    // the distribution's ID. With a "real" cross-stack bucket, that auto-
    // attach succeeds and creates a cyclic dependency (RecipeStack policy
    // refers to ImagesStack distribution; ImagesStack origin refers to
    // RecipeStack bucket). Importing via `fromBucketAttributes` makes the
    // bucket reference behave like an imported bucket — `addToResourcePolicy`
    // is a no-op on the imported view, so the auto-attach is skipped (CDK
    // emits a warning instead). We then explicitly attach a policy below
    // using the original cross-stack bucket reference, with a wildcard
    // SourceArn to avoid the same cycle.
    const importedBucket = s3.Bucket.fromBucketAttributes(this, 'ImportedRecipeImageBucket', {
      bucketArn: recipeImageBucket.bucketArn,
      region: recipeImageBucket.env.region,
    })

    const recipeImageOrigin = origins.S3BucketOrigin.withOriginAccessControl(
      importedBucket,
      { originAccessControl },
    )

    // CloudFront Function: viewer-request handler that returns a synthetic
    // 404 for any path that hits the default behaviour. CloudFront requires
    // every behaviour (including the default) to declare an origin, so the
    // origin reference is a formality — the function ensures the origin is
    // never queried for default-behaviour requests.
    const defaultDeny404 = new cloudfront.Function(this, 'DefaultDeny404Function', {
      code: cloudfront.FunctionCode.fromInline(
        `function handler(event) {
  return { statusCode: 404, statusDescription: 'Not Found' };
}`,
      ),
    })

    // Shared cache + headers policies (also used by AkliInfrastructureStack).
    const imageCachePolicy = createImageCachePolicy(this)
    const securityHeadersPolicy = createSecurityHeadersPolicy(this)

    // CloudFront distribution for images.akli.dev.
    const distribution = new cloudfront.Distribution(this, 'ImagesDistribution', {
      domainNames: [IMAGES_DOMAIN_NAME],
      certificate: imagesCertificate,
      defaultBehavior: {
        // Origin is a formality — function below returns 404 before the
        // origin is queried.
        origin: recipeImageOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: securityHeadersPolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        functionAssociations: [{
          function: defaultDeny404,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        'recipes/*': {
          origin: recipeImageOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: imageCachePolicy,
          responseHeadersPolicy: securityHeadersPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
        },
      },
    })

    // Bucket policy: grant s3:GetObject to the CloudFront service principal,
    // scoped via aws:SourceArn. Required because the bucket is owned by
    // RecipeStack — CDK does not auto-attach the policy for cross-stack
    // origins.
    //
    // SourceArn caveat: the bucket lives in RecipeStack and the distribution
    // lives here in ImagesStack. Referencing `distribution.distributionId`
    // directly would create a cyclic stack dependency (RecipeStack would
    // depend on ImagesStack via the policy, while ImagesStack already
    // depends on RecipeStack via the bucket origin). A wildcard scoped to
    // this account preserves the same security boundary in practice (only
    // CloudFront distributions in this account can invoke S3 with this
    // SourceArn) without creating a cycle.
    recipeImageBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [`${recipeImageBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          'aws:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/*`,
        },
      },
    }))

    // Route 53 alias records: images.akli.dev → CloudFront distribution.
    // Use the literal global CloudFront alias hosted-zone ID (Z2FDTNDATAQYW2)
    // rather than the Fn::FindInMap that route53-targets.CloudFrontTarget
    // emits — this keeps the synthesised template compact and predictable
    // (and matches the AC, which asserts the literal value).
    const cloudFrontAliasTarget: route53.IAliasRecordTarget = {
      bind: () => ({
        dnsName: distribution.distributionDomainName,
        hostedZoneId: 'Z2FDTNDATAQYW2',
      }),
    }

    new route53.ARecord(this, 'ImagesAliasRecord', {
      zone: hostedZone,
      recordName: 'images',
      target: route53.RecordTarget.fromAlias(cloudFrontAliasTarget),
    })

    new route53.AaaaRecord(this, 'ImagesAaaaAliasRecord', {
      zone: hostedZone,
      recordName: 'images',
      target: route53.RecordTarget.fromAlias(cloudFrontAliasTarget),
    })

    applyStackTags(this, props)
  }
}

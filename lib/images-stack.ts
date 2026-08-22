import type { StackProps } from 'aws-cdk-lib'
import { Stack } from 'aws-cdk-lib'
import type * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'
import { createImageCachePolicy, createSecurityHeadersPolicy } from './cdn-policies'
import { createCrossStackOacOrigin, grantCloudFrontReadCrossStack } from './s3-policies'
import { applyStackTags } from './utils'

const IMAGES_DOMAIN_NAME = 'images.akli.dev'

interface ImagesStackProps extends StackProps {
  hostedZone: route53.IHostedZone
  imagesCertificate: certificatemanager.ICertificate
  recipeImageBucket: s3.IBucket
}

export class ImagesStack extends Stack {
  constructor(scope: Construct, id: string, props: ImagesStackProps) {
    super(scope, id, props)

    const { hostedZone, imagesCertificate, recipeImageBucket } = props

    // See `createCrossStackOacOrigin` in s3-policies.ts for the
    // cross-stack-reimport / cyclic-dependency rationale.
    const recipeImageOrigin = createCrossStackOacOrigin(
      this,
      'ImagesOAC',
      'ImportedRecipeImageBucket',
      recipeImageBucket,
    )

    const defaultDeny404 = new cloudfront.Function(this, 'DefaultDeny404Function', {
      code: cloudfront.FunctionCode.fromInline(
        `function handler(event) {
  return { statusCode: 404, statusDescription: 'Not Found' };
}`,
      ),
    })

    const imageCachePolicy = createImageCachePolicy(this)
    const securityHeadersPolicy = createSecurityHeadersPolicy(this)

    const distribution = new cloudfront.Distribution(this, 'ImagesDistribution', {
      domainNames: [IMAGES_DOMAIN_NAME],
      certificate: imagesCertificate,
      defaultBehavior: {
        // Origin is a formality; the function below returns 404 first so the
        // origin is never queried for default-behaviour requests.
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

    // See `grantCloudFrontReadCrossStack` in s3-policies.ts for the
    // wildcard-SourceArn / cyclic-dependency rationale.
    grantCloudFrontReadCrossStack(recipeImageBucket, this.account)

    const aliasTarget = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))

    new route53.ARecord(this, 'ImagesAliasRecord', {
      zone: hostedZone,
      recordName: 'images',
      target: aliasTarget,
    })

    new route53.AaaaRecord(this, 'ImagesAaaaAliasRecord', {
      zone: hostedZone,
      recordName: 'images',
      target: aliasTarget,
    })

    applyStackTags(this, props)
  }
}

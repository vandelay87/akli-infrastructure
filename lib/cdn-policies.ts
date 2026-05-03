import { Duration } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import type { Construct } from 'constructs'

export const IMAGE_CACHE_POLICY_NAME = 'AkliImageCachePolicy'

export function createImageCachePolicy(
  scope: Construct,
  id: string = 'ImageCachePolicy',
): cloudfront.CachePolicy {
  return new cloudfront.CachePolicy(scope, id, {
    cachePolicyName: IMAGE_CACHE_POLICY_NAME,
    defaultTtl: Duration.days(30),
    maxTtl: Duration.days(365),
    minTtl: Duration.seconds(0),
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
    headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Accept', 'CloudFront-Viewer-Country'),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
  })
}

export function createSecurityHeadersPolicy(
  scope: Construct,
  id: string = 'SecurityHeaders',
): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    securityHeadersBehavior: {
      contentTypeOptions: { override: true },
      frameOptions: {
        frameOption: cloudfront.HeadersFrameOption.DENY,
        override: true,
      },
      referrerPolicy: {
        referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
      strictTransportSecurity: {
        accessControlMaxAge: Duration.days(365),
        includeSubdomains: true,
        preload: true,
        override: true,
      },
    },
  })
}

import { Duration } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import type { Construct } from 'constructs'

/**
 * Creates the shared image cache policy used by CloudFront distributions
 * that serve optimised images. Stable name `AkliImageCachePolicy` lets
 * tests and other stacks reference the policy by name.
 */
export function createImageCachePolicy(
  scope: Construct,
  id: string = 'ImageCachePolicy',
): cloudfront.CachePolicy {
  return new cloudfront.CachePolicy(scope, id, {
    cachePolicyName: 'AkliImageCachePolicy',
    defaultTtl: Duration.days(30),
    maxTtl: Duration.days(365),
    minTtl: Duration.seconds(0),
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
    headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Accept', 'CloudFront-Viewer-Country'),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
  })
}

/**
 * Creates the shared response headers policy applied to CloudFront viewer
 * responses (CSP-adjacent security headers, HSTS, frame options, etc.).
 */
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
        accessControlMaxAge: Duration.seconds(31536000),
        includeSubdomains: true,
        preload: true,
        override: true,
      },
    },
  })
}

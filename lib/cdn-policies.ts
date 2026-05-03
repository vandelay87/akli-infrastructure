import { Duration } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import type { Construct } from 'constructs'

interface CachePolicyOptions {
  /**
   * Optional explicit cache policy name. CloudFront cache policy names are
   * account-globally unique — set this only for singleton policies.
   * Multi-stack factories (e.g. createImageCachePolicy) must leave it unset
   * so CDK auto-generates a unique name per stack.
   */
  readonly cachePolicyName?: string
  readonly defaultTtl: Duration
  /** Maximum TTL. Defaults to defaultTtl. */
  readonly maxTtl?: Duration
  /** Headers to include in the cache key. Empty/undefined = none. */
  readonly headers?: readonly string[]
}

export function createCachePolicy(
  scope: Construct,
  id: string,
  opts: CachePolicyOptions,
): cloudfront.CachePolicy {
  const headerBehavior = opts.headers && opts.headers.length > 0
    ? cloudfront.CacheHeaderBehavior.allowList(...opts.headers)
    : cloudfront.CacheHeaderBehavior.none()

  return new cloudfront.CachePolicy(scope, id, {
    cachePolicyName: opts.cachePolicyName,
    defaultTtl: opts.defaultTtl,
    maxTtl: opts.maxTtl ?? opts.defaultTtl,
    minTtl: Duration.seconds(0),
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
    headerBehavior,
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
  })
}

// CloudFront cache policy names are account-globally unique, so this factory
// must not set an explicit name — multiple stacks (AkliInfrastructureStack,
// ImagesStack) each call it and would 409 on deploy if they shared a name.
// CDK auto-generates a unique name per stack.
export function createImageCachePolicy(
  scope: Construct,
  id: string = 'ImageCachePolicy',
): cloudfront.CachePolicy {
  return createCachePolicy(scope, id, {
    defaultTtl: Duration.days(30),
    maxTtl: Duration.days(365),
    headers: ['Accept', 'CloudFront-Viewer-Country'],
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

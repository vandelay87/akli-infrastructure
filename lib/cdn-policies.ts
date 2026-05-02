import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import type { Construct } from 'constructs'

/**
 * Creates the shared image cache policy used by CloudFront distributions
 * that serve optimised images. Stable name `AkliImageCachePolicy` lets
 * tests and other stacks reference the policy by name.
 *
 * Stub — replaced by the cdk-engineer in issue #122.
 */
export function createImageCachePolicy(_scope: Construct, _id?: string): cloudfront.CachePolicy {
  throw new Error('createImageCachePolicy: not implemented')
}

/**
 * Creates the shared response headers policy applied to CloudFront viewer
 * responses (CSP-adjacent security headers, HSTS, frame options, etc.).
 *
 * Stub — replaced by the cdk-engineer in issue #122.
 */
export function createSecurityHeadersPolicy(
  _scope: Construct,
  _id?: string,
): cloudfront.ResponseHeadersPolicy {
  throw new Error('createSecurityHeadersPolicy: not implemented')
}

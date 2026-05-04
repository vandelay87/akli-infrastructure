import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import {
  createCachePolicy,
  createImageCachePolicy,
  createSecurityHeadersPolicy,
} from '../lib/cdn-policies'

function harnessStack(): cdk.Stack {
  const app = new cdk.App()
  return new cdk.Stack(app, 'PolicyHarnessStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
  })
}

describe('cdn-policies', () => {
  describe('createImageCachePolicy', () => {
    let policy: cloudfront.CachePolicy
    let template: Template

    beforeAll(() => {
      const stack = harnessStack()
      policy = createImageCachePolicy(stack, 'TestImageCachePolicy')
      template = Template.fromStack(stack)
    })

    it('returns a cloudfront.CachePolicy construct', () => {
      expect(policy).toBeInstanceOf(cloudfront.CachePolicy)
    })

    it('configures default 30-day, max 365-day, min 0-second TTLs', () => {
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          DefaultTTL: 30 * 24 * 60 * 60,
          MaxTTL: 365 * 24 * 60 * 60,
          MinTTL: 0,
        }),
      })
    })

    it('forwards all query strings, allowlists Accept and CloudFront-Viewer-Country headers, and forwards no cookies', () => {
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
            QueryStringsConfig: { QueryStringBehavior: 'all' },
            HeadersConfig: {
              HeaderBehavior: 'whitelist',
              Headers: Match.arrayWith(['Accept', 'CloudFront-Viewer-Country']),
            },
            CookiesConfig: { CookieBehavior: 'none' },
          }),
        }),
      })
    })
  })

  describe('createCachePolicy', () => {
    it('defaults maxTtl to defaultTtl and minTtl to 0 when only defaultTtl is provided', () => {
      const stack = harnessStack()
      createCachePolicy(stack, 'DefaultsPolicy', {
        defaultTtl: cdk.Duration.minutes(5),
      })
      const template = Template.fromStack(stack)
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          DefaultTTL: 300,
          MaxTTL: 300,
          MinTTL: 0,
        }),
      })
    })

    it('honours an explicit maxTtl', () => {
      const stack = harnessStack()
      createCachePolicy(stack, 'ExplicitMaxTtlPolicy', {
        defaultTtl: cdk.Duration.minutes(1),
        maxTtl: cdk.Duration.hours(1),
      })
      const template = Template.fromStack(stack)
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          DefaultTTL: 60,
          MaxTTL: 3600,
          MinTTL: 0,
        }),
      })
    })

    it('configures HeaderBehavior=none when no headers are provided', () => {
      const stack = harnessStack()
      createCachePolicy(stack, 'NoHeadersPolicy', {
        defaultTtl: cdk.Duration.seconds(60),
      })
      const template = Template.fromStack(stack)
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
            HeadersConfig: { HeaderBehavior: 'none' },
          }),
        }),
      })
    })

    it('whitelists provided headers in the cache key', () => {
      const stack = harnessStack()
      createCachePolicy(stack, 'WithHeadersPolicy', {
        defaultTtl: cdk.Duration.seconds(60),
        headers: ['Accept'],
      })
      const template = Template.fromStack(stack)
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
            HeadersConfig: {
              HeaderBehavior: 'whitelist',
              Headers: ['Accept'],
            },
          }),
        }),
      })
    })

    it('always sets QueryStringBehavior=all, CookieBehavior=none, MinTTL=0 regardless of opts', () => {
      const stack = harnessStack()
      createCachePolicy(stack, 'InvariantsPolicy', {
        defaultTtl: cdk.Duration.days(7),
        maxTtl: cdk.Duration.days(30),
        headers: ['Accept', 'CloudFront-Viewer-Country'],
      })
      const template = Template.fromStack(stack)
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          MinTTL: 0,
          ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
            QueryStringsConfig: { QueryStringBehavior: 'all' },
            CookiesConfig: { CookieBehavior: 'none' },
          }),
        }),
      })
    })

    it('sets Name to the explicit cachePolicyName when provided, and lets CDK auto-generate it otherwise', () => {
      const stack = harnessStack()
      createCachePolicy(stack, 'NamedPolicy', {
        cachePolicyName: 'MyExplicitName',
        defaultTtl: cdk.Duration.minutes(5),
      })
      createCachePolicy(stack, 'UnnamedPolicy', {
        defaultTtl: cdk.Duration.minutes(5),
      })
      const template = Template.fromStack(stack)
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({ Name: 'MyExplicitName' }),
      })
      // CDK always emits a Name on AWS::CloudFront::CachePolicy. When
      // cachePolicyName is omitted, CDK derives it from the construct path
      // (e.g. "PolicyHarnessStackUnnamedPolicyXXXXXX-<region>") rather than
      // leaving it undefined.
      const policies = template.findResources('AWS::CloudFront::CachePolicy')
      const autoNamed = Object.values(policies).find(
        (resource) => {
          const name = resource.Properties?.CachePolicyConfig?.Name as string | undefined
          return typeof name === 'string'
            && name !== 'MyExplicitName'
            && name.includes('UnnamedPolicy')
        },
      )
      expect(autoNamed).toBeDefined()
    })
  })

  describe('createSecurityHeadersPolicy', () => {
    let policy: cloudfront.ResponseHeadersPolicy
    let template: Template

    beforeAll(() => {
      const stack = harnessStack()
      policy = createSecurityHeadersPolicy(stack, 'TestSecurityHeaders')
      template = Template.fromStack(stack)
    })

    it('returns a cloudfront.ResponseHeadersPolicy construct', () => {
      expect(policy).toBeInstanceOf(cloudfront.ResponseHeadersPolicy)
    })

    it('configures the documented security headers (content type, frame options, referrer policy, HSTS)', () => {
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            ContentTypeOptions: { Override: true },
            FrameOptions: { FrameOption: 'DENY', Override: true },
            ReferrerPolicy: {
              ReferrerPolicy: 'strict-origin-when-cross-origin',
              Override: true,
            },
            StrictTransportSecurity: {
              AccessControlMaxAgeSec: 31536000,
              IncludeSubdomains: true,
              Preload: true,
              Override: true,
            },
          }),
        }),
      })
    })
  })
})

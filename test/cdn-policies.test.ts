import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import { createImageCachePolicy, createSecurityHeadersPolicy } from '../lib/cdn-policies'

function harnessStack(): cdk.Stack {
  const app = new cdk.App()
  return new cdk.Stack(app, 'PolicyHarnessStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
  })
}

describe('cdn-policies', () => {
  describe('createImageCachePolicy', () => {
    it('returns a cloudfront.CachePolicy construct', () => {
      const stack = harnessStack()

      const policy = createImageCachePolicy(stack, 'TestImageCachePolicy')

      expect(policy).toBeInstanceOf(cloudfront.CachePolicy)
    })

    it('synthesises with the stable name AkliImageCachePolicy', () => {
      const stack = harnessStack()
      createImageCachePolicy(stack, 'TestImageCachePolicy')

      const template = Template.fromStack(stack)
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          Name: 'AkliImageCachePolicy',
        }),
      })
    })

    it('configures default 30-day, max 365-day, min 0-second TTLs', () => {
      const stack = harnessStack()
      createImageCachePolicy(stack, 'TestImageCachePolicy')

      const template = Template.fromStack(stack)
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          DefaultTTL: 30 * 24 * 60 * 60,
          MaxTTL: 365 * 24 * 60 * 60,
          MinTTL: 0,
        }),
      })
    })

    it('forwards all query strings, allowlists Accept and CloudFront-Viewer-Country headers, and forwards no cookies', () => {
      const stack = harnessStack()
      createImageCachePolicy(stack, 'TestImageCachePolicy')

      const template = Template.fromStack(stack)
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

  describe('createSecurityHeadersPolicy', () => {
    it('returns a cloudfront.ResponseHeadersPolicy construct', () => {
      const stack = harnessStack()

      const policy = createSecurityHeadersPolicy(stack, 'TestSecurityHeaders')

      expect(policy).toBeInstanceOf(cloudfront.ResponseHeadersPolicy)
    })

    it('configures the documented security headers (content type, frame options, referrer policy, HSTS)', () => {
      const stack = harnessStack()
      createSecurityHeadersPolicy(stack, 'TestSecurityHeaders')

      const template = Template.fromStack(stack)
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

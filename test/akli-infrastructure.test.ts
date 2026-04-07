import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import { AkliInfrastructureStack } from '../lib/akli-infrastructure-stack'

function createTestStack(): Template {
  const app = new cdk.App()

  // Create mock dependencies that the stack requires
  const mockStack = new cdk.Stack(app, 'MockStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const hostedZone = new route53.HostedZone(mockStack, 'MockHostedZone', {
    zoneName: 'akli.dev',
  })

  const certificate = new certificatemanager.Certificate(mockStack, 'MockCertificate', {
    domainName: 'akli.dev',
  })

  const stack = new AkliInfrastructureStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    crossRegionReferences: true,
    hostedZone,
    certificate,
  })

  return Template.fromStack(stack)
}

describe('AkliInfrastructureStack', () => {
  let template: Template

  beforeAll(() => {
    template = createTestStack()
  })

  describe('SSR Lambda function', () => {
    it('creates a Lambda function with Node.js 20 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
      })
    })

    it('configures 256 MB memory', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 256,
      })
    })

    it('configures 10 second timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 10,
      })
    })
  })

  describe('S3 bucket', () => {
    it('blocks all public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      })
    })
  })

  describe('CloudFront distribution', () => {
    it('creates a distribution with the correct domain names', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          Aliases: ['akli.dev', 'www.akli.dev'],
        },
      })
    })

    it('configures an origin failover group', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          OriginGroups: Match.objectLike({
            Quantity: 1,
            Items: Match.arrayWith([
              Match.objectLike({
                FailoverCriteria: {
                  StatusCodes: {
                    Items: [500, 502, 503, 504],
                    Quantity: 4,
                  },
                },
                Members: {
                  Quantity: 2,
                  Items: Match.arrayWith([
                    Match.objectLike({ OriginId: Match.anyValue() }),
                  ]),
                },
              }),
            ]),
          }),
        },
      })
    })

    it('does not have SPA error responses', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          CustomErrorResponses: Match.absent(),
        },
      })
    })

    it('has static asset cache behaviours that route to S3 for each file extension', () => {
      const staticExtensions = [
        '*.js', '*.css', '*.ico', '*.svg', '*.webp',
        '*.woff2', '*.png', '*.jpg', '*.json', '*.xml', '*.txt', '*.pdf',
      ]

      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          CacheBehaviors: Match.arrayWith(
            staticExtensions.map((ext) =>
              Match.objectLike({
                PathPattern: ext,
                Compress: true,
                ViewerProtocolPolicy: 'redirect-to-https',
                CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // CACHING_OPTIMIZED managed policy ID
              }),
            ),
          ),
        },
      })
    })

    it('static asset behaviours use S3 origin, not the failover group', () => {
      const resources = template.toJSON().Resources
      const distResource = Object.values(resources).find(
        (r: any) => r.Type === 'AWS::CloudFront::Distribution',
      ) as any

      const cacheBehaviors = distResource.Properties.DistributionConfig.CacheBehaviors
      const jsAssetBehavior = cacheBehaviors.find((b: any) => b.PathPattern === '*.js')

      const cfOrigins = distResource.Properties.DistributionConfig.Origins
      const s3OriginIds = cfOrigins
        .filter((o: any) => o.S3OriginConfig !== undefined || o.OriginAccessControlId !== undefined)
        .map((o: any) => o.Id)

      expect(s3OriginIds).toContain(jsAssetBehavior.TargetOriginId)
    })
  })

  describe('Lambda Function URL', () => {
    it('creates a Function URL with RESPONSE_STREAM invoke mode', () => {
      template.hasResourceProperties('AWS::Lambda::Url', {
        InvokeMode: 'RESPONSE_STREAM',
      })
    })

    it('uses NONE auth type (CloudFront handles protection)', () => {
      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'NONE',
      })
    })

    it('associates the Function URL with the SSR Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Url', {
        TargetFunctionArn: Match.objectLike({
          'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('SsrFunction')]),
        }),
      })
    })

    it('exports the Function URL as a CloudFormation output', () => {
      template.hasOutput('FunctionUrl', {
        Value: Match.objectLike({
          'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('SsrFunctionFunctionUrl')]),
        }),
        Description: Match.stringLikeRegexp('Function URL'),
      })
    })
  })

  describe('SSR cache policy', () => {
    it('creates a cache policy with 60-second TTL', () => {
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: {
          Name: 'SsrCachePolicy',
          DefaultTTL: 60,
          MaxTTL: 60,
        },
      })
    })
  })

  describe('IAM deploy policy', () => {
    it('grants lambda:UpdateFunctionCode and lambda:GetFunction scoped to the SSR function', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['lambda:UpdateFunctionCode', 'lambda:GetFunction'],
              Effect: 'Allow',
              Resource: Match.objectLike({
                'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('SsrFunction')]),
              }),
            }),
          ]),
        },
      })
    })
  })

  describe('CloudFront Function URL origin', () => {
    it('has the Lambda Function URL as a CloudFront origin', () => {
      const resources = template.toJSON().Resources
      const dist = Object.values(resources).find(
        (r: any) => r.Type === 'AWS::CloudFront::Distribution',
      ) as any

      const origins = dist.Properties.DistributionConfig.Origins
      const customOrigin = origins.find((o: any) => o.CustomOriginConfig !== undefined)

      const domainName = customOrigin.DomainName
      const fnGetAtt = domainName?.['Fn::Select']?.[1]?.['Fn::Split']?.[1]?.['Fn::GetAtt']

      expect(fnGetAtt).toBeDefined()
      expect(fnGetAtt[0]).toMatch(/SsrFunctionFunctionUrl/)
      expect(fnGetAtt[1]).toBe('FunctionUrl')
    })

    it('uses the Function URL origin as the primary in the OriginGroup failover', () => {
      const resources = template.toJSON().Resources
      const dist = Object.values(resources).find(
        (r: any) => r.Type === 'AWS::CloudFront::Distribution',
      ) as any

      const origins = dist.Properties.DistributionConfig.Origins
      const originGroups = dist.Properties.DistributionConfig.OriginGroups

      const functionUrlOrigin = origins.find((o: any) => {
        const fnGetAtt = o.DomainName?.['Fn::Select']?.[1]?.['Fn::Split']?.[1]?.['Fn::GetAtt']
        return fnGetAtt && fnGetAtt[0]?.match(/SsrFunctionFunctionUrl/)
      })

      expect(functionUrlOrigin).toBeDefined()

      const primaryMemberId = originGroups.Items[0].Members.Items[0].OriginId
      expect(primaryMemberId).toBe(functionUrlOrigin.Id)

      const fallbackMemberId = originGroups.Items[0].Members.Items[1].OriginId
      const s3Origin = origins.find((o: any) => o.S3OriginConfig !== undefined)
      expect(fallbackMemberId).toBe(s3Origin.Id)
    })
  })

  describe('Security headers', () => {
    it('applies security headers policy to SSR responses', () => {
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            ContentTypeOptions: { Override: true },
            FrameOptions: { FrameOption: 'DENY', Override: true },
            StrictTransportSecurity: Match.objectLike({
              AccessControlMaxAgeSec: 31536000,
              IncludeSubdomains: true,
              Preload: true,
              Override: true,
            }),
          },
        },
      })
    })
  })
})

import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import { AkliInfrastructureStack } from '../lib/akli-infrastructure-stack'

type CfnResource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string }
type CfnOrigin = { Id: string; S3OriginConfig?: unknown; OriginAccessControlId?: unknown; DomainName?: Record<string, unknown>; CustomOriginConfig?: unknown }
type CfnCacheBehavior = { PathPattern: string; TargetOriginId: string }
type CfnPolicyStatement = { Sid?: string; Effect: string; Principal?: unknown; Action?: unknown; Resource?: unknown; Condition?: unknown }

function cfnDistribution(template: Template): CfnResource {
  const resources = template.toJSON().Resources as Record<string, CfnResource>
  const dist = Object.values(resources).find((r) => r.Type === 'AWS::CloudFront::Distribution')
  if (!dist) throw new Error('CloudFront::Distribution not found in template')
  return dist
}

function distributionLogicalId(template: Template): string {
  const resources = template.toJSON().Resources as Record<string, CfnResource>
  const entry = Object.entries(resources).find(([, r]) => r.Type === 'AWS::CloudFront::Distribution')
  if (!entry) throw new Error('CloudFront::Distribution not found in template')
  return entry[0]
}

// Finds a resource of the given CFN type whose logical ID starts with idPrefix.
// CDK appends an 8-character hash to the construct ID to form the logical ID
// (e.g. construct ID 'PokedexBucket' -> logical ID 'PokedexBucketAB12CD34'), so an
// exact-match lookup would never succeed.
function findResourceByLogicalIdPrefix(template: Template, type: string, idPrefix: string): CfnResource {
  const resources = template.toJSON().Resources as Record<string, CfnResource>
  const entry = Object.entries(resources).find(
    ([logicalId, r]) => r.Type === type && logicalId.startsWith(idPrefix),
  )
  if (!entry) throw new Error(`${type} with logical ID prefix "${idPrefix}" not found in template`)
  return entry[1]
}

// True when a Condition value's AWS:SourceArn (or similar) references the given
// distribution's logical ID via an Fn::Join/Ref, regardless of exact Fn::Join shape.
function sourceArnReferencesDistribution(condition: unknown, distLogicalId: string): boolean {
  const json = JSON.stringify(condition)
  return json.includes(`"Ref":"${distLogicalId}"`) && json.includes(':distribution/')
}

function distributionConfig(dist: CfnResource): Record<string, unknown> {
  return dist.Properties.DistributionConfig as Record<string, unknown>
}

function isFunctionUrlOrigin(origin: CfnOrigin): boolean {
  const fnSelect = origin.DomainName?.['Fn::Select'] as [number, { 'Fn::Split': [string, { 'Fn::GetAtt': [string, string] }] }] | undefined
  const fnGetAtt = fnSelect?.[1]?.['Fn::Split']?.[1]?.['Fn::GetAtt']
  return Boolean(fnGetAtt && /SsrFunctionFunctionUrl/.test(fnGetAtt[0]))
}

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

  describe('Per-app dedicated S3 buckets (Pokedex, Sandbox)', () => {
    const dedicatedBuckets = [
      { app: 'Pokedex', idPrefix: 'PokedexBucket' },
      { app: 'Sandbox', idPrefix: 'SandboxBucket' },
    ]

    it('creates exactly three S3 buckets in total (Site, Pokedex, Sandbox)', () => {
      template.resourceCountIs('AWS::S3::Bucket', 3)
    })

    describe.each(dedicatedBuckets)('$app bucket', ({ idPrefix }) => {
      it('is hardened the same way as SiteBucket: BLOCK_ALL, SSE-S3, DESTROY + autoDeleteObjects', () => {
        const bucket = findResourceByLogicalIdPrefix(template, 'AWS::S3::Bucket', idPrefix)

        expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        })

        expect(bucket.Properties.BucketEncryption).toEqual({
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        })

        // RemovalPolicy.DESTROY
        expect(bucket.DeletionPolicy).toBe('Delete')
        expect(bucket.UpdateReplacePolicy).toBe('Delete')

        // autoDeleteObjects: true is implemented via this marker tag plus a
        // Custom::S3AutoDeleteObjects resource wired up by the CDK framework.
        expect(bucket.Properties.Tags).toEqual(
          expect.arrayContaining([{ Key: 'aws-cdk:auto-delete-objects', Value: 'true' }]),
        )
      })

      it('enforces SSL by denying non-HTTPS requests in its bucket policy', () => {
        const policy = findResourceByLogicalIdPrefix(template, 'AWS::S3::BucketPolicy', `${idPrefix}Policy`)
        const statements = (policy.Properties.PolicyDocument as { Statement: CfnPolicyStatement[] }).Statement

        expect(statements).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              Effect: 'Deny',
              Principal: { AWS: '*' },
              Action: 's3:*',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        )
      })

      it('grants the shared OAC distribution s3:GetObject/s3:ListBucket, scoped via AWS:SourceArn', () => {
        const policy = findResourceByLogicalIdPrefix(template, 'AWS::S3::BucketPolicy', `${idPrefix}Policy`)
        const statements = (policy.Properties.PolicyDocument as { Statement: CfnPolicyStatement[] }).Statement
        const bucketLogicalId = (policy.Properties.Bucket as { Ref: string }).Ref

        const grant = statements.find((s) => s.Sid === 'AllowCloudFrontServicePrincipal')
        expect(grant).toBeDefined()

        expect(grant?.Effect).toBe('Allow')
        expect(grant?.Principal).toEqual({ Service: 'cloudfront.amazonaws.com' })
        expect(grant?.Action).toEqual(['s3:GetObject', 's3:ListBucket'])

        // Resource must cover both the bucket ARN and the bucket ARN wildcard (objects),
        // referencing this specific bucket (not some other bucket's policy).
        const resourceJson = JSON.stringify(grant?.Resource)
        expect(resourceJson).toContain(bucketLogicalId)
        expect(resourceJson).toContain('/*')

        // Scoped, via AWS:SourceArn, to the single shared CloudFront distribution.
        const distId = distributionLogicalId(template)
        expect(sourceArnReferencesDistribution(grant?.Condition, distId)).toBe(true)
      })
    })

    it('gives Pokedex and Sandbox distinct buckets (not the same bucket twice)', () => {
      const pokedexBucket = findResourceByLogicalIdPrefix(template, 'AWS::S3::Bucket', 'PokedexBucket')
      const sandboxBucket = findResourceByLogicalIdPrefix(template, 'AWS::S3::Bucket', 'SandboxBucket')
      expect(pokedexBucket).not.toBe(sandboxBucket)
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
      const config = distributionConfig(cfnDistribution(template))
      const cacheBehaviors = config.CacheBehaviors as CfnCacheBehavior[]
      const jsAssetBehavior = cacheBehaviors.find((b) => b.PathPattern === '*.js')

      const origins = config.Origins as CfnOrigin[]
      const s3OriginIds = origins
        .filter((o) => o.S3OriginConfig !== undefined || o.OriginAccessControlId !== undefined)
        .map((o) => o.Id)

      expect(s3OriginIds).toContain(jsAssetBehavior?.TargetOriginId)
    })
  })

  describe('Lambda Function URL', () => {
    it('creates a Function URL with RESPONSE_STREAM invoke mode', () => {
      template.hasResourceProperties('AWS::Lambda::Url', {
        InvokeMode: 'RESPONSE_STREAM',
      })
    })

    it('uses AWS_IAM auth type (CloudFront signs via OAC)', () => {
      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'AWS_IAM',
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

  describe('Image cache policy', () => {
    it('configures 30-day default / 365-day max TTL with all-query / Accept+Country header allowlist', () => {
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          DefaultTTL: 30 * 24 * 60 * 60,
          MaxTTL: 365 * 24 * 60 * 60,
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
    it('has the Lambda Function URL as a CloudFront origin with OAC', () => {
      const origins = distributionConfig(cfnDistribution(template)).Origins as CfnOrigin[]
      const lambdaOrigin = origins.find(isFunctionUrlOrigin)

      expect(lambdaOrigin).toBeDefined()
      expect(lambdaOrigin?.OriginAccessControlId).toBeDefined()
      expect(lambdaOrigin?.CustomOriginConfig).toBeDefined()
    })

    it('uses the Function URL origin as the primary in the OriginGroup failover', () => {
      const config = distributionConfig(cfnDistribution(template))
      const origins = config.Origins as CfnOrigin[]
      const originGroups = config.OriginGroups as { Items: [{ Members: { Items: [{ OriginId: string }, { OriginId: string }] } }] }

      const functionUrlOrigin = origins.find(isFunctionUrlOrigin)
      expect(functionUrlOrigin).toBeDefined()

      const primaryMemberId = originGroups.Items[0].Members.Items[0].OriginId
      expect(primaryMemberId).toBe(functionUrlOrigin?.Id)

      const fallbackMemberId = originGroups.Items[0].Members.Items[1].OriginId
      const s3Origin = origins.find((o) => o.S3OriginConfig !== undefined)
      expect(fallbackMemberId).toBe(s3Origin?.Id)
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

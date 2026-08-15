import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { AppSiteStack } from '../lib/app-site-stack'

interface AppCase {
  appName: string
  domainName: string
  recordName: string
}

const CASES: AppCase[] = [
  { appName: 'Pokedex', domainName: 'pokedex.akli.dev', recordName: 'pokedex' },
  { appName: 'Sandbox', domainName: 'sandbox.akli.dev', recordName: 'sandbox' },
]

interface Harness {
  siteTemplate: Template
  // The bucket is owned by a fake AkliInfrastructureStack-equivalent stack,
  // mirroring #213's AkliInfrastructureStack.pokedexBucket/sandboxBucket.
  // Bucket policy additions made by AppSiteStack land on THIS template, not
  // siteTemplate — see the two-handles note in the issue.
  bucketOwnerTemplate: Template
  siteStack: AppSiteStack
}

function createHarness(testCase: AppCase): Harness {
  const app = new cdk.App()

  cdk.Tags.of(app).add('Owner', 'Akli')
  cdk.Tags.of(app).add('CostCenter', testCase.appName)

  // CertificateStack-equivalent in us-east-1 (for cross-region consumption)
  const certStack = new cdk.Stack(app, `Test${testCase.appName}CertStack`, {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
  })

  const hostedZone = new route53.HostedZone(certStack, 'TestHostedZone', {
    zoneName: 'akli.dev',
  })

  const certificate = new certificatemanager.Certificate(certStack, `Test${testCase.appName}Cert`, {
    domainName: testCase.domainName,
  })

  // AkliInfrastructureStack-equivalent owning stack that exposes the per-app
  // bucket as s3.IBucket (mirroring #213's pokedexBucket/sandboxBucket).
  const bucketOwnerStack = new cdk.Stack(app, `Test${testCase.appName}BucketOwnerStack`, {
    env: { account: '123456789012', region: 'eu-west-2' },
  })

  const bucket = new s3.Bucket(bucketOwnerStack, `Test${testCase.appName}Bucket`, {
    bucketName: `test-${testCase.recordName}-bucket-123456789012`,
  })

  const siteStack = new AppSiteStack(app, `${testCase.appName}SiteStack`, {
    env: { account: '123456789012', region: 'eu-west-2' },
    crossRegionReferences: true,
    appName: testCase.appName,
    domainName: testCase.domainName,
    recordName: testCase.recordName,
    hostedZone,
    certificate,
    bucket,
    tags: {
      Project: `akli-${testCase.recordName}`,
      Environment: 'production',
      ManagedBy: 'cdk',
    },
  })

  return {
    siteTemplate: Template.fromStack(siteStack),
    bucketOwnerTemplate: Template.fromStack(bucketOwnerStack),
    siteStack,
  }
}

type CfnResource = { Type: string; Properties: Record<string, unknown> }
type CfnDistributionResource = CfnResource & {
  Properties: {
    DistributionConfig: {
      Aliases?: string[]
      DefaultRootObject?: string
      Origins?: Array<Record<string, unknown>>
      DefaultCacheBehavior?: Record<string, unknown>
      ViewerCertificate?: Record<string, unknown>
      CustomErrorResponses?: Array<Record<string, unknown>>
    }
  }
}

// Per the PRD's "Note on testing precision": AppSiteStack instances are
// separate Stack instances, each producing its own template with exactly
// one CloudFront::Distribution — so grabbing the sole one is unambiguous.
function getSoleDistribution(template: Template): CfnDistributionResource {
  const matches = template.findResources('AWS::CloudFront::Distribution')
  const entries = Object.values(matches)
  expect(entries).toHaveLength(1)
  return entries[0] as CfnDistributionResource
}

describe.each(CASES)('AppSiteStack ($appName)', (testCase) => {
  let harness: Harness

  beforeAll(() => {
    harness = createHarness(testCase)
  })

  describe('CloudFront distribution', () => {
    it(`creates exactly one AWS::CloudFront::Distribution with Aliases: [${testCase.domainName}]`, () => {
      const distribution = getSoleDistribution(harness.siteTemplate)
      expect(distribution.Properties.DistributionConfig.Aliases).toEqual([testCase.domainName])
    })

    it('sets DefaultRootObject: index.html', () => {
      const distribution = getSoleDistribution(harness.siteTemplate)
      expect(distribution.Properties.DistributionConfig.DefaultRootObject).toBe('index.html')
    })

    it(`configures ViewerCertificate.AcmCertificateArn referencing its own ${testCase.appName} certificate`, () => {
      const distribution = getSoleDistribution(harness.siteTemplate)
      const viewerCertificate = distribution.Properties.DistributionConfig.ViewerCertificate
      expect(viewerCertificate).toBeDefined()
      const acmArn = (viewerCertificate as { AcmCertificateArn?: unknown }).AcmCertificateArn
      // Cross-region cert refs come through SSM dynamic references — must exist and be non-null.
      expect(acmArn).toBeDefined()
      expect(acmArn).not.toBeNull()
      expect((viewerCertificate as { SslSupportMethod?: string }).SslSupportMethod).toBe('sni-only')
    })

    it('default behaviour sets ViewerProtocolPolicy: redirect-to-https', () => {
      const distribution = getSoleDistribution(harness.siteTemplate)
      const defaultBehavior = distribution.Properties.DistributionConfig.DefaultCacheBehavior as {
        ViewerProtocolPolicy?: string
      }
      expect(defaultBehavior.ViewerProtocolPolicy).toBe('redirect-to-https')
    })

    it('default behaviour ResponseHeadersPolicyId references the shared security headers policy', () => {
      const distribution = getSoleDistribution(harness.siteTemplate)
      const defaultBehavior = distribution.Properties.DistributionConfig.DefaultCacheBehavior as {
        ResponseHeadersPolicyId?: { Ref?: string } | string
      }
      const ref = (defaultBehavior.ResponseHeadersPolicyId as { Ref?: string } | undefined)?.Ref
      expect(ref).toBeDefined()
      // createSecurityHeadersPolicy gives the policy a stable construct id
      // starting with "SecurityHeaders" (name left unset — see cdn-policies.ts).
      expect(ref).toMatch(/SecurityHeaders/)
    })

    it('default behaviour origin uses OAC (OriginAccessControlId is non-null)', () => {
      const distribution = getSoleDistribution(harness.siteTemplate)
      const origins = distribution.Properties.DistributionConfig.Origins ?? []
      const defaultBehavior = distribution.Properties.DistributionConfig.DefaultCacheBehavior as {
        TargetOriginId?: string
      }
      const origin = origins.find(
        (o) => (o as { Id?: string }).Id === defaultBehavior.TargetOriginId,
      ) as { OriginAccessControlId?: unknown } | undefined
      expect(origin).toBeDefined()
      expect(origin?.OriginAccessControlId).toBeDefined()
      expect(origin?.OriginAccessControlId).not.toBeNull()
    })

    it('CustomErrorResponses covers 403 -> /index.html, 200 (SPA fallback)', () => {
      const distribution = getSoleDistribution(harness.siteTemplate)
      const errorResponses = distribution.Properties.DistributionConfig.CustomErrorResponses ?? []
      expect(errorResponses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      )
    })

    it('CustomErrorResponses covers 404 -> /index.html, 200 (SPA fallback)', () => {
      const distribution = getSoleDistribution(harness.siteTemplate)
      const errorResponses = distribution.Properties.DistributionConfig.CustomErrorResponses ?? []
      expect(errorResponses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      )
    })

    it('does not use a CloudFront::Function for SPA fallback (replaced by errorResponses)', () => {
      // The old subdirectoryIndexHandler approach (still used by the shared
      // AkliInfrastructureStack distribution, untouched by this issue) used a
      // viewer-request CloudFront::Function. AppSiteStack must not reintroduce
      // that pattern — SPA fallback here is via errorResponses only.
      const functions = harness.siteTemplate.findResources('AWS::CloudFront::Function')
      expect(Object.keys(functions)).toHaveLength(0)
    })

    it('creates an AWS::CloudFront::OriginAccessControl with sigv4 + always', () => {
      harness.siteTemplate.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
        OriginAccessControlConfig: Match.objectLike({
          SigningProtocol: 'sigv4',
          SigningBehavior: 'always',
        }),
      })
    })
  })

  describe('Route 53', () => {
    it(`creates an A alias record for ${testCase.domainName} pointing at the distribution`, () => {
      harness.siteTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: `${testCase.domainName}.`,
        Type: 'A',
        AliasTarget: Match.objectLike({
          DNSName: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('.*Distribution.*')]),
          }),
          HostedZoneId: Match.anyValue(),
        }),
      })
    })

    it(`creates an AAAA alias record for ${testCase.domainName} pointing at the distribution`, () => {
      harness.siteTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: `${testCase.domainName}.`,
        Type: 'AAAA',
        AliasTarget: Match.objectLike({
          DNSName: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('.*Distribution.*')]),
          }),
          HostedZoneId: Match.anyValue(),
        }),
      })
    })
  })

  describe('S3 bucket policy on the owning stack (two-handles regression guard)', () => {
    it('grants s3:GetObject to cloudfront.amazonaws.com scoped via a wildcard StringLike aws:SourceArn', () => {
      // The bucket is owned by the fake AkliInfrastructureStack-equivalent
      // stack, so calling .addToResourcePolicy() on the ORIGINAL bucket prop
      // (not the fromBucketAttributes(...) imported handle used for the
      // CloudFront origin) must land the policy on THAT stack's template —
      // exactly mirroring ImagesStack's re-attachment of RecipeStack's bucket
      // policy. If AppSiteStack instead calls .addToResourcePolicy() on the
      // imported handle, this silently no-ops and this assertion fails.
      harness.bucketOwnerTemplate.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 's3:GetObject',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Resource: Match.objectLike({
                'Fn::Join': Match.arrayWith([
                  '',
                  Match.arrayWith([
                    Match.objectLike({
                      'Fn::GetAtt': Match.arrayWith([
                        Match.stringLikeRegexp(`^Test${testCase.appName}Bucket.*`),
                      ]),
                    }),
                    '/*',
                  ]),
                ]),
              }),
              Condition: Match.objectLike({
                StringLike: Match.objectLike({
                  'aws:SourceArn': Match.stringLikeRegexp('^arn:aws:cloudfront::.*:distribution/\\*$'),
                }),
              }),
            }),
          ]),
        }),
      })
    })

    it('does not use StringEquals for the aws:SourceArn condition (must be StringLike for the wildcard to work)', () => {
      const bucketPolicies = harness.bucketOwnerTemplate.findResources('AWS::S3::BucketPolicy')
      const offendingStatements: unknown[] = []
      for (const policy of Object.values(bucketPolicies)) {
        const statements =
          ((policy as { Properties: { PolicyDocument: { Statement?: unknown[] } } }).Properties
            .PolicyDocument.Statement) ?? []
        for (const stmt of statements) {
          const s = stmt as {
            Principal?: { Service?: string | string[] }
            Condition?: { StringEquals?: Record<string, unknown> }
          }
          const principalService = s.Principal?.Service
          const isCloudFrontPrincipal = principalService === 'cloudfront.amazonaws.com'
            || (Array.isArray(principalService) && principalService.includes('cloudfront.amazonaws.com'))
          if (!isCloudFrontPrincipal) continue
          const sourceArn = s.Condition?.StringEquals?.['aws:SourceArn']
            ?? s.Condition?.StringEquals?.['AWS:SourceArn']
          if (sourceArn !== undefined) offendingStatements.push(s)
        }
      }
      expect(offendingStatements).toEqual([])
    })

    it('the bucket policy is NOT present on the site stack template itself (it belongs to the owning stack)', () => {
      const bucketPolicies = harness.siteTemplate.findResources('AWS::S3::BucketPolicy')
      expect(Object.keys(bucketPolicies)).toHaveLength(0)
    })
  })

  describe('Cross-stack / cross-region', () => {
    it('constructs successfully as an instance of AppSiteStack', () => {
      expect(harness.siteStack).toBeInstanceOf(AppSiteStack)
    })

    it('enables crossRegionReferences on the stack instance', () => {
      // Cross-region machinery is observable two ways:
      // 1. The internal `_crossRegionReferences` flag CDK sets on the Stack
      //    instance when the prop is true.
      // 2. The synthesised distribution's cert ref is a cross-region token
      //    (Fn::ImportValue / CrossRegion SSM dynamic ref) rather than a literal.
      // Either is sufficient proof.
      const stack = harness.siteStack as unknown as { _crossRegionReferences?: boolean }
      const flagSet = stack._crossRegionReferences === true

      let isCrossRegionToken = false
      try {
        const distribution = getSoleDistribution(harness.siteTemplate)
        const acmArn = (distribution.Properties.DistributionConfig.ViewerCertificate as
          | { AcmCertificateArn?: unknown }
          | undefined)?.AcmCertificateArn
        if (acmArn !== undefined && acmArn !== null) {
          const serialised = JSON.stringify(acmArn)
          isCrossRegionToken = typeof acmArn === 'object'
            && (serialised.includes('Fn::ImportValue') || serialised.includes('CrossRegion'))
        }
      } catch {
        // Distribution not yet emitted by stub — fall through and rely on the flag.
      }

      expect(flagSet || isCrossRegionToken).toBe(true)
    })
  })

  describe('Tags', () => {
    it(`tags the distribution with Project=akli-${testCase.recordName}`, () => {
      harness.siteTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Project', Value: `akli-${testCase.recordName}` }),
        ]),
      })
    })

    it('tags the distribution with Owner', () => {
      harness.siteTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Owner', Value: 'Akli' }),
        ]),
      })
    })

    it('tags the distribution with Environment=production', () => {
      harness.siteTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'production' }),
        ]),
      })
    })

    it('tags the distribution with ManagedBy=cdk', () => {
      harness.siteTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'cdk' }),
        ]),
      })
    })
  })
})

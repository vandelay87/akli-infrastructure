import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { ImagesStack } from '../lib/images-stack'
import { RecipeStack } from '../lib/recipe-stack'
import { findResourceEntryByLogicalIdPrefix, referencesLogicalId } from './cdk-test-helpers'

interface Harness {
  imagesTemplate: Template
  recipeTemplate: Template
  imagesStack: ImagesStack
}

function createHarness(): Harness {
  const app = new cdk.App()

  cdk.Tags.of(app).add('Owner', 'Akli')
  cdk.Tags.of(app).add('CostCenter', 'Recipes')

  // CertificateStack-equivalent in us-east-1 (for cross-region consumption)
  const certStack = new cdk.Stack(app, 'TestCertStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
  })

  const hostedZone = new route53.HostedZone(certStack, 'TestHostedZone', {
    zoneName: 'akli.dev',
  })

  const imagesCertificate = new certificatemanager.Certificate(certStack, 'TestImagesCert', {
    domainName: 'images.akli.dev',
  })

  // RecipeStack owns the recipe-images bucket. It must be synthesised in the
  // same app so the cross-stack bucket reference resolves and the bucket
  // policy + notification ACs are observable on its template.
  const recipeStack = new RecipeStack(app, 'TestRecipeStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    userPoolId: 'eu-west-2_TestPool123',
    userPoolClientId: 'test-client-id-abc',
    userPoolArn: 'arn:aws:cognito-idp:eu-west-2:123456789012:userpool/eu-west-2_TestPool123',
    tags: {
      Project: 'recipes',
      Environment: 'production',
      ManagedBy: 'cdk',
    },
  })

  const siteStack = new cdk.Stack(app, 'TestSiteStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
  })
  const siteBucket = new s3.Bucket(siteStack, 'TestSiteBucket')

  const imagesStack = new ImagesStack(app, 'TestImagesStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    crossRegionReferences: true,
    hostedZone,
    imagesCertificate,
    recipeImageBucket: recipeStack.imageBucket,
    siteBucket,
    tags: {
      Project: 'akli-images',
      Environment: 'production',
      ManagedBy: 'cdk',
    },
  })

  return {
    imagesTemplate: Template.fromStack(imagesStack),
    recipeTemplate: Template.fromStack(recipeStack),
    imagesStack,
  }
}

type CfnResource = { Type: string; Properties: Record<string, unknown> }
type CfnDistributionResource = CfnResource & {
  Properties: {
    DistributionConfig: {
      Aliases?: string[]
      Origins?: Array<Record<string, unknown>>
      CacheBehaviors?: Array<Record<string, unknown>>
      DefaultCacheBehavior?: Record<string, unknown>
      ViewerCertificate?: Record<string, unknown>
    }
  }
}

function findDistribution(template: Template, aliasMatcher: string): CfnDistributionResource {
  const resources = template.toJSON().Resources as Record<string, CfnResource>
  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::CloudFront::Distribution') continue
    const cfg = (resource.Properties as { DistributionConfig?: { Aliases?: string[] } }).DistributionConfig
    if (cfg?.Aliases?.includes(aliasMatcher)) {
      return resource as CfnDistributionResource
    }
  }
  throw new Error(`No CloudFront::Distribution with alias ${aliasMatcher} in template`)
}

type CfnCacheBehavior = {
  PathPattern: string
  TargetOriginId: string
  AllowedMethods: string[]
  Compress: boolean
  ViewerProtocolPolicy: string
  CachePolicyId: { Ref?: string }
  ResponseHeadersPolicyId: { Ref?: string }
}

type CfnOrigin = {
  Id: string
  DomainName: unknown
  OriginAccessControlId?: { 'Fn::GetAtt'?: [string, string] }
}

function findCacheBehavior(template: Template, pathPattern: string): CfnCacheBehavior {
  const distribution = findDistribution(template, 'images.akli.dev')
  const behaviors = (distribution.Properties.DistributionConfig.CacheBehaviors ?? []) as CfnCacheBehavior[]
  const behavior = behaviors.find((b) => b.PathPattern === pathPattern)
  if (!behavior) throw new Error(`No CacheBehavior with PathPattern ${pathPattern} in template`)
  return behavior
}

function findOriginForBucket(template: Template, bucketLogicalIdPrefix: string): CfnOrigin {
  const distribution = findDistribution(template, 'images.akli.dev')
  const origins = (distribution.Properties.DistributionConfig.Origins ?? []) as CfnOrigin[]
  const origin = origins.find((o) => referencesLogicalId(o.DomainName, bucketLogicalIdPrefix))
  if (!origin) throw new Error(`No origin referencing bucket ${bucketLogicalIdPrefix} in template`)
  return origin
}

// Identify the image cache policy by its unique TTLs (30d default / 365d max);
// other CachePolicy resources in the template have different TTLs (e.g. SSR's
// 60s default). Cannot match by Name because cache policy names are
// account-globally unique, so the factory deliberately leaves the name unset
// and lets CDK auto-generate per-stack.
const IMAGE_CACHE_DEFAULT_TTL_SEC = 30 * 24 * 60 * 60
const IMAGE_CACHE_MAX_TTL_SEC = 365 * 24 * 60 * 60

function findImageCachePolicyLogicalId(template: Template): string {
  const resources = template.toJSON().Resources as Record<string, CfnResource>
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::CloudFront::CachePolicy') continue
    const cfg = (resource.Properties as {
      CachePolicyConfig?: { DefaultTTL?: number; MaxTTL?: number }
    }).CachePolicyConfig
    if (cfg?.DefaultTTL === IMAGE_CACHE_DEFAULT_TTL_SEC && cfg?.MaxTTL === IMAGE_CACHE_MAX_TTL_SEC) {
      return logicalId
    }
  }
  throw new Error('No image cache policy (30d/365d TTL) found in template')
}

describe('ImagesStack', () => {
  let harness: Harness

  beforeAll(() => {
    harness = createHarness()
  })

  describe('CloudFront distribution', () => {
    it('creates an AWS::CloudFront::Distribution with Aliases: [images.akli.dev]', () => {
      harness.imagesTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Aliases: ['images.akli.dev'],
        }),
      })
    })

    it('configures ViewerCertificate.AcmCertificateArn referencing ImagesCert', () => {
      const distribution = findDistribution(harness.imagesTemplate, 'images.akli.dev')
      const viewerCertificate = distribution.Properties.DistributionConfig.ViewerCertificate
      expect(viewerCertificate).toBeDefined()
      const acmArn = (viewerCertificate as { AcmCertificateArn?: unknown }).AcmCertificateArn
      // Cross-region cert refs come through SSM dynamic references — must exist and be non-null.
      expect(acmArn).toBeDefined()
      // SslSupportMethod is sni-only when an ACM cert is set (vs the default cloudfront cert)
      expect((viewerCertificate as { SslSupportMethod?: string }).SslSupportMethod).toBe('sni-only')
    })

    it('default behaviour has exactly one FunctionAssociation, on viewer-request', () => {
      const distribution = findDistribution(harness.imagesTemplate, 'images.akli.dev')
      const defaultBehavior = distribution.Properties.DistributionConfig.DefaultCacheBehavior as {
        FunctionAssociations?: Array<{ EventType: string; FunctionARN: unknown }>
      }
      expect(defaultBehavior.FunctionAssociations).toHaveLength(1)
      expect(defaultBehavior.FunctionAssociations?.[0]).toEqual(
        expect.objectContaining({ EventType: 'viewer-request' }),
      )
    })

    it('the default-behaviour CloudFront Function inline code returns statusCode: 404', () => {
      const resources = harness.imagesTemplate.toJSON().Resources as Record<string, CfnResource>
      const functions = Object.values(resources).filter(
        (r) => r.Type === 'AWS::CloudFront::Function',
      )
      expect(functions.length).toBeGreaterThan(0)
      const has404 = functions.some((fn) => {
        const code = (fn.Properties as { FunctionCode?: string }).FunctionCode
        return typeof code === 'string' && /statusCode\s*:\s*404/.test(code)
      })
      expect(has404).toBe(true)
    })

    it('CacheBehaviors array contains exactly two entries: recipes/* and blog/*', () => {
      const distribution = findDistribution(harness.imagesTemplate, 'images.akli.dev')
      const cacheBehaviors = distribution.Properties.DistributionConfig.CacheBehaviors ?? []
      expect(cacheBehaviors).toHaveLength(2)
      harness.imagesTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({ PathPattern: 'recipes/*' }),
            Match.objectLike({ PathPattern: 'blog/*' }),
          ]),
        }),
      })
    })

    describe.each(['recipes/*', 'blog/*'])('%s behaviour', (pathPattern) => {
      it('allows only GET and HEAD, compresses, and redirects to HTTPS', () => {
        const behavior = findCacheBehavior(harness.imagesTemplate, pathPattern)
        expect(behavior.AllowedMethods).toEqual(['GET', 'HEAD'])
        expect(behavior.Compress).toBe(true)
        expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https')
      })

      it('CachePolicyId references the shared image cache policy', () => {
        const behavior = findCacheBehavior(harness.imagesTemplate, pathPattern)
        expect(behavior.CachePolicyId.Ref).toBe(findImageCachePolicyLogicalId(harness.imagesTemplate))
      })

      it('ResponseHeadersPolicyId references the shared security headers policy', () => {
        const [headersPolicyLogicalId] = findResourceEntryByLogicalIdPrefix(
          harness.imagesTemplate,
          'AWS::CloudFront::ResponseHeadersPolicy',
          'SecurityHeaders',
        )
        const behavior = findCacheBehavior(harness.imagesTemplate, pathPattern)
        expect(behavior.ResponseHeadersPolicyId.Ref).toBe(headersPolicyLogicalId)
      })
    })

    it('recipes/* origin uses OAC (OriginAccessControlId is non-null)', () => {
      const distribution = findDistribution(harness.imagesTemplate, 'images.akli.dev')
      const origins = (distribution.Properties.DistributionConfig.Origins ?? []) as CfnOrigin[]
      const recipesBehavior = findCacheBehavior(harness.imagesTemplate, 'recipes/*')
      const recipesOrigin = origins.find((o) => o.Id === recipesBehavior.TargetOriginId)
      expect(recipesOrigin).toBeDefined()
      expect(recipesOrigin?.OriginAccessControlId).toBeDefined()
      expect(recipesOrigin?.OriginAccessControlId).not.toBeNull()
    })

    it('recipes/* targets the recipe-images bucket origin, whose DomainName is the bucket regional domain', () => {
      const recipeImagesOrigin = findOriginForBucket(harness.imagesTemplate, 'RecipeImagesBucket')
      const recipesBehavior = findCacheBehavior(harness.imagesTemplate, 'recipes/*')
      expect(recipesBehavior.TargetOriginId).toBe(recipeImagesOrigin.Id)
      expect(JSON.stringify(recipeImagesOrigin.DomainName)).toMatch(
        /RegionalDomainName|s3\.eu-west-2\.amazonaws\.com/,
      )
    })

    it('has two origins: the recipe-images bucket and the site bucket regional domain', () => {
      const distribution = findDistribution(harness.imagesTemplate, 'images.akli.dev')
      expect(distribution.Properties.DistributionConfig.Origins).toHaveLength(2)
      findOriginForBucket(harness.imagesTemplate, 'RecipeImagesBucket')
      const siteOrigin = findOriginForBucket(harness.imagesTemplate, 'TestSiteBucket')
      expect(JSON.stringify(siteOrigin.DomainName)).toMatch(/s3\.eu-west-2\.amazonaws\.com/)
    })

    it('site-bucket and recipe-images origins reference distinct OAC resources', () => {
      const oacLogicalIdFor = (bucketPrefix: string) =>
        findOriginForBucket(harness.imagesTemplate, bucketPrefix).OriginAccessControlId?.['Fn::GetAtt']?.[0]
      const recipeOacId = oacLogicalIdFor('RecipeImagesBucket')
      const siteOacId = oacLogicalIdFor('TestSiteBucket')
      expect(recipeOacId).toBeDefined()
      expect(siteOacId).toBeDefined()
      expect(siteOacId).not.toBe(recipeOacId)
    })

    it('blog/* behaviour targets the site-bucket origin, not the recipe-images origin', () => {
      const siteOriginId = findOriginForBucket(harness.imagesTemplate, 'TestSiteBucket').Id
      const recipeImagesOriginId = findOriginForBucket(harness.imagesTemplate, 'RecipeImagesBucket').Id
      const blogBehavior = findCacheBehavior(harness.imagesTemplate, 'blog/*')
      expect(blogBehavior.TargetOriginId).toBe(siteOriginId)
      expect(blogBehavior.TargetOriginId).not.toBe(recipeImagesOriginId)
    })

    it('creates exactly two OriginAccessControls, both sigv4 + always', () => {
      harness.imagesTemplate.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2)
      harness.imagesTemplate.resourcePropertiesCountIs(
        'AWS::CloudFront::OriginAccessControl',
        {
          OriginAccessControlConfig: Match.objectLike({
            SigningProtocol: 'sigv4',
            SigningBehavior: 'always',
          }),
        },
        2,
      )
    })
  })

  describe('Route 53', () => {
    it('creates an A alias record for images.akli.dev pointing at the distribution', () => {
      harness.imagesTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'images.akli.dev.',
        Type: 'A',
        AliasTarget: Match.objectLike({
          DNSName: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('.*Distribution.*')]),
          }),
          HostedZoneId: Match.anyValue(),
        }),
      })
    })

    it('the A record references the akli.dev hosted zone', () => {
      const resources = harness.imagesTemplate.toJSON().Resources as Record<string, CfnResource>
      const aRecord = Object.values(resources).find((r) => {
        if (r.Type !== 'AWS::Route53::RecordSet') return false
        const props = r.Properties as { Name?: string; Type?: string }
        return props.Name === 'images.akli.dev.' && props.Type === 'A'
      })
      expect(aRecord).toBeDefined()
      const hostedZoneId = (aRecord?.Properties as { HostedZoneId?: unknown }).HostedZoneId
      expect(hostedZoneId).toBeDefined()
      // Cross-region hosted zone reference comes through as a non-null SSM ref / token
      expect(hostedZoneId).not.toBeNull()
    })

    it('creates an AAAA alias record for images.akli.dev', () => {
      harness.imagesTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'images.akli.dev.',
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

  describe('S3 bucket policy on RecipeImagesBucket (RecipeStack template)', () => {
    it('grants s3:GetObject to cloudfront.amazonaws.com scoped via aws:SourceArn', () => {
      // The recipe-images bucket is owned by RecipeStack, so the bucket policy
      // additions made by ImagesStack land on RecipeStack's synthesised template.
      harness.recipeTemplate.hasResourceProperties('AWS::S3::BucketPolicy', {
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
                        Match.stringLikeRegexp('^RecipeImagesBucket.*'),
                      ]),
                    }),
                    '/*',
                  ]),
                ]),
              }),
              Condition: Match.objectLike({
                StringLike: Match.objectLike({
                  'aws:SourceArn': Match.anyValue(),
                }),
              }),
            }),
          ]),
        }),
      })
    })

    it('no Allow statement grants Principal: "*"', () => {
      // Restrict to Effect: Allow — the bucket has a Deny statement for
      // non-TLS access from Principal { AWS: '*' } as part of enforceSSL,
      // which is a security control we must preserve, not weaken.
      const wildcardAllowStatements: unknown[] = []
      const bucketPolicies = harness.recipeTemplate.findResources('AWS::S3::BucketPolicy')
      for (const policy of Object.values(bucketPolicies)) {
        const statements =
          ((policy as { Properties: { PolicyDocument: { Statement?: unknown[] } } }).Properties
            .PolicyDocument.Statement) ?? []
        for (const stmt of statements) {
          const s = stmt as { Effect?: string; Principal?: unknown }
          if (s.Effect !== 'Allow') continue
          if (s.Principal === '*') {
            wildcardAllowStatements.push(s)
            continue
          }
          if (s.Principal && typeof s.Principal === 'object') {
            const aws = (s.Principal as { AWS?: unknown }).AWS
            if (aws === '*') wildcardAllowStatements.push(s)
          }
        }
      }
      expect(wildcardAllowStatements).toEqual([])
    })

    it('no statement grants s3:ListBucket to the CloudFront service principal', () => {
      const offendingStatements: unknown[] = []
      const bucketPolicies = harness.recipeTemplate.findResources('AWS::S3::BucketPolicy')
      for (const policy of Object.values(bucketPolicies)) {
        const statements =
          ((policy as { Properties: { PolicyDocument: { Statement?: unknown[] } } }).Properties
            .PolicyDocument.Statement) ?? []
        for (const stmt of statements) {
          const s = stmt as {
            Action?: string | string[]
            Principal?: { Service?: string | string[] }
          }
          const principalService = s.Principal?.Service
          const isCloudFrontPrincipal = principalService === 'cloudfront.amazonaws.com'
            || (Array.isArray(principalService)
              && principalService.includes('cloudfront.amazonaws.com'))
          if (!isCloudFrontPrincipal) continue
          const action = s.Action
          const grantsList = Array.isArray(action)
            ? action.includes('s3:ListBucket')
            : action === 's3:ListBucket'
          if (grantsList) offendingStatements.push(s)
        }
      }
      expect(offendingStatements).toEqual([])
    })

    it('every statement granting the CloudFront principal includes an aws:SourceArn condition', () => {
      const cloudfrontStatementsWithoutSourceArn: unknown[] = []
      let cloudfrontStatementsSeen = 0
      const bucketPolicies = harness.recipeTemplate.findResources('AWS::S3::BucketPolicy')
      for (const policy of Object.values(bucketPolicies)) {
        const statements =
          ((policy as { Properties: { PolicyDocument: { Statement?: unknown[] } } }).Properties
            .PolicyDocument.Statement) ?? []
        for (const stmt of statements) {
          const s = stmt as {
            Principal?: { Service?: string | string[] }
            Condition?: {
              StringEquals?: Record<string, unknown>
              StringLike?: Record<string, unknown>
            }
          }
          const principalService = s.Principal?.Service
          const isCloudFrontPrincipal = principalService === 'cloudfront.amazonaws.com'
            || (Array.isArray(principalService)
              && principalService.includes('cloudfront.amazonaws.com'))
          if (!isCloudFrontPrincipal) continue
          cloudfrontStatementsSeen += 1
          const sourceArn = s.Condition?.StringEquals?.['aws:SourceArn']
            ?? s.Condition?.StringEquals?.['AWS:SourceArn']
            ?? s.Condition?.StringLike?.['aws:SourceArn']
            ?? s.Condition?.StringLike?.['AWS:SourceArn']
          if (sourceArn === undefined || sourceArn === null) {
            cloudfrontStatementsWithoutSourceArn.push(s)
          }
        }
      }
      expect(cloudfrontStatementsWithoutSourceArn).toEqual([])
      expect(cloudfrontStatementsSeen).toBeGreaterThan(0)
    })

    it('the bucket retains BlockPublicAcls/IgnorePublicAcls/BlockPublicPolicy/RestrictPublicBuckets: true', () => {
      harness.recipeTemplate.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'akli-recipe-images-123456789012-eu-west-2',
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      })
    })
  })

  describe('S3 event notification on RecipeImagesBucket (RecipeStack template)', () => {
    it('filters S3 events on prefix uploads/ only — no recipes/ filter present', () => {
      // CDK realises bucket notifications via a `Custom::S3BucketNotifications`
      // custom resource (not inline on the bucket). The shape there is
      // `NotificationConfiguration.LambdaFunctionConfigurations[*].Filter.Key.FilterRules`.
      // Walk every notification-bearing resource and assert no rule has
      // `Name: 'prefix', Value: 'recipes/'`.
      type FilterRule = { Name?: string; Value?: unknown }
      type LambdaConfig = {
        Filter?: { Key?: { FilterRules?: FilterRule[] }; S3Key?: { Rules?: FilterRule[] } }
        Events?: string[]
      }

      const lambdaConfigs: LambdaConfig[] = []

      const json = harness.recipeTemplate.toJSON()
      const resources = json.Resources as Record<string, CfnResource>

      for (const resource of Object.values(resources)) {
        const props = resource.Properties as Record<string, unknown> | undefined
        if (!props) continue
        const notif = (props as { NotificationConfiguration?: {
          LambdaConfigurations?: LambdaConfig[]
          LambdaFunctionConfigurations?: LambdaConfig[]
        } }).NotificationConfiguration
        if (notif?.LambdaFunctionConfigurations) {
          lambdaConfigs.push(...notif.LambdaFunctionConfigurations)
        }
        if (notif?.LambdaConfigurations) {
          lambdaConfigs.push(...notif.LambdaConfigurations)
        }
      }

      expect(lambdaConfigs.length).toBeGreaterThan(0)

      const allRules = (cfg: LambdaConfig): FilterRule[] => [
        ...(cfg.Filter?.Key?.FilterRules ?? []),
        ...(cfg.Filter?.S3Key?.Rules ?? []),
      ]

      const hasUploadsPrefix = lambdaConfigs.some((cfg) =>
        allRules(cfg).some((r) => r.Name === 'prefix' && r.Value === 'uploads/'),
      )
      expect(hasUploadsPrefix).toBe(true)

      const recipesPrefixRules = lambdaConfigs.flatMap((cfg) =>
        allRules(cfg).filter((r) => r.Name === 'prefix' && r.Value === 'recipes/'),
      )
      expect(recipesPrefixRules).toEqual([])
    })
  })

  describe('Cross-stack / cross-region', () => {
    it('exposes recipeImageBucket on its props interface', () => {
      // The harness above passes recipeStack.imageBucket into ImagesStack props.
      // If the prop interface drops the field, this test file fails to compile.
      // Run-time assertion: the harness constructed without throwing.
      expect(harness.imagesStack).toBeInstanceOf(ImagesStack)
    })

    it('enables crossRegionReferences on the stack instance', () => {
      // Cross-region machinery is observable two ways:
      // 1. The internal `_crossRegionReferences` flag CDK sets on the Stack
      //    instance when the prop is true.
      // 2. The synthesised distribution's cert ref is a cross-region token
      //    (Fn::ImportValue / CrossRegion SSM dynamic ref) rather than a literal.
      // Either is sufficient proof.
      const stack = harness.imagesStack as unknown as { _crossRegionReferences?: boolean }
      const flagSet = stack._crossRegionReferences === true

      let isCrossRegionToken = false
      try {
        const distribution = findDistribution(harness.imagesTemplate, 'images.akli.dev')
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
    it('tags the distribution with Project=akli-images', () => {
      harness.imagesTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Project', Value: 'akli-images' }),
        ]),
      })
    })

    it('tags the distribution with Owner', () => {
      harness.imagesTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Owner', Value: 'Akli' }),
        ]),
      })
    })

    it('tags the distribution with Environment=production', () => {
      harness.imagesTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'production' }),
        ]),
      })
    })

    it('tags the distribution with ManagedBy=cdk', () => {
      harness.imagesTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'cdk' }),
        ]),
      })
    })
  })
})

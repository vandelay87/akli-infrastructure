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

// Finds the [logicalId, resource] entry for the given CFN type whose logical ID starts
// with idPrefix. CDK appends an 8-character hash to the construct ID to form the logical
// ID (e.g. construct ID 'PokedexBucket' -> logical ID 'PokedexBucketAB12CD34'), so an
// exact-match lookup would never succeed. Pass '' as idPrefix to match on type alone.
function findResourceEntryByLogicalIdPrefix(template: Template, type: string, idPrefix: string): [string, CfnResource] {
  const resources = template.toJSON().Resources as Record<string, CfnResource>
  const entries = Object.entries(resources).filter(
    ([logicalId, r]) => r.Type === type && logicalId.startsWith(idPrefix),
  )
  if (entries.length === 0) throw new Error(`${type} with logical ID prefix "${idPrefix}" not found in template`)
  if (entries.length > 1) {
    throw new Error(
      `Multiple ${type} resources match logical ID prefix "${idPrefix}": ${entries.map(([id]) => id).join(', ')}`,
    )
  }
  return entries[0]
}

function findResourceByLogicalIdPrefix(template: Template, type: string, idPrefix: string): CfnResource {
  return findResourceEntryByLogicalIdPrefix(template, type, idPrefix)[1]
}

function distributionLogicalId(template: Template): string {
  return findResourceEntryByLogicalIdPrefix(template, 'AWS::CloudFront::Distribution', '')[0]
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

// --- helpers for per-logical-ID template walks (OIDC provider / per-app IAM roles) ---

function allResources(template: Template): Record<string, CfnResource> {
  return template.toJSON().Resources as Record<string, CfnResource>
}

/** Trust policy statements (AssumeRolePolicyDocument) for an AWS::IAM::Role resource. */
function trustPolicyStatements(role: CfnResource): Record<string, unknown>[] {
  const doc = role.Properties.AssumeRolePolicyDocument as { Statement: Record<string, unknown>[] } | undefined
  if (!doc) throw new Error('Role has no AssumeRolePolicyDocument')
  return doc.Statement
}

/**
 * All inline policy statements that apply to a Role, regardless of whether they were attached
 * as a separate AWS::IAM::Policy resource (role.attachInlinePolicy) or embedded directly on the
 * Role resource itself (Properties.Policies).
 */
function policyStatementsForRole(template: Template, roleLogicalId: string): Record<string, unknown>[] {
  const resources = allResources(template)
  const statements: Record<string, unknown>[] = []

  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::IAM::Policy') continue
    const roles = resource.Properties.Roles as Array<{ Ref?: string }> | undefined
    if (roles?.some((ref) => ref.Ref === roleLogicalId)) {
      const doc = resource.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }
      statements.push(...doc.Statement)
    }
  }

  const role = resources[roleLogicalId]
  const inlinePolicies = role?.Properties.Policies as Array<{ PolicyDocument: { Statement: Record<string, unknown>[] } }> | undefined
  if (inlinePolicies) {
    for (const p of inlinePolicies) {
      statements.push(...p.PolicyDocument.Statement)
    }
  }

  return statements
}

/** True if `logicalId` appears anywhere inside the (Ref / Fn::GetAtt / Fn::Join / Fn::Sub) structure of `value`. */
function referencesLogicalId(value: unknown, logicalId: string): boolean {
  return JSON.stringify(value).includes(logicalId)
}

function findLambdaStatement(statements: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return statements.find((s) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action]
    return actions.includes('lambda:UpdateFunctionCode')
  })
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

  describe('GitHub OIDC provider', () => {
    it('registers a native AWS::IAM::OIDCProvider for token.actions.githubusercontent.com with the sts.amazonaws.com audience', () => {
      template.hasResourceProperties('AWS::IAM::OIDCProvider', {
        Url: 'https://token.actions.githubusercontent.com',
        ClientIdList: ['sts.amazonaws.com'],
      })
    })

    it('configures both required GitHub intermediate CA thumbprints', () => {
      // GitHub's OIDC token endpoint can present either of two intermediate CA certs (per
      // GitHub's 2023-06-27 OIDC changelog post), so both must be trusted — asserting the
      // exact set (not just "at least one 40-char hex value") catches a future edit that
      // accidentally drops one.
      const [, provider] = findResourceEntryByLogicalIdPrefix(template, 'AWS::IAM::OIDCProvider', '')
      const thumbprints = provider.Properties.ThumbprintList as string[]

      expect(thumbprints).toEqual([
        '6938fd4d98bab03faadb97b34396831e3780aea1',
        '1c58a3a8518e8759bf075b76b750d4f2df264fcd',
      ])
    })

    it('does not register the legacy Lambda-backed OpenIdConnectProvider custom resource', () => {
      const resources = allResources(template)
      const legacyProviderType = Object.values(resources).find(
        (r) => r.Type === 'Custom::AWSCDKOpenIdConnectProvider',
      )
      expect(legacyProviderType).toBeUndefined()
    })

    it('registers exactly one OIDC provider in the stack', () => {
      // Throws if there is more than one AWS::IAM::OIDCProvider resource — CloudFormation
      // hard-fails on duplicate provider URLs, so the stack must only ever declare one.
      expect(() => findResourceEntryByLogicalIdPrefix(template, 'AWS::IAM::OIDCProvider', '')).not.toThrow()
    })
  })

  describe('Per-app GitHub Actions deploy roles', () => {
    const DEPLOY_APPS = [
      {
        roleLogicalIdPrefix: 'PersonalWebsiteDeployRole',
        repo: 'personal-website',
        bucketLogicalIdPrefix: 'SiteBucket',
        hasLambdaAccess: true,
      },
      {
        roleLogicalIdPrefix: 'PokedexDeployRole',
        repo: 'pokedex',
        bucketLogicalIdPrefix: 'PokedexBucket',
        hasLambdaAccess: false,
      },
      {
        roleLogicalIdPrefix: 'SandboxDeployRole',
        repo: 'sand-box',
        bucketLogicalIdPrefix: 'SandboxBucket',
        hasLambdaAccess: false,
      },
    ] as const

    describe.each(DEPLOY_APPS)('$roleLogicalIdPrefix', ({ roleLogicalIdPrefix, repo, bucketLogicalIdPrefix, hasLambdaAccess }) => {
      it(`trusts only repo:vandelay87/${repo}:ref:refs/heads/main via the GitHub OIDC provider`, () => {
        const [, role] = findResourceEntryByLogicalIdPrefix(template, 'AWS::IAM::Role', roleLogicalIdPrefix)
        const statements = trustPolicyStatements(role)

        const webIdentityStatement = statements.find((s) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action]
          return actions.includes('sts:AssumeRoleWithWebIdentity')
        })

        expect(webIdentityStatement).toBeDefined()
        expect(webIdentityStatement?.Effect).toBe('Allow')

        const condition = webIdentityStatement?.Condition as Record<string, Record<string, unknown>> | undefined
        const scopedConditions = { ...(condition?.StringEquals ?? {}), ...(condition?.StringLike ?? {}) }

        expect(scopedConditions['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com')
        expect(scopedConditions['token.actions.githubusercontent.com:sub']).toBe(`repo:vandelay87/${repo}:ref:refs/heads/main`)
      })

      it(`grants S3 access scoped only to its own bucket (${bucketLogicalIdPrefix})`, () => {
        const [roleLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::IAM::Role', roleLogicalIdPrefix)
        const [bucketLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::S3::Bucket', bucketLogicalIdPrefix)
        const statements = policyStatementsForRole(template, roleLogicalId)

        const s3Statement = statements.find((s) => {
          const actions = (Array.isArray(s.Action) ? s.Action : [s.Action]) as string[]
          return actions.some((a) => a.startsWith('s3:'))
        })

        expect(s3Statement).toBeDefined()
        expect(s3Statement?.Effect).toBe('Allow')
        expect(referencesLogicalId(s3Statement?.Resource, bucketLogicalId)).toBe(true)

        const actions = (Array.isArray(s3Statement?.Action) ? s3Statement?.Action : [s3Statement?.Action]) as string[]
        expect(actions).toEqual(
          expect.arrayContaining(['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket']),
        )
      })

      if (hasLambdaAccess) {
        it('grants lambda:UpdateFunctionCode/GetFunction scoped to the SSR function', () => {
          const [roleLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::IAM::Role', roleLogicalIdPrefix)
          const lambdaStatement = findLambdaStatement(policyStatementsForRole(template, roleLogicalId))

          expect(lambdaStatement).toBeDefined()
          expect(lambdaStatement?.Effect).toBe('Allow')
          const actions = lambdaStatement?.Action as string[]
          expect(actions).toEqual(expect.arrayContaining(['lambda:UpdateFunctionCode', 'lambda:GetFunction']))
          expect(referencesLogicalId(lambdaStatement?.Resource, 'SsrFunction')).toBe(true)
        })
      } else {
        it('does not grant lambda:UpdateFunctionCode/GetFunction access', () => {
          const [roleLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::IAM::Role', roleLogicalIdPrefix)
          const lambdaStatement = findLambdaStatement(policyStatementsForRole(template, roleLogicalId))

          expect(lambdaStatement).toBeUndefined()
        })
      }

      it('grants cloudfront:CreateInvalidation scoped to the one shared distribution', () => {
        const [roleLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::IAM::Role', roleLogicalIdPrefix)
        const [distributionLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::CloudFront::Distribution', '')
        const statements = policyStatementsForRole(template, roleLogicalId)

        const invalidationStatement = statements.find((s) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action]
          return actions.includes('cloudfront:CreateInvalidation')
        })

        expect(invalidationStatement).toBeDefined()
        expect(invalidationStatement?.Effect).toBe('Allow')
        expect(referencesLogicalId(invalidationStatement?.Resource, distributionLogicalId)).toBe(true)
      })
    })

    it("no Role's policy references another app's bucket ARN (cross-app S3 isolation)", () => {
      const bucketsByApp = DEPLOY_APPS.map((app) => ({
        ...app,
        bucketLogicalId: findResourceEntryByLogicalIdPrefix(template, 'AWS::S3::Bucket', app.bucketLogicalIdPrefix)[0],
      }))

      for (const app of bucketsByApp) {
        const [roleLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::IAM::Role', app.roleLogicalIdPrefix)
        const statements = policyStatementsForRole(template, roleLogicalId)

        const otherApps = bucketsByApp.filter((other) => other.bucketLogicalId !== app.bucketLogicalId)
        for (const other of otherApps) {
          const referencesOtherAppsBucket = statements.some((s) => referencesLogicalId(s, other.bucketLogicalId))
          expect(referencesOtherAppsBucket).toBe(false)
        }
      }
    })
  })
})

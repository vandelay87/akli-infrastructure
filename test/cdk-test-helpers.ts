import type { Template } from 'aws-cdk-lib/assertions'

export type CfnResource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string }

// Finds the [logicalId, resource] entry for the given CFN type whose logical ID starts
// with idPrefix. CDK appends an 8-character hash to the construct ID to form the logical
// ID (e.g. construct ID 'PokedexBucket' -> logical ID 'PokedexBucketAB12CD34'), so an
// exact-match lookup would never succeed. Pass '' as idPrefix to match on type alone.
export function findResourceEntryByLogicalIdPrefix(template: Template, type: string, idPrefix: string): [string, CfnResource] {
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

/** True if `logicalId` appears anywhere inside the (Ref / Fn::GetAtt / Fn::Join / Fn::Sub) structure of `value`. */
export function referencesLogicalId(value: unknown, logicalId: string): boolean {
  return JSON.stringify(value).includes(logicalId)
}

export function findStatementByAction(statements: Record<string, unknown>[], action: string): Record<string, unknown> | undefined {
  return statements.find((s) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action]
    return actions.includes(action)
  })
}

export type CfnPolicyStatement = { Sid?: string; Effect: string; Principal?: unknown; Action?: unknown; Resource?: unknown; Condition?: unknown }

export type CfnOrigin = {
  Id: string
  DomainName?: Record<string, unknown>
  S3OriginConfig?: unknown
  CustomOriginConfig?: unknown
  OriginAccessControlId?: { 'Fn::GetAtt'?: [string, string] }
}

export type CfnCacheBehavior = {
  PathPattern: string
  TargetOriginId: string
  AllowedMethods?: string[]
  Compress?: boolean
  ViewerProtocolPolicy?: string
  CachePolicyId?: { Ref?: string }
  ResponseHeadersPolicyId?: { Ref?: string }
}

export type CfnDistributionConfig = {
  Aliases?: string[]
  Origins?: CfnOrigin[]
  CacheBehaviors?: CfnCacheBehavior[]
  DefaultCacheBehavior?: Record<string, unknown>
  ViewerCertificate?: Record<string, unknown>
  [key: string]: unknown
}

/** The template's sole AWS::CloudFront::Distribution. */
export function cfnDistribution(template: Template): CfnResource {
  return findResourceEntryByLogicalIdPrefix(template, 'AWS::CloudFront::Distribution', '')[1]
}

export function distributionConfig(dist: CfnResource): CfnDistributionConfig {
  return dist.Properties.DistributionConfig as CfnDistributionConfig
}

export function bucketPolicyStatements(template: Template, bucketIdPrefix: string): CfnPolicyStatement[] {
  const [, policy] = findResourceEntryByLogicalIdPrefix(template, 'AWS::S3::BucketPolicy', `${bucketIdPrefix}Policy`)
  return (policy.Properties.PolicyDocument as { Statement: CfnPolicyStatement[] }).Statement
}

export function isCloudFrontServicePrincipal(statement: { Principal?: unknown }): boolean {
  const service = (statement.Principal as { Service?: unknown } | undefined)?.Service
  return Array.isArray(service) ? service.includes('cloudfront.amazonaws.com') : service === 'cloudfront.amazonaws.com'
}

/** Statements added by `grantCloudFrontReadCrossStack`: CloudFront principal with a `StringLike` condition. */
export function crossStackCloudFrontStatements(statements: CfnPolicyStatement[]): CfnPolicyStatement[] {
  return statements.filter(
    (s) => isCloudFrontServicePrincipal(s) && (s.Condition as { StringLike?: unknown } | undefined)?.StringLike !== undefined,
  )
}

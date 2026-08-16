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

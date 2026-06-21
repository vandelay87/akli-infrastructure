import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'

export const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TABLE_NAME = process.env.TABLE_NAME ?? ''

export const SLUG_INDEX_NAME = 'slug-index'

const STEP_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidStepId(stepId: string): boolean {
  return STEP_ID_REGEX.test(stepId)
}

export interface RecipeStep {
  readonly stepId?: string
}

export interface Recipe extends Record<string, unknown> {
  readonly id?: string
  readonly slug?: string
  readonly steps?: readonly RecipeStep[]
}

export async function getRecipeById(id: string): Promise<Recipe | undefined> {
  const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { id } }))
  return result.Item as Recipe | undefined
}

// Returns the id of every recipe row matching the slug. The slug-index GSI tolerates
// transient duplicate-slug rows, so callers that need exclude-self semantics inspect
// the full list rather than the first hit.
export async function queryRecipeIdsBySlug(slug: string): Promise<(string | undefined)[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: SLUG_INDEX_NAME,
      KeyConditionExpression: 'slug = :slug',
      ExpressionAttributeValues: { ':slug': slug },
    }),
  )
  return (result.Items ?? []).map((item) => (item as { id?: string }).id)
}

export async function findIdBySlug(slug: string): Promise<string | undefined> {
  const [id] = await queryRecipeIdsBySlug(slug)
  return id
}

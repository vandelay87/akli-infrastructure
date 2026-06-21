import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  type UpdateCommandInput,
  type UpdateCommandOutput,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb'

export const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TABLE_NAME = process.env.TABLE_NAME ?? ''

export const SLUG_INDEX_NAME = 'slug-index'
const STATUS_INDEX_NAME = 'status-createdAt-index'
const AUTHOR_INDEX_NAME = 'authorId-createdAt-index'

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
  readonly status?: string
  readonly authorId?: string
  readonly ttl?: number
  readonly imageStatus?: Record<string, number>
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

export async function queryRecipesByStatus(status: string): Promise<Recipe[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: STATUS_INDEX_NAME,
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
      ScanIndexForward: false,
    }),
  )
  return (result.Items ?? []) as Recipe[]
}

export async function queryRecipesByAuthor(authorId: string): Promise<Recipe[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: AUTHOR_INDEX_NAME,
      KeyConditionExpression: 'authorId = :authorId',
      ExpressionAttributeValues: { ':authorId': authorId },
      ScanIndexForward: false,
    }),
  )
  return (result.Items ?? []) as Recipe[]
}

export async function scanRecipes(input: Omit<ScanCommandInput, 'TableName'>): Promise<Recipe[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME, ...input }))
  return (result.Items ?? []) as Recipe[]
}

export async function putRecipe(item: Record<string, unknown>): Promise<void> {
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }))
}

export async function deleteRecipe(id: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { id } }))
}

// Update seam: owns the table name and client; callers supply the rest of the
// UpdateCommand input (Key, expressions, ReturnValues, condition handling).
export function updateRecipe(input: Omit<UpdateCommandInput, 'TableName'>): Promise<UpdateCommandOutput> {
  return docClient.send(new UpdateCommand({ TableName: TABLE_NAME, ...input }))
}

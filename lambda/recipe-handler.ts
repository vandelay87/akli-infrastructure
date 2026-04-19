import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'

const ddbClient = new DynamoDBClient({})
const docClient = DynamoDBDocumentClient.from(ddbClient)
const s3Client = new S3Client({})

const TABLE_NAME = process.env.TABLE_NAME ?? ''
const IMAGE_BUCKET_NAME = process.env.IMAGE_BUCKET_NAME ?? ''
const DRAFT_TTL_SECONDS = 30 * 24 * 60 * 60

interface JwtPayload {
  readonly sub: string
  readonly email?: string
  readonly name?: string
  readonly 'cognito:groups'?: readonly string[]
}

interface CoverImage {
  readonly key: string
  readonly alt: string
}

interface Ingredient {
  readonly item: string
  readonly quantity: string
  readonly unit: string
}

interface Step {
  readonly order: number
  readonly text: string
  readonly image?: { readonly key: string; readonly alt: string }
}

interface CreateRecipeInput {
  readonly title?: string
  readonly coverImage?: Partial<CoverImage>
  readonly intro?: string
  readonly ingredients?: readonly Ingredient[]
  readonly steps?: readonly Step[]
  readonly tags?: readonly string[]
  readonly prepTime?: number
  readonly cookTime?: number
  readonly servings?: number
}

function json(statusCode: number, body: Record<string, unknown> | readonly Record<string, unknown>[]): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function decodeJwt(event: APIGatewayProxyEventV2): JwtPayload | undefined {
  const authHeader = event.headers.authorization
  if (!authHeader) return undefined

  const token = authHeader.replace(/^bearer\s+/i, '')
  if (!token) return undefined

  try {
    const parts = token.split('.')
    if (parts.length < 2) return undefined
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as JwtPayload
  } catch {
    return undefined
  }
}

function isAdmin(event: APIGatewayProxyEventV2): boolean {
  const payload = decodeJwt(event)
  if (!payload) return false
  const groups = payload['cognito:groups']
  return Array.isArray(groups) && groups.includes('admin')
}

function tagsToArray(tags: unknown): string[] {
  if (tags instanceof Set) return Array.from(tags) as string[]
  if (Array.isArray(tags)) return tags as string[]
  if (tags && typeof tags === 'object' && 'wrapperName' in tags && 'values' in tags) {
    return (tags as { values: string[] }).values
  }
  return []
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function findUniqueSlug(baseSlug: string): Promise<string> {
  let candidate = baseSlug
  let suffix = 2

  while (true) {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'slug = :slug',
        ExpressionAttributeValues: { ':slug': candidate },
      }),
    )

    if (!result.Items || result.Items.length === 0) return candidate
    candidate = `${baseSlug}-${suffix}`
    suffix += 1
  }
}

function convertRecipeTags(recipe: Record<string, unknown>): Record<string, unknown> {
  return { ...recipe, tags: tagsToArray(recipe.tags) }
}

function lightweightRecipe(recipe: Record<string, unknown>): Record<string, unknown> {
  return {
    id: recipe.id,
    title: recipe.title,
    slug: recipe.slug,
    coverImage: recipe.coverImage,
    tags: tagsToArray(recipe.tags),
    prepTime: recipe.prepTime,
    cookTime: recipe.cookTime,
    servings: recipe.servings,
    createdAt: recipe.createdAt,
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    switch (event.routeKey) {
      case 'GET /recipes/tags':
        return await handleListTags()
      case 'GET /recipes':
        return await handleListPublished()
      case 'GET /recipes/admin':
        return await handleListForAdmin(event)
      case 'GET /recipes/{slug}':
        return await handleGetBySlug(event)
      case 'GET /me/recipes':
        return await handleListUserRecipes(event)
      case 'POST /recipes':
        return await handleCreateRecipe(event)
      case 'POST /recipes/drafts':
        return await handleCreateDraft(event)
      case 'PUT /recipes/{id}':
        return await handleUpdateRecipe(event)
      case 'PATCH /recipes/{id}/publish':
        return await handlePublish(event)
      case 'PATCH /recipes/{id}/unpublish':
        return await handleUnpublish(event)
      case 'DELETE /recipes/{id}':
        return await handleDeleteRecipe(event)
      default:
        return json(404, { error: 'Not found' })
    }
  } catch {
    return json(500, { error: 'Internal server error' })
  }
}

async function handleListTags(): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'published' },
      ProjectionExpression: 'tags',
    }),
  )

  const countMap: Record<string, number> = {}
  for (const item of result.Items ?? []) {
    const tags = tagsToArray(item.tags)
    for (const tag of tags) {
      countMap[tag] = (countMap[tag] ?? 0) + 1
    }
  }

  const sorted = Object.entries(countMap)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag))

  return json(200, sorted)
}

async function handleListPublished(): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'published' },
      ScanIndexForward: false,
    }),
  )

  const recipes = (result.Items ?? []).map((item) => lightweightRecipe(item as Record<string, unknown>))
  return json(200, recipes)
}

async function handleListForAdmin(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })
  if (!isAdmin(event)) return json(403, { error: 'Forbidden' })

  const queryByStatus = (status: string) =>
    docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'status-createdAt-index',
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
        ScanIndexForward: false,
      }),
    )

  const [publishedResult, draftResult] = await Promise.all([queryByStatus('published'), queryByStatus('draft')])

  const nowSeconds = Math.floor(Date.now() / 1000)
  const merged = [...(publishedResult.Items ?? []), ...(draftResult.Items ?? [])] as Record<string, unknown>[]
  const live = merged.filter((item) => typeof item.ttl !== 'number' || (item.ttl as number) > nowSeconds)

  return json(200, live.map((item) => convertRecipeTags(item)))
}

async function handleGetBySlug(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const slug = event.pathParameters?.slug
  if (!slug) return json(400, { error: 'slug is required' })

  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'slug = :slug',
      ExpressionAttributeValues: { ':slug': slug },
    }),
  )

  if (!result.Items || result.Items.length === 0) {
    return json(404, { error: 'Recipe not found' })
  }

  const recipe = result.Items[0] as Record<string, unknown>
  if (recipe.status !== 'published') {
    return json(404, { error: 'Recipe not found' })
  }

  return json(200, convertRecipeTags(recipe))
}

async function handleListUserRecipes(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'authorId-createdAt-index',
      KeyConditionExpression: 'authorId = :authorId',
      ExpressionAttributeValues: { ':authorId': payload.sub },
      ScanIndexForward: false,
    }),
  )

  const recipes = (result.Items ?? []).map((item) => convertRecipeTags(item as Record<string, unknown>))
  return json(200, recipes)
}

async function handleCreateRecipe(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })

  const input = JSON.parse(event.body ?? '{}') as CreateRecipeInput
  const errors = validateCreateInput(input)
  if (errors.length > 0) return json(400, { error: errors.join(', ') })

  const id = randomUUID()
  const baseSlug = generateSlug(input.title as string)
  const slug = await findUniqueSlug(baseSlug)
  const now = new Date().toISOString()

  const item: Record<string, unknown> = {
    id,
    slug,
    title: input.title,
    intro: input.intro,
    coverImage: input.coverImage,
    ingredients: input.ingredients,
    steps: input.steps,
    prepTime: input.prepTime,
    cookTime: input.cookTime,
    servings: input.servings,
    status: 'draft',
    authorId: payload.sub,
    authorName: payload.name ?? payload.email ?? '',
    createdAt: now,
    updatedAt: now,
  }

  if (input.tags && input.tags.length > 0) {
    item.tags = new Set(input.tags)
  }

  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }))

  return json(201, { ...item, tags: input.tags ?? [] })
}

function validateCreateInput(input: CreateRecipeInput): string[] {
  const errors: string[] = []
  if (!input.title) errors.push('title is required')
  if (!input.coverImage) {
    errors.push('coverImage is required')
  } else {
    if (!input.coverImage.key) errors.push('coverImage.key is required')
    if (!input.coverImage.alt) errors.push('coverImage.alt is required')
  }
  if (!input.ingredients || input.ingredients.length === 0) errors.push('At least one ingredient is required')
  if (!input.steps || input.steps.length === 0) errors.push('At least one step is required')
  return errors
}

async function handleCreateDraft(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })
  if (!isAdmin(event)) return json(403, { error: 'Forbidden' })

  const input = JSON.parse(event.body ?? '{}') as { title?: string }
  const title = typeof input.title === 'string' ? input.title : ''

  const id = randomUUID()
  const slug = title.length > 0 ? await findUniqueSlug(generateSlug(title)) : `draft-${id}`
  const ttl = Math.floor(Date.now() / 1000) + DRAFT_TTL_SECONDS
  const now = new Date().toISOString()

  const item: Record<string, unknown> = {
    id,
    slug,
    status: 'draft',
    ttl,
    title,
    intro: '',
    ingredients: [],
    steps: [],
    authorId: payload.sub,
    authorName: payload.name ?? payload.email ?? '',
    createdAt: now,
    updatedAt: now,
  }

  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }))

  return json(201, { id, slug })
}

async function handleUpdateRecipe(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })

  const id = event.pathParameters?.id
  if (!id) return json(400, { error: 'id is required' })

  const existing = await getRecipeById(id)
  if (!existing) return json(404, { error: 'Recipe not found' })

  if (!isOwnerOrAdmin(existing.authorId as string, payload.sub, event)) {
    return json(403, { error: 'Forbidden' })
  }

  const updates = JSON.parse(event.body ?? '{}') as Record<string, unknown>
  delete updates.slug
  delete updates.id
  delete updates.authorId
  delete updates.createdAt

  const now = new Date().toISOString()
  const expressionParts: string[] = []
  const expressionNames: Record<string, string> = {}
  const expressionValues: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(updates)) {
    const attrName = `#${key}`
    const attrValue = `:${key}`
    expressionParts.push(`${attrName} = ${attrValue}`)
    expressionNames[attrName] = key
    expressionValues[attrValue] = value
  }

  expressionParts.push('#updatedAt = :updatedAt')
  expressionNames['#updatedAt'] = 'updatedAt'
  expressionValues[':updatedAt'] = now

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: 'ALL_NEW',
    }),
  )

  return json(200, convertRecipeTags(result.Attributes as Record<string, unknown>))
}

async function handlePublish(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  return await handleStatusChange(event, 'published')
}

async function handleUnpublish(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  return await handleStatusChange(event, 'draft')
}

async function handleStatusChange(event: APIGatewayProxyEventV2, newStatus: string): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })

  const id = event.pathParameters?.id
  if (!id) return json(400, { error: 'id is required' })

  const existing = await getRecipeById(id)
  if (!existing) return json(404, { error: 'Recipe not found' })

  if (!isOwnerOrAdmin(existing.authorId as string, payload.sub, event)) {
    return json(403, { error: 'Forbidden' })
  }

  const now = new Date().toISOString()
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':status': newStatus, ':updatedAt': now },
      ReturnValues: 'ALL_NEW',
    }),
  )

  return json(200, convertRecipeTags(result.Attributes as Record<string, unknown>))
}

async function handleDeleteRecipe(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })

  const id = event.pathParameters?.id
  if (!id) return json(400, { error: 'id is required' })

  const existing = await getRecipeById(id)
  if (!existing) return json(404, { error: 'Recipe not found' })

  if (!isOwnerOrAdmin(existing.authorId as string, payload.sub, event)) {
    return json(403, { error: 'Forbidden' })
  }

  const listResult = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: IMAGE_BUCKET_NAME,
      Prefix: `processed/recipes/${id}/`,
    }),
  )

  if (listResult.Contents && listResult.Contents.length > 0) {
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: IMAGE_BUCKET_NAME,
        Delete: {
          Objects: listResult.Contents.map((obj) => ({ Key: obj.Key })),
        },
      }),
    )
  }

  await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { id } }))

  return json(200, { message: 'Recipe deleted successfully' })
}

async function getRecipeById(id: string): Promise<Record<string, unknown> | undefined> {
  const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { id } }))
  return result.Item as Record<string, unknown> | undefined
}

function isOwnerOrAdmin(authorId: string, currentUserId: string, event: APIGatewayProxyEventV2): boolean {
  if (authorId === currentUserId) return true
  return isAdmin(event)
}

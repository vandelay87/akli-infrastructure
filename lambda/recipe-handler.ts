import { randomUUID } from 'node:crypto'
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { VARIANT_SUFFIXES, PROCESSED_PREFIX } from './image-variants'

const ddbClient = new DynamoDBClient({})
const docClient = DynamoDBDocumentClient.from(ddbClient)
const s3Client = new S3Client({})

const TABLE_NAME = process.env.TABLE_NAME ?? ''
const IMAGE_BUCKET_NAME = process.env.IMAGE_BUCKET_NAME ?? ''
const DRAFT_TTL_SECONDS = 30 * 24 * 60 * 60

type RecipeStatus = 'draft' | 'published'
const DRAFT: RecipeStatus = 'draft'
const PUBLISHED: RecipeStatus = 'published'

interface JwtPayload {
  readonly sub: string
  readonly email?: string
  readonly name?: string
  readonly 'cognito:groups'?: readonly string[]
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
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

export const RESERVED_SLUGS: readonly string[] = ['new', 'admin', 'drafts', 'images']

const SLUG_LOCKED_RESPONSE = {
  error: 'slug_locked',
  message: 'Cannot change slug after images have been uploaded. Delete uploaded images first.',
} as const

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const STEP_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidSlug(slug: string): boolean {
  if (slug.length < 1 || slug.length > 100) return false
  if (!SLUG_REGEX.test(slug)) return false
  if (RESERVED_SLUGS.includes(slug)) return false
  return true
}

export async function slugExists(slug: string, excludeId?: string): Promise<boolean> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'slug-index',
      KeyConditionExpression: 'slug = :slug',
      ExpressionAttributeValues: { ':slug': slug },
    }),
  )
  if (!result.Items || result.Items.length === 0) return false
  if (excludeId) return result.Items.some((i) => (i as { id: string }).id !== excludeId)
  return true
}

function imageStatusOf(item: Record<string, unknown>): Record<string, number> {
  return (item.imageStatus as Record<string, number> | undefined) ?? {}
}

function composeImageProcessedAt<T extends Record<string, unknown>>(item: T): Omit<T, 'imageStatus'> {
  const imageStatus = imageStatusOf(item)
  const slug = typeof item.slug === 'string' ? item.slug : undefined
  const coverImage = item.coverImage as Record<string, unknown> | undefined

  const coverDerivedKey = slug ? `${PROCESSED_PREFIX}${slug}/cover` : undefined
  const coverProcessedAt = coverDerivedKey ? imageStatus[coverDerivedKey] : undefined

  const steps = Array.isArray(item.steps)
    ? item.steps.map((step) => {
        const s = step as { stepId?: unknown; image?: Record<string, unknown> }
        if (!slug || typeof s.stepId !== 'string' || !s.image) return step
        const stepDerivedKey = `${PROCESSED_PREFIX}${slug}/step-${s.stepId}`
        const processedAt = imageStatus[stepDerivedKey]
        return processedAt !== undefined
          ? { ...(step as object), image: { ...s.image, processedAt } }
          : step
      })
    : item.steps

  const nextCover = coverImage && coverProcessedAt !== undefined
    ? { ...coverImage, processedAt: coverProcessedAt }
    : coverImage
  const { imageStatus: _stripped, ...rest } = item
  return { ...rest, coverImage: nextCover, steps } as Omit<T, 'imageStatus'>
}

function convertRecipeTags(recipe: Record<string, unknown>): Record<string, unknown> {
  return composeImageProcessedAt({ ...recipe, tags: tagsToArray(recipe.tags) })
}

function lightweightRecipe(recipe: Record<string, unknown>): Record<string, unknown> {
  const composed = composeImageProcessedAt(recipe)
  return {
    id: composed.id,
    title: composed.title,
    slug: composed.slug,
    coverImage: composed.coverImage,
    tags: tagsToArray(composed.tags),
    prepTime: composed.prepTime,
    cookTime: composed.cookTime,
    servings: composed.servings,
    createdAt: composed.createdAt,
  }
}

function lightweightAdminRecipe(recipe: Record<string, unknown>): Record<string, unknown> {
  const composed = composeImageProcessedAt(recipe)
  return {
    id: composed.id,
    title: composed.title,
    slug: composed.slug,
    coverImage: composed.coverImage,
    tags: tagsToArray(composed.tags),
    prepTime: composed.prepTime,
    cookTime: composed.cookTime,
    servings: composed.servings,
    createdAt: composed.createdAt,
    status: composed.status,
    updatedAt: composed.updatedAt,
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
      case 'GET /recipes/admin/{id}':
        return await handleGetAdminRecipeById(event)
      case 'GET /recipes/{slug}':
        return await handleGetBySlug(event)
      case 'GET /me/recipes':
        return await handleListUserRecipes(event)
      case 'POST /recipes/drafts':
        return await handleCreateDraft(event)
      case 'PATCH /recipes/{id}':
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
      ExpressionAttributeValues: { ':status': PUBLISHED },
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

function queryRecipesByStatus(status: RecipeStatus) {
  return docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
      ScanIndexForward: false,
    }),
  )
}

async function handleListPublished(): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await queryRecipesByStatus(PUBLISHED)

  const recipes = (result.Items ?? []).map((item) => lightweightRecipe(item as Record<string, unknown>))
  return json(200, recipes)
}

async function handleListForAdmin(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  if (!decodeJwt(event)) return json(401, { error: 'Unauthorised' })
  if (!isAdmin(event)) return json(403, { error: 'Forbidden' })

  const [publishedResult, draftResult] = await Promise.all([queryRecipesByStatus(PUBLISHED), queryRecipesByStatus(DRAFT)])

  const nowSeconds = Math.floor(Date.now() / 1000)
  const merged = [...(publishedResult.Items ?? []), ...(draftResult.Items ?? [])] as Record<string, unknown>[]
  const live = merged.filter((item) => typeof item.ttl !== 'number' || item.ttl > nowSeconds)

  return json(200, live.map(lightweightAdminRecipe))
}

async function handleGetAdminRecipeById(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  if (!decodeJwt(event)) return json(401, { error: 'Unauthorised' })
  if (!isAdmin(event)) return json(403, { error: 'Forbidden' })

  const id = event.pathParameters?.id
  if (!id) return json(400, { error: 'id is required' })

  const item = await getRecipeById(id)
  if (!item) return json(404, { error: 'Recipe not found' })

  return json(200, convertRecipeTags(item))
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
  if (recipe.status !== PUBLISHED) {
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

async function handleCreateDraft(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })
  if (!isAdmin(event)) return json(403, { error: 'Forbidden' })

  const input = JSON.parse(event.body ?? '{}') as { slug?: unknown }
  const id = randomUUID()
  const requestedSlug = typeof input.slug === 'string' ? input.slug : undefined

  let slug: string
  if (requestedSlug !== undefined) {
    if (!isValidSlug(requestedSlug)) return json(400, { error: 'invalid_slug' })
    if (await slugExists(requestedSlug)) {
      return json(409, { error: 'slug_taken', message: `Slug "${requestedSlug}" is already in use.` })
    }
    slug = requestedSlug
  } else {
    slug = `draft-${id.slice(0, 8)}`
  }

  const ttl = Math.floor(Date.now() / 1000) + DRAFT_TTL_SECONDS
  const now = new Date().toISOString()

  const item: Record<string, unknown> = {
    id,
    slug,
    status: DRAFT,
    ttl,
    title: '',
    intro: '',
    ingredients: [],
    steps: [],
    imageStatus: {},
    authorId: payload.sub,
    authorName: payload.name ?? payload.email ?? '',
    createdAt: now,
    updatedAt: now,
  }

  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }))

  return json(201, { id, slug })
}

function variantKeysFor(key: string): readonly string[] {
  return VARIANT_SUFFIXES.map((suffix) => `${key}-${suffix}.webp`)
}

function droppedImageBaseKeys(oldItem: Record<string, unknown>, updates: Record<string, unknown>): string[] {
  const slug = typeof oldItem.slug === 'string' ? oldItem.slug : undefined
  if (!slug) return []
  const droppedKeys: string[] = []

  if ('coverImage' in updates) {
    const newCover = updates.coverImage
    const coverRemoved = newCover === null || newCover === undefined
    if (coverRemoved) {
      droppedKeys.push(`${PROCESSED_PREFIX}${slug}/cover`)
    }
  }

  if ('steps' in updates && Array.isArray(updates.steps)) {
    const newStepIds = new Set(
      (updates.steps as Array<{ stepId?: unknown }>).flatMap((s) =>
        typeof s.stepId === 'string' ? [s.stepId] : [],
      ),
    )
    const oldSteps = (Array.isArray(oldItem.steps) ? oldItem.steps : []) as Array<{ stepId?: unknown }>
    for (const oldStep of oldSteps) {
      const oldStepId = typeof oldStep.stepId === 'string' ? oldStep.stepId : undefined
      if (!oldStepId || newStepIds.has(oldStepId)) continue
      droppedKeys.push(`${PROCESSED_PREFIX}${slug}/step-${oldStepId}`)
    }
  }

  return droppedKeys
}

function stripProcessedAtFromBody(updates: Record<string, unknown>): void {
  const coverImage = updates.coverImage
  if (coverImage && typeof coverImage === 'object' && !Array.isArray(coverImage)) {
    delete (coverImage as Record<string, unknown>).processedAt
  }

  const steps = updates.steps
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue
      const image = (step as { image?: unknown }).image
      if (image && typeof image === 'object' && !Array.isArray(image)) {
        delete (image as Record<string, unknown>).processedAt
      }
    }
  }
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
  delete updates.id
  delete updates.authorId
  delete updates.createdAt
  delete updates.status
  delete updates.ttl
  stripProcessedAtFromBody(updates)

  if ('steps' in updates && Array.isArray(updates.steps)) {
    const seenStepIds = new Set<string>()
    for (const step of updates.steps as Array<Record<string, unknown>>) {
      const stepId = step.stepId
      if (typeof stepId !== 'string' || !STEP_ID_REGEX.test(stepId)) {
        return json(400, { error: 'invalid_stepId' })
      }
      if (seenStepIds.has(stepId)) {
        return json(400, { error: 'duplicate_stepId' })
      }
      seenStepIds.add(stepId)
    }
  }

  const requestedSlug = typeof updates.slug === 'string' ? updates.slug : undefined
  const slugChanging = requestedSlug !== undefined && requestedSlug !== existing.slug

  if (slugChanging) {
    if (!isValidSlug(requestedSlug)) return json(400, { error: 'invalid_slug' })

    if (Object.keys(imageStatusOf(existing)).length > 0) {
      return json(409, SLUG_LOCKED_RESPONSE)
    }

    if (await slugExists(requestedSlug, id)) {
      return json(409, { error: 'slug_taken', message: `Slug "${requestedSlug}" is already in use.` })
    }
  } else {
    delete updates.slug
  }

  const now = new Date().toISOString()
  const setParts: string[] = []
  const expressionNames: Record<string, string> = {}
  const expressionValues: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(updates)) {
    const attrName = `#${key}`
    const attrValue = `:${key}`
    setParts.push(`${attrName} = ${attrValue}`)
    expressionNames[attrName] = key
    expressionValues[attrValue] = value
  }

  setParts.push('#updatedAt = :updatedAt')
  expressionNames['#updatedAt'] = 'updatedAt'
  expressionValues[':updatedAt'] = now

  const isDraft = existing.status === DRAFT
  const refreshedTtl = Math.floor(Date.now() / 1000) + DRAFT_TTL_SECONDS
  if (isDraft) {
    setParts.push('#ttl = :ttl')
    expressionNames['#ttl'] = 'ttl'
    expressionValues[':ttl'] = refreshedTtl
  }

  const droppedKeys = droppedImageBaseKeys(existing, updates)
  const removeParts: string[] = []
  droppedKeys.forEach((droppedKey, index) => {
    const placeholder = `#droppedImageKey${index}`
    removeParts.push(`imageStatus.${placeholder}`)
    expressionNames[placeholder] = droppedKey
  })

  const updateExpression = removeParts.length > 0
    ? `SET ${setParts.join(', ')} REMOVE ${removeParts.join(', ')}`
    : `SET ${setParts.join(', ')}`

  const conditionExpression = slugChanging
    ? 'attribute_exists(id) AND (attribute_not_exists(imageStatus) OR size(imageStatus) = :zero) AND slug = :expectedOldSlug'
    : undefined

  if (slugChanging) {
    expressionValues[':zero'] = 0
    expressionValues[':expectedOldSlug'] = existing.slug
  }

  let updateResult
  try {
    updateResult = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ConditionExpression: conditionExpression,
        ReturnValues: 'ALL_OLD',
      }),
    )
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || (err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const reRead = await getRecipeById(id)
      if (reRead && Object.keys(imageStatusOf(reRead)).length > 0) {
        return json(409, SLUG_LOCKED_RESPONSE)
      }
      return json(409, { error: 'conflict', message: 'Recipe was modified by another request. Please retry.' })
    }
    throw err
  }

  const atomicOld = updateResult.Attributes as Record<string, unknown>

  const keysToDelete = droppedImageBaseKeys(atomicOld, updates).flatMap(variantKeysFor)
  if (keysToDelete.length > 0) {
    const deleteResult = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: IMAGE_BUCKET_NAME,
        Delete: { Objects: keysToDelete.map((Key) => ({ Key })) },
      }),
    )
    if (deleteResult.Errors && deleteResult.Errors.length > 0) {
      console.error('Partial S3 delete failure during recipe image swap', deleteResult.Errors)
    }
  }

  const newItem: Record<string, unknown> = {
    ...atomicOld,
    ...updates,
    updatedAt: now,
    ...(isDraft ? { ttl: refreshedTtl } : {}),
  }

  return json(200, convertRecipeTags(newItem))
}

interface PublishErrors {
  title?: string
  intro?: string
  coverImage?: { key?: string; alt?: string; processedAt?: string }
  ingredients?: string
  steps?: string
  stepImages?: Array<{ order: number; processedAt: string }>
}

function validatePublishInput(item: Record<string, unknown>): PublishErrors {
  const errors: PublishErrors = {}

  const title = item.title
  if (typeof title !== 'string' || title.trim().length === 0) {
    errors.title = 'title is required'
  }

  const intro = item.intro
  if (typeof intro !== 'string' || intro.trim().length === 0) {
    errors.intro = 'intro is required'
  }

  const coverImage = item.coverImage as { key?: unknown; alt?: unknown } | undefined
  const coverErrors: { key?: string; alt?: string; processedAt?: string } = {}
  const coverKey = coverImage?.key
  if (typeof coverKey !== 'string' || coverKey.trim().length === 0) {
    coverErrors.key = 'coverImage.key is required'
  }
  const coverAlt = coverImage?.alt
  if (typeof coverAlt !== 'string' || coverAlt.trim().length === 0) {
    coverErrors.alt = 'coverImage.alt is required'
  }

  const imageStatus = imageStatusOf(item)

  if (!coverErrors.key && imageStatus[coverKey as string] === undefined) {
    coverErrors.processedAt = 'Cover image still processing'
  }

  if (coverErrors.key || coverErrors.alt || coverErrors.processedAt) {
    errors.coverImage = coverErrors
  }

  const ingredients = item.ingredients
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    errors.ingredients = 'At least one ingredient is required'
  }

  const steps = item.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.steps = 'At least one step is required'
  } else {
    const hasEmptyStep = steps.some((step) => {
      const text = (step as { text?: unknown }).text
      return typeof text !== 'string' || text.trim().length === 0
    })
    if (hasEmptyStep) {
      errors.steps = 'Every step must have non-empty text'
    }

    const stepImageErrors: Array<{ order: number; processedAt: string }> = []
    for (const step of steps) {
      const typedStep = step as { order?: unknown; image?: { key?: unknown } }
      const imageKey = typedStep.image?.key
      if (typeof imageKey !== 'string' || imageKey.trim().length === 0) continue
      if (imageStatus[imageKey] !== undefined) continue
      const order = typeof typedStep.order === 'number' ? typedStep.order : 0
      stepImageErrors.push({ order, processedAt: 'Step image still processing' })
    }
    if (stepImageErrors.length > 0) {
      errors.stepImages = stepImageErrors
    }
  }

  return errors
}

async function handlePublish(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })
  if (!isAdmin(event)) return json(403, { error: 'Forbidden' })

  const id = event.pathParameters?.id
  if (!id) return json(400, { error: 'id is required' })

  const existing = await getRecipeById(id)
  if (!existing) return json(404, { error: 'Recipe not found' })

  const errors = validatePublishInput(existing)
  if (Object.keys(errors).length > 0) return json(400, { errors })

  if (existing.status === PUBLISHED) {
    return json(200, convertRecipeTags(existing))
  }

  const now = new Date().toISOString()
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt REMOVE #ttl',
      ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':status': PUBLISHED, ':updatedAt': now },
      ReturnValues: 'ALL_NEW',
    }),
  )

  return json(200, convertRecipeTags(result.Attributes as Record<string, unknown>))
}

async function handleUnpublish(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeJwt(event)
  if (!payload) return json(401, { error: 'Unauthorised' })
  if (!isAdmin(event)) return json(403, { error: 'Forbidden' })

  const id = event.pathParameters?.id
  if (!id) return json(400, { error: 'id is required' })

  const existing = await getRecipeById(id)
  if (!existing) return json(404, { error: 'Recipe not found' })

  if (existing.status === DRAFT) {
    return json(200, convertRecipeTags(existing))
  }

  const now = new Date().toISOString()
  const ttl = Math.floor(Date.now() / 1000) + DRAFT_TTL_SECONDS
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt, #ttl = :ttl',
      ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':status': DRAFT, ':updatedAt': now, ':ttl': ttl },
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

  const slug = typeof existing.slug === 'string' ? existing.slug : undefined
  if (slug) {
    const listResult = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: IMAGE_BUCKET_NAME,
        Prefix: `${PROCESSED_PREFIX}${slug}/`,
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

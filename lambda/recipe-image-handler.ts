import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { UPLOAD_PREFIX } from './image-variants'

const s3 = new S3Client({})
const ddbClient = new DynamoDBClient({})
const docClient = DynamoDBDocumentClient.from(ddbClient)
const IMAGE_BUCKET_NAME = process.env.IMAGE_BUCKET_NAME ?? ''
const TABLE_NAME = process.env.TABLE_NAME ?? ''

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(statusCode: number, body: Record<string, unknown>): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function decodeToken(event: APIGatewayProxyEventV2): Record<string, unknown> | undefined {
  const authHeader = event.headers.authorization
  if (!authHeader) return undefined

  const token = authHeader.replace(/^bearer\s+/i, '')
  if (!token) return undefined

  try {
    const parts = token.split('.')
    if (parts.length < 2) return undefined
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

interface UploadUrlBody {
  readonly recipeId?: string
  readonly imageType?: string
  readonly stepId?: string
}

interface RecipeStep {
  readonly stepId?: string
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    switch (event.routeKey) {
      case 'POST /recipes/images/upload-url':
        return await handleUploadUrl(event)
      default:
        return json(404, { error: 'Not found' })
    }
  } catch {
    return json(500, { error: 'Internal server error' })
  }
}

async function handleUploadUrl(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const payload = decodeToken(event)
  if (!payload) return json(401, { error: 'Unauthorised' })

  const { recipeId, imageType, stepId } = JSON.parse(event.body ?? '{}') as UploadUrlBody
  if (!recipeId || !imageType) return json(400, { error: 'recipeId and imageType are required' })

  // Step uploads must validate stepId BEFORE issuing the GetItem — saves a DDB read on a clearly-bad request.
  if (imageType !== 'cover') {
    if (!stepId) return json(400, { error: 'stepId is required for step images' })
    if (!UUID_REGEX.test(stepId)) return json(400, { error: 'invalid_stepId' })
  }

  const recipe = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { id: recipeId } }))
  if (!recipe.Item) return json(404, { error: 'Recipe not found' })

  const slug = recipe.Item.slug as string

  let uploadKey: string
  if (imageType === 'cover') {
    uploadKey = `${UPLOAD_PREFIX}${slug}/cover`
  } else {
    const steps = (recipe.Item.steps as RecipeStep[] | undefined) ?? []
    if (!steps.some((s) => s.stepId === stepId)) return json(404, { error: 'step_not_found' })
    uploadKey = `${UPLOAD_PREFIX}${slug}/step-${stepId}`
  }

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: IMAGE_BUCKET_NAME, Key: uploadKey }),
    { expiresIn: 900 },
  )

  return json(200, { uploadUrl })
}

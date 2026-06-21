import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { UPLOAD_PREFIX } from './image-variants'
import { getRecipeById, isValidStepId } from './recipe-store'

const s3 = new S3Client({})
const IMAGE_BUCKET_NAME = process.env.IMAGE_BUCKET_NAME ?? ''

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
    if (!isValidStepId(stepId)) return json(400, { error: 'invalid_stepId' })
  }

  const recipe = await getRecipeById(recipeId)
  if (!recipe) return json(404, { error: 'Recipe not found' })

  const slug = recipe.slug

  let uploadKey: string
  if (imageType === 'cover') {
    uploadKey = `${UPLOAD_PREFIX}${slug}/cover`
  } else {
    const steps = recipe.steps ?? []
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

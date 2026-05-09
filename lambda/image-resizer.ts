import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { S3Event } from 'aws-lambda'
import sharp from 'sharp'
import { VARIANT_SUFFIXES, toProcessedKey, UPLOAD_PREFIX, type VariantSuffix } from './image-variants'

const s3 = new S3Client({})
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

interface ImageVariant {
  readonly suffix: VariantSuffix
  readonly width: number
  readonly quality: number
}

const VARIANT_SIZING: Record<VariantSuffix, { readonly width: number; readonly quality: number }> = {
  thumb: { width: 400, quality: 80 },
  medium: { width: 800, quality: 85 },
  full: { width: 1200, quality: 90 },
}

const VARIANTS: readonly ImageVariant[] = VARIANT_SUFFIXES.map((suffix) => ({
  suffix,
  ...VARIANT_SIZING[suffix],
}))

type SkipReason = 'unrecognised_key_shape' | 'recipe_not_found' | 'recipe_deleted'

// Accepts exactly `uploads/recipes/<slug>/<type>` — extra trailing segments are rejected.
export function parseRecipeSlug(uploadKey: string): string | undefined {
  if (!uploadKey.startsWith(UPLOAD_PREFIX)) return undefined
  const segments = uploadKey.slice(UPLOAD_PREFIX.length).split('/')
  if (segments.length !== 2) return undefined
  const slug = segments[0]
  if (!slug) return undefined
  return slug
}

export async function handler(event: S3Event): Promise<void> {
  const bucketName = process.env.IMAGE_BUCKET_NAME
  if (!bucketName) throw new Error('IMAGE_BUCKET_NAME not set')

  const tableName = process.env.TABLE_NAME
  if (!tableName) throw new Error('TABLE_NAME not set')

  for (const record of event.Records) {
    const key = record.s3.object.key
    const sourceBucket = record.s3.bucket.name

    const getResponse = await s3.send(
      new GetObjectCommand({ Bucket: sourceBucket, Key: key }),
    )

    const bodyBytes = await getResponse.Body!.transformToByteArray()
    const imageBuffer = Buffer.from(bodyBytes)

    const processedKey = toProcessedKey(key)

    await Promise.all(
      VARIANTS.map(async (variant) => {
        const variantBuffer = await sharp(imageBuffer)
          .resize(variant.width)
          .webp({ quality: variant.quality })
          .toBuffer()

        await s3.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: `${processedKey}-${variant.suffix}.webp`,
            ContentType: 'image/webp',
            Body: variantBuffer,
          }),
        )
      }),
    )

    const logSkip = (reason: SkipReason) =>
      console.info({ event: 'resizer.writeback.skipped', reason, key })

    await s3.send(
      new DeleteObjectCommand({ Bucket: sourceBucket, Key: key }),
    )

    const slug = parseRecipeSlug(key)
    if (slug === undefined) {
      logSkip('unrecognised_key_shape')
      continue
    }

    const lookup = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'slug-index',
        KeyConditionExpression: 'slug = :slug',
        ExpressionAttributeValues: { ':slug': slug },
      }),
    )
    const [item] = lookup.Items ?? []
    const recipeId = (item as { id?: string } | undefined)?.id
    if (!recipeId) {
      logSkip('recipe_not_found')
      continue
    }

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id: recipeId },
          UpdateExpression: 'SET imageStatus.#k = :ts',
          ConditionExpression: 'attribute_exists(id)',
          ExpressionAttributeNames: { '#k': processedKey },
          ExpressionAttributeValues: { ':ts': Date.now() },
        }),
      )
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        logSkip('recipe_deleted')
      } else {
        throw error
      }
    }
  }
}

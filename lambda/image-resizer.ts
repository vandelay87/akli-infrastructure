import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { S3Event } from 'aws-lambda'
import sharp from 'sharp'
import { VARIANT_SUFFIXES, toProcessedKey, UPLOAD_PREFIX, type VariantSuffix } from './image-variants'

const s3 = new S3Client({})
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

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

const RECIPES_SEGMENT = 'recipes'

function parseRecipeId(uploadKey: string): string | undefined {
  if (!uploadKey.startsWith(UPLOAD_PREFIX)) return undefined
  const segments = uploadKey.slice(UPLOAD_PREFIX.length).split('/')
  if (segments.length < 3) return undefined
  if (segments[0] !== RECIPES_SEGMENT) return undefined
  const id = segments[1]
  if (!id) return undefined
  return id
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

    const recipeId = parseRecipeId(key)
    if (recipeId === undefined) {
      console.info({ event: 'resizer.writeback.skipped', reason: 'unrecognised_key_shape', key })
    } else {
      try {
        await ddb.send(
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
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
          console.info({ event: 'resizer.writeback.skipped', reason: 'recipe_deleted', key })
        } else {
          throw error
        }
      }
    }

    await s3.send(
      new DeleteObjectCommand({ Bucket: sourceBucket, Key: key }),
    )
  }
}

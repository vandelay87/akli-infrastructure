import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { S3Event } from 'aws-lambda'
import sharp from 'sharp'
import { VARIANT_SUFFIXES, type VariantSuffix } from './image-variants'

const s3 = new S3Client({})

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

export async function handler(event: S3Event): Promise<void> {
  const bucketName = process.env.IMAGE_BUCKET_NAME
  if (!bucketName) throw new Error('IMAGE_BUCKET_NAME not set')

  for (const record of event.Records) {
    const key = record.s3.object.key
    const sourceBucket = record.s3.bucket.name

    const getResponse = await s3.send(
      new GetObjectCommand({ Bucket: sourceBucket, Key: key }),
    )

    const bodyBytes = await getResponse.Body!.transformToByteArray()
    const imageBuffer = Buffer.from(bodyBytes)

    const processedKey = key.replace('uploads/', 'processed/')

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

    await s3.send(
      new DeleteObjectCommand({ Bucket: sourceBucket, Key: key }),
    )
  }
}

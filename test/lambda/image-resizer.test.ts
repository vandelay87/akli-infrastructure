import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { S3Event } from 'aws-lambda'
import { mockClient } from 'aws-sdk-client-mock'

const s3Mock = mockClient(S3Client)

const mockSharp = {
  resize: jest.fn().mockReturnThis(),
  webp: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('mock-image')),
}
jest.mock('sharp', () => jest.fn(() => mockSharp))

process.env.IMAGE_BUCKET_NAME = 'test-image-bucket'

import { handler } from '../../lambda/image-resizer'

function makeS3Event(key: string, bucket = 'test-image-bucket'): S3Event {
  return {
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'eu-west-2',
        eventTime: '2026-04-09T00:00:00.000Z',
        eventName: 'ObjectCreated:Put',
        userIdentity: { principalId: 'test' },
        requestParameters: { sourceIPAddress: '127.0.0.1' },
        responseElements: {
          'x-amz-request-id': 'test',
          'x-amz-id-2': 'test',
        },
        s3: {
          s3SchemaVersion: '1.0',
          configurationId: 'test',
          bucket: {
            name: bucket,
            ownerIdentity: { principalId: 'test' },
            arn: `arn:aws:s3:::${bucket}`,
          },
          object: {
            key,
            size: 1024,
            eTag: 'test-etag',
            sequencer: '001',
          },
        },
      },
    ],
  }
}

describe('image-resizer handler', () => {
  beforeEach(() => {
    s3Mock.reset()
    jest.clearAllMocks()

    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToByteArray: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      } as never,
    })
    s3Mock.on(PutObjectCommand).resolves({})
    s3Mock.on(DeleteObjectCommand).resolves({})
  })

  it('generates three WebP variants with correct dimensions and quality', async () => {
    await handler(makeS3Event('uploads/recipes/abc/cover'))

    // sharp should be called with the downloaded image buffer
    const sharp = jest.requireMock('sharp') as jest.Mock
    expect(sharp).toHaveBeenCalledTimes(3)

    // Verify resize dimensions: 400 (thumb), 800 (medium), 1200 (full)
    expect(mockSharp.resize).toHaveBeenCalledWith(400)
    expect(mockSharp.resize).toHaveBeenCalledWith(800)
    expect(mockSharp.resize).toHaveBeenCalledWith(1200)

    // Verify WebP quality: 80 (thumb), 85 (medium), 90 (full)
    expect(mockSharp.webp).toHaveBeenCalledWith({ quality: 80 })
    expect(mockSharp.webp).toHaveBeenCalledWith({ quality: 85 })
    expect(mockSharp.webp).toHaveBeenCalledWith({ quality: 90 })
  })

  it('uploads variants to processed/ prefix with correct keys', async () => {
    await handler(makeS3Event('uploads/recipes/abc/cover'))

    const putCalls = s3Mock.commandCalls(PutObjectCommand)
    expect(putCalls).toHaveLength(3)

    const putKeys = putCalls.map((call) => call.args[0].input.Key).sort()
    expect(putKeys).toEqual([
      'processed/recipes/abc/cover-full.webp',
      'processed/recipes/abc/cover-medium.webp',
      'processed/recipes/abc/cover-thumb.webp',
    ])

    // All uploads go to the correct bucket
    for (const call of putCalls) {
      expect(call.args[0].input.Bucket).toBe('test-image-bucket')
    }
  })

  it('deletes the original after successful resize', async () => {
    await handler(makeS3Event('uploads/recipes/abc/cover'))

    const deleteCalls = s3Mock.commandCalls(DeleteObjectCommand)
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].args[0].input).toEqual({
      Bucket: 'test-image-bucket',
      Key: 'uploads/recipes/abc/cover',
    })
  })

  it('sets WebP content type on uploaded variants', async () => {
    await handler(makeS3Event('uploads/recipes/abc/cover'))

    const putCalls = s3Mock.commandCalls(PutObjectCommand)
    expect(putCalls).toHaveLength(3)

    for (const call of putCalls) {
      expect(call.args[0].input.ContentType).toBe('image/webp')
    }
  })
})

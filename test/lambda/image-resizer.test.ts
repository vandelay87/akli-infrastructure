import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { S3Event } from 'aws-lambda'
import { mockClient } from 'aws-sdk-client-mock'

const s3Mock = mockClient(S3Client)
const ddbMock = mockClient(DynamoDBDocumentClient)

const mockSharp = {
  resize: jest.fn().mockReturnThis(),
  webp: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('mock-image')),
}
jest.mock('sharp', () => jest.fn(() => mockSharp))

process.env.IMAGE_BUCKET_NAME = 'test-image-bucket'
process.env.TABLE_NAME = 'test-recipes-table'

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
    ddbMock.reset()
    jest.clearAllMocks()

    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToByteArray: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      } as never,
    })
    s3Mock.on(PutObjectCommand).resolves({})
    s3Mock.on(DeleteObjectCommand).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
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

  it('throws a clear error when TABLE_NAME env var is unset', async () => {
    const saved = process.env.TABLE_NAME
    delete process.env.TABLE_NAME
    try {
      await expect(handler(makeS3Event('uploads/recipes/abc/cover'))).rejects.toThrow(/TABLE_NAME/)
    } finally {
      process.env.TABLE_NAME = saved
    }
  })

  it('writes back imageStatus to DynamoDB after variant PUTs for a cover image', async () => {
    const before = Date.now()
    await handler(makeS3Event('uploads/recipes/abc/cover'))
    const after = Date.now()

    const updateCalls = ddbMock.commandCalls(UpdateCommand)
    expect(updateCalls).toHaveLength(1)

    const input = updateCalls[0].args[0].input
    expect(input.TableName).toBe('test-recipes-table')
    expect(input.Key).toEqual({ id: 'abc' })
    expect(input.UpdateExpression).toBe('SET imageStatus.#k = :ts')
    expect(input.ConditionExpression).toBe('attribute_exists(id)')
    expect(input.ExpressionAttributeNames).toEqual({ '#k': 'processed/recipes/abc/cover' })

    const ts = input.ExpressionAttributeValues?.[':ts']
    expect(typeof ts).toBe('number')
    expect(Number.isFinite(ts)).toBe(true)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('writes back imageStatus to DynamoDB for a step image key', async () => {
    await handler(makeS3Event('uploads/recipes/abc/step-2'))

    const updateCalls = ddbMock.commandCalls(UpdateCommand)
    expect(updateCalls).toHaveLength(1)

    const input = updateCalls[0].args[0].input
    expect(input.Key).toEqual({ id: 'abc' })
    expect(input.ExpressionAttributeNames).toEqual({ '#k': 'processed/recipes/abc/step-2' })
  })

  it('swallows ConditionalCheckFailedException, still deletes source, and logs skip event', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})

    const condFailed = new ConditionalCheckFailedException({
      $metadata: {},
      message: 'The conditional request failed',
    })
    ddbMock.on(UpdateCommand).rejects(condFailed)

    await expect(handler(makeS3Event('uploads/recipes/abc/cover'))).resolves.toBeUndefined()

    // Source-delete still runs.
    const deleteCalls = s3Mock.commandCalls(DeleteObjectCommand)
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].args[0].input).toEqual({
      Bucket: 'test-image-bucket',
      Key: 'uploads/recipes/abc/cover',
    })

    // Structured info log is emitted.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'resizer.writeback.skipped',
        reason: 'recipe_deleted',
      }),
    )

    infoSpy.mockRestore()
  })

  it('rethrows non-conditional DDB errors', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('boom'))

    await expect(handler(makeS3Event('uploads/recipes/abc/cover'))).rejects.toThrow('boom')
  })

  it('skips the DDB write for a malformed key that does not match uploads/recipes/<id>/...', async () => {
    // This key passes the toProcessedKey prefix guard but isn't the recipes shape.
    await handler(makeS3Event('uploads/not-recipes/x'))

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0)

    // Variant writes and source-delete still happen.
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(3)
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1)
  })

  it('invokes DDB UpdateCommand before the source DeleteObjectCommand', async () => {
    // Sequencing is enforced via the handler's error-propagation contract: if the
    // UpdateCommand is issued BEFORE the source DeleteObjectCommand, rejecting the
    // UpdateCommand with a generic error must prevent the source-delete from firing.
    // If the delete were issued first, it would run regardless of the DDB outcome.
    ddbMock.on(UpdateCommand).rejects(new Error('sequencing-probe'))

    await expect(handler(makeS3Event('uploads/recipes/abc/cover'))).rejects.toThrow(
      'sequencing-probe',
    )

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1)
    // Source-delete never fires because the update threw first.
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0)
  })
})

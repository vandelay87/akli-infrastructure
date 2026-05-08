import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
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

import * as imageResizer from '../../lambda/image-resizer'

const { handler } = imageResizer

const RESOLVED_ID = 'recipe-id-resolved-by-gsi'

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

describe('parseRecipeSlug', () => {
  type ParseRecipeSlug = (key: string) => string | undefined

  function getParseRecipeSlug(): ParseRecipeSlug {
    const exported = (imageResizer as unknown as Record<string, unknown>).parseRecipeSlug
    if (typeof exported !== 'function') {
      throw new Error('parseRecipeSlug is not exported from image-resizer.ts')
    }
    return exported as ParseRecipeSlug
  }

  it('returns the slug segment for a well-formed cover upload key', () => {
    const parseRecipeSlug = getParseRecipeSlug()
    expect(parseRecipeSlug('uploads/recipes/beans-on-toast/cover')).toBe('beans-on-toast')
  })

  it('returns undefined for a key that does not start with the upload prefix', () => {
    const parseRecipeSlug = getParseRecipeSlug()
    expect(parseRecipeSlug('uploads/something-else/beans-on-toast/cover')).toBeUndefined()
  })

  it('is the only key-parser exported from image-resizer.ts (no parseRecipeId)', () => {
    expect(
      (imageResizer as unknown as Record<string, unknown>).parseRecipeId,
    ).toBeUndefined()
    expect(
      typeof (imageResizer as unknown as Record<string, unknown>).parseRecipeSlug,
    ).toBe('function')
  })
})

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
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: RESOLVED_ID }] })
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

  it('uploads variants to recipes/ prefix with correct keys', async () => {
    await handler(makeS3Event('uploads/recipes/abc/cover'))

    const putCalls = s3Mock.commandCalls(PutObjectCommand)
    expect(putCalls).toHaveLength(3)

    const putKeys = putCalls.map((call) => call.args[0].input.Key).sort()
    expect(putKeys).toEqual([
      'recipes/abc/cover-full.webp',
      'recipes/abc/cover-medium.webp',
      'recipes/abc/cover-thumb.webp',
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

  it('queries the slug-index GSI to resolve the parsed slug to a recipe id', async () => {
    await handler(makeS3Event('uploads/recipes/beans-on-toast/cover'))

    const queryCalls = ddbMock.commandCalls(QueryCommand)
    expect(queryCalls).toHaveLength(1)

    const input = queryCalls[0].args[0].input
    expect(input.TableName).toBe('test-recipes-table')
    expect(input.IndexName).toBe('slug-index')
    expect(input.KeyConditionExpression).toBe('slug = :slug')
    expect(input.ExpressionAttributeValues).toEqual({ ':slug': 'beans-on-toast' })
  })

  it('writes back imageStatus to DynamoDB after variant PUTs for a cover image, keyed by the GSI-resolved id', async () => {
    const before = Date.now()
    await handler(makeS3Event('uploads/recipes/abc/cover'))
    const after = Date.now()

    const updateCalls = ddbMock.commandCalls(UpdateCommand)
    expect(updateCalls).toHaveLength(1)

    const input = updateCalls[0].args[0].input
    expect(input.TableName).toBe('test-recipes-table')
    // The path segment 'abc' is the slug; the id used in the Key comes from the GSI lookup.
    expect(input.Key).toEqual({ id: RESOLVED_ID })
    expect(input.UpdateExpression).toBe('SET imageStatus.#k = :ts')
    expect(input.ConditionExpression).toBe('attribute_exists(id)')
    expect(input.ExpressionAttributeNames).toEqual({ '#k': 'recipes/abc/cover' })

    const ts = input.ExpressionAttributeValues?.[':ts']
    expect(typeof ts).toBe('number')
    expect(Number.isFinite(ts)).toBe(true)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('writes back imageStatus to DynamoDB for a step image key, keyed by the GSI-resolved id', async () => {
    await handler(makeS3Event('uploads/recipes/abc/step-9d904a59-e83f-43b8-9f40-fbdb3008974c'))

    const updateCalls = ddbMock.commandCalls(UpdateCommand)
    expect(updateCalls).toHaveLength(1)

    const input = updateCalls[0].args[0].input
    expect(input.Key).toEqual({ id: RESOLVED_ID })
    expect(input.ExpressionAttributeNames).toEqual({
      '#k': 'recipes/abc/step-9d904a59-e83f-43b8-9f40-fbdb3008974c',
    })
  })

  it('logs recipe_not_found and skips the DDB write when the GSI returns no items; variant PUTs and source delete still ran', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
    ddbMock.on(QueryCommand).resolves({ Items: [] })

    await expect(handler(makeS3Event('uploads/recipes/missing-slug/cover'))).resolves.toBeUndefined()

    // Variant PUTs still ran.
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(3)

    // Source delete still ran.
    const deleteCalls = s3Mock.commandCalls(DeleteObjectCommand)
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].args[0].input).toEqual({
      Bucket: 'test-image-bucket',
      Key: 'uploads/recipes/missing-slug/cover',
    })

    // No UpdateCommand was issued.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0)

    // Structured info log emitted with the expected reason and key.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'resizer.writeback.skipped',
        reason: 'recipe_not_found',
        key: 'uploads/recipes/missing-slug/cover',
      }),
    )

    infoSpy.mockRestore()
  })

  it('swallows ConditionalCheckFailedException (recipe_deleted skip), with the source-delete already having fired before the UpdateCommand', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})

    const condFailed = new ConditionalCheckFailedException({
      $metadata: {},
      message: 'The conditional request failed',
    })
    ddbMock.on(UpdateCommand).rejects(condFailed)

    await expect(handler(makeS3Event('uploads/recipes/abc/cover'))).resolves.toBeUndefined()

    // Source-delete fired (earlier in the flow, before the UpdateCommand threw).
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

  it('throws and writes nothing for a malformed key that does not match uploads/recipes/<slug>/...', async () => {
    // With UPLOAD_PREFIX = 'uploads/recipes/', this key fails the prefix guard
    // inside toProcessedKey and the handler now refuses to process it.
    await expect(handler(makeS3Event('uploads/not-recipes/x'))).rejects.toThrow(/uploads\/recipes\//)

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0)
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0)
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0)
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0)
  })

  it('invokes the source DeleteObjectCommand BEFORE the UpdateCommand (variants -> delete source -> query GSI -> update DDB)', async () => {
    // Sequencing-probe trick (mirrors the previous "Update before Delete" assertion, inverted):
    // if the UpdateCommand is issued AFTER the source DeleteObjectCommand, rejecting the
    // UpdateCommand with a generic error must NOT prevent the source-delete from having fired.
    ddbMock.on(UpdateCommand).rejects(new Error('sequencing-probe'))

    await expect(handler(makeS3Event('uploads/recipes/abc/cover'))).rejects.toThrow(
      'sequencing-probe',
    )

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1)
    // Source-delete fired earlier in the flow, before the UpdateCommand threw.
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1)
  })

  it('orders the resizer flow as: write variants -> delete source -> query GSI -> update DDB', async () => {
    // Track call order across both mocks via a shared sequence counter using jest.spyOn
    // on the underlying send methods. aws-sdk-client-mock exposes per-mock call lists but
    // not a cross-mock chronological one, so we tag calls as they happen.
    const sequence: string[] = []

    s3Mock.on(PutObjectCommand).callsFake(async () => {
      sequence.push('s3:put')
      return {}
    })
    s3Mock.on(DeleteObjectCommand).callsFake(async () => {
      sequence.push('s3:delete')
      return {}
    })
    ddbMock.on(QueryCommand).callsFake(async () => {
      sequence.push('ddb:query')
      return { Items: [{ id: RESOLVED_ID }] }
    })
    ddbMock.on(UpdateCommand).callsFake(async () => {
      sequence.push('ddb:update')
      return {}
    })

    await handler(makeS3Event('uploads/recipes/abc/cover'))

    // Three variant PUTs first (in any order amongst themselves — they fire concurrently),
    // then the source delete, then the GSI query, then the update.
    expect(sequence.filter((step) => step === 's3:put')).toHaveLength(3)
    const tail = sequence.filter((step) => step !== 's3:put')
    expect(tail).toEqual(['s3:delete', 'ddb:query', 'ddb:update'])

    // And every PUT preceded the source delete.
    const lastPutIndex = sequence.lastIndexOf('s3:put')
    const deleteIndex = sequence.indexOf('s3:delete')
    expect(lastPutIndex).toBeLessThan(deleteIndex)
  })
})

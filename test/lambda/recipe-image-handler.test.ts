import { S3Client } from '@aws-sdk/client-s3'
import type { PutObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { mockClient } from 'aws-sdk-client-mock'

// jest.mock() is hoisted above imports, so the handler imports the mocked module.
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://mock-presigned-url.s3.amazonaws.com/test'),
}))

const s3Mock = mockClient(S3Client)
const ddbMock = mockClient(DynamoDBDocumentClient)

process.env.IMAGE_BUCKET_NAME = 'test-recipe-images-bucket'
process.env.TABLE_NAME = 'test-recipes-table'

import { handler } from '../../lambda/recipe-image-handler'

// Build a fake JWT with the given payload (header.payload.signature)
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = 'fake-signature'
  return `${header}.${body}.${signature}`
}

const contributorToken = fakeJwt({ 'cognito:groups': ['contributor'], sub: 'contributor-user-id', email: 'contributor@example.com', name: 'Test Contributor' })

const RECIPE_ID = 'recipe-uuid-1'
const RECIPE_SLUG = 'beans-on-toast'
const STEP_ID_A = '9d904a59-e83f-43b8-9f40-fbdb3008974c'
const STEP_ID_B = 'b51ad2e3-2c3e-4b6e-9d3a-1f8e8b2a7c11'
const STEP_ID_NOT_IN_RECIPE = 'cccccccc-cccc-4ccc-bccc-cccccccccccc'

function recipeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECIPE_ID,
    slug: RECIPE_SLUG,
    steps: [
      { stepId: STEP_ID_A, order: 1, text: 'Toast the bread.' },
      { stepId: STEP_ID_B, order: 2, text: 'Heat the beans.' },
    ],
    ...overrides,
  }
}

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /recipes/images/upload-url',
    rawPath: '/recipes/images/upload-url',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      domainName: 'test.execute-api.eu-west-2.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method: 'POST',
        path: '/recipes/images/upload-url',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'test-request-id',
      routeKey: 'POST /recipes/images/upload-url',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2
}

function lastPresignedKey(): string | undefined {
  const calls = (getSignedUrl as jest.Mock).mock.calls
  if (calls.length === 0) return undefined
  const command = calls[calls.length - 1][1] as PutObjectCommand
  return command.input.Key
}

describe('Recipe Image handler', () => {
  beforeEach(() => {
    s3Mock.reset()
    ddbMock.reset()
    ;(getSignedUrl as jest.Mock).mockClear()
    ;(getSignedUrl as jest.Mock).mockResolvedValue('https://mock-presigned-url.s3.amazonaws.com/test')
  })

  // ─── POST /recipes/images/upload-url — response shape ───────────────
  describe('POST /recipes/images/upload-url — response shape', () => {
    it('returns 200 with uploadUrl and no key field', async () => {
      ddbMock.on(GetCommand).resolves({ Item: recipeItem() })
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: RECIPE_ID, imageType: 'cover' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(typeof body.uploadUrl).toBe('string')
      expect(body).not.toHaveProperty('key')
    })
  })

  // ─── POST /recipes/images/upload-url — cover image ──────────────────
  describe('POST /recipes/images/upload-url — cover image', () => {
    it('builds the presigned key as uploads/recipes/<slug>/cover using the slug from the recipe item', async () => {
      ddbMock.on(GetCommand).resolves({ Item: recipeItem() })
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: RECIPE_ID, imageType: 'cover' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      expect(lastPresignedKey()).toBe(`uploads/recipes/${RECIPE_SLUG}/cover`)
    })

    it('ignores a stray stepId on a cover request (no 400) and still produces the cover key', async () => {
      ddbMock.on(GetCommand).resolves({ Item: recipeItem() })
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: RECIPE_ID, imageType: 'cover', stepId: STEP_ID_A }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      expect(lastPresignedKey()).toBe(`uploads/recipes/${RECIPE_SLUG}/cover`)
    })
  })

  // ─── POST /recipes/images/upload-url — step image ───────────────────
  describe('POST /recipes/images/upload-url — step image', () => {
    it('builds the presigned key as uploads/recipes/<slug>/step-<stepId> using the slug from the recipe item', async () => {
      ddbMock.on(GetCommand).resolves({ Item: recipeItem() })
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: RECIPE_ID, imageType: 'step', stepId: STEP_ID_A }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      expect(lastPresignedKey()).toBe(`uploads/recipes/${RECIPE_SLUG}/step-${STEP_ID_A}`)
    })

    it('returns 400 when a step upload arrives without a stepId', async () => {
      ddbMock.on(GetCommand).resolves({ Item: recipeItem() })
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: RECIPE_ID, imageType: 'step' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it.each([
      ['not-a-uuid'],
      ['abc'],
      ['12345'],
      ['00000000-0000-0000-0000-000000000000'], // valid format-ish but not v1-5 (version nibble 0)
    ])('returns 400 when stepId %s is not a valid UUID', async (badStepId) => {
      ddbMock.on(GetCommand).resolves({ Item: recipeItem() })
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: RECIPE_ID, imageType: 'step', stepId: badStepId }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it("returns 404 when stepId is a valid UUID but doesn't appear in the recipe's steps", async () => {
      ddbMock.on(GetCommand).resolves({ Item: recipeItem() })
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: RECIPE_ID, imageType: 'step', stepId: STEP_ID_NOT_IN_RECIPE }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  // ─── POST /recipes/images/upload-url — recipe not found ─────────────
  describe('POST /recipes/images/upload-url — recipe not found', () => {
    it('returns 404 for a cover upload when GetItem returns no Item', async () => {
      ddbMock.on(GetCommand).resolves({})
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: 'nonexistent-id', imageType: 'cover' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 404 for a step upload when GetItem returns no Item', async () => {
      ddbMock.on(GetCommand).resolves({})
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: 'nonexistent-id', imageType: 'step', stepId: STEP_ID_A }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  // ─── POST /recipes/images/upload-url — auth + validation ────────────
  describe('POST /recipes/images/upload-url — auth + validation', () => {
    it('returns 401 without bearer token', async () => {
      const event = makeEvent({
        headers: {},
        body: JSON.stringify({ recipeId: RECIPE_ID, imageType: 'cover' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 400 for missing recipeId', async () => {
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ imageType: 'cover' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 400 for missing imageType', async () => {
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: RECIPE_ID }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  // ─── Unknown route ──────────────────────────────────────────────────
  describe('Unknown route', () => {
    it('returns 404 for unmatched route', async () => {
      const event = makeEvent({
        routeKey: 'GET /unknown',
        rawPath: '/unknown',
        requestContext: {
          accountId: '123456789012',
          apiId: 'test-api',
          domainName: 'test.execute-api.eu-west-2.amazonaws.com',
          domainPrefix: 'test',
          http: {
            method: 'GET',
            path: '/unknown',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
          requestId: 'test-request-id',
          routeKey: 'GET /unknown',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })
})

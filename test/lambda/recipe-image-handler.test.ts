import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'

// Mock getSignedUrl before importing the handler
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://mock-presigned-url.s3.amazonaws.com/test'),
}))

const s3Mock = mockClient(S3Client)

// Set environment variables before importing handler
process.env.IMAGE_BUCKET_NAME = 'test-recipe-images-bucket'

// Import handler after mock setup
import { handler } from '../../lambda/recipe-image-handler'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Build a fake JWT with the given payload (header.payload.signature)
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = 'fake-signature'
  return `${header}.${body}.${signature}`
}

const contributorToken = fakeJwt({ 'cognito:groups': ['contributor'], sub: 'contributor-user-id', email: 'contributor@example.com', name: 'Test Contributor' })

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

describe('Recipe Image handler', () => {
  beforeEach(() => {
    s3Mock.reset()
    ;(getSignedUrl as jest.Mock).mockClear()
    ;(getSignedUrl as jest.Mock).mockResolvedValue('https://mock-presigned-url.s3.amazonaws.com/test')
  })

  // ─── POST /recipes/images/upload-url — presigned URL generation ────
  describe('POST /recipes/images/upload-url — presigned URL generation', () => {
    it('returns 200 with uploadUrl and key', async () => {
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: 'abc', imageType: 'cover' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(typeof body.uploadUrl).toBe('string')
      expect(typeof body.key).toBe('string')
      expect(body.key).toMatch(/^uploads\/recipes\/[^/]+\//)
    })

    it('generates correct S3 key for cover image', async () => {
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: 'abc', imageType: 'cover' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.key).toBe('uploads/recipes/abc/cover')
    })

    it('generates correct S3 key for step image', async () => {
      const event = makeEvent({
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ recipeId: 'abc', imageType: 'step', stepOrder: 3 }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.key).toBe('uploads/recipes/abc/step-3')
    })

    it('returns 401 without bearer token', async () => {
      const event = makeEvent({
        headers: {},
        body: JSON.stringify({ recipeId: 'abc', imageType: 'cover' }),
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
        body: JSON.stringify({ recipeId: 'abc' }),
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

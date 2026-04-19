import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'

const ddbMock = mockClient(DynamoDBDocumentClient)
const s3Mock = mockClient(S3Client)

// Set environment variables before importing handler
process.env.TABLE_NAME = 'test-recipes-table'
process.env.IMAGE_BUCKET_NAME = 'test-recipe-images-bucket'

// Import handler after mock setup
import { handler } from '../../lambda/recipe-handler'

// Build a fake JWT with the given payload (header.payload.signature)
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = 'fake-signature'
  return `${header}.${body}.${signature}`
}

const contributorToken = fakeJwt({ 'cognito:groups': ['contributor'], sub: 'contributor-user-id', email: 'contributor@example.com', name: 'Test Contributor' })
const adminToken = fakeJwt({ 'cognito:groups': ['admin'], sub: 'admin-user-id', email: 'admin@example.com', name: 'Admin User' })
const otherContributorToken = fakeJwt({ 'cognito:groups': ['contributor'], sub: 'other-contributor-id', email: 'other@example.com', name: 'Other Contributor' })

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /recipes',
    rawPath: '/recipes',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      domainName: 'test.execute-api.eu-west-2.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method: 'GET',
        path: '/recipes',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'test-request-id',
      routeKey: 'GET /recipes',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2
}

// Helper to build a valid recipe body for POST /recipes
function validRecipeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Slow-Cooked Lamb Ragu',
    coverImage: { key: 'recipes/images/test-id/cover', alt: 'A bowl of lamb ragu' },
    intro: 'A rich, hearty ragu.',
    ingredients: [{ item: 'lamb shoulder', quantity: '1', unit: 'kg' }],
    steps: [{ order: 1, text: 'Season the lamb and sear.' }],
    tags: ['Italian', 'Slow Cook'],
    prepTime: 20,
    cookTime: 240,
    servings: 4,
    ...overrides,
  })
}

// Sample published recipe item as it would appear in DynamoDB
function publishedRecipeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'recipe-uuid-1',
    slug: 'slow-cooked-lamb-ragu',
    title: 'Slow-Cooked Lamb Ragu',
    intro: 'A rich, hearty ragu.',
    coverImage: { key: 'recipes/images/recipe-uuid-1/cover', alt: 'A bowl of lamb ragu' },
    ingredients: [{ item: 'lamb shoulder', quantity: '1', unit: 'kg' }],
    steps: [{ order: 1, text: 'Season the lamb and sear.' }],
    tags: new Set(['Italian', 'Slow Cook']),
    prepTime: 20,
    cookTime: 240,
    servings: 4,
    status: 'published',
    authorId: 'contributor-user-id',
    authorName: 'Test Contributor',
    createdAt: '2026-04-08T12:00:00Z',
    updatedAt: '2026-04-08T14:30:00Z',
    ...overrides,
  }
}

function draftRecipeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return publishedRecipeItem({ status: 'draft', slug: 'my-draft-recipe', title: 'My Draft Recipe', ...overrides })
}

describe('Recipe Lambda handler', () => {
  beforeEach(() => {
    ddbMock.reset()
    s3Mock.reset()
  })

  // ─── GET /recipes — public listing ──────────────────────────────────
  describe('GET /recipes — list published recipes', () => {
    it('returns 200 with lightweight fields for published recipes only', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [publishedRecipeItem()],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes',
        rawPath: '/recipes',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(Array.isArray(body)).toBe(true)
      expect(body).toHaveLength(1)
      // Lightweight fields only
      expect(body[0]).toEqual({
        id: 'recipe-uuid-1',
        title: 'Slow-Cooked Lamb Ragu',
        slug: 'slow-cooked-lamb-ragu',
        coverImage: { key: 'recipes/images/recipe-uuid-1/cover', alt: 'A bowl of lamb ragu' },
        tags: ['Italian', 'Slow Cook'],
        prepTime: 20,
        cookTime: 240,
        servings: 4,
        createdAt: '2026-04-08T12:00:00Z',
      })
      // Must NOT include full details like intro, ingredients, steps
      expect(body[0]).not.toHaveProperty('intro')
      expect(body[0]).not.toHaveProperty('ingredients')
      expect(body[0]).not.toHaveProperty('steps')
    })

    it('queries the status-createdAt GSI filtered to status = published', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [publishedRecipeItem()],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes',
        rawPath: '/recipes',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)

      const queryCalls = ddbMock.commandCalls(QueryCommand)
      expect(queryCalls).toHaveLength(1)
      const input = queryCalls[0].args[0].input
      expect(input.IndexName).toBe('status-createdAt-index')
      expect(input.KeyConditionExpression).toBe('#status = :status')
      expect(input.ExpressionAttributeNames).toEqual({ '#status': 'status' })
      expect(input.ExpressionAttributeValues).toEqual({ ':status': 'published' })

      const body = JSON.parse(result.body as string)
      for (const recipe of body) {
        expect(recipe).not.toHaveProperty('status', 'draft')
      }
    })

    it('converts DynamoDB StringSet tags to JSON arrays', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [publishedRecipeItem({ tags: new Set(['Italian', 'Slow Cook', 'Winter']) })],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes',
        rawPath: '/recipes',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(Array.isArray(body[0].tags)).toBe(true)
      expect(body[0].tags).toContain('Italian')
      expect(body[0].tags).toContain('Slow Cook')
      expect(body[0].tags).toContain('Winter')
    })
  })

  // ─── GET /recipes/{slug} — single published recipe ──────────────────
  describe('GET /recipes/{slug} — get published recipe by slug', () => {
    it('returns 200 with full recipe for a published recipe', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [publishedRecipeItem()],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes/{slug}',
        rawPath: '/recipes/slow-cooked-lamb-ragu',
        pathParameters: { slug: 'slow-cooked-lamb-ragu' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.id).toBe('recipe-uuid-1')
      expect(body.slug).toBe('slow-cooked-lamb-ragu')
      expect(body.title).toBe('Slow-Cooked Lamb Ragu')
      expect(body.intro).toBe('A rich, hearty ragu.')
      expect(body.ingredients).toBeDefined()
      expect(body.steps).toBeDefined()
      expect(Array.isArray(body.tags)).toBe(true)
    })

    it('returns 404 (not 200) for a draft recipe and does not leak the item', async () => {
      const draft = draftRecipeItem({ slug: 'my-draft-recipe', title: 'Secret Draft' })
      ddbMock.on(ScanCommand).resolves({
        Items: [draft],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes/{slug}',
        rawPath: '/recipes/my-draft-recipe',
        pathParameters: { slug: 'my-draft-recipe' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
      // Must not leak any of the draft's contents in the response body.
      expect(body).not.toHaveProperty('id')
      expect(body).not.toHaveProperty('title')
      expect(body).not.toHaveProperty('slug')
      expect(body).not.toHaveProperty('intro')
      expect(body).not.toHaveProperty('status')
      expect(result.body).not.toContain('Secret Draft')
    })

    it('returns 404 for a non-existent slug', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes/{slug}',
        rawPath: '/recipes/does-not-exist',
        pathParameters: { slug: 'does-not-exist' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  describe('public endpoints do not leak drafts when drafts and published items coexist', () => {
    const published = publishedRecipeItem({
      id: 'pub-id',
      slug: 'published-lamb-ragu',
      title: 'Published Lamb Ragu',
    })
    const draft = draftRecipeItem({
      id: 'draft-id',
      slug: 'secret-draft-recipe',
      title: 'Secret Draft Recipe',
    })

    it('GET /recipes excludes the draft slug, id, and title', async () => {
      // The GSI-backed list handler only ever sees published items — simulate that.
      ddbMock.on(QueryCommand).resolves({ Items: [published] })

      const result = await handler(makeEvent({ routeKey: 'GET /recipes', rawPath: '/recipes' }))

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string) as Array<{ slug: string; id: string }>
      expect(body.map((r) => r.slug)).not.toContain('secret-draft-recipe')
      expect(body.map((r) => r.id)).not.toContain('draft-id')
      expect(result.body).not.toContain('Secret Draft Recipe')
    })

    it('GET /recipes/{slug} returns 404 for the draft slug without leaking its contents', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [draft] })

      const result = await handler(makeEvent({
        routeKey: 'GET /recipes/{slug}',
        rawPath: '/recipes/secret-draft-recipe',
        pathParameters: { slug: 'secret-draft-recipe' },
      }))

      expect(result.statusCode).toBe(404)
      expect(result.body).not.toContain('Secret Draft Recipe')
    })

    it('GET /recipes/{slug} returns 200 for the published slug', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [published] })

      const result = await handler(makeEvent({
        routeKey: 'GET /recipes/{slug}',
        rawPath: '/recipes/published-lamb-ragu',
        pathParameters: { slug: 'published-lamb-ragu' },
      }))

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.slug).toBe('published-lamb-ragu')
    })
  })

  // ─── GET /me/recipes — authenticated user's recipes ─────────────────
  describe('GET /me/recipes — list user recipes', () => {
    it('returns 200 with all recipes (draft and published) for authenticated user, sorted newest first', async () => {
      const draft = draftRecipeItem({ createdAt: '2026-04-09T10:00:00Z' })
      const published = publishedRecipeItem({ createdAt: '2026-04-08T12:00:00Z' })

      ddbMock.on(QueryCommand).resolves({
        Items: [draft, published],
      })

      const event = makeEvent({
        routeKey: 'GET /me/recipes',
        rawPath: '/me/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(Array.isArray(body)).toBe(true)
      expect(body).toHaveLength(2)
    })

    it('returns 401 without a valid token', async () => {
      const event = makeEvent({
        routeKey: 'GET /me/recipes',
        rawPath: '/me/recipes',
        headers: {},
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  // ─── POST /recipes — create recipe ──────────────────────────────────
  describe('POST /recipes — create recipe', () => {
    it('returns 201 with status draft and authorId from JWT sub', async () => {
      // Slug uniqueness check returns no collisions
      ddbMock.on(ScanCommand).resolves({ Items: [] })
      ddbMock.on(PutCommand).resolves({})

      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: validRecipeBody(),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(201)
      const body = JSON.parse(result.body as string)
      expect(body.status).toBe('draft')
      expect(body.authorId).toBe('contributor-user-id')
      expect(body.id).toBeDefined()
      expect(body.slug).toBe('slow-cooked-lamb-ragu')
      expect(body.createdAt).toBeDefined()
    })

    it('auto-generates a URL-friendly slug from the title', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] })
      ddbMock.on(PutCommand).resolves({})

      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: validRecipeBody({ title: 'My Amazing Recipe!' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(201)
      const body = JSON.parse(result.body as string)
      expect(body.slug).toBe('my-amazing-recipe')
    })

    it('appends numeric suffix when slug collides', async () => {
      // First scan returns existing recipe with same slug
      ddbMock.on(ScanCommand)
        .resolvesOnce({ Items: [{ slug: 'slow-cooked-lamb-ragu' }] })  // collision
        .resolvesOnce({ Items: [] })  // no collision with suffix
      ddbMock.on(PutCommand).resolves({})

      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: validRecipeBody(),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(201)
      const body = JSON.parse(result.body as string)
      expect(body.slug).toBe('slow-cooked-lamb-ragu-2')
    })

    it('returns 401 without a valid token', async () => {
      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: {},
        body: validRecipeBody(),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 400 when title is missing', async () => {
      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: validRecipeBody({ title: undefined }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 400 when coverImage is missing', async () => {
      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: validRecipeBody({ coverImage: undefined }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 400 when coverImage key is missing', async () => {
      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: validRecipeBody({ coverImage: { alt: 'some alt text' } }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 400 when coverImage alt is missing', async () => {
      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: validRecipeBody({ coverImage: { key: 'some/key' } }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 400 when ingredients are empty', async () => {
      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: validRecipeBody({ ingredients: [] }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 400 when steps are empty', async () => {
      const event = makeEvent({
        routeKey: 'POST /recipes',
        rawPath: '/recipes',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: validRecipeBody({ steps: [] }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  // ─── POST /recipes/drafts — create draft ────────────────────────────
  describe('POST /recipes/drafts — create draft', () => {
    it('returns 401 without a valid token', async () => {
      const event = makeEvent({
        routeKey: 'POST /recipes/drafts',
        rawPath: '/recipes/drafts',
        headers: {},
        body: '{}',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 403 when the caller is not an admin', async () => {
      const event = makeEvent({
        routeKey: 'POST /recipes/drafts',
        rawPath: '/recipes/drafts',
        headers: { authorization: `Bearer ${contributorToken}` },
        body: '{}',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 201 with { id, slug } in the body on success', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] })
      ddbMock.on(PutCommand).resolves({})

      const event = makeEvent({
        routeKey: 'POST /recipes/drafts',
        rawPath: '/recipes/drafts',
        headers: { authorization: `Bearer ${adminToken}` },
        body: '{}',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(201)
      const body = JSON.parse(result.body as string)
      expect(typeof body.id).toBe('string')
      expect(body.id).toMatch(/^[0-9a-f-]+$/i)
      expect(typeof body.slug).toBe('string')
    })

    it('writes status=draft and ttl=now+30d to DynamoDB', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-19T12:00:00Z'))
      try {
        ddbMock.on(ScanCommand).resolves({ Items: [] })
        ddbMock.on(PutCommand).resolves({})

        const event = makeEvent({
          routeKey: 'POST /recipes/drafts',
          rawPath: '/recipes/drafts',
          headers: { authorization: `Bearer ${adminToken}` },
          body: '{}',
        })

        const result = await handler(event)

        expect(result.statusCode).toBe(201)

        const putCalls = ddbMock.commandCalls(PutCommand)
        expect(putCalls).toHaveLength(1)
        const item = putCalls[0].args[0].input.Item as Record<string, unknown>
        expect(item.status).toBe('draft')

        const expectedTtl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
        expect(typeof item.ttl).toBe('number')
        expect(item.ttl).toBe(expectedTtl)
      } finally {
        jest.useRealTimers()
      }
    })

    it('defaults slug to draft-<uuid> when no title is provided', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] })
      ddbMock.on(PutCommand).resolves({})

      const event = makeEvent({
        routeKey: 'POST /recipes/drafts',
        rawPath: '/recipes/drafts',
        headers: { authorization: `Bearer ${adminToken}` },
        body: '{}',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(201)
      const body = JSON.parse(result.body as string)
      expect(body.slug).toMatch(/^draft-/)
    })

    it('derives slug from the title when one is provided', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] })
      ddbMock.on(PutCommand).resolves({})

      const event = makeEvent({
        routeKey: 'POST /recipes/drafts',
        rawPath: '/recipes/drafts',
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ title: 'My New Recipe' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(201)
      const body = JSON.parse(result.body as string)
      expect(body.slug).toBe('my-new-recipe')
    })
  })

  // ─── GET /recipes/admin — list all recipes for admins ──────────────
  describe('GET /recipes/admin — list all recipes for admins', () => {
    it('returns 401 without a valid token', async () => {
      const event = makeEvent({
        routeKey: 'GET /recipes/admin',
        rawPath: '/recipes/admin',
        headers: {},
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 403 when the caller is not an admin', async () => {
      const event = makeEvent({
        routeKey: 'GET /recipes/admin',
        rawPath: '/recipes/admin',
        headers: { authorization: `Bearer ${contributorToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('merges drafts and published recipes via two GSI queries with no table scan', async () => {
      const published = publishedRecipeItem({ id: 'pub-id', slug: 'pub-slug', title: 'Published Recipe' })
      const draft = draftRecipeItem({ id: 'draft-id', slug: 'draft-slug', title: 'Draft Recipe' })

      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [published] })
        .resolvesOnce({ Items: [draft] })

      const event = makeEvent({
        routeKey: 'GET /recipes/admin',
        rawPath: '/recipes/admin',
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)

      const queryCalls = ddbMock.commandCalls(QueryCommand)
      expect(queryCalls).toHaveLength(2)
      for (const call of queryCalls) {
        expect(call.args[0].input.IndexName).toBe('status-createdAt-index')
      }

      const statusValues = queryCalls.map((call) => call.args[0].input.ExpressionAttributeValues?.[':status'])
      expect(new Set(statusValues)).toEqual(new Set(['published', 'draft']))

      expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0)

      const body = JSON.parse(result.body as string)
      expect(Array.isArray(body)).toBe(true)
      expect(body).toHaveLength(2)
      const statuses = body.map((r: { status: string }) => r.status)
      expect(statuses).toContain('published')
      expect(statuses).toContain('draft')
    })

    it('filters out draft items whose ttl is in the past', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-19T12:00:00Z'))
      try {
        const nowSeconds = Math.floor(Date.now() / 1000)
        const expiredDraft = draftRecipeItem({ id: 'expired-id', slug: 'expired-slug', title: 'Expired Draft', ttl: nowSeconds - 100 })
        const liveDraft = draftRecipeItem({ id: 'live-id', slug: 'live-slug', title: 'Live Draft', ttl: nowSeconds + 100000 })

        ddbMock.on(QueryCommand)
          .resolvesOnce({ Items: [] })
          .resolvesOnce({ Items: [expiredDraft, liveDraft] })

        const event = makeEvent({
          routeKey: 'GET /recipes/admin',
          rawPath: '/recipes/admin',
          headers: { authorization: `Bearer ${adminToken}` },
        })

        const result = await handler(event)

        expect(result.statusCode).toBe(200)
        const body = JSON.parse(result.body as string)
        expect(body).toHaveLength(1)
        expect(body[0].id).toBe('live-id')
        expect(body.map((r: { id: string }) => r.id)).not.toContain('expired-id')
      } finally {
        jest.useRealTimers()
      }
    })

    it('returns a lightweight admin projection that includes status and updatedAt but omits heavy fields', async () => {
      const published = publishedRecipeItem({ id: 'pub-id', slug: 'pub-slug', title: 'Published Recipe' })
      const draft = draftRecipeItem({ id: 'draft-id', slug: 'draft-slug', title: 'Draft Recipe' })

      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [published] })
        .resolvesOnce({ Items: [draft] })

      const event = makeEvent({
        routeKey: 'GET /recipes/admin',
        rawPath: '/recipes/admin',
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string) as Array<Record<string, unknown>>
      expect(body).toHaveLength(2)

      for (const item of body) {
        expect(item).toHaveProperty('id')
        expect(item).toHaveProperty('title')
        expect(item).toHaveProperty('slug')
        expect(item).toHaveProperty('coverImage')
        expect(item).toHaveProperty('tags')
        expect(item).toHaveProperty('prepTime')
        expect(item).toHaveProperty('cookTime')
        expect(item).toHaveProperty('servings')
        expect(item).toHaveProperty('createdAt')
        expect(item).toHaveProperty('status')
        expect(item).toHaveProperty('updatedAt')
        expect(typeof item.status).toBe('string')
        expect(typeof item.updatedAt).toBe('string')
        expect(Array.isArray(item.tags)).toBe(true)

        // Heavy/private fields must be stripped from the list response.
        expect(item).not.toHaveProperty('intro')
        expect(item).not.toHaveProperty('ingredients')
        expect(item).not.toHaveProperty('steps')
        expect(item).not.toHaveProperty('authorId')
        expect(item).not.toHaveProperty('authorName')
        expect(item).not.toHaveProperty('ttl')
      }
    })

    it('includes published items that have no ttl attribute', async () => {
      const published = publishedRecipeItem({ id: 'pub-id', slug: 'pub-slug', title: 'Published Recipe' })
      // Confirm the helper does not attach a ttl by default
      expect(published).not.toHaveProperty('ttl')

      ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [published] })
        .resolvesOnce({ Items: [] })

      const event = makeEvent({
        routeKey: 'GET /recipes/admin',
        rawPath: '/recipes/admin',
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveLength(1)
      expect(body[0].id).toBe('pub-id')
    })
  })

  // ─── PATCH /recipes/{id} — update recipe ────────────────────────────
  describe('PATCH /recipes/{id} — update recipe', () => {
    it('returns 200 when contributor updates their own recipe', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: publishedRecipeItem({ authorId: 'contributor-user-id', title: 'Updated Title' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ title: 'Updated Title', intro: 'Updated intro.' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
    })

    it('returns 403 when contributor tries to update another user\'s recipe', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'other-contributor-id' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ title: 'Hijacked Title' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 200 when admin updates any recipe', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: publishedRecipeItem({ authorId: 'contributor-user-id', title: 'Admin Updated' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ title: 'Admin Updated' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
    })

    it('does not change slug when title is updated (slug is immutable)', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ slug: 'slow-cooked-lamb-ragu', authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: publishedRecipeItem({ slug: 'slow-cooked-lamb-ragu', title: 'Completely New Title', authorId: 'contributor-user-id' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${contributorToken}` },
        body: JSON.stringify({ title: 'Completely New Title' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.slug).toBe('slow-cooked-lamb-ragu')
    })

    it('returns 401 without a valid token', async () => {
      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: {},
        body: JSON.stringify({ title: 'No Auth Update' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  // ─── PATCH /recipes/{id} — draft-aware update and image-swap cleanup ─
  describe('PATCH /recipes/{id} — draft-aware update and image-swap cleanup', () => {
    it('refreshes ttl on a draft PATCH', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-19T12:00:00Z'))
      try {
        const oldItem = draftRecipeItem({ id: 'recipe-uuid-1', authorId: 'contributor-user-id' })
        ddbMock.on(GetCommand).resolves({ Item: oldItem })
        ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })

        const event = makeEvent({
          routeKey: 'PATCH /recipes/{id}',
          rawPath: '/recipes/recipe-uuid-1',
          pathParameters: { id: 'recipe-uuid-1' },
          headers: { authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ title: 'Updated Draft Title' }),
        })

        const result = await handler(event)

        expect(result.statusCode).toBe(200)

        const updateCalls = ddbMock.commandCalls(UpdateCommand)
        expect(updateCalls).toHaveLength(1)
        const input = updateCalls[0].args[0].input
        const expectedTtl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
        expect(input.ExpressionAttributeValues).toBeDefined()
        expect((input.ExpressionAttributeValues as Record<string, unknown>)[':ttl']).toBe(expectedTtl)
      } finally {
        jest.useRealTimers()
      }
    })

    it('does NOT set ttl on a published PATCH', async () => {
      const oldItem = publishedRecipeItem({ id: 'recipe-uuid-1', authorId: 'contributor-user-id' })
      ddbMock.on(GetCommand).resolves({ Item: oldItem })
      ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ title: 'Updated Published Title' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)

      const updateCalls = ddbMock.commandCalls(UpdateCommand)
      expect(updateCalls).toHaveLength(1)
      const input = updateCalls[0].args[0].input
      expect((input.ExpressionAttributeValues as Record<string, unknown>)[':ttl']).toBeUndefined()
      expect(input.UpdateExpression).toBeDefined()
      expect(input.UpdateExpression).not.toMatch(/\bttl\b/)
    })

    it('uses ReturnValues: ALL_OLD on the UpdateCommand', async () => {
      const oldItem = publishedRecipeItem({ id: 'recipe-uuid-1', authorId: 'contributor-user-id' })
      ddbMock.on(GetCommand).resolves({ Item: oldItem })
      ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ title: 'Any Update' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)

      const updateCalls = ddbMock.commandCalls(UpdateCommand)
      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0].args[0].input.ReturnValues).toBe('ALL_OLD')
    })

    it('diffs image swap against the UpdateCommand ALL_OLD snapshot, not the pre-read', async () => {
      const preReadItem = publishedRecipeItem({
        id: 'recipe-uuid-1',
        authorId: 'contributor-user-id',
        coverImage: { key: 'keyA', alt: 'Pre-read alt' },
      })
      const atomicOldItem = {
        ...preReadItem,
        coverImage: { key: 'keyB', alt: 'Atomic-old alt' },
      }
      ddbMock.on(GetCommand).resolves({ Item: preReadItem })
      ddbMock.on(UpdateCommand).resolves({ Attributes: atomicOldItem })
      s3Mock.on(DeleteObjectsCommand).resolves({})

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ coverImage: { key: 'keyC', alt: 'New alt' } }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)

      const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand)
      expect(deleteCalls).toHaveLength(1)
      const keys = (deleteCalls[0].args[0].input.Delete?.Objects ?? []).map((o) => o.Key)
      // Diff must be against the atomic-old snapshot (keyB), not the pre-read (keyA).
      expect(keys).toContain('keyB-thumb.webp')
      expect(keys).toContain('keyB-medium.webp')
      expect(keys).toContain('keyB-full.webp')
      expect(keys).not.toContain('keyA-thumb.webp')
      expect(keys).not.toContain('keyA-medium.webp')
      expect(keys).not.toContain('keyA-full.webp')
      expect(keys).toHaveLength(3)
    })

    it('cover-image swap deletes the three old variants from S3', async () => {
      const oldItem = publishedRecipeItem({
        id: 'recipe-uuid-1',
        authorId: 'contributor-user-id',
        coverImage: { key: 'recipes/images/recipe-1/cover', alt: 'Old alt' },
      })
      ddbMock.on(GetCommand).resolves({ Item: oldItem })
      ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })
      s3Mock.on(DeleteObjectsCommand).resolves({})

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ coverImage: { key: 'recipes/images/recipe-1/cover-v2', alt: 'New alt' } }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)

      const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand)
      expect(deleteCalls).toHaveLength(1)
      const deleteInput = deleteCalls[0].args[0].input
      const keys = (deleteInput.Delete?.Objects ?? []).map((o) => o.Key)
      expect(keys).toContain('recipes/images/recipe-1/cover-thumb.webp')
      expect(keys).toContain('recipes/images/recipe-1/cover-medium.webp')
      expect(keys).toContain('recipes/images/recipe-1/cover-full.webp')
      expect(keys).toHaveLength(3)
    })

    it('same cover-image key triggers no S3 delete', async () => {
      const oldItem = publishedRecipeItem({
        id: 'recipe-uuid-1',
        authorId: 'contributor-user-id',
        coverImage: { key: 'recipes/images/recipe-1/cover', alt: 'Old alt' },
      })
      ddbMock.on(GetCommand).resolves({ Item: oldItem })
      ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ coverImage: { key: 'recipes/images/recipe-1/cover', alt: 'Same key' } }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0)
    })

    it('step-image swap deletes old variants by key-set (reorder-safe)', async () => {
      const oldItem = publishedRecipeItem({
        id: 'recipe-uuid-1',
        authorId: 'contributor-user-id',
        steps: [
          { order: 1, text: 'A', image: { key: 'step-a', alt: 'a' } },
          { order: 2, text: 'B', image: { key: 'step-b', alt: 'b' } },
          { order: 3, text: 'C', image: { key: 'step-c', alt: 'c' } },
        ],
      })
      ddbMock.on(GetCommand).resolves({ Item: oldItem })
      ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })
      s3Mock.on(DeleteObjectsCommand).resolves({})

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          steps: [
            { order: 1, text: 'C', image: { key: 'step-c', alt: 'c' } },
            { order: 2, text: 'D', image: { key: 'step-d', alt: 'd' } },
          ],
        }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)

      const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand)
      expect(deleteCalls).toHaveLength(1)
      const keys = (deleteCalls[0].args[0].input.Delete?.Objects ?? []).map((o) => o.Key)
      // step-a variants must be scheduled for deletion
      expect(keys).toContain('step-a-thumb.webp')
      expect(keys).toContain('step-a-medium.webp')
      expect(keys).toContain('step-a-full.webp')
      // step-b variants must be scheduled for deletion
      expect(keys).toContain('step-b-thumb.webp')
      expect(keys).toContain('step-b-medium.webp')
      expect(keys).toContain('step-b-full.webp')
      // step-c is still referenced — its variants must NOT be deleted
      expect(keys).not.toContain('step-c-thumb.webp')
      expect(keys).not.toContain('step-c-medium.webp')
      expect(keys).not.toContain('step-c-full.webp')
      // step-d is newly added — its variants must NOT be deleted
      expect(keys).not.toContain('step-d-thumb.webp')
      expect(keys).not.toContain('step-d-medium.webp')
      expect(keys).not.toContain('step-d-full.webp')
      expect(keys).toHaveLength(6)
    })

    it('pure step reorder (same key-set) triggers no S3 delete', async () => {
      const oldItem = publishedRecipeItem({
        id: 'recipe-uuid-1',
        authorId: 'contributor-user-id',
        steps: [
          { order: 1, text: 'A', image: { key: 'step-a', alt: 'a' } },
          { order: 2, text: 'B', image: { key: 'step-b', alt: 'b' } },
          { order: 3, text: 'C', image: { key: 'step-c', alt: 'c' } },
        ],
      })
      ddbMock.on(GetCommand).resolves({ Item: oldItem })
      ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          steps: [
            { order: 1, text: 'C', image: { key: 'step-c', alt: 'c' } },
            { order: 2, text: 'A', image: { key: 'step-a', alt: 'a' } },
            { order: 3, text: 'B', image: { key: 'step-b', alt: 'b' } },
          ],
        }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0)
    })

    it('invokes UpdateCommand before DeleteObjectsCommand', async () => {
      const oldItem = publishedRecipeItem({
        id: 'recipe-uuid-1',
        authorId: 'contributor-user-id',
        coverImage: { key: 'recipes/images/recipe-1/cover', alt: 'Old alt' },
      })
      ddbMock.on(GetCommand).resolves({ Item: oldItem })

      const callOrder: string[] = []
      ddbMock.on(UpdateCommand).callsFake(async () => {
        callOrder.push('update')
        return { Attributes: oldItem }
      })
      s3Mock.on(DeleteObjectsCommand).callsFake(async () => {
        callOrder.push('delete')
        return {}
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ coverImage: { key: 'recipes/images/recipe-1/cover-v2', alt: 'New alt' } }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1)
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1)
      expect(callOrder).toEqual(['update', 'delete'])
    })

    it('logs and swallows partial S3 delete failures without rolling back DDB', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const oldItem = publishedRecipeItem({
          id: 'recipe-uuid-1',
          authorId: 'contributor-user-id',
          coverImage: { key: 'recipes/images/recipe-1/cover', alt: 'Old alt' },
        })
        ddbMock.on(GetCommand).resolves({ Item: oldItem })
        ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })
        s3Mock.on(DeleteObjectsCommand).resolves({
          Errors: [{ Key: 'recipes/images/recipe-1/cover-thumb.webp', Code: 'AccessDenied', Message: 'nope' }],
        })

        const event = makeEvent({
          routeKey: 'PATCH /recipes/{id}',
          rawPath: '/recipes/recipe-uuid-1',
          pathParameters: { id: 'recipe-uuid-1' },
          headers: { authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ coverImage: { key: 'recipes/images/recipe-1/cover-v2', alt: 'New alt' } }),
        })

        const result = await handler(event)

        expect(result.statusCode).toBe(200)
        const body = JSON.parse(result.body as string)
        expect(body.id).toBe('recipe-uuid-1')
        expect(body.coverImage).toEqual({ key: 'recipes/images/recipe-1/cover-v2', alt: 'New alt' })

        // Must have logged the partial failure somewhere observable.
        const logged = errorSpy.mock.calls.length + warnSpy.mock.calls.length
        expect(logged).toBeGreaterThan(0)
      } finally {
        errorSpy.mockRestore()
        warnSpy.mockRestore()
      }
    })

    it('silently drops status from the update body', async () => {
      const oldItem = publishedRecipeItem({ id: 'recipe-uuid-1', authorId: 'contributor-user-id' })
      ddbMock.on(GetCommand).resolves({ Item: oldItem })
      ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ title: 'x', status: 'published' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const updateCalls = ddbMock.commandCalls(UpdateCommand)
      expect(updateCalls).toHaveLength(1)
      const input = updateCalls[0].args[0].input
      expect((input.ExpressionAttributeNames as Record<string, string>)['#status']).toBeUndefined()
      expect((input.ExpressionAttributeValues as Record<string, unknown>)[':status']).toBeUndefined()
    })

    it('silently drops ttl from the update body', async () => {
      const oldItem = publishedRecipeItem({ id: 'recipe-uuid-1', authorId: 'contributor-user-id' })
      ddbMock.on(GetCommand).resolves({ Item: oldItem })
      ddbMock.on(UpdateCommand).resolves({ Attributes: oldItem })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ title: 'x', ttl: 12345 }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const updateCalls = ddbMock.commandCalls(UpdateCommand)
      expect(updateCalls).toHaveLength(1)
      const input = updateCalls[0].args[0].input
      // The user-supplied ttl value must not be present
      expect((input.ExpressionAttributeNames as Record<string, string>)['#ttl']).toBeUndefined()
      expect((input.ExpressionAttributeValues as Record<string, unknown>)[':ttl']).toBe(undefined)
    })
  })

  // ─── PATCH /recipes/{id}/publish ────────────────────────────────────
  describe('PATCH /recipes/{id}/publish — publish recipe (admin-only)', () => {
    it('returns 200 and sets status to published when admin publishes a valid draft', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: draftRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/publish',
        rawPath: '/recipes/recipe-uuid-1/publish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.status).toBe('published')
    })

    it('removes ttl via UpdateExpression REMOVE (not SET ttl = null) on publish', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: draftRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/publish',
        rawPath: '/recipes/recipe-uuid-1/publish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const updateCalls = ddbMock.commandCalls(UpdateCommand)
      expect(updateCalls).toHaveLength(1)
      const input = updateCalls[0].args[0].input
      const updateExpression = input.UpdateExpression as string
      // The UpdateExpression must REMOVE ttl (either `REMOVE ttl` or `REMOVE #ttl`).
      expect(updateExpression).toMatch(/REMOVE\s+(#ttl|ttl)/)
      // It must NOT SET a ttl value (no `:ttl` placeholder, no `ttl = :` pattern).
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>
      expect(values[':ttl']).toBeUndefined()
    })

    describe('server-side validation — returns 400 with field-level errors', () => {
      function publishEvent() {
        return makeEvent({
          routeKey: 'PATCH /recipes/{id}/publish',
          rawPath: '/recipes/recipe-uuid-1/publish',
          pathParameters: { id: 'recipe-uuid-1' },
          headers: { authorization: `Bearer ${adminToken}` },
        })
      }

      it('returns 400 with a `title` error when title is missing', async () => {
        ddbMock.on(GetCommand).resolves({
          Item: draftRecipeItem({ authorId: 'contributor-user-id', title: '' }),
        })

        const result = await handler(publishEvent())

        expect(result.statusCode).toBe(400)
        const body = JSON.parse(result.body as string)
        expect(body.errors).toBeDefined()
        expect(body.errors).toHaveProperty('title')
      })

      it('returns 400 with an `intro` error when intro is missing', async () => {
        ddbMock.on(GetCommand).resolves({
          Item: draftRecipeItem({ authorId: 'contributor-user-id', intro: '' }),
        })

        const result = await handler(publishEvent())

        expect(result.statusCode).toBe(400)
        const body = JSON.parse(result.body as string)
        expect(body.errors).toHaveProperty('intro')
      })

      it('returns 400 with a `coverImage.key` error when cover key is missing', async () => {
        ddbMock.on(GetCommand).resolves({
          Item: draftRecipeItem({
            authorId: 'contributor-user-id',
            coverImage: { key: '', alt: 'alt' },
          }),
        })

        const result = await handler(publishEvent())

        expect(result.statusCode).toBe(400)
        const body = JSON.parse(result.body as string)
        expect(body.errors).toHaveProperty('coverImage.key')
      })

      it('returns 400 with a `coverImage.alt` error when cover alt is missing', async () => {
        ddbMock.on(GetCommand).resolves({
          Item: draftRecipeItem({
            authorId: 'contributor-user-id',
            coverImage: { key: 'recipes/images/recipe-uuid-1/cover', alt: '' },
          }),
        })

        const result = await handler(publishEvent())

        expect(result.statusCode).toBe(400)
        const body = JSON.parse(result.body as string)
        expect(body.errors).toHaveProperty('coverImage.alt')
      })

      it('returns 400 with an `ingredients` error when ingredients list is empty', async () => {
        ddbMock.on(GetCommand).resolves({
          Item: draftRecipeItem({ authorId: 'contributor-user-id', ingredients: [] }),
        })

        const result = await handler(publishEvent())

        expect(result.statusCode).toBe(400)
        const body = JSON.parse(result.body as string)
        expect(body.errors).toHaveProperty('ingredients')
      })

      it('returns 400 with a `steps` error when steps is missing', async () => {
        ddbMock.on(GetCommand).resolves({
          Item: draftRecipeItem({ authorId: 'contributor-user-id', steps: [] }),
        })

        const result = await handler(publishEvent())

        expect(result.statusCode).toBe(400)
        const body = JSON.parse(result.body as string)
        expect(body.errors).toHaveProperty('steps')
      })

      it('returns 400 with a `steps` error when all steps have empty text', async () => {
        ddbMock.on(GetCommand).resolves({
          Item: draftRecipeItem({
            authorId: 'contributor-user-id',
            steps: [{ order: 1, text: '' }, { order: 2, text: '   ' }],
          }),
        })

        const result = await handler(publishEvent())

        expect(result.statusCode).toBe(400)
        const body = JSON.parse(result.body as string)
        expect(body.errors).toHaveProperty('steps')
      })
    })

    it('returns 200 (no-op) when publishing an already-published recipe that still passes validation', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/publish',
        rawPath: '/recipes/recipe-uuid-1/publish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.status).toBe('published')
    })

    it('returns 400 when re-publishing an already-published recipe that now fails validation', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id', title: '' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/publish',
        rawPath: '/recipes/recipe-uuid-1/publish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body as string)
      expect(body.errors).toHaveProperty('title')
    })

    it('returns 403 when a contributor (even the owner) publishes — admin-only', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: draftRecipeItem({ authorId: 'contributor-user-id' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/publish',
        rawPath: '/recipes/recipe-uuid-1/publish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${contributorToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 401 without a valid token', async () => {
      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/publish',
        rawPath: '/recipes/recipe-uuid-1/publish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: {},
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
    })
  })

  // ─── PATCH /recipes/{id}/unpublish ──────────────────────────────────
  describe('PATCH /recipes/{id}/unpublish — unpublish recipe (admin-only)', () => {
    it('returns 200 and sets status to draft with ttl = now + 30d', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: draftRecipeItem({ authorId: 'contributor-user-id' }),
      })

      const before = Math.floor(Date.now() / 1000)

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/unpublish',
        rawPath: '/recipes/recipe-uuid-1/unpublish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      const after = Math.floor(Date.now() / 1000)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.status).toBe('draft')

      const updateCalls = ddbMock.commandCalls(UpdateCommand)
      expect(updateCalls).toHaveLength(1)
      const input = updateCalls[0].args[0].input
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>
      const ttl = values[':ttl']
      expect(typeof ttl).toBe('number')

      const thirtyDays = 30 * 24 * 60 * 60
      const expectedMin = before + thirtyDays - 60
      const expectedMax = after + thirtyDays + 60
      expect(ttl as number).toBeGreaterThanOrEqual(expectedMin)
      expect(ttl as number).toBeLessThanOrEqual(expectedMax)
    })

    it('returns 200 (no-op) when unpublishing an already-draft recipe', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: draftRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: draftRecipeItem({ authorId: 'contributor-user-id' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/unpublish',
        rawPath: '/recipes/recipe-uuid-1/unpublish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const updateCalls = ddbMock.commandCalls(UpdateCommand)
      if (updateCalls.length > 0) {
        const values = (updateCalls[0].args[0].input.ExpressionAttributeValues ?? {}) as Record<string, unknown>
        if (values[':status'] !== undefined) {
          expect(values[':status']).toBe('draft')
        }
      }
    })

    it('returns 403 when a contributor (even the owner) unpublishes — admin-only', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/unpublish',
        rawPath: '/recipes/recipe-uuid-1/unpublish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${contributorToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 401 without a valid token', async () => {
      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/unpublish',
        rawPath: '/recipes/recipe-uuid-1/unpublish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: {},
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
    })
  })

  // ─── DELETE /recipes/{id} — delete recipe ───────────────────────────
  describe('DELETE /recipes/{id} — delete recipe', () => {
    it('returns 200 and deletes recipe from DynamoDB and S3 images', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(DeleteCommand).resolves({})
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          { Key: 'processed/recipes/recipe-uuid-1/cover-thumb.webp' },
          { Key: 'processed/recipes/recipe-uuid-1/cover-medium.webp' },
          { Key: 'processed/recipes/recipe-uuid-1/cover-full.webp' },
        ],
      })
      s3Mock.on(DeleteObjectsCommand).resolves({})

      const event = makeEvent({
        routeKey: 'DELETE /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${contributorToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      // Verify S3 cleanup was attempted
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1)
      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1)
    })

    it('returns 403 when contributor deletes another user\'s recipe', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'other-contributor-id' }),
      })

      const event = makeEvent({
        routeKey: 'DELETE /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${contributorToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 200 when admin deletes any recipe', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(DeleteCommand).resolves({})
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] })

      const event = makeEvent({
        routeKey: 'DELETE /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
    })

    it('returns 401 without a valid token', async () => {
      const event = makeEvent({
        routeKey: 'DELETE /recipes/{id}',
        rawPath: '/recipes/recipe-uuid-1',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: {},
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  // ─── GET /recipes/tags — public tag aggregation ─────────────────────
  describe('GET /recipes/tags — list tags with counts', () => {
    it('returns 200 with tags sorted alphabetically with counts', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { tags: { wrapperName: 'Set', values: ['Italian', 'Slow Cook'], type: 'String' }, status: 'published' },
          { tags: { wrapperName: 'Set', values: ['Italian', 'Vegetarian'], type: 'String' }, status: 'published' },
        ],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes/tags',
        rawPath: '/recipes/tags',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(Array.isArray(body)).toBe(true)
      expect(body).toEqual([
        { tag: 'Italian', count: 2 },
        { tag: 'Slow Cook', count: 1 },
        { tag: 'Vegetarian', count: 1 },
      ])
    })

    it('aggregates tag counts across multiple published recipes', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { tags: { wrapperName: 'Set', values: ['Italian', 'Pasta'], type: 'String' }, status: 'published' },
          { tags: { wrapperName: 'Set', values: ['Italian', 'Slow Cook'], type: 'String' }, status: 'published' },
          { tags: { wrapperName: 'Set', values: ['Italian', 'Pasta', 'Vegetarian'], type: 'String' }, status: 'published' },
        ],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes/tags',
        rawPath: '/recipes/tags',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      // Italian appears in all 3 recipes
      expect(body.find((t: { tag: string }) => t.tag === 'Italian')).toEqual({ tag: 'Italian', count: 3 })
      // Pasta appears in 2 recipes
      expect(body.find((t: { tag: string }) => t.tag === 'Pasta')).toEqual({ tag: 'Pasta', count: 2 })
      // Slow Cook and Vegetarian appear in 1 recipe each
      expect(body.find((t: { tag: string }) => t.tag === 'Slow Cook')).toEqual({ tag: 'Slow Cook', count: 1 })
      expect(body.find((t: { tag: string }) => t.tag === 'Vegetarian')).toEqual({ tag: 'Vegetarian', count: 1 })
    })

    it('excludes tags from draft recipes', async () => {
      // The ScanCommand should filter on status = 'published', so drafts should not appear
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { tags: { wrapperName: 'Set', values: ['Italian'], type: 'String' }, status: 'published' },
        ],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes/tags',
        rawPath: '/recipes/tags',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual([{ tag: 'Italian', count: 1 }])
      // Draft tags must not be included — the scan should only return published recipes
    })

    it('returns empty array when no published recipes exist', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [],
      })

      const event = makeEvent({
        routeKey: 'GET /recipes/tags',
        rawPath: '/recipes/tags',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(Array.isArray(body)).toBe(true)
      expect(body).toEqual([])
    })
  })

  // ─── Unknown route ──────────────────────────────────────────────────
  describe('Unknown route', () => {
    it('returns 404 for unmatched route', async () => {
      const event = makeEvent({
        routeKey: 'GET /unknown',
        rawPath: '/unknown',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })
})

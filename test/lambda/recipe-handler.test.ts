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

    it('does not return draft recipes', async () => {
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
      // The query should filter by status=published via the GSI
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

    it('returns 404 for a draft recipe', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [draftRecipeItem({ slug: 'my-draft-recipe' })],
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

  // ─── PUT /recipes/{id} — update recipe ──────────────────────────────
  describe('PUT /recipes/{id} — update recipe', () => {
    it('returns 200 when contributor updates their own recipe', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: publishedRecipeItem({ authorId: 'contributor-user-id', title: 'Updated Title' }),
      })

      const event = makeEvent({
        routeKey: 'PUT /recipes/{id}',
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
        routeKey: 'PUT /recipes/{id}',
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
        routeKey: 'PUT /recipes/{id}',
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
        routeKey: 'PUT /recipes/{id}',
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
        routeKey: 'PUT /recipes/{id}',
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

  // ─── PATCH /recipes/{id}/publish ────────────────────────────────────
  describe('PATCH /recipes/{id}/publish — publish recipe', () => {
    it('returns 200 and sets status to published', async () => {
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
        headers: { authorization: `Bearer ${contributorToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.status).toBe('published')
    })

    it('returns 403 when contributor publishes another user\'s recipe', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: draftRecipeItem({ authorId: 'other-contributor-id' }),
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
  })

  // ─── PATCH /recipes/{id}/unpublish ──────────────────────────────────
  describe('PATCH /recipes/{id}/unpublish — unpublish recipe', () => {
    it('returns 200 and sets status to draft', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'contributor-user-id' }),
      })
      ddbMock.on(UpdateCommand).resolves({
        Attributes: draftRecipeItem({ authorId: 'contributor-user-id' }),
      })

      const event = makeEvent({
        routeKey: 'PATCH /recipes/{id}/unpublish',
        rawPath: '/recipes/recipe-uuid-1/unpublish',
        pathParameters: { id: 'recipe-uuid-1' },
        headers: { authorization: `Bearer ${contributorToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body.status).toBe('draft')
    })

    it('returns 403 when contributor unpublishes another user\'s recipe', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: publishedRecipeItem({ authorId: 'other-contributor-id' }),
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

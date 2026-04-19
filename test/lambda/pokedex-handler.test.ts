import { DynamoDBClient, ScanCommand, GetItemCommand } from '@aws-sdk/client-dynamodb'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { mockClient } from 'aws-sdk-client-mock'

const ddbMock = mockClient(DynamoDBClient)

// Import handler after mock setup
import { handler } from '../../lambda/pokedex-handler'

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /pokedex/pokemon',
    rawPath: '/pokedex/pokemon',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      domainName: 'test.execute-api.eu-west-2.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method: 'GET',
        path: '/pokedex/pokemon',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'test-request-id',
      routeKey: 'GET /pokedex/pokemon',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2
}

const samplePokemonItem = {
  id: { N: '1' },
  name: { S: 'Bulbasaur' },
  types: { L: [{ S: 'Grass' }, { S: 'Poison' }] },
  sprite: { S: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/1.png' },
  height: { N: '7' },
  weight: { N: '69' },
  category: { S: 'Seed Pokemon' },
  description: { S: 'A strange seed was planted on its back at birth.' },
  genderRate: { N: '1' },
  stats: {
    M: {
      hp: { N: '45' },
      attack: { N: '49' },
      defense: { N: '49' },
      specialAttack: { N: '65' },
      specialDefense: { N: '65' },
      speed: { N: '45' },
    },
  },
}

// DynamoDB returns only projected fields for Scan (ProjectionExpression: id, name, types, sprite)
const samplePokemonScanItem = {
  id: { N: '1' },
  name: { S: 'Bulbasaur' },
  types: { L: [{ S: 'Grass' }, { S: 'Poison' }] },
  sprite: { S: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/1.png' },
}

describe('Pokedex Lambda handler', () => {
  beforeEach(() => {
    ddbMock.reset()
  })

  describe('GET /pokedex/pokemon', () => {
    it('returns 200 with pokemon array, count, and nextToken', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [samplePokemonScanItem],
        Count: 1,
        ScannedCount: 1,
      })

      const event = makeEvent({
        routeKey: 'GET /pokedex/pokemon',
        rawPath: '/pokedex/pokemon',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('pokemon')
      expect(body).toHaveProperty('count')
      expect(body).toHaveProperty('nextToken')
      expect(Array.isArray(body.pokemon)).toBe(true)
      expect(body.pokemon[0]).toEqual({
        id: 1,
        name: 'Bulbasaur',
        types: ['Grass', 'Poison'],
        sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/1.png',
      })
      expect(body.count).toBe(1)
      expect(body.nextToken).toBeNull()
    })

    it('returns summary fields only (id, name, types, sprite)', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [samplePokemonScanItem],
        Count: 1,
        ScannedCount: 1,
      })

      const event = makeEvent({
        routeKey: 'GET /pokedex/pokemon',
        rawPath: '/pokedex/pokemon',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      const pokemon = body.pokemon[0]
      expect(Object.keys(pokemon).sort()).toEqual(['id', 'name', 'sprite', 'types'])
    })
  })

  describe('GET /pokedex/pokemon/{id} — valid ID', () => {
    it('returns 200 with full Pokemon detail', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: samplePokemonItem,
      })

      const event = makeEvent({
        routeKey: 'GET /pokedex/pokemon/{id}',
        rawPath: '/pokedex/pokemon/1',
        pathParameters: { id: '1' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({
        id: 1,
        name: 'Bulbasaur',
        types: ['Grass', 'Poison'],
        sprite: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/1.png',
        height: 7,
        weight: 69,
        category: 'Seed Pokemon',
        description: 'A strange seed was planted on its back at birth.',
        genderRate: 1,
        stats: {
          hp: 45,
          attack: 49,
          defense: 49,
          specialAttack: 65,
          specialDefense: 65,
          speed: 45,
        },
      })
    })
  })

  describe('GET /pokedex/pokemon/{id} — invalid ID', () => {
    it('returns 404 when Pokemon is not found in DynamoDB', async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: undefined,
      })

      const event = makeEvent({
        routeKey: 'GET /pokedex/pokemon/{id}',
        rawPath: '/pokedex/pokemon/999',
        pathParameters: { id: '999' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({ error: 'Pokemon not found' })
    })

    it('returns 404 for non-numeric ID', async () => {
      const event = makeEvent({
        routeKey: 'GET /pokedex/pokemon/{id}',
        rawPath: '/pokedex/pokemon/pikachu',
        pathParameters: { id: 'pikachu' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({ error: 'Pokemon not found' })
    })
  })

  describe('Unknown route', () => {
    it('returns 404 for unmatched route', async () => {
      const event = makeEvent({
        routeKey: 'GET /unknown',
        rawPath: '/unknown',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({ error: 'Pokemon not found' })
    })
  })

  describe('Error handling', () => {
    it('returns 500 when DynamoDB throws an error', async () => {
      ddbMock.on(ScanCommand).rejects(new Error('DynamoDB connection failed'))

      const event = makeEvent({
        routeKey: 'GET /pokedex/pokemon',
        rawPath: '/pokedex/pokemon',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(500)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({ error: 'Internal server error' })
    })
  })
})

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { DynamoDBClient, ScanCommand, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'

const client = new DynamoDBClient({})
const TABLE_NAME = process.env.TABLE_NAME || 'pokedex-pokemon'

// Helper to create JSON response
function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const routeKey = event.routeKey

    if (routeKey === 'GET /pokedex/pokemon') {
      // List all Pokemon — summary fields only
      const result = await client.send(new ScanCommand({ TableName: TABLE_NAME }))
      const items = (result.Items || []).map(item => {
        const pokemon = unmarshall(item)
        return { id: pokemon.id, name: pokemon.name, types: pokemon.types, sprite: pokemon.sprite }
      })
      return jsonResponse(200, { pokemon: items, count: items.length, nextToken: null })
    }

    if (routeKey === 'GET /pokedex/pokemon/{id}') {
      const idParam = event.pathParameters?.id
      const id = Number(idParam)
      if (!idParam || isNaN(id)) {
        return jsonResponse(404, { error: 'Pokemon not found' })
      }

      const result = await client.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { id: { N: String(id) } },
      }))

      if (!result.Item) {
        return jsonResponse(404, { error: 'Pokemon not found' })
      }

      return jsonResponse(200, unmarshall(result.Item))
    }

    return jsonResponse(404, { error: 'Pokemon not found' })
  } catch (error) {
    return jsonResponse(500, { error: 'Internal server error' })
  }
}

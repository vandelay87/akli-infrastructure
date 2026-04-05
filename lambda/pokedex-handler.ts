import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { DynamoDBClient, ScanCommand, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'

const client = new DynamoDBClient({})
const TABLE_NAME = process.env.TABLE_NAME!

const ROUTE_LIST = 'GET /pokedex/pokemon'
const ROUTE_DETAIL = 'GET /pokedex/pokemon/{id}'

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

    if (routeKey === ROUTE_LIST) {
      const result = await client.send(new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: 'id, #n, types, sprite',
        ExpressionAttributeNames: { '#n': 'name' },
      }))
      const items = (result.Items || []).map(item => unmarshall(item))
      return jsonResponse(200, { pokemon: items, count: items.length, nextToken: null })
    }

    if (routeKey === ROUTE_DETAIL) {
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

import { DynamoDBClient, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { mockClient } from 'aws-sdk-client-mock'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'

const ddbMock = mockClient(DynamoDBClient)

process.env.TABLE_NAME = 'pokedex-pokemon'
process.env.POKEMON_DATA_PATH = require('path').join(__dirname, '..', '..', 'data', 'pokemon.json')

import { onEvent } from '../../lambda/seed-pokemon'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pokemonData: unknown[] = require('../../data/pokemon.json')

function makeEvent(
  requestType: 'Create' | 'Update' | 'Delete',
  overrides: Partial<CloudFormationCustomResourceEvent> = {},
): CloudFormationCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken: 'arn:aws:lambda:eu-west-2:123456789012:function:test',
    ResponseURL: 'https://cloudformation-custom-resource-response.s3.amazonaws.com/test',
    StackId: 'arn:aws:cloudformation:eu-west-2:123456789012:stack/test/guid',
    RequestId: 'test-request-id',
    ResourceType: 'Custom::SeedPokemon',
    LogicalResourceId: 'SeedPokemon',
    ResourceProperties: {
      ServiceToken: 'arn:aws:lambda:eu-west-2:123456789012:function:test',
      DataHash: 'abc123',
    },
    PhysicalResourceId: 'seed-pokemon',
    ...overrides,
  } as CloudFormationCustomResourceEvent
}

describe('seed-pokemon onEvent', () => {
  beforeEach(() => {
    ddbMock.reset()
  })

  describe('Create event', () => {
    it('calls BatchWriteItem with correct data from pokemon.json', async () => {
      ddbMock.on(BatchWriteItemCommand).resolves({ UnprocessedItems: {} })

      await onEvent(makeEvent('Create'))

      const calls = ddbMock.commandCalls(BatchWriteItemCommand)
      // 151 pokemon / 25 per batch = 7 batches (6 full + 1 partial)
      expect(calls.length).toBe(Math.ceil(pokemonData.length / 25))

      // Verify first batch contains first 25 pokemon
      const firstCallInput = calls[0].args[0].input
      const firstBatchRequests = firstCallInput.RequestItems!['pokedex-pokemon']
      expect(firstBatchRequests).toHaveLength(25)
    })
  })

  describe('Update event', () => {
    it('calls BatchWriteItem (idempotent reseed)', async () => {
      ddbMock.on(BatchWriteItemCommand).resolves({ UnprocessedItems: {} })

      await onEvent(makeEvent('Update'))

      const calls = ddbMock.commandCalls(BatchWriteItemCommand)
      expect(calls.length).toBe(Math.ceil(pokemonData.length / 25))
    })
  })

  describe('Delete event', () => {
    it('is a no-op and returns success', async () => {
      const result = await onEvent(makeEvent('Delete'))

      expect(result.PhysicalResourceId).toBe('seed-pokemon')
      const calls = ddbMock.commandCalls(BatchWriteItemCommand)
      expect(calls.length).toBe(0)
    })
  })

  describe('UnprocessedItems retry', () => {
    it('retries when BatchWriteItem returns UnprocessedItems', async () => {
      // First call for first batch returns unprocessed items, second call succeeds
      const unprocessedItem = {
        PutRequest: {
          Item: { id: { N: '1' }, name: { S: 'Bulbasaur' } },
        },
      }

      let firstBatchCallCount = 0
      ddbMock.on(BatchWriteItemCommand).callsFake((input) => {
        const requests = input.RequestItems!['pokedex-pokemon']
        // Only simulate unprocessed items for the first batch (25 items)
        if (requests.length === 25 && firstBatchCallCount === 0) {
          firstBatchCallCount++
          return {
            UnprocessedItems: {
              'pokedex-pokemon': [unprocessedItem],
            },
          }
        }
        return { UnprocessedItems: {} }
      })

      await onEvent(makeEvent('Create'))

      const calls = ddbMock.commandCalls(BatchWriteItemCommand)
      // Normal batches + 1 retry for the first batch
      const expectedBatches = Math.ceil(pokemonData.length / 25)
      expect(calls.length).toBe(expectedBatches + 1)
    })
  })
})

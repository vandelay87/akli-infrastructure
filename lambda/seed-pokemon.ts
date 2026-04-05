import { DynamoDBClient, BatchWriteItemCommand, BatchWriteItemCommandOutput, WriteRequest } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import type { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda'
import * as fs from 'fs'
import * as path from 'path'

const client = new DynamoDBClient({})
const TABLE_NAME = process.env.TABLE_NAME!

const BATCH_SIZE = 25
const MAX_RETRIES = 5
const BASE_DELAY_MS = 100

interface Pokemon {
  readonly id: number
  readonly name: string
  readonly types: readonly string[]
  readonly sprite: string
  readonly height: number
  readonly weight: number
  readonly category: string
  readonly description: string
  readonly genderRate: number
  readonly stats: {
    readonly hp: number
    readonly attack: number
    readonly defense: number
    readonly specialAttack: number
    readonly specialDefense: number
    readonly speed: number
  }
}

function loadPokemonData(): Pokemon[] {
  const dataPath = path.join(__dirname, '..', 'data', 'pokemon.json')
  const raw = fs.readFileSync(dataPath, 'utf-8')
  return JSON.parse(raw) as Pokemon[]
}

async function seedTable(pokemon: Pokemon[]): Promise<void> {
  for (let i = 0; i < pokemon.length; i += BATCH_SIZE) {
    const batch = pokemon.slice(i, i + BATCH_SIZE)
    const writeRequests = batch.map(p => ({
      PutRequest: {
        Item: marshall(p, { removeUndefinedValues: true }),
      },
    }))

    let unprocessed: WriteRequest[] | undefined = writeRequests
    let retries = 0

    while (unprocessed && unprocessed.length > 0 && retries <= MAX_RETRIES) {
      if (retries > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, retries - 1)
        await new Promise(resolve => setTimeout(resolve, delay))
      }

      const result: BatchWriteItemCommandOutput = await client.send(new BatchWriteItemCommand({
        RequestItems: { [TABLE_NAME]: unprocessed },
      }))

      const remaining = result.UnprocessedItems?.[TABLE_NAME]
      unprocessed = remaining && remaining.length > 0 ? remaining : undefined
      retries++
    }

    if (unprocessed && unprocessed.length > 0) {
      throw new Error(`Failed to write all items after ${MAX_RETRIES} retries`)
    }
  }
}

export async function onEvent(
  event: CloudFormationCustomResourceEvent,
): Promise<Partial<CloudFormationCustomResourceResponse>> {
  const requestType = event.RequestType

  const physicalId = event.RequestType === 'Create'
    ? 'seed-pokemon'
    : event.PhysicalResourceId

  if (requestType === 'Delete') {
    return { PhysicalResourceId: physicalId }
  }

  // Create and Update both seed (idempotent — PutItem overwrites)
  const pokemon = loadPokemonData()
  await seedTable(pokemon)

  return { PhysicalResourceId: physicalId }
}

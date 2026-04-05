import { Duration, Stack, StackProps, Tags } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as path from 'path'

export class PokedexStack extends Stack {
  public readonly pokemonFunction: NodejsFunction

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const table = new dynamodb.Table(this, 'PokemonTable', {
      tableName: 'pokedex-pokemon',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    })

    this.pokemonFunction = new NodejsFunction(this, 'PokemonHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      entry: path.join(__dirname, '..', 'lambda', 'pokedex-handler.ts'),
      handler: 'handler',
      environment: {
        TABLE_NAME: table.tableName,
      },
    })

    table.grantReadData(this.pokemonFunction)

    // StackProps.tags don't auto-propagate to resources — must apply explicitly
    if (props?.tags) {
      for (const [key, value] of Object.entries(props.tags)) {
        Tags.of(this).add(key, value)
      }
    }
  }
}

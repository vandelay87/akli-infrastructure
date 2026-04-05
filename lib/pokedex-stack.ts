import { Stack, StackProps, Tags } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'

export class PokedexStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    new dynamodb.Table(this, 'PokemonTable', {
      tableName: 'pokedex-pokemon',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    })

    // Propagate stack-level tags to all resources
    if (props?.tags) {
      for (const [key, value] of Object.entries(props.tags)) {
        Tags.of(this).add(key, value)
      }
    }
  }
}

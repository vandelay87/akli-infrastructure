import { CfnOutput, CustomResource, Duration, Stack, StackProps, Tags } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { Provider } from 'aws-cdk-lib/custom-resources'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export class PokedexStack extends Stack {
  public readonly pokemonFunction: NodejsFunction
  public readonly httpApi: HttpApi

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const table = new dynamodb.Table(this, 'PokemonTable', {
      tableName: 'pokedex-pokemon',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    })

    // Seed DynamoDB from data/pokemon.json via Custom Resource
    const pokemonDataPath = path.join(__dirname, '..', 'data', 'pokemon.json')
    const pokemonDataHash = crypto
      .createHash('md5')
      .update(fs.readFileSync(pokemonDataPath, 'utf-8'))
      .digest('hex')

    const seederFunction = new NodejsFunction(this, 'SeedPokemonHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.minutes(5),
      entry: path.join(__dirname, '..', 'lambda', 'seed-pokemon.ts'),
      handler: 'onEvent',
      environment: {
        TABLE_NAME: table.tableName,
      },
    })

    table.grant(seederFunction, 'dynamodb:BatchWriteItem')

    const seedProvider = new Provider(this, 'SeedPokemonProvider', {
      onEventHandler: seederFunction,
    })

    new CustomResource(this, 'SeedPokemonResource', {
      serviceToken: seedProvider.serviceToken,
      properties: {
        DataHash: pokemonDataHash,
      },
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

    // HTTP API Gateway (v2) for the Pokedex API
    const pokemonIntegration = new HttpLambdaIntegration('PokemonIntegration', this.pokemonFunction)

    this.httpApi = new HttpApi(this, 'PokedexHttpApi', {
      apiName: 'pokedex-api',
      description: 'HTTP API Gateway for the Pokedex API',
      corsPreflight: {
        allowOrigins: ['https://akli.dev'],
        allowMethods: [CorsHttpMethod.GET],
        allowHeaders: ['Content-Type'],
      },
    })

    this.httpApi.addRoutes({
      path: '/pokedex/pokemon',
      methods: [HttpMethod.GET],
      integration: pokemonIntegration,
    })

    this.httpApi.addRoutes({
      path: '/pokedex/pokemon/{id}',
      methods: [HttpMethod.GET],
      integration: pokemonIntegration,
    })

    new CfnOutput(this, 'PokedexApiUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'Pokedex HTTP API Gateway endpoint URL',
    })

    // StackProps.tags don't auto-propagate to resources — must apply explicitly
    if (props?.tags) {
      for (const [key, value] of Object.entries(props.tags)) {
        Tags.of(this).add(key, value)
      }
    }
  }
}

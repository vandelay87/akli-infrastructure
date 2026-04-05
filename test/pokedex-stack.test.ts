import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { PokedexStack } from '../lib/pokedex-stack'

function createTestStack(): Template {
  const app = new cdk.App()

  cdk.Tags.of(app).add('Owner', 'Akli')
  cdk.Tags.of(app).add('CostCenter', 'Pokedex')

  const stack = new PokedexStack(app, 'TestPokedexStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    tags: {
      Project: 'pokedex',
      Environment: 'production',
      ManagedBy: 'cdk',
    },
  })

  return Template.fromStack(stack)
}

describe('PokedexStack', () => {
  let template: Template

  beforeAll(() => {
    template = createTestStack()
  })

  describe('DynamoDB table', () => {
    it('creates a DynamoDB table named pokedex-pokemon', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'pokedex-pokemon',
      })
    })

    it('has partition key id of type Number', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: [
          { AttributeName: 'id', KeyType: 'HASH' },
        ],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: 'id', AttributeType: 'N' },
        ]),
      })
    })

    it('uses on-demand billing (PAY_PER_REQUEST)', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
      })
    })

    it('does not define a sort key', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: Match.exact([
          { AttributeName: 'id', KeyType: 'HASH' },
        ]),
      })
    })

    it('does not define any GSIs', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        GlobalSecondaryIndexes: Match.absent(),
      })
    })
  })

  describe('Lambda function', () => {
    it('creates a Lambda function with Node.js 22 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
      })
    })

    it('configures 256 MB memory', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 256,
      })
    })

    it('configures 10 second timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 10,
      })
    })
  })

  describe('Lambda IAM permissions', () => {
    it('grants dynamodb:GetItem and dynamodb:Scan actions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'dynamodb:GetItem',
                'dynamodb:Scan',
              ]),
              Effect: 'Allow',
            }),
          ]),
        },
      })
    })

    it('scopes DynamoDB access to the Pokedex table ARN (not wildcard)', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'dynamodb:GetItem',
                'dynamodb:Scan',
              ]),
              Effect: 'Allow',
              Resource: Match.not('*'),
            }),
          ]),
        },
      })
    })
  })

  describe('HTTP API Gateway', () => {
    it('creates an HTTP API (ApiGatewayV2)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        ProtocolType: 'HTTP',
      })
    })

    it('configures CORS to allow https://akli.dev', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        CorsConfiguration: Match.objectLike({
          AllowOrigins: Match.arrayWith(['https://akli.dev']),
        }),
      })
    })

    it('has a GET /pokedex/pokemon route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'GET /pokedex/pokemon',
      })
    })

    it('has a GET /pokedex/pokemon/{id} route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'GET /pokedex/pokemon/{id}',
      })
    })

    it('exports the API URL as a CloudFormation output', () => {
      template.hasOutput('PokedexApiUrl', {})
    })
  })

  describe('Tags', () => {
    it('tags all resources with Owner', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Owner', Value: 'Akli' }),
        ]),
      })
    })

    it('tags all resources with CostCenter', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'CostCenter', Value: 'Pokedex' }),
        ]),
      })
    })

    it('tags all resources with Project=pokedex', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Project', Value: 'pokedex' }),
        ]),
      })
    })

    it('tags all resources with Environment', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'production' }),
        ]),
      })
    })

    it('tags all resources with ManagedBy=cdk', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'cdk' }),
        ]),
      })
    })
  })
})

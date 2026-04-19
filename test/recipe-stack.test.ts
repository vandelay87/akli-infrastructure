import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { RecipeStack } from '../lib/recipe-stack'

function createTestStack(): Template {
  const app = new cdk.App()

  cdk.Tags.of(app).add('Owner', 'Akli')
  cdk.Tags.of(app).add('CostCenter', 'Recipes')

  const stack = new RecipeStack(app, 'TestRecipeStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    userPoolId: 'eu-west-2_TestPool123',
    userPoolClientId: 'test-client-id-abc',
    userPoolArn: 'arn:aws:cognito-idp:eu-west-2:123456789012:userpool/eu-west-2_TestPool123',
    tags: {
      Project: 'recipes',
      Environment: 'production',
      ManagedBy: 'cdk',
    },
  })

  return Template.fromStack(stack)
}

describe('RecipeStack', () => {
  let template: Template

  beforeAll(() => {
    template = createTestStack()
  })

  describe('DynamoDB table', () => {
    it('creates a DynamoDB table named recipes', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'recipes',
      })
    })

    it('has partition key id of type String', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: [
          { AttributeName: 'id', KeyType: 'HASH' },
        ],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: 'id', AttributeType: 'S' },
        ]),
      })
    })

    it('uses on-demand billing (PAY_PER_REQUEST)', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
      })
    })

    it('enables Point-in-Time Recovery', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      })
    })
  })

  describe('DynamoDB TTL', () => {
    it('enables native TTL on the recipes table using the ttl attribute', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', Match.objectLike({
        TableName: 'recipes',
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
      }))
    })

    it('does not include ttl in the recipes table AttributeDefinitions (TTL is metadata, not a key)', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', Match.objectLike({
        TableName: 'recipes',
        AttributeDefinitions: Match.not(Match.arrayWith([
          Match.objectLike({ AttributeName: 'ttl' }),
        ])),
      }))
    })
  })

  describe('GSI status-createdAt-index', () => {
    it('creates GSI with name status-createdAt-index', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'status-createdAt-index',
          }),
        ]),
      })
    })

    it('has partition key status (String)', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'status-createdAt-index',
            KeySchema: Match.arrayWith([
              { AttributeName: 'status', KeyType: 'HASH' },
            ]),
          }),
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: 'status', AttributeType: 'S' },
        ]),
      })
    })

    it('has sort key createdAt (String)', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'status-createdAt-index',
            KeySchema: Match.arrayWith([
              { AttributeName: 'createdAt', KeyType: 'RANGE' },
            ]),
          }),
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: 'createdAt', AttributeType: 'S' },
        ]),
      })
    })
  })

  describe('GSI authorId-createdAt-index', () => {
    it('creates GSI with name authorId-createdAt-index', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'authorId-createdAt-index',
          }),
        ]),
      })
    })

    it('has partition key authorId (String)', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'authorId-createdAt-index',
            KeySchema: Match.arrayWith([
              { AttributeName: 'authorId', KeyType: 'HASH' },
            ]),
          }),
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: 'authorId', AttributeType: 'S' },
        ]),
      })
    })

    it('has sort key createdAt (String)', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'authorId-createdAt-index',
            KeySchema: Match.arrayWith([
              { AttributeName: 'createdAt', KeyType: 'RANGE' },
            ]),
          }),
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: 'createdAt', AttributeType: 'S' },
        ]),
      })
    })
  })

  describe('S3 image bucket', () => {
    it('creates an S3 bucket named akli-recipe-images-{account-id}-eu-west-2', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'akli-recipe-images-123456789012-eu-west-2',
      })
    })

    it('blocks all public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      })
    })

    it('has a lifecycle rule to abort incomplete multipart uploads after 1 day', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              AbortIncompleteMultipartUpload: {
                DaysAfterInitiation: 1,
              },
              Status: 'Enabled',
            }),
          ]),
        },
      })
    })

    it('allows PUT from https://akli.dev via CORS', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        CorsConfiguration: {
          CorsRules: Match.arrayWith([
            Match.objectLike({
              AllowedMethods: Match.arrayWith(['PUT']),
              AllowedOrigins: Match.arrayWith(['https://akli.dev']),
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
  })

  describe('CORS', () => {
    it('configures CORS to allow https://akli.dev', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        CorsConfiguration: Match.objectLike({
          AllowOrigins: Match.arrayWith(['https://akli.dev']),
        }),
      })
    })

    it('allows GET, POST, PUT, PATCH, and DELETE methods', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        CorsConfiguration: Match.objectLike({
          AllowMethods: Match.arrayWith(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        }),
      })
    })

    it('allows Content-Type and Authorization headers', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        CorsConfiguration: Match.objectLike({
          AllowHeaders: Match.arrayWith(['Content-Type', 'Authorization']),
        }),
      })
    })
  })

  describe('Routes', () => {
    it('has a GET /recipes route (public)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'GET /recipes',
        AuthorizationType: 'NONE',
      })
    })

    it('has a GET /recipes/{slug} route (public)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'GET /recipes/{slug}',
        AuthorizationType: 'NONE',
      })
    })

    it('has a GET /recipes/tags route (public)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'GET /recipes/tags',
        AuthorizationType: 'NONE',
      })
    })

    it('has a GET /me/recipes route (protected)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'GET /me/recipes',
        AuthorizationType: 'JWT',
      })
    })

    it('has a PATCH /recipes/{id} route (protected)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', Match.objectLike({
        RouteKey: 'PATCH /recipes/{id}',
        AuthorizationType: 'JWT',
        AuthorizerId: Match.anyValue(),
      }))
    })

    it('does not expose the old PUT /recipes/{id} route', () => {
      template.resourcePropertiesCountIs('AWS::ApiGatewayV2::Route', {
        RouteKey: 'PUT /recipes/{id}',
      }, 0)
    })

    it('has a PATCH /recipes/{id}/publish route (protected)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'PATCH /recipes/{id}/publish',
        AuthorizationType: 'JWT',
      })
    })

    it('has a PATCH /recipes/{id}/unpublish route (protected)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'PATCH /recipes/{id}/unpublish',
        AuthorizationType: 'JWT',
      })
    })

    it('has a DELETE /recipes/{id} route (protected)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'DELETE /recipes/{id}',
        AuthorizationType: 'JWT',
      })
    })

    it('has a POST /recipes/images/upload-url route (protected)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /recipes/images/upload-url',
        AuthorizationType: 'JWT',
      })
    })

    const adminRoutes = [
      'POST /recipes/drafts',
      'GET /recipes/admin',
      'PATCH /recipes/{id}',
      'PATCH /recipes/{id}/publish',
      'PATCH /recipes/{id}/unpublish',
      'DELETE /recipes/{id}',
    ]

    it.each(adminRoutes)('route %s has AuthorizationType: JWT', (routeKey) => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', Match.objectLike({
        RouteKey: routeKey,
        AuthorizationType: 'JWT',
        AuthorizerId: Match.anyValue(),
      }))
    })

    it('does not expose the old POST /recipes route', () => {
      template.resourcePropertiesCountIs('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /recipes',
      }, 0)
    })
  })

  describe('IAM — recipe handler role', () => {
    it('grants s3:DeleteObject on the image bucket', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['s3:DeleteObject*']),
              Effect: 'Allow',
            }),
          ]),
        }),
      })
    })
  })

  describe('POST /recipes/drafts route', () => {
    it('has a POST /recipes/drafts route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /recipes/drafts',
      })
    })

    it('is protected by the JWT authoriser', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', Match.objectLike({
        RouteKey: 'POST /recipes/drafts',
        AuthorizationType: 'JWT',
        AuthorizerId: Match.anyValue(),
      }))
    })
  })

  describe('GET /recipes/admin route', () => {
    it('has a GET /recipes/admin route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'GET /recipes/admin',
      })
    })

    it('is protected by the JWT authoriser', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', Match.objectLike({
        RouteKey: 'GET /recipes/admin',
        AuthorizationType: 'JWT',
        AuthorizerId: Match.anyValue(),
      }))
    })
  })

  describe('JWT Authoriser', () => {
    it('creates a JWT authoriser', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        AuthorizerType: 'JWT',
        IdentitySource: Match.arrayWith(['$request.header.Authorization']),
      })
    })

    it('configures the JWT authoriser with Issuer and Audience', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        JwtConfiguration: Match.objectLike({
          Issuer: Match.anyValue(),
          Audience: Match.anyValue(),
        }),
      })
    })
  })

  describe('Tags', () => {
    it('tags the table with Owner', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Owner', Value: 'Akli' }),
        ]),
      })
    })

    it('tags the table with CostCenter', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'CostCenter', Value: 'Recipes' }),
        ]),
      })
    })

    it('tags the table with Project=recipes', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Project', Value: 'recipes' }),
        ]),
      })
    })

    it('tags the table with Environment=production', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'production' }),
        ]),
      })
    })

    it('tags the table with ManagedBy=cdk', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'cdk' }),
        ]),
      })
    })
  })
})

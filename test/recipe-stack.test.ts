import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { RecipeStack } from '../lib/recipe-stack'

function createTestStack(): Template {
  const app = new cdk.App()

  cdk.Tags.of(app).add('Owner', 'Akli')
  cdk.Tags.of(app).add('CostCenter', 'Recipes')

  const stack = new RecipeStack(app, 'TestRecipeStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
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

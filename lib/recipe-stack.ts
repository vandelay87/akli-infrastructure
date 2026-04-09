import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { applyStackTags } from './utils'

export class RecipeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const table = new dynamodb.Table(this, 'RecipesTable', {
      tableName: 'recipes',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    })

    table.addGlobalSecondaryIndex({
      indexName: 'status-createdAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    })

    table.addGlobalSecondaryIndex({
      indexName: 'authorId-createdAt-index',
      partitionKey: { name: 'authorId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    })

    new s3.Bucket(this, 'RecipeImagesBucket', {
      bucketName: `akli-recipe-images-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['https://akli.dev'],
          allowedHeaders: ['*'],
        },
      ],
    })

    applyStackTags(this, props)
  }
}

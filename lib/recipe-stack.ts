import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { CorsHttpMethod, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3n from 'aws-cdk-lib/aws-s3-notifications'
import * as path from 'path'
import { applyStackTags } from './utils'

interface RecipeStackProps extends StackProps {
  userPoolId: string
  userPoolClientId: string
  userPoolArn: string
}

export class RecipeStack extends Stack {
  public readonly httpApi: HttpApi

  constructor(scope: Construct, id: string, props: RecipeStackProps) {
    super(scope, id, props)

    const { userPoolId, userPoolClientId, userPoolArn } = props

    // DynamoDB table
    const table = new dynamodb.Table(this, 'RecipesTable', {
      tableName: 'recipes',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
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

    // S3 image bucket
    const imageBucket = new s3.Bucket(this, 'RecipeImagesBucket', {
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

    // HTTP API with CORS
    this.httpApi = new HttpApi(this, 'RecipeHttpApi', {
      apiName: 'recipe-api',
      corsPreflight: {
        allowOrigins: ['https://akli.dev'],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    })

    // Lambda functions
    const recipeHandler = new NodejsFunction(this, 'RecipeHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      entry: path.join(__dirname, '..', 'lambda', 'recipe-handler.ts'),
      handler: 'handler',
      functionName: 'akli-recipe-handler',
      environment: {
        TABLE_NAME: table.tableName,
        IMAGE_BUCKET_NAME: imageBucket.bucketName,
      },
    })

    table.grantReadWriteData(recipeHandler)
    imageBucket.grantRead(recipeHandler)
    imageBucket.grantDelete(recipeHandler)

    const recipeImageHandler = new NodejsFunction(this, 'RecipeImageHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      entry: path.join(__dirname, '..', 'lambda', 'recipe-image-handler.ts'),
      handler: 'handler',
      functionName: 'akli-recipe-image-handler',
      environment: {
        IMAGE_BUCKET_NAME: imageBucket.bucketName,
      },
    })

    imageBucket.grantPut(recipeImageHandler)

    const imageResizer = new NodejsFunction(this, 'ImageResizer', {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
      entry: path.join(__dirname, '..', 'lambda', 'image-resizer.ts'),
      handler: 'handler',
      functionName: 'akli-image-resizer',
      environment: {
        IMAGE_BUCKET_NAME: imageBucket.bucketName,
      },
    })

    imageBucket.grantReadWrite(imageResizer)
    imageBucket.grantDelete(imageResizer)

    // S3 event notification for image uploads
    imageBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(imageResizer),
      { prefix: 'uploads/' },
    )

    // JWT Authoriser — IdentitySource must be an array for CFN early validation
    const jwtAuthorizer = new apigwv2.CfnAuthorizer(this, 'JwtAuthorizer', {
      apiId: this.httpApi.httpApiId,
      authorizerType: 'JWT',
      identitySource: ['$request.header.Authorization'],
      name: 'cognito-jwt',
      jwtConfiguration: {
        issuer: `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}`,
        audience: [userPoolClientId],
      },
    })

    // API Gateway Integrations
    const recipeIntegration = new apigwv2.CfnIntegration(this, 'RecipeHandlerIntegration', {
      apiId: this.httpApi.httpApiId,
      integrationType: 'AWS_PROXY',
      integrationUri: recipeHandler.functionArn,
      payloadFormatVersion: '2.0',
    })

    const recipeImageIntegration = new apigwv2.CfnIntegration(this, 'RecipeImageHandlerIntegration', {
      apiId: this.httpApi.httpApiId,
      integrationType: 'AWS_PROXY',
      integrationUri: recipeImageHandler.functionArn,
      payloadFormatVersion: '2.0',
    })

    // Grant API Gateway invoke permissions
    recipeHandler.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.httpApi.httpApiId}/*/*`,
    })

    recipeImageHandler.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.httpApi.httpApiId}/*/*`,
    })

    // Public Routes (AuthorizationType: NONE)
    new apigwv2.CfnRoute(this, 'GetRecipesRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'GET /recipes',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'NONE',
    })

    new apigwv2.CfnRoute(this, 'GetRecipeBySlugRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'GET /recipes/{slug}',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'NONE',
    })

    new apigwv2.CfnRoute(this, 'GetRecipeTagsRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'GET /recipes/tags',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'NONE',
    })

    // Protected Routes (AuthorizationType: JWT)
    new apigwv2.CfnRoute(this, 'GetMyRecipesRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'GET /me/recipes',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'CreateRecipeRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'POST /recipes',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'UpdateRecipeRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'PUT /recipes/{id}',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'PublishRecipeRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'PATCH /recipes/{id}/publish',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'UnpublishRecipeRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'PATCH /recipes/{id}/unpublish',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'DeleteRecipeRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'DELETE /recipes/{id}',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'UploadImageUrlRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'POST /recipes/images/upload-url',
      target: `integrations/${recipeImageIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    applyStackTags(this, props)
  }
}

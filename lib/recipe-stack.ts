import * as path from 'path'
import type { StackProps } from 'aws-cdk-lib'
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { CorsHttpMethod, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3n from 'aws-cdk-lib/aws-s3-notifications'
import type { Construct } from 'constructs'
import { applyStackTags } from './utils'

interface RecipeStackProps extends StackProps {
  userPoolId: string
  userPoolClientId: string
  userPoolArn: string
}

export class RecipeStack extends Stack {
  public readonly httpApi: HttpApi
  public readonly imageBucket: s3.IBucket

  constructor(scope: Construct, id: string, props: RecipeStackProps) {
    super(scope, id, props)

    const { userPoolId, userPoolClientId } = props

    // DynamoDB table
    const table = new dynamodb.Table(this, 'RecipesTable', {
      tableName: 'recipes',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
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

    table.addGlobalSecondaryIndex({
      indexName: 'slug-index',
      partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
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
    this.imageBucket = imageBucket

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
        TABLE_NAME: table.tableName,
      },
    })

    imageBucket.grantPut(recipeImageHandler)
    recipeImageHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [table.tableArn],
    }))

    const imageResizer = new NodejsFunction(this, 'ImageResizer', {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
      entry: path.join(__dirname, '..', 'lambda', 'image-resizer.ts'),
      handler: 'handler',
      functionName: 'akli-image-resizer',
      environment: {
        IMAGE_BUCKET_NAME: imageBucket.bucketName,
        TABLE_NAME: table.tableName,
      },
      // sharp ships native binaries — bundle in Docker so the linux-x64 binary
      // is installed instead of the host's (e.g. darwin) binary. beforeInstall:
      // (1) the pnpm baked into CDK's bundling image hits a URLSearchParams bug
      // on Node 22, so install a current pnpm to a writable prefix; (2) pnpm 10
      // blocks install scripts by default — allowlist sharp so its postinstall
      // can fetch the linux-x64 binary.
      //
      // Under Jest the binary is irrelevant — Template.fromStack only asserts
      // CloudFormation properties — so skip Docker and bundle with local esbuild,
      // leaving sharp and the AWS SDK external so esbuild walks neither graph.
      // Keeps the test suite fast and Docker-free; real deploys take the Docker
      // path above.
      bundling: process.env.JEST_WORKER_ID
        ? { externalModules: ['sharp', '@aws-sdk/*'] }
        : {
            nodeModules: ['sharp'],
            forceDockerBundling: true,
            commandHooks: {
              beforeBundling: () => [],
              afterBundling: () => [],
              beforeInstall: (_inputDir, outputDir) => [
                'export HOME=/tmp && mkdir -p /tmp/pnpm-bin && npm install --prefix /tmp/pnpm-bin pnpm@10.33.2 && export PATH=/tmp/pnpm-bin/node_modules/.bin:$PATH',
                `echo 'only-built-dependencies[]=sharp' > ${outputDir}/.npmrc`,
              ],
            },
          },
    })

    imageBucket.grantReadWrite(imageResizer)
    imageBucket.grantDelete(imageResizer)
    // Narrow ARN (no GSI wildcards): table.grant() would add /index/* which UpdateItem cannot target.
    imageResizer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [table.tableArn],
    }))
    imageResizer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${table.tableArn}/index/slug-index`],
    }))

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

    new apigwv2.CfnRoute(this, 'AdminListRecipesRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'GET /recipes/admin',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'AdminGetRecipeByIdRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'GET /recipes/admin/{id}',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'CreateDraftRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'POST /recipes/drafts',
      target: `integrations/${recipeIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'UpdateRecipeRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'PATCH /recipes/{id}',
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

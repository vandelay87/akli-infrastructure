import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { CorsHttpMethod, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Provider } from 'aws-cdk-lib/custom-resources'
import * as path from 'path'
import { applyStackTags } from './utils'

export class AuthStack extends Stack {
  public readonly httpApi: HttpApi
  public readonly userPoolId: string
  public readonly userPoolClientId: string
  public readonly userPoolArn: string

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // Cognito User Pool
    const userPool = new cognito.UserPool(this, 'AuthUserPool', {
      userPoolName: 'akli-auth-user-pool',
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      userInvitation: {
        emailSubject: 'Your akli.dev account invitation',
        emailBody:
          'Hello {username}, you have been invited to join akli.dev. Your temporary password is {####}.',
      },
      removalPolicy: RemovalPolicy.RETAIN,
    })

    this.userPoolId = userPool.userPoolId
    this.userPoolArn = userPool.userPoolArn

    // User Pool Client
    const userPoolClient = new cognito.CfnUserPoolClient(this, 'AuthUserPoolClient', {
      userPoolId: userPool.userPoolId,
      clientName: 'akli-auth-client',
      explicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      accessTokenValidity: 1,
      refreshTokenValidity: 30,
      tokenValidityUnits: {
        accessToken: 'hours',
        refreshToken: 'days',
      },
    })

    this.userPoolClientId = userPoolClient.ref

    // Cognito Groups
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'admin',
    })

    new cognito.CfnUserPoolGroup(this, 'ContributorGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'contributor',
    })

    // Seed Admin Custom Resource
    const adminSecretName = 'akli/auth/admin-credentials'
    const adminSecret = secretsmanager.Secret.fromSecretNameV2(this, 'AdminSecret', adminSecretName)

    const seedAdminFunction = new NodejsFunction(this, 'SeedAdminHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(30),
      entry: path.join(__dirname, '..', 'lambda', 'seed-admin.ts'),
      handler: 'onEvent',
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        ADMIN_SECRET_NAME: adminSecretName,
      },
    })

    seedAdminFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup'],
      resources: [userPool.userPoolArn],
    }))

    adminSecret.grantRead(seedAdminFunction)

    const seedAdminProvider = new Provider(this, 'SeedAdminProvider', {
      onEventHandler: seedAdminFunction,
    })

    new CustomResource(this, 'SeedAdminResource', {
      serviceToken: seedAdminProvider.serviceToken,
    })

    // HTTP API with CORS
    this.httpApi = new HttpApi(this, 'AuthHttpApi', {
      apiName: 'auth-api',
      corsPreflight: {
        allowOrigins: ['https://akli.dev'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.DELETE],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    })

    // Lambda Functions
    const authHandler = new NodejsFunction(this, 'AuthHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      entry: path.join(__dirname, '..', 'lambda', 'auth-handler.ts'),
      handler: 'handler',
      functionName: 'akli-auth-handler',
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.ref,
      },
    })

    authHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:InitiateAuth', 'cognito-idp:RespondToAuthChallenge'],
      resources: [userPool.userPoolArn],
    }))

    const authAdminHandler = new NodejsFunction(this, 'AuthAdminHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      entry: path.join(__dirname, '..', 'lambda', 'auth-admin-handler.ts'),
      handler: 'handler',
      functionName: 'akli-auth-admin-handler',
      environment: {
        USER_POOL_ID: userPool.userPoolId,
      },
    })

    authAdminHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:ListUsers',
        'cognito-idp:ListUsersInGroup',
      ],
      resources: [userPool.userPoolArn],
    }))

    // JWT Authoriser — IdentitySource must be an array for CFN early validation
    const jwtAuthorizer = new apigwv2.CfnAuthorizer(this, 'JwtAuthorizer', {
      apiId: this.httpApi.httpApiId,
      authorizerType: 'JWT',
      identitySource: ['$request.header.Authorization'],
      name: 'cognito-jwt',
      jwtConfiguration: {
        issuer: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
        audience: [userPoolClient.ref],
      },
    })

    // API Gateway Integrations
    const authIntegration = new apigwv2.CfnIntegration(this, 'AuthHandlerIntegration', {
      apiId: this.httpApi.httpApiId,
      integrationType: 'AWS_PROXY',
      integrationUri: authHandler.functionArn,
      payloadFormatVersion: '2.0',
    })

    const authAdminIntegration = new apigwv2.CfnIntegration(this, 'AuthAdminHandlerIntegration', {
      apiId: this.httpApi.httpApiId,
      integrationType: 'AWS_PROXY',
      integrationUri: authAdminHandler.functionArn,
      payloadFormatVersion: '2.0',
    })

    // Grant API Gateway invoke permissions
    authHandler.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.httpApi.httpApiId}/*/*`,
    })

    authAdminHandler.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${this.httpApi.httpApiId}/*/*`,
    })

    // Public Routes (AuthorizationType: NONE)
    new apigwv2.CfnRoute(this, 'LoginRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'POST /auth/login',
      target: `integrations/${authIntegration.ref}`,
      authorizationType: 'NONE',
    })

    new apigwv2.CfnRoute(this, 'RefreshRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'POST /auth/refresh',
      target: `integrations/${authIntegration.ref}`,
      authorizationType: 'NONE',
    })

    new apigwv2.CfnRoute(this, 'ConfirmNewPasswordRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'POST /auth/confirm-new-password',
      target: `integrations/${authIntegration.ref}`,
      authorizationType: 'NONE',
    })

    // Protected Routes (AuthorizationType: JWT)
    new apigwv2.CfnRoute(this, 'ChangePasswordRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'POST /auth/change-password',
      target: `integrations/${authIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'GetUsersRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'GET /auth/users',
      target: `integrations/${authAdminIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'CreateUserRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'POST /auth/users',
      target: `integrations/${authAdminIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    new apigwv2.CfnRoute(this, 'DeleteUserRoute', {
      apiId: this.httpApi.httpApiId,
      routeKey: 'DELETE /auth/users/{userId}',
      target: `integrations/${authAdminIntegration.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuthorizer.ref,
    })

    // CloudWatch Alarms
    new cloudwatch.Alarm(this, 'FailedLoginAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AuthApi',
        metricName: 'FailedLogins',
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    })

    new cloudwatch.Alarm(this, 'AuthHandlerErrorAlarm', {
      metric: authHandler.metricErrors(),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    })

    new cloudwatch.Alarm(this, 'AuthAdminHandlerErrorAlarm', {
      metric: authAdminHandler.metricErrors(),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    })

    // Stack Outputs
    new CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    })

    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.ref,
      description: 'Cognito User Pool Client ID',
    })

    applyStackTags(this, props)
  }
}

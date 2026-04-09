import { CfnOutput, CustomResource, Duration, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Provider } from 'aws-cdk-lib/custom-resources'
import * as path from 'path'
import { applyStackTags } from './utils'

export class AuthStack extends Stack {
  public readonly httpApi!: HttpApi

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
    })

    // User Pool Client
    const userPoolClient = new cognito.CfnUserPoolClient(this, 'AuthUserPoolClient', {
      userPoolId: userPool.userPoolId,
      clientName: 'akli-auth-client',
      explicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      accessTokenValidity: 1,
      refreshTokenValidity: 30,
      tokenValidityUnits: {
        accessToken: 'hours',
        refreshToken: 'days',
      },
    })

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

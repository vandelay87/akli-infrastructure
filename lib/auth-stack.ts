import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2'
import * as cognito from 'aws-cdk-lib/aws-cognito'
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

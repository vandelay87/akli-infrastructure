import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { AuthStack } from '../lib/auth-stack'

function createTestStack(): Template {
  const app = new cdk.App()

  cdk.Tags.of(app).add('Owner', 'Akli')
  cdk.Tags.of(app).add('CostCenter', 'Auth')

  const stack = new AuthStack(app, 'TestAuthStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    tags: {
      Project: 'auth',
      Environment: 'production',
      ManagedBy: 'cdk',
    },
  })

  return Template.fromStack(stack)
}

describe('AuthStack', () => {
  let template: Template

  beforeAll(() => {
    template = createTestStack()
  })

  describe('Cognito User Pool', () => {
    it('creates a Cognito User Pool', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {})
    })

    it('uses email as the username alias', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        UsernameAttributes: Match.arrayWith(['email']),
      })
    })

    it('disables self-sign-up', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        AdminCreateUserConfig: Match.objectLike({
          AllowAdminCreateUserOnly: true,
        }),
      })
    })

    it('requires minimum 8 character passwords', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        Policies: Match.objectLike({
          PasswordPolicy: Match.objectLike({
            MinimumLength: 8,
          }),
        }),
      })
    })

    it('requires uppercase letters in passwords', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        Policies: Match.objectLike({
          PasswordPolicy: Match.objectLike({
            RequireUppercase: true,
          }),
        }),
      })
    })

    it('requires lowercase letters in passwords', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        Policies: Match.objectLike({
          PasswordPolicy: Match.objectLike({
            RequireLowercase: true,
          }),
        }),
      })
    })

    it('requires numbers in passwords', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        Policies: Match.objectLike({
          PasswordPolicy: Match.objectLike({
            RequireNumbers: true,
          }),
        }),
      })
    })

    it('requires symbols in passwords', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        Policies: Match.objectLike({
          PasswordPolicy: Match.objectLike({
            RequireSymbols: true,
          }),
        }),
      })
    })

    it('configures a custom invite email message', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        AdminCreateUserConfig: Match.objectLike({
          InviteMessageTemplate: Match.objectLike({
            EmailSubject: Match.anyValue(),
            EmailMessage: Match.anyValue(),
          }),
        }),
      })
    })
  })

  describe('User Pool Client', () => {
    it('creates a User Pool Client', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {})
    })

    it('enables USER_SRP_AUTH flow', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_SRP_AUTH']),
      })
    })

    it('enables ALLOW_REFRESH_TOKEN_AUTH flow', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ExplicitAuthFlows: Match.arrayWith(['ALLOW_REFRESH_TOKEN_AUTH']),
      })
    })

    it('configures access token validity to 1 hour', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        AccessTokenValidity: 1,
        TokenValidityUnits: Match.objectLike({
          AccessToken: 'hours',
        }),
      })
    })

    it('configures refresh token validity to 30 days', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        RefreshTokenValidity: 30,
        TokenValidityUnits: Match.objectLike({
          RefreshToken: 'days',
        }),
      })
    })
  })

  describe('Cognito Groups', () => {
    it('creates an admin group', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
        GroupName: 'admin',
      })
    })

    it('creates a contributor group', () => {
      template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
        GroupName: 'contributor',
      })
    })
  })

  describe('Lambda Functions', () => {
    it('creates an auth-handler Lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs22.x',
        FunctionName: Match.stringLikeRegexp('auth-handler'),
      })
    })

    it('creates an auth-admin-handler Lambda function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs22.x',
        FunctionName: Match.stringLikeRegexp('auth-admin-handler'),
      })
    })

    it('configures auth-handler with 256 MB memory', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('auth-handler'),
        MemorySize: 256,
      })
    })

    it('configures auth-admin-handler with 256 MB memory', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('auth-admin-handler'),
        MemorySize: 256,
      })
    })

    it('configures auth-handler with 10 second timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('auth-handler'),
        Timeout: 10,
      })
    })

    it('configures auth-admin-handler with 10 second timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('auth-admin-handler'),
        Timeout: 10,
      })
    })

    it('creates a seed-admin Lambda for the Custom Resource', () => {
      template.hasResourceProperties('AWS::CloudFormation::CustomResource', {})
    })
  })

  describe('auth-admin-handler IAM policy', () => {
    it('grants the Cognito actions the handler needs', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'cognito-idp:AdminCreateUser',
                'cognito-idp:AdminDeleteUser',
                'cognito-idp:AdminAddUserToGroup',
                'cognito-idp:ListUsers',
                'cognito-idp:ListUsersInGroup',
              ]),
            }),
          ]),
        }),
      })
    })
  })

  describe('HTTP API Gateway', () => {
    it('creates an HTTP API (ApiGatewayV2)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        ProtocolType: 'HTTP',
      })
    })

    it('has a POST /auth/login route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/login',
      })
    })

    it('has a POST /auth/refresh route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/refresh',
      })
    })

    it('has a POST /auth/confirm-new-password route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/confirm-new-password',
      })
    })

    it('has a POST /auth/change-password route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/change-password',
      })
    })

    it('has a GET /auth/users route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'GET /auth/users',
      })
    })

    it('has a POST /auth/users route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/users',
      })
    })

    it('has a DELETE /auth/users/{userId} route', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'DELETE /auth/users/{userId}',
      })
    })
  })

  describe('JWT Authoriser', () => {
    it('creates a JWT authoriser linked to the Cognito User Pool', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        AuthorizerType: 'JWT',
        IdentitySource: Match.arrayWith(['$request.header.Authorization']),
      })
    })

    it('configures the JWT authoriser with the User Pool issuer', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        JwtConfiguration: Match.objectLike({
          Issuer: Match.anyValue(),
          Audience: Match.anyValue(),
        }),
      })
    })

    it('protects POST /auth/change-password with the authoriser', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/change-password',
        AuthorizationType: 'JWT',
      })
    })

    it('protects GET /auth/users with the authoriser', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'GET /auth/users',
        AuthorizationType: 'JWT',
      })
    })

    it('protects POST /auth/users with the authoriser', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/users',
        AuthorizationType: 'JWT',
      })
    })

    it('protects DELETE /auth/users/{userId} with the authoriser', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'DELETE /auth/users/{userId}',
        AuthorizationType: 'JWT',
      })
    })

    it('does not protect POST /auth/login (public route)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/login',
        AuthorizationType: 'NONE',
      })
    })

    it('does not protect POST /auth/refresh (public route)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/refresh',
        AuthorizationType: 'NONE',
      })
    })

    it('does not protect POST /auth/confirm-new-password (public route)', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /auth/confirm-new-password',
        AuthorizationType: 'NONE',
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

    it('allows GET, POST, and DELETE methods', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        CorsConfiguration: Match.objectLike({
          AllowMethods: Match.arrayWith(['GET', 'POST', 'DELETE']),
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

  describe('CloudWatch Alarms', () => {
    it('creates an alarm for failed login spikes', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: Match.anyValue(),
        Namespace: Match.anyValue(),
        ComparisonOperator: Match.anyValue(),
      })
    })

    it('creates an alarm for Lambda errors', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'Errors',
        Namespace: 'AWS/Lambda',
      })
    })
  })

  describe('Stack Outputs', () => {
    it('exports the User Pool ID', () => {
      template.hasOutput('UserPoolId', {})
    })

    it('exports the User Pool Client ID', () => {
      template.hasOutput('UserPoolClientId', {})
    })
  })

  describe('Tags', () => {
    it('tags the User Pool with Owner', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        UserPoolTags: Match.objectLike({ Owner: 'Akli' }),
      })
    })

    it('tags the User Pool with Project=auth', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        UserPoolTags: Match.objectLike({ Project: 'auth' }),
      })
    })

    it('tags the User Pool with Environment=production', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        UserPoolTags: Match.objectLike({ Environment: 'production' }),
      })
    })

    it('tags the User Pool with ManagedBy=cdk', () => {
      template.hasResourceProperties('AWS::Cognito::UserPool', {
        UserPoolTags: Match.objectLike({ ManagedBy: 'cdk' }),
      })
    })
  })
})

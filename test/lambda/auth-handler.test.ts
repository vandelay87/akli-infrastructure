import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  ChangePasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { mockClient } from 'aws-sdk-client-mock'

const cognitoMock = mockClient(CognitoIdentityProviderClient)

// Import handler after mock setup
import { handler } from '../../lambda/auth-handler'

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /auth/login',
    rawPath: '/auth/login',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      domainName: 'test.execute-api.eu-west-2.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method: 'POST',
        path: '/auth/login',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'test-request-id',
      routeKey: 'POST /auth/login',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2
}

describe('Auth Lambda handler', () => {
  beforeEach(() => {
    cognitoMock.reset()
  })

  describe('POST /auth/login — successful SRP flow', () => {
    it('returns 200 with accessToken, idToken, and refreshToken', async () => {
      cognitoMock.on(InitiateAuthCommand).resolves({
        AuthenticationResult: {
          AccessToken: 'mock-access-token',
          IdToken: 'mock-id-token',
          RefreshToken: 'mock-refresh-token',
        },
      })

      const event = makeEvent({
        routeKey: 'POST /auth/login',
        rawPath: '/auth/login',
        requestContext: {
          accountId: '123456789012',
          apiId: 'test-api',
          domainName: 'test.execute-api.eu-west-2.amazonaws.com',
          domainPrefix: 'test',
          http: {
            method: 'POST',
            path: '/auth/login',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
          requestId: 'test-request-id',
          routeKey: 'POST /auth/login',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
        body: JSON.stringify({ email: 'user@example.com', password: 'P@ssw0rd!' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({
        accessToken: 'mock-access-token',
        idToken: 'mock-id-token',
        refreshToken: 'mock-refresh-token',
      })
    })
  })

  describe('POST /auth/login — wrong password', () => {
    it('returns 401 when Cognito rejects credentials', async () => {
      const error = new Error('Incorrect username or password.')
      error.name = 'NotAuthorizedException'
      cognitoMock.on(InitiateAuthCommand).rejects(error)

      const event = makeEvent({
        routeKey: 'POST /auth/login',
        rawPath: '/auth/login',
        body: JSON.stringify({ email: 'user@example.com', password: 'wrong-password' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  describe('POST /auth/login — new password challenge', () => {
    it('returns 200 with challengeName and session when NEW_PASSWORD_REQUIRED', async () => {
      cognitoMock.on(InitiateAuthCommand).resolves({
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        Session: 'mock-session-token',
      })

      const event = makeEvent({
        routeKey: 'POST /auth/login',
        rawPath: '/auth/login',
        body: JSON.stringify({ email: 'user@example.com', password: 'TempPass1!' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({
        challengeName: 'NEW_PASSWORD_REQUIRED',
        session: 'mock-session-token',
      })
    })
  })

  describe('POST /auth/confirm-new-password', () => {
    it('returns 200 with tokens after successful challenge response', async () => {
      cognitoMock.on(RespondToAuthChallengeCommand).resolves({
        AuthenticationResult: {
          AccessToken: 'mock-access-token',
          IdToken: 'mock-id-token',
          RefreshToken: 'mock-refresh-token',
        },
      })

      const event = makeEvent({
        routeKey: 'POST /auth/confirm-new-password',
        rawPath: '/auth/confirm-new-password',
        requestContext: {
          accountId: '123456789012',
          apiId: 'test-api',
          domainName: 'test.execute-api.eu-west-2.amazonaws.com',
          domainPrefix: 'test',
          http: {
            method: 'POST',
            path: '/auth/confirm-new-password',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
          requestId: 'test-request-id',
          routeKey: 'POST /auth/confirm-new-password',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
        body: JSON.stringify({
          email: 'user@example.com',
          newPassword: 'NewP@ss1!',
          session: 'mock-session-token',
        }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({
        accessToken: 'mock-access-token',
        idToken: 'mock-id-token',
        refreshToken: 'mock-refresh-token',
      })
    })
  })

  describe('POST /auth/refresh', () => {
    it('returns 200 with new accessToken and idToken', async () => {
      cognitoMock.on(InitiateAuthCommand).resolves({
        AuthenticationResult: {
          AccessToken: 'mock-new-access-token',
          IdToken: 'mock-new-id-token',
        },
      })

      const event = makeEvent({
        routeKey: 'POST /auth/refresh',
        rawPath: '/auth/refresh',
        requestContext: {
          accountId: '123456789012',
          apiId: 'test-api',
          domainName: 'test.execute-api.eu-west-2.amazonaws.com',
          domainPrefix: 'test',
          http: {
            method: 'POST',
            path: '/auth/refresh',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
          requestId: 'test-request-id',
          routeKey: 'POST /auth/refresh',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
        body: JSON.stringify({ refreshToken: 'mock-refresh-token' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({
        accessToken: 'mock-new-access-token',
        idToken: 'mock-new-id-token',
      })
    })
  })

  describe('POST /auth/change-password', () => {
    it('returns 200 on successful password change', async () => {
      cognitoMock.on(ChangePasswordCommand).resolves({})

      const event = makeEvent({
        routeKey: 'POST /auth/change-password',
        rawPath: '/auth/change-password',
        requestContext: {
          accountId: '123456789012',
          apiId: 'test-api',
          domainName: 'test.execute-api.eu-west-2.amazonaws.com',
          domainPrefix: 'test',
          http: {
            method: 'POST',
            path: '/auth/change-password',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
          requestId: 'test-request-id',
          routeKey: 'POST /auth/change-password',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
        headers: {
          authorization: 'Bearer mock-access-token',
        },
        body: JSON.stringify({
          previousPassword: 'OldP@ss1!',
          proposedPassword: 'NewP@ss2!',
        }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({ message: 'Password changed successfully' })
    })
  })

  describe('Unknown route', () => {
    it('returns 404 for unmatched route', async () => {
      const event = makeEvent({
        routeKey: 'GET /auth/unknown',
        rawPath: '/auth/unknown',
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })
})

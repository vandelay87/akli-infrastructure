import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  ListUsersCommand,
  AdminDeleteUserCommand,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { mockClient } from 'aws-sdk-client-mock'

const cognitoMock = mockClient(CognitoIdentityProviderClient)

// Import handler after mock setup
import { handler } from '../../lambda/auth-admin-handler'

// Build a fake JWT with the given payload (header.payload.signature)
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = 'fake-signature'
  return `${header}.${body}.${signature}`
}

const adminToken = fakeJwt({ 'cognito:groups': ['admin'], sub: 'admin-user-id', email: 'admin@example.com' })
const nonAdminToken = fakeJwt({ 'cognito:groups': ['user'], sub: 'regular-user-id', email: 'user@example.com' })

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /auth/users',
    rawPath: '/auth/users',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${adminToken}`,
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      domainName: 'test.execute-api.eu-west-2.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method: 'GET',
        path: '/auth/users',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'test-request-id',
      routeKey: 'GET /auth/users',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2
}

describe('Auth Admin Lambda handler', () => {
  beforeEach(() => {
    cognitoMock.reset()
  })

  describe('Authorization — non-admin callers', () => {
    it('returns 403 for GET /auth/users when caller is not admin', async () => {
      const event = makeEvent({
        routeKey: 'GET /auth/users',
        rawPath: '/auth/users',
        headers: { authorization: `Bearer ${nonAdminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 403 for POST /auth/users when caller is not admin', async () => {
      const event = makeEvent({
        routeKey: 'POST /auth/users',
        rawPath: '/auth/users',
        headers: { authorization: `Bearer ${nonAdminToken}` },
        requestContext: {
          accountId: '123456789012',
          apiId: 'test-api',
          domainName: 'test.execute-api.eu-west-2.amazonaws.com',
          domainPrefix: 'test',
          http: {
            method: 'POST',
            path: '/auth/users',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
          requestId: 'test-request-id',
          routeKey: 'POST /auth/users',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
        body: JSON.stringify({ email: 'new@example.com', role: 'user' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 403 for DELETE /auth/users/{userId} when caller is not admin', async () => {
      const event = makeEvent({
        routeKey: 'DELETE /auth/users/{userId}',
        rawPath: '/auth/users/some-user-id',
        headers: { authorization: `Bearer ${nonAdminToken}` },
        pathParameters: { userId: 'some-user-id' },
        requestContext: {
          accountId: '123456789012',
          apiId: 'test-api',
          domainName: 'test.execute-api.eu-west-2.amazonaws.com',
          domainPrefix: 'test',
          http: {
            method: 'DELETE',
            path: '/auth/users/some-user-id',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
          requestId: 'test-request-id',
          routeKey: 'DELETE /auth/users/{userId}',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })

    it('returns 403 when no authorization header is provided', async () => {
      const event = makeEvent({
        routeKey: 'GET /auth/users',
        rawPath: '/auth/users',
        headers: {},
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })

  describe('GET /auth/users — list users', () => {
    it('returns 200 with array of users containing email, userId, role, and status', async () => {
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          {
            Username: 'user-id-1',
            Attributes: [
              { Name: 'email', Value: 'alice@example.com' },
              { Name: 'custom:role', Value: 'admin' },
            ],
            UserStatus: 'CONFIRMED',
            Enabled: true,
          },
          {
            Username: 'user-id-2',
            Attributes: [
              { Name: 'email', Value: 'bob@example.com' },
              { Name: 'custom:role', Value: 'user' },
            ],
            UserStatus: 'FORCE_CHANGE_PASSWORD',
            Enabled: true,
          },
        ],
      })

      const event = makeEvent({
        routeKey: 'GET /auth/users',
        rawPath: '/auth/users',
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(Array.isArray(body)).toBe(true)
      expect(body).toHaveLength(2)
      expect(body[0]).toEqual({
        email: 'alice@example.com',
        userId: 'user-id-1',
        role: 'admin',
        status: 'CONFIRMED',
      })
      expect(body[1]).toEqual({
        email: 'bob@example.com',
        userId: 'user-id-2',
        role: 'user',
        status: 'FORCE_CHANGE_PASSWORD',
      })
    })
  })

  describe('POST /auth/users — create user', () => {
    it('returns 201 with created user details', async () => {
      cognitoMock.on(AdminCreateUserCommand).resolves({
        User: {
          Username: 'new-user-id',
          Attributes: [
            { Name: 'email', Value: 'new@example.com' },
          ],
          UserStatus: 'FORCE_CHANGE_PASSWORD',
          Enabled: true,
        },
      })
      cognitoMock.on(AdminAddUserToGroupCommand).resolves({})

      const event = makeEvent({
        routeKey: 'POST /auth/users',
        rawPath: '/auth/users',
        headers: { authorization: `Bearer ${adminToken}` },
        requestContext: {
          accountId: '123456789012',
          apiId: 'test-api',
          domainName: 'test.execute-api.eu-west-2.amazonaws.com',
          domainPrefix: 'test',
          http: {
            method: 'POST',
            path: '/auth/users',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
          requestId: 'test-request-id',
          routeKey: 'POST /auth/users',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
        body: JSON.stringify({ email: 'new@example.com', role: 'user' }),
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(201)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('userId', 'new-user-id')
      expect(body).toHaveProperty('email', 'new@example.com')
      expect(body).toHaveProperty('status', 'FORCE_CHANGE_PASSWORD')
    })
  })

  describe('DELETE /auth/users/{userId} — delete user', () => {
    it('returns 200 on successful user deletion', async () => {
      cognitoMock.on(AdminDeleteUserCommand).resolves({})

      const event = makeEvent({
        routeKey: 'DELETE /auth/users/{userId}',
        rawPath: '/auth/users/target-user-id',
        headers: { authorization: `Bearer ${adminToken}` },
        pathParameters: { userId: 'target-user-id' },
        requestContext: {
          accountId: '123456789012',
          apiId: 'test-api',
          domainName: 'test.execute-api.eu-west-2.amazonaws.com',
          domainPrefix: 'test',
          http: {
            method: 'DELETE',
            path: '/auth/users/target-user-id',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'test',
          },
          requestId: 'test-request-id',
          routeKey: 'DELETE /auth/users/{userId}',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body as string)
      expect(body).toEqual({ message: 'User deleted successfully' })
    })
  })

  describe('Unknown route', () => {
    it('returns 404 for unmatched route', async () => {
      const event = makeEvent({
        routeKey: 'PATCH /auth/users',
        rawPath: '/auth/users',
        headers: { authorization: `Bearer ${adminToken}` },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body as string)
      expect(body).toHaveProperty('error')
    })
  })
})

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'
import { mockClient } from 'aws-sdk-client-mock'

const cognitoMock = mockClient(CognitoIdentityProviderClient)
const secretsMock = mockClient(SecretsManagerClient)

process.env.USER_POOL_ID = 'eu-west-2_TestPool'
process.env.ADMIN_SECRET_NAME = 'test/admin-credentials'

import { onEvent } from '../../lambda/seed-admin'

const ADMIN_SECRET = JSON.stringify({
  email: 'admin@example.com',
  password: 'TempP@ss1!',
})

function makeEvent(
  requestType: 'Create' | 'Update' | 'Delete',
  overrides: Partial<CloudFormationCustomResourceEvent> = {},
): CloudFormationCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken: 'arn:aws:lambda:eu-west-2:123456789012:function:test',
    ResponseURL: 'https://cloudformation-custom-resource-response.s3.amazonaws.com/test',
    StackId: 'arn:aws:cloudformation:eu-west-2:123456789012:stack/test/guid',
    RequestId: 'test-request-id',
    ResourceType: 'Custom::SeedAdmin',
    LogicalResourceId: 'SeedAdmin',
    ResourceProperties: {
      ServiceToken: 'arn:aws:lambda:eu-west-2:123456789012:function:test',
    },
    PhysicalResourceId: 'seed-admin',
    ...overrides,
  } as CloudFormationCustomResourceEvent
}

describe('seed-admin onEvent', () => {
  beforeEach(() => {
    cognitoMock.reset()
    secretsMock.reset()
  })

  describe('Create event', () => {
    it('reads secret, creates user, and adds to admin group', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: ADMIN_SECRET,
      })
      cognitoMock.on(AdminCreateUserCommand).resolves({
        User: { Username: 'admin@example.com' },
      })
      cognitoMock.on(AdminAddUserToGroupCommand).resolves({})

      await onEvent(makeEvent('Create'))

      // Should fetch secret
      const secretCalls = secretsMock.commandCalls(GetSecretValueCommand)
      expect(secretCalls).toHaveLength(1)
      expect(secretCalls[0].args[0].input).toEqual({
        SecretId: 'test/admin-credentials',
      })

      // Should create user with email and temporary password
      const createCalls = cognitoMock.commandCalls(AdminCreateUserCommand)
      expect(createCalls).toHaveLength(1)
      expect(createCalls[0].args[0].input).toMatchObject({
        UserPoolId: 'eu-west-2_TestPool',
        Username: 'admin@example.com',
        TemporaryPassword: 'TempP@ss1!',
      })

      // Should add user to admin group
      const groupCalls = cognitoMock.commandCalls(AdminAddUserToGroupCommand)
      expect(groupCalls).toHaveLength(1)
      expect(groupCalls[0].args[0].input).toMatchObject({
        UserPoolId: 'eu-west-2_TestPool',
        Username: 'admin@example.com',
        GroupName: 'admin',
      })
    })

    it('skips creation but still adds to group when user already exists', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: ADMIN_SECRET,
      })

      const usernameExistsError = new Error('User account already exists')
      usernameExistsError.name = 'UsernameExistsException'
      cognitoMock.on(AdminCreateUserCommand).rejects(usernameExistsError)
      cognitoMock.on(AdminAddUserToGroupCommand).resolves({})

      await onEvent(makeEvent('Create'))

      // Should still attempt creation
      const createCalls = cognitoMock.commandCalls(AdminCreateUserCommand)
      expect(createCalls).toHaveLength(1)

      // Should still add to admin group even if user existed
      const groupCalls = cognitoMock.commandCalls(AdminAddUserToGroupCommand)
      expect(groupCalls).toHaveLength(1)
      expect(groupCalls[0].args[0].input).toMatchObject({
        UserPoolId: 'eu-west-2_TestPool',
        Username: 'admin@example.com',
        GroupName: 'admin',
      })
    })
  })

  describe('Update event', () => {
    it('behaves the same as Create (idempotent)', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: ADMIN_SECRET,
      })
      cognitoMock.on(AdminCreateUserCommand).resolves({
        User: { Username: 'admin@example.com' },
      })
      cognitoMock.on(AdminAddUserToGroupCommand).resolves({})

      await onEvent(makeEvent('Update'))

      // Should fetch secret
      const secretCalls = secretsMock.commandCalls(GetSecretValueCommand)
      expect(secretCalls).toHaveLength(1)

      // Should create user
      const createCalls = cognitoMock.commandCalls(AdminCreateUserCommand)
      expect(createCalls).toHaveLength(1)

      // Should add to admin group
      const groupCalls = cognitoMock.commandCalls(AdminAddUserToGroupCommand)
      expect(groupCalls).toHaveLength(1)
    })
  })

  describe('Delete event', () => {
    it('returns early without calling Cognito or Secrets Manager', async () => {
      const result = await onEvent(makeEvent('Delete'))

      expect(result.PhysicalResourceId).toBe('seed-admin')

      // Should NOT call Secrets Manager
      const secretCalls = secretsMock.commandCalls(GetSecretValueCommand)
      expect(secretCalls).toHaveLength(0)

      // Should NOT call Cognito
      const createCalls = cognitoMock.commandCalls(AdminCreateUserCommand)
      expect(createCalls).toHaveLength(0)
      const groupCalls = cognitoMock.commandCalls(AdminAddUserToGroupCommand)
      expect(groupCalls).toHaveLength(0)
    })
  })

  describe('PhysicalResourceId', () => {
    it('returns "seed-admin" as PhysicalResourceId on Create', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: ADMIN_SECRET,
      })
      cognitoMock.on(AdminCreateUserCommand).resolves({
        User: { Username: 'admin@example.com' },
      })
      cognitoMock.on(AdminAddUserToGroupCommand).resolves({})

      const result = await onEvent(makeEvent('Create'))

      expect(result.PhysicalResourceId).toBe('seed-admin')
    })

    it('returns existing PhysicalResourceId on Update', async () => {
      secretsMock.on(GetSecretValueCommand).resolves({
        SecretString: ADMIN_SECRET,
      })
      cognitoMock.on(AdminCreateUserCommand).resolves({
        User: { Username: 'admin@example.com' },
      })
      cognitoMock.on(AdminAddUserToGroupCommand).resolves({})

      const result = await onEvent(makeEvent('Update'))

      expect(result.PhysicalResourceId).toBe('seed-admin')
    })

    it('returns existing PhysicalResourceId on Delete', async () => {
      const result = await onEvent(makeEvent('Delete'))

      expect(result.PhysicalResourceId).toBe('seed-admin')
    })
  })
})

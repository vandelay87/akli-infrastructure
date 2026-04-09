import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'
import type { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda'

const cognitoClient = new CognitoIdentityProviderClient({})
const secretsClient = new SecretsManagerClient({})

const USER_POOL_ID = process.env.USER_POOL_ID!
const ADMIN_SECRET_NAME = process.env.ADMIN_SECRET_NAME!

export async function onEvent(
  event: CloudFormationCustomResourceEvent,
): Promise<Partial<CloudFormationCustomResourceResponse>> {
  const physicalId = event.RequestType === 'Create'
    ? 'seed-admin'
    : event.PhysicalResourceId

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalId }
  }

  // Read admin credentials from Secrets Manager
  const secretResponse = await secretsClient.send(new GetSecretValueCommand({
    SecretId: ADMIN_SECRET_NAME,
  }))

  const { email, password } = JSON.parse(secretResponse.SecretString!) as {
    email: string
    password: string
  }

  // Create admin user (idempotent — swallow UsernameExistsException)
  try {
    await cognitoClient.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      TemporaryPassword: password,
      MessageAction: 'SUPPRESS',
    }))
  } catch (error: unknown) {
    if ((error as { name: string }).name !== 'UsernameExistsException') {
      throw error
    }
  }

  // Add user to admin group
  await cognitoClient.send(new AdminAddUserToGroupCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
    GroupName: 'admin',
  }))

  return { PhysicalResourceId: physicalId }
}

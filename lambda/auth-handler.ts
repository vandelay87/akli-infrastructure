import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  ChangePasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider'

const cognito = new CognitoIdentityProviderClient({})
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID ?? ''

function json(statusCode: number, body: Record<string, unknown>): APIGatewayProxyStructuredResultV2 {
  return { statusCode, body: JSON.stringify(body) }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  switch (event.routeKey) {
    case 'POST /auth/login':
      return handleLogin(event)
    case 'POST /auth/confirm-new-password':
      return handleConfirmNewPassword(event)
    case 'POST /auth/refresh':
      return handleRefresh(event)
    case 'POST /auth/change-password':
      return handleChangePassword(event)
    default:
      return json(404, { error: 'Not found' })
  }
}

async function handleLogin(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const { email, password } = JSON.parse(event.body ?? '{}')
    const response = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    )

    if (response.AuthenticationResult) {
      return json(200, {
        accessToken: response.AuthenticationResult.AccessToken,
        idToken: response.AuthenticationResult.IdToken,
        refreshToken: response.AuthenticationResult.RefreshToken,
      })
    }

    if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      return json(200, {
        challengeName: response.ChallengeName,
        session: response.Session,
      })
    }

    return json(500, { error: 'Unexpected response' })
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'NotAuthorizedException') {
      return json(401, { error: error.message })
    }
    throw error
  }
}

async function handleConfirmNewPassword(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { email, newPassword, session } = JSON.parse(event.body ?? '{}')
  const response = await cognito.send(
    new RespondToAuthChallengeCommand({
      ClientId: CLIENT_ID,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    }),
  )

  return json(200, {
    accessToken: response.AuthenticationResult?.AccessToken,
    idToken: response.AuthenticationResult?.IdToken,
    refreshToken: response.AuthenticationResult?.RefreshToken,
  })
}

async function handleRefresh(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { refreshToken } = JSON.parse(event.body ?? '{}')
  const response = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  )

  return json(200, {
    accessToken: response.AuthenticationResult?.AccessToken,
    idToken: response.AuthenticationResult?.IdToken,
  })
}

async function handleChangePassword(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const token = event.headers.authorization?.replace('Bearer ', '') ?? ''
  const { previousPassword, proposedPassword } = JSON.parse(event.body ?? '{}')

  await cognito.send(
    new ChangePasswordCommand({
      PreviousPassword: previousPassword,
      ProposedPassword: proposedPassword,
      AccessToken: token,
    }),
  )

  return json(200, { message: 'Password changed successfully' })
}

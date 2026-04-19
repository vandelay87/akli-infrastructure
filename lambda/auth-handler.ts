import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  ChangePasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'

const cognito = new CognitoIdentityProviderClient({})
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID ?? ''

function json(statusCode: number, body: Record<string, unknown>): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    switch (event.routeKey) {
      case 'POST /auth/login':
        return await handleLogin(event)
      case 'POST /auth/confirm-new-password':
        return await handleConfirmNewPassword(event)
      case 'POST /auth/refresh':
        return await handleRefresh(event)
      case 'POST /auth/change-password':
        return await handleChangePassword(event)
      default:
        return json(404, { error: 'Not found' })
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'NotAuthorizedException') {
      return json(401, { error: 'Invalid credentials' })
    }
    return json(500, { error: 'Internal server error' })
  }
}

async function handleLogin(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { email, password } = JSON.parse(event.body ?? '{}')
  if (!email || !password) return json(400, { error: 'email and password are required' })

  const response = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  )

  if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    return json(200, {
      challengeName: response.ChallengeName,
      session: response.Session,
    })
  }

  if (!response.AuthenticationResult) {
    return json(500, { error: 'Unexpected response' })
  }

  return json(200, {
    accessToken: response.AuthenticationResult.AccessToken,
    idToken: response.AuthenticationResult.IdToken,
    refreshToken: response.AuthenticationResult.RefreshToken,
  })
}

async function handleConfirmNewPassword(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { email, newPassword, session } = JSON.parse(event.body ?? '{}')
  if (!email || !newPassword || !session) return json(400, { error: 'email, newPassword, and session are required' })

  const response = await cognito.send(
    new RespondToAuthChallengeCommand({
      ClientId: CLIENT_ID,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    }),
  )

  if (!response.AuthenticationResult) {
    return json(500, { error: 'Unexpected response' })
  }

  return json(200, {
    accessToken: response.AuthenticationResult.AccessToken,
    idToken: response.AuthenticationResult.IdToken,
    refreshToken: response.AuthenticationResult.RefreshToken,
  })
}

async function handleRefresh(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { refreshToken } = JSON.parse(event.body ?? '{}')
  if (!refreshToken) return json(400, { error: 'refreshToken is required' })

  const response = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  )

  if (!response.AuthenticationResult) {
    return json(500, { error: 'Unexpected response' })
  }

  return json(200, {
    accessToken: response.AuthenticationResult.AccessToken,
    idToken: response.AuthenticationResult.IdToken,
  })
}

async function handleChangePassword(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const token = event.headers.authorization?.replace(/^bearer\s+/i, '') ?? ''
  if (!token) return json(401, { error: 'Authorization header is required' })

  const { previousPassword, proposedPassword } = JSON.parse(event.body ?? '{}')
  if (!previousPassword || !proposedPassword) return json(400, { error: 'previousPassword and proposedPassword are required' })

  await cognito.send(
    new ChangePasswordCommand({
      PreviousPassword: previousPassword,
      ProposedPassword: proposedPassword,
      AccessToken: token,
    }),
  )

  return json(200, { message: 'Password changed successfully' })
}

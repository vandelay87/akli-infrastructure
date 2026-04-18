import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider'

const cognito = new CognitoIdentityProviderClient({})
const USER_POOL_ID = process.env.USER_POOL_ID ?? ''
const ADMIN_GROUP = 'admin'

type AdminUser = {
  email: string
  userId: string
  role: 'admin' | 'contributor'
  status: string
}

function json(statusCode: number, body: Record<string, unknown> | readonly Record<string, unknown>[]): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function isAdmin(event: APIGatewayProxyEventV2): boolean {
  const authHeader = event.headers.authorization
  if (!authHeader) return false

  const token = authHeader.replace(/^bearer\s+/i, '')
  if (!token) return false

  try {
    const parts = token.split('.')
    if (parts.length < 2) return false
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>
    const groups = payload['cognito:groups']
    return Array.isArray(groups) && groups.includes(ADMIN_GROUP)
  } catch {
    return false
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    if (!isAdmin(event)) {
      return json(403, { error: 'Forbidden' })
    }

    switch (event.routeKey) {
      case 'GET /auth/users':
        return await handleListUsers()
      case 'POST /auth/users':
        return await handleCreateUser(event)
      case 'DELETE /auth/users/{userId}':
        return await handleDeleteUser(event)
      default:
        return json(404, { error: 'Not found' })
    }
  } catch (err) {
    console.error('auth-admin handler error:', err)
    return json(500, { error: 'Internal server error' })
  }
}

async function listAllUsers(): Promise<UserType[]> {
  const users: UserType[] = []
  let paginationToken: string | undefined
  do {
    const page = await cognito.send(
      new ListUsersCommand({ UserPoolId: USER_POOL_ID, PaginationToken: paginationToken }),
    )
    if (page.Users) users.push(...page.Users)
    paginationToken = page.PaginationToken
  } while (paginationToken)
  return users
}

async function listAllUsersInGroup(groupName: string): Promise<UserType[]> {
  const users: UserType[] = []
  let nextToken: string | undefined
  do {
    const page = await cognito.send(
      new ListUsersInGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: groupName, NextToken: nextToken }),
    )
    if (page.Users) users.push(...page.Users)
    nextToken = page.NextToken
  } while (nextToken)
  return users
}

async function handleListUsers(): Promise<APIGatewayProxyStructuredResultV2> {
  const [allUsers, adminGroupUsers] = await Promise.all([
    listAllUsers(),
    listAllUsersInGroup(ADMIN_GROUP),
  ])

  const adminUsernames = new Set(
    adminGroupUsers
      .map((u) => u.Username)
      .filter((name): name is string => Boolean(name))
  )

  const users: AdminUser[] = allUsers.map((user) => ({
    email: user.Attributes?.find((attr) => attr.Name === 'email')?.Value ?? '',
    userId: user.Username ?? '',
    role: user.Username && adminUsernames.has(user.Username) ? 'admin' : 'contributor',
    status: user.UserStatus ?? '',
  }))

  return json(200, users)
}

async function handleCreateUser(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { email, role } = JSON.parse(event.body ?? '{}') as { email?: string; role?: string }
  if (!email || !role) return json(400, { error: 'email and role are required' })

  const response = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      UserAttributes: [{ Name: 'email', Value: email }],
    }),
  )

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      GroupName: role,
    }),
  )

  return json(201, {
    userId: response.User?.Username ?? '',
    email,
    status: response.User?.UserStatus ?? '',
  })
}

async function handleDeleteUser(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const userId = event.pathParameters?.userId
  if (!userId) return json(400, { error: 'userId is required' })

  await cognito.send(
    new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
    }),
  )

  return json(200, { message: 'User deleted successfully' })
}

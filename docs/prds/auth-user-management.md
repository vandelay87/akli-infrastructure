# PRD: Authentication & User Management Infrastructure

## Overview

Add authentication and user management to the akli.dev platform using AWS Cognito. This enables protected recipe management endpoints where only authenticated users can create and edit content, while all recipe content remains publicly readable. This is the foundational PRD (1 of 4) in the recipes epic — all other PRDs depend on this auth layer.

## Problem Statement

akli.dev currently has no authentication. The upcoming recipes feature requires the ability to restrict who can create and edit recipes (the site owner and invited contributors) while keeping all content publicly viewable. Without a centralised auth layer, every future protected feature would need its own ad-hoc solution.

## Goals

- Provide a secure, serverless authentication system using AWS Cognito that integrates with the existing API Gateway infrastructure.
- Support two roles: **admin** (full control including user management) and **contributor** (can manage their own recipes only).
- Enable invite-only user registration — no self-sign-up.
- Expose user management operations (invite, list, remove) as protected API endpoints for admin use.
- Follow AWS best practices and integrate cleanly with the existing CDK multi-stack architecture.

## Non-Goals

- **Login UI** — the frontend login page, auth context, and protected route handling are covered in PRD 4 (Admin Interface).
- **Self-registration** — users are invite-only. There is no public sign-up flow.
- **Social/federated identity providers** (Google, GitHub, etc.) — email + password only for this iteration.
- **Multi-factor authentication** — not required for the initial release given the small user base.
- **Fine-grained resource-level permissions** — the recipes PRD will handle ownership checks at the application layer. This PRD provides the role (admin/contributor) via JWT claims.

## User Stories

- As the site owner, I want a Cognito user pool so that I can authenticate against the API and manage recipes.
- As the site owner (admin), I want to invite a contributor by email so that they receive a temporary password and can log in.
- As the site owner (admin), I want to list all users so that I can see who has access.
- As the site owner (admin), I want to remove a contributor so that they can no longer log in.
- As a contributor, I want to log in with my email and password so that I can access protected recipe endpoints.
- As a contributor, I want to change my temporary password on first login so that my account is secure.
- As an API consumer, I want public endpoints to remain unauthenticated so that anyone can read recipes.

## Design & UX

This PRD is infrastructure-only — no UI components. The Cognito user pool will issue JWTs that the frontend (PRD 4) will use for login flows. The API responses follow the same JSON structure as the existing Pokedex API.

### API Endpoints

All endpoints are under the existing `api.akli.dev` CloudFront distribution.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | Public | Authenticate with email + password, returns JWT tokens |
| POST | `/auth/refresh` | Public | Refresh an expired access token |
| POST | `/auth/confirm-new-password` | Public | Complete the `NEW_PASSWORD_REQUIRED` challenge with session token |
| POST | `/auth/change-password` | Bearer token | Voluntarily change password |
| GET | `/auth/users` | Admin only | List all users with their roles |
| POST | `/auth/users` | Admin only | Invite a new user by email (Cognito sends invite email) |
| DELETE | `/auth/users/{userId}` | Admin only | Remove a user from the pool by Cognito `sub` |

### Auth Flow

1. Admin invites contributor via `POST /auth/users` with their email.
2. Cognito sends an email with a temporary password.
3. Contributor logs in via `POST /auth/login` — receives `NEW_PASSWORD_REQUIRED` challenge.
4. Frontend prompts for new password, calls `POST /auth/confirm-new-password` with the session token.
5. Subsequent logins return access token (1h), ID token, and refresh token (30d).
6. Frontend stores tokens and attaches the access token as `Authorization: Bearer <token>` header.
7. API Gateway JWT authoriser validates the token and extracts the `cognito:groups` claim for role checks.

## Technical Considerations

### New Stack: `AuthStack`

A new `AuthStack` in `lib/auth-stack.ts` deployed to `eu-west-2`, following the same conventions as `PokedexStack`:

**Cognito User Pool:**
- Email as the username/sign-in alias.
- Self-sign-up disabled (`selfSignUpEnabled: false`).
- Password policy: minimum 8 characters, require uppercase, lowercase, numbers, and symbols.
- Email verification not required (admin-created accounts are pre-verified).
- Account recovery via email only.
- Invite email customised with basic akli.dev branding (site name, simple message template — not the default Cognito email).

**Cognito User Pool Client:**
- Auth flows: `USER_SRP_AUTH` (for login — uses Secure Remote Password protocol, never transmits the password) and `ALLOW_REFRESH_TOKEN_AUTH` (for token refresh).
- No OAuth flows or hosted UI — all auth is handled via the API + custom frontend.
- Note: The frontend must use the `amazon-cognito-identity-js` library or AWS Amplify Auth to handle the SRP protocol client-side.
- Access token validity: 1 hour.
- Refresh token validity: 30 days.

**Cognito Groups:**
- `admin` — full access to all endpoints including user management.
- `contributor` — access to recipe CRUD for their own recipes only.

**Seed Admin User:**
- A Custom Resource (following the Pokedex seeder pattern) creates the initial admin user and adds them to the `admin` group on first deploy.
- The admin email and temporary password are stored in Secrets Manager. The secret name is passed as a CDK context variable.

### Lambda Functions

All Lambda functions use Node.js 22, 256MB memory, 10s timeout, following existing conventions:

- **`lambda/auth-handler.ts`** — Handles login (SRP flow initiation and response), refresh, confirm-new-password, and change-password using the `@aws-sdk/client-cognito-identity-provider` SDK. Routes based on HTTP method + path.
- **`lambda/auth-admin-handler.ts`** — Handles user invite, list, and remove. Separated from the auth handler for cleaner IAM permissions (this one needs `cognito-idp:AdminCreateUser`, `AdminDeleteUser`, `ListUsers`).
- **`lambda/seed-admin.ts`** — Custom Resource handler that creates the initial admin user and assigns the admin group. Idempotent (checks if user exists before creating).

### API Gateway Integration

- Add routes to the existing `api.akli.dev` CloudFront distribution via the `ApiStack`.
- Public auth routes (`/auth/login`, `/auth/refresh`) use no authoriser.
- Protected routes use an **HTTP API JWT authoriser** configured with the Cognito user pool issuer URL and client ID.
- Admin-only routes additionally check `cognito:groups` claim in the Lambda handler (API Gateway JWT authoriser doesn't support group-based routing natively on HTTP API v2, so the Lambda verifies the claim).

### CloudFront/API Stack Changes

- The `AuthStack` creates its own `HttpApi` and exposes `httpApi.apiEndpoint` as a public property — same pattern as `PokedexStack`.
- The `ApiStack` receives the auth API endpoint as a prop (`authApiUrl: string`), alongside the existing `pokedexApiUrl`.
- New CloudFront behaviour: `/auth/*` routed to the auth API origin.
- **`AllowedMethods` must be set to `ALLOW_ALL`** for `/auth/*` (POST/DELETE required — unlike `/pokedex/*` which only uses GET).
- A custom **origin request policy** must forward the `Authorization` header to the API Gateway origin (the existing `ApiOriginRequestPolicy` forwards no headers, which would strip JWT tokens).
- Cache policy: **caching disabled** for all auth endpoints (tokens must never be cached).
- CORS: Allow origin `https://akli.dev`, methods GET/POST/DELETE, headers `Content-Type` and `Authorization`.

### Stack Dependencies

The `AuthStack` will expose the user pool ID, user pool client ID, and user pool ARN as outputs. These will be consumed by the `RecipeStack` (PRD 2) for its JWT authoriser configuration, avoiding duplication.

### TDD Approach

Follow test-driven development: write CDK assertion tests before implementing the stack. Use `aws-cdk-lib/assertions` for template matching, consistent with any existing test patterns in the repo.

## Acceptance Criteria

### Cognito Setup
- [ ] A Cognito user pool is created with email as the sign-in alias and self-sign-up disabled.
- [ ] Password policy enforces minimum 8 characters with uppercase, lowercase, numbers, and symbols.
- [ ] A user pool client is created with `USER_SRP_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` flows, no hosted UI.
- [ ] Access token validity is 1 hour; refresh token validity is 30 days.
- [ ] Two Cognito groups exist: `admin` and `contributor`.
- [ ] An initial admin user is seeded via Custom Resource on first deploy, with credentials stored in Secrets Manager.

### API Endpoints
- [ ] `POST /auth/login` accepts `{ email, password }` and returns `{ accessToken, idToken, refreshToken }` on success.
- [ ] `POST /auth/login` returns `{ challengeName: "NEW_PASSWORD_REQUIRED", session }` when a user has a temporary password.
- [ ] `POST /auth/refresh` accepts `{ refreshToken }` and returns new `{ accessToken, idToken }`.
- [ ] `POST /auth/confirm-new-password` accepts `{ session, newPassword }` and completes the `NEW_PASSWORD_REQUIRED` challenge. This is a public endpoint (no bearer token — the user hasn't completed auth yet).
- [ ] `POST /auth/change-password` accepts `{ previousPassword, newPassword }` with a valid bearer token for voluntary password changes.
- [ ] `GET /auth/users` returns a list of users with email, userId (Cognito `sub`), role (group), and status. Requires admin group membership.
- [ ] `POST /auth/users` accepts `{ email, role }` and creates a Cognito user with an invite email. Requires admin group membership.
- [ ] `DELETE /auth/users/{userId}` removes the user from the pool using the Cognito `sub` (UUID) as the identifier. Requires admin group membership.
- [ ] All admin-only endpoints return 403 if the caller is not in the `admin` group.
- [ ] All protected endpoints return 401 if no valid bearer token is provided.
- [ ] Public endpoints (`/auth/login`, `/auth/refresh`) work without any token.

### Infrastructure
- [ ] `AuthStack` is deployed to `eu-west-2` and follows existing tagging conventions (Owner, CostCenter, Project, Environment, ManagedBy).
- [ ] Auth endpoints are accessible via `api.akli.dev/auth/*` through the CloudFront distribution.
- [ ] Caching is disabled for all `/auth/*` CloudFront behaviours.
- [ ] CloudFront `/auth/*` behaviour uses `AllowedMethods.ALLOW_ALL` to support POST and DELETE.
- [ ] A custom origin request policy forwards the `Authorization` header to the auth API Gateway origin.
- [ ] CORS is configured to allow `https://akli.dev` with GET, POST, DELETE methods and `Content-Type`, `Authorization` headers.
- [ ] User pool ID and client ID are exported as stack outputs for consumption by other stacks.
- [ ] The `seed-admin` Custom Resource is idempotent — redeployment does not duplicate or overwrite the admin user.
- [ ] Cognito invite email uses a custom message template with basic akli.dev branding (site name in subject/body).
- [ ] A CloudWatch alarm is configured for failed login spikes (e.g. >10 failed attempts in 5 minutes).
- [ ] A CloudWatch alarm is configured for auth Lambda errors (error rate > 0).

### Testing
- [ ] CDK assertion tests verify the user pool, client, groups, and Lambda functions are created with the correct configuration.
- [ ] CDK assertion tests verify API Gateway routes and authoriser configuration.
- [ ] Lambda handler unit tests cover: successful login (SRP flow), failed login (wrong password), new password challenge flow, confirm-new-password, token refresh, and voluntary password change.
- [ ] Token validation/rejection is tested at the API Gateway authoriser level via CDK assertion tests (not Lambda unit tests, as the JWT authoriser handles this).
- [ ] Lambda admin handler unit tests cover: user creation, user listing, user deletion, and 403 for non-admin callers.
- [ ] All tests follow TDD — written before implementation.


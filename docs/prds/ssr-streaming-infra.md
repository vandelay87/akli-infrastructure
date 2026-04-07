# PRD: SSR Streaming Infrastructure

## Overview

Replace the API Gateway v2 (HTTP API) in the SSR path with a Lambda Function URL configured for response streaming. This enables progressive HTML streaming from the SSR Lambda through CloudFront to the browser, reduces cost by eliminating API Gateway, and lowers latency by removing a network hop.

## Problem Statement

The current SSR pipeline routes page requests through API Gateway v2 before reaching the Lambda. API Gateway buffers the entire response before forwarding it, which means:

1. Progressive streaming from `renderToPipeableStream` is impossible (the buffer defeats it)
2. API Gateway adds latency (extra network hop) and cost ($1/million requests)
3. The API Gateway serves no purpose here. It has no rate limiting, request validation, or usage plans configured. It's a pass-through.

Lambda Function URLs support response streaming natively. CloudFront can forward streaming responses from Function URLs without buffering. This is AWS's recommended architecture for SSR workloads.

## Goals

- Lambda SSR responses stream progressively through CloudFront to the browser
- API Gateway v2 removed from the SSR path (cost reduction, lower latency)
- CloudFront failover to S3 preserved (existing behaviour on 5xx)
- No downtime during migration
- CI/CD pipeline continues to work (Lambda code deployment)

## Non-Goals

- Changing the Lambda runtime, memory, or timeout
- Modifying CloudFront cache policies or static asset behaviours
- Touching the Pokedex API Gateway (separate stack, unrelated)
- Lambda@Edge or CloudFront Functions for SSR (over-engineered for this use case)

## User Stories

- As a visitor, I want blog pages to load faster so I see content sooner.
- As the site owner, I want lower AWS costs by removing the unnecessary API Gateway.
- As the site owner, I want the SSR pipeline to support React's streaming APIs for future-proofing.

## Design & UX

No user-facing design changes. The visitor experience improves (faster TTFB) but the pages look identical.

### Current architecture

```
Browser → CloudFront → API Gateway v2 → Lambda (renderToString) → buffered HTML
```

### New architecture

```
Browser → CloudFront → Lambda Function URL (RESPONSE_STREAM) → streaming HTML
```

## Technical Considerations

### Lambda Function URL

- Add a Function URL to the existing `SsrFunction` in `AkliInfrastructureStack`
- Invoke mode: `RESPONSE_STREAM` (enables `awslambda.streamifyResponse`)
- Auth type: `AWS_IAM` (CloudFront signs requests via OAC) or `NONE` (public, CloudFront handles caching)
- The Function URL endpoint replaces the API Gateway endpoint as the CloudFront origin

### CloudFront origin change

- Remove the `HttpOrigin` pointing to the API Gateway domain
- Add a new `HttpOrigin` pointing to the Lambda Function URL domain
- The OriginGroup (failover to S3 on 5xx) should be preserved with the new origin as primary
- SSR cache policy (60s TTL, forward query strings) stays the same

### API Gateway removal

- Remove the `HttpApi` construct and `HttpLambdaIntegration`
- Remove the `HttpApiUrl` CloudFormation output
- Update any references to the API Gateway endpoint

### Lambda handler changes

- The handler signature changes from API Gateway v2 format to Function URL format
- Function URL events are similar to API Gateway v2 events (`requestContext`, `rawPath`, `headers`) but not identical
- The handler must be wrapped with `awslambda.streamifyResponse` for streaming mode
- This change is in personal-website (separate PRD), but the infrastructure must support it

### IAM and permissions

- Lambda Function URL with `AWS_IAM` auth requires CloudFront OAC (Origin Access Control) for Lambda
- CDK supports this via `FunctionUrlOrigin` construct
- The `github-actions-deploy` IAM policy already has `lambda:UpdateFunctionCode` and `lambda:GetFunction`, which is sufficient
- If using `NONE` auth type, no additional IAM changes needed

### CI/CD impact

- The deploy workflow in personal-website pushes the server bundle to Lambda via `aws lambda update-function-code`. This doesn't change since the Lambda function itself is the same.
- The `SSR_LAMBDA_FUNCTION_NAME` secret remains valid

### Cost impact

- API Gateway v2: $1.00 per million requests (removed)
- Lambda Function URL: no additional cost (included in Lambda pricing)
- Net saving: ~$1/million requests

### Testing

TDD is the preferred approach.

- **CDK assertion tests**: verify Function URL exists on SSR Lambda with correct invoke mode, CloudFront origin points to Function URL (not API Gateway), OriginGroup failover preserved, API Gateway removed
- **Integration**: deploy to a test environment and verify streaming responses

## Acceptance Criteria

- [ ] Lambda Function URL added to SSR function with `RESPONSE_STREAM` invoke mode
- [ ] CloudFront default behaviour origin changed from API Gateway to Lambda Function URL
- [ ] CloudFront OriginGroup failover to S3 on 5xx preserved
- [ ] API Gateway v2 (`HttpApi`) removed from the stack
- [ ] `HttpApiUrl` output removed, replaced with Function URL output
- [ ] SSR cache policy unchanged (60s TTL, query string forwarding)
- [ ] Static asset cache behaviours unchanged (S3 origin)
- [ ] Security headers policy still applied to SSR responses
- [ ] `github-actions-deploy` IAM policy updated if needed for Function URL
- [ ] CDK assertion tests verify Function URL, CloudFront origin, and failover configuration
- [ ] `cdk diff` shows removal of API Gateway resources and addition of Function URL
- [ ] All tests pass (`pnpm test`)

## Open Questions

- Should the Function URL use `AWS_IAM` auth (more secure, requires CloudFront OAC for Lambda) or `NONE` (simpler, CloudFront caching handles protection)? AWS recommends `AWS_IAM` with OAC for production.
- Does the existing CloudFront subdirectory index rewrite function need updating for the new origin?
- Should the API Gateway be removed entirely or left in place (disabled) as a rollback option?

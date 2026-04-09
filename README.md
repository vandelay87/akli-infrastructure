# akli-infrastructure

AWS CDK infrastructure for [akli.dev](https://akli.dev). Manages static site hosting with S3, CloudFront, Route 53, and ACM.

## Architecture

Six CDK stacks deployed across regions:

| Stack | Region | Resources |
|-------|--------|-----------|
| CertificateStack | us-east-1 | Route 53 hosted zone, ACM certificates (required by CloudFront) |
| AkliInfrastructureStack | eu-west-2 | S3 bucket, CloudFront distribution, Route 53 records, IAM users |
| PokedexStack | eu-west-2 | DynamoDB table, HTTP API Gateway, Lambda handlers |
| AuthStack | eu-west-2 | Cognito user pool, HTTP API Gateway, Lambda handlers, JWT authoriser, CloudWatch alarms |
| RecipeStack | eu-west-2 | DynamoDB table, S3 image bucket, HTTP API Gateway, Lambda handlers (CRUD, image upload, image resizer), JWT authoriser |
| ApiStack | eu-west-2 | CloudFront distribution for api.akli.dev, routes to Pokedex, Auth, and Recipe APIs |

```
Route 53 (akli.dev, www.akli.dev)
  → CloudFront (HTTPS, compression, security headers)
    → Lambda Function URL (SSR, RESPONSE_STREAM) with S3 failover on 5xx
    → S3 (private, OAC) for static assets
```

### CloudFront behaviours

- **Default (SSR):** Lambda Function URL origin with S3 failover (OriginGroup, 5xx), 60s TTL, query string forwarding
- **Static assets (*.js, *.css, etc.):** S3 origin, optimised caching
- **images/*:** S3 origin, 30-day default TTL, 365-day max, query string caching
- **apps/sand-box*, apps/pokedex*:** S3 origin, CloudFront Function for subdirectory index rewriting

### Security

- S3 public access blocked, SSL enforced
- HTTPS redirect with HSTS (1 year, preload)
- X-Frame-Options: DENY, X-Content-Type-Options: nosniff
- Origin Access Control (only CloudFront can reach S3)

## Stack

- AWS CDK 2 + TypeScript
- pnpm

## Getting started

```bash
pnpm install
```

Create a `.env` file:

```
CDK_DEFAULT_ACCOUNT=<account-id>
CDK_DEFAULT_REGION=eu-west-2
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Compile TypeScript |
| `pnpm watch` | Watch mode compilation |
| `pnpm test` | Run Jest tests |
| `pnpm cdk diff --all` | Preview infrastructure changes |
| `pnpm cdk deploy --all` | Deploy all stacks |
| `pnpm cdk synth` | Generate CloudFormation templates |
| `pnpm cdk bootstrap` | Bootstrap CDK in the AWS account |

## CI/CD

GitHub Actions workflow on `.github/workflows/deploy.yml`:

- **PRs to main:** runs `cdk diff` to preview changes
- **Push to main:** bootstraps, deploys all stacks, then invalidates the CloudFront cache

Two IAM users with credentials stored in Secrets Manager:
- `github-actions-deploy` — S3 sync and CloudFront invalidation
- `cdk-github-actions` — CDK bootstrap and deploy

## Tags

All resources are tagged with:

| Tag | Value |
|-----|-------|
| Owner | Akli |
| CostCenter | Website |
| Project | akli-website |
| Environment | production |
| ManagedBy | CDK |

# akli-infrastructure

AWS CDK infrastructure for [akli.dev](https://akli.dev). Manages static site hosting with S3, CloudFront, Route 53, and ACM.

## Architecture

Seven CDK stacks deployed across regions:

| Stack | Region | Resources |
|-------|--------|-----------|
| CertificateStack | us-east-1 | Route 53 hosted zone, ACM certificates (required by CloudFront) |
| AkliInfrastructureStack | eu-west-2 | S3 buckets (site, Pokedex, Sandbox), CloudFront distribution, Route 53 records, IAM users, GitHub OIDC provider, per-app deploy roles |
| PokedexStack | eu-west-2 | DynamoDB table, HTTP API Gateway, Lambda handlers |
| AuthStack | eu-west-2 | Cognito user pool, HTTP API Gateway, Lambda handlers, JWT authoriser, CloudWatch alarms |
| RecipeStack | eu-west-2 | DynamoDB table, S3 image bucket, HTTP API Gateway, Lambda handlers (CRUD, image upload, image resizer), JWT authoriser |
| ImagesStack | eu-west-2 | CloudFront distribution for images.akli.dev, OAC, Route 53 records — serves recipe images from the recipe-images bucket under `recipes/*` |
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
- **apps/sand-box*, apps/pokedex*:** dedicated per-app S3 origins (`SandboxBucket`, `PokedexBucket`), CloudFront Function for subdirectory index rewriting

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
| `pnpm lint` | Run ESLint across the project |
| `pnpm cdk diff --all` | Preview infrastructure changes |
| `pnpm cdk deploy --all` | Deploy all stacks |
| `pnpm cdk synth` | Generate CloudFormation templates |
| `pnpm cdk bootstrap` | Bootstrap CDK in the AWS account |

## CI/CD

GitHub Actions workflow on `.github/workflows/deploy.yml`:

- **PRs to main:** runs `cdk diff` to preview changes
- **Push to main:** bootstraps, deploys all stacks, then invalidates the CloudFront cache

One IAM user with credentials stored in Secrets Manager, for this repo's own CDK bootstrap/deploy:
- `cdk-github-actions` — CDK bootstrap and deploy

A GitHub OIDC provider (`token.actions.githubusercontent.com`) and per-app IAM roles let `personal-website`, `pokedex`, and `sand-box` deploy without long-lived static credentials — each role trusts only its own repo on `main` and can only touch its own S3 bucket:
- `personal-website-deploy`, `pokedex-deploy`, `sandbox-deploy`

CloudFront routes `apps/pokedex*`/`apps/sand-box*` to their own dedicated buckets (`PokedexBucket`/`SandboxBucket`). The legacy shared `github-actions-deploy` IAM user and its static-key credential, used before this OIDC migration, have been removed.

## Tags

All resources are tagged with:

| Tag | Value |
|-----|-------|
| Owner | Akli |
| CostCenter | Website |
| Project | akli-website |
| Environment | production |
| ManagedBy | CDK |

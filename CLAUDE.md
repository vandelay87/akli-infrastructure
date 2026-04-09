# akli-infrastructure

AWS CDK infrastructure for akli.dev. Manages static site hosting with S3, CloudFront, Route 53, and ACM.

## PRDs

Before implementing any new feature, check `docs/prds/` for a relevant PRD. If one exists, read it fully and follow the spec. Do not add features beyond what the PRD describes.

## Stack

- AWS CDK 2 + TypeScript
- Jest for testing
- Package manager: pnpm (do not use npm or yarn)

## Architecture

Five stacks deployed across regions:

- **CertificateStack** (us-east-1): Route 53 hosted zone + ACM certificates (CloudFront requires us-east-1)
- **AkliInfrastructureStack** (eu-west-2): S3, CloudFront, Route 53 records, IAM users, Secrets Manager
- **PokedexStack** (eu-west-2): DynamoDB table, HTTP API Gateway, Lambda handlers
- **AuthStack** (eu-west-2): Cognito user pool, HTTP API Gateway, Lambda handlers, JWT authoriser, CloudWatch alarms
- **ApiStack** (eu-west-2): CloudFront distribution for api.akli.dev, routes to Pokedex and Auth APIs

Cross-region references are enabled so the main stack can consume the certificate.

## Conventions

- Stacks live in `lib/` with descriptive names (`*-stack.ts`)
- CDK app entry point is `bin/akli-infrastructure.ts`
- All resources are tagged (Owner, CostCenter, Project, Environment, ManagedBy)
- IAM credentials are stored in Secrets Manager, never hardcoded
- Use `--all` flag when running `cdk diff` or `cdk deploy` (multi-stack app)

## Deployment

- CI/CD via GitHub Actions on push to `main`
- PRs run `cdk diff` to preview changes
- Pushes deploy all stacks and invalidate the CloudFront cache
- Two IAM users: `github-actions-deploy` (S3/CloudFront) and `cdk-github-actions` (CDK admin)

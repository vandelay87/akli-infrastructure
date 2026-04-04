# PRD: SSR Infrastructure

## Overview

Add server-side rendering infrastructure to akli.dev by introducing a Lambda function and HTTP API Gateway as a second CloudFront origin. This enables crawlers and social media platforms to receive fully rendered HTML with correct meta tags, and lays the foundation for future dynamic content (blog, API-driven pages). The existing S3 static hosting remains as a fallback origin.

## Problem Statement

akli.dev is a client-side rendered SPA. Search engines and social media crawlers that don't execute JavaScript only see the generic meta tags from `index.html`. Per-page titles, descriptions, and Open Graph tags set dynamically via React are invisible to these crawlers. This limits SEO performance and produces poor link previews when the site is shared on social media.

Prerendering could solve this for the current 3 static pages, but it doesn't scale to future dynamic content. SSR provides a single solution that works for both static and dynamic routes.

## Goals

- Crawlers (Google, Twitter, Facebook, LinkedIn) receive fully rendered HTML with correct per-page meta tags
- CloudFront routes page requests to the Lambda SSR origin and static assets to S3
- If the Lambda origin fails, CloudFront falls back to the S3 static origin (existing SPA behaviour)
- Infrastructure supports future dynamic routes without further architectural changes
- Cost scales to zero when there is no traffic (Lambda + API Gateway pay-per-request model)

## Non-Goals

- Migrating the sand-box app to SSR — it's a standalone canvas app with no SEO-relevant text content and is deployed separately
- Implementing the SSR application code itself — that is a separate PRD in the personal-website repo
- Adding a database, CMS, or external data sources — the Lambda renders the React app, nothing more for now
- Edge computing (Lambda@Edge, CloudFront Functions for SSR) — keeping everything in eu-west-2 for consistency with the existing stack

## User Stories

- As a recruiter, I want to find akli.dev in Google search results with a relevant title and description so I can quickly understand what Akli does.
- As a user sharing akli.dev on LinkedIn or Twitter, I want the link preview to show a proper title, description, and image for the specific page being shared.
- As the site owner, I want the SSR infrastructure to scale to zero when idle so I don't pay for unused compute.
- As the site owner, I want the site to remain available if the Lambda fails, falling back to the existing SPA behaviour.

## Design & UX

No user-facing design changes. The infrastructure change is transparent — users see the same site, but crawlers and social media platforms receive server-rendered HTML instead of an empty SPA shell.

### Request flow

```
User/Crawler request
  → CloudFront
    ├── Static assets (*.js, *.css, images/*, apps/sand-box*)
    │     → S3 origin (unchanged)
    │
    └── HTML page requests (/, /apps, etc.)
          → API Gateway → Lambda (renders React to HTML)
          → If Lambda 5xx: failover to S3 origin (SPA fallback)
```

## Technical Considerations

### New AWS resources

All resources are added to the existing `AkliInfrastructureStack` in `eu-west-2`.

#### Lambda function
- Runtime: Node.js 20
- Handler: receives the request path, renders the React app to HTML using `renderToString`, returns the HTML response with correct status code and headers
- Memory: 256 MB (sufficient for React SSR; can be tuned later)
- Timeout: 10 seconds
- The Lambda code (server bundle) is deployed as a zip artifact from the personal-website CI/CD pipeline. For the initial infrastructure deployment, use a placeholder handler that returns a simple HTML page.
- Reserved concurrency: not set initially (Lambda default). Can add provisioned concurrency later if cold starts become an issue.

#### HTTP API Gateway (API Gateway v2)
- Cheaper and lower latency than REST API (API Gateway v1)
- Routes all requests (`$default` route) to the Lambda function
- No custom domain — CloudFront sits in front of it

#### CloudFront changes
- **New origin:** API Gateway endpoint as a second origin
- **Origin failover group:** Primary origin is API Gateway (Lambda SSR). Failover origin is S3 (existing static site). CloudFront automatically fails over on 5xx responses from the primary.
- **Updated default behaviour:** Route to the failover origin group instead of directly to S3. This means page requests go to Lambda first, with S3 as the fallback.
- **Static asset behaviours unchanged:** `images/*`, `apps/sand-box*`, and file-extension patterns (`.js`, `.css`, `.ico`, `.webp`, `.woff2`, etc.) continue routing to S3 directly. Add explicit cache behaviours for static file extensions to ensure they never hit Lambda.
- **Cache policy for SSR responses:** Cache HTML responses at the CloudFront edge for a short TTL (e.g., 60 seconds) to reduce Lambda invocations. Use a custom cache policy that caches on the full URI.
- **Remove SPA error responses:** The 404/403 → `/index.html` fallback is no longer needed for SSR routes — the Lambda handles routing. Keep the fallback only for the S3 failover scenario.

#### IAM
- Lambda execution role with CloudWatch Logs permissions (standard)
- No S3 access needed for the Lambda — it renders from its bundled code, not from S3

#### Deployment updates
- The GitHub Actions deploy workflow for personal-website will need to push the server bundle to Lambda (via `aws lambda update-function-code`). This requires adding Lambda permissions to the `github-actions-deploy` IAM user's policy.
- Add `lambda:UpdateFunctionCode` and `lambda:GetFunction` to the deploy user's policy, scoped to the SSR Lambda function ARN.
- Export the Lambda function name and ARN as CloudFormation outputs so the personal-website CI/CD can reference them.

### Cost considerations

- **Lambda:** $0.20 per 1M requests + $0.0000166667 per GB-second. At 256 MB and 100ms average duration, 100K requests/month costs ~$0.06.
- **API Gateway v2:** $1.00 per 1M requests. 100K requests/month costs ~$0.10.
- **CloudFront caching** significantly reduces Lambda invocations — most repeat visitors and crawlers hit the cache.
- Total estimated cost at low traffic: under $1/month. Scales linearly with traffic.

### What stays the same

- S3 bucket, OAC, and bucket policy — unchanged
- Certificate stack — unchanged
- Route 53 records — unchanged
- Security headers policy — applied to all behaviours including the new SSR origin
- `images/*` and `apps/sand-box*` cache behaviours — unchanged
- IAM user for CDK deployment — unchanged

## Acceptance Criteria

- [ ] Lambda function is created in eu-west-2 with Node.js 20 runtime and a placeholder handler
- [ ] HTTP API Gateway (v2) is created and routes requests to the Lambda function
- [ ] CloudFront distribution has the API Gateway as a new origin
- [ ] CloudFront origin failover group is configured: API Gateway primary, S3 fallback on 5xx
- [ ] CloudFront default behaviour routes to the failover origin group
- [ ] Static asset requests (`.js`, `.css`, `.ico`, `.webp`, `.woff2`, `images/*`, `apps/sand-box*`) continue routing directly to S3
- [ ] SSR HTML responses are cached at the CloudFront edge with a short TTL
- [ ] Security headers policy is applied to SSR responses
- [ ] Lambda execution role has CloudWatch Logs permissions
- [ ] `github-actions-deploy` IAM user policy includes `lambda:UpdateFunctionCode` and `lambda:GetFunction` scoped to the SSR Lambda ARN
- [ ] Lambda function name and ARN are exported as CloudFormation outputs
- [ ] `cdk diff` shows only the expected new resources (no unintended changes to existing infrastructure)
- [ ] `cdk deploy` completes successfully
- [ ] Existing static site continues to work during and after deployment (no downtime)
- [ ] Tags (Owner, CostCenter, Project, Environment, ManagedBy) are applied to all new resources

## Open Questions

- Should the CloudFront SSR cache TTL be configurable via a CDK context value, or is a hardcoded 60 seconds sufficient for now?
- Should we add a CloudWatch alarm for Lambda errors to catch SSR failures early, or is that a follow-up?
- What static file extensions should explicitly route to S3? Starting set: `.js`, `.css`, `.ico`, `.svg`, `.webp`, `.woff2`, `.png`, `.jpg`, `.json`, `.xml`, `.txt`. Are there others?

# PRD: Per-App S3 Buckets & OIDC Deploy Credentials

> Companion PRDs: `oidc-deploy-credentials.md` in `personal-website`, `pokedex`, and `sand-box`. This is the primary/detailed PRD — the companions are small, mechanical changes to each app's own `deploy.yml`.
>
> This is infra PRD #1 of 2 in a planned hosting re-architecture. A second, separate PRD (subdomain-per-app, e.g. `pokedex.akli.dev` instead of `akli.dev/apps/pokedex`) is planned as a follow-up and is explicitly out of scope here.

## Overview

Replace the current shared-infrastructure deploy pattern — one S3 bucket for the whole site, one IAM User (`github-actions-deploy`) with a bucket-wide static access key copied into every app repo's GitHub Actions secrets — with per-app isolation: each app gets its own S3 bucket and its own IAM Role, assumed via GitHub OIDC federation rather than a long-lived static key. This is a deliberate best-practices/learning exercise, not a response to an incident — nothing is currently broken.

## Problem Statement

Today, `personal-website`, `pokedex`, and `sand-box` all deploy using the *same* IAM credential: a static access key belonging to `github-actions-deploy`, stored in Secrets Manager and copied by hand into each repo's GitHub Actions secrets. This was verified directly, not assumed — `personal-website/.github/workflows/deploy.yml` and `pokedex/.github/workflows/deploy.yml`/`sand-box/.github/workflows/deploy.yml` all configure AWS credentials from secrets holding the same underlying key (under different secret *names* per repo).

Two concrete problems with this:

1. **Every app is wildly over-privileged.** The shared credential's policy grants `s3:GetObject/PutObject/DeleteObject/ListBucket` on the *entire* site bucket (not scoped to any app's own prefix), `cloudfront:CreateInvalidation` on the whole distribution, and `lambda:UpdateFunctionCode`/`GetFunction` on the SSR Lambda. That means Pokedex and Sand-box's CI — which only need to sync static files into their own subfolder — currently hold credentials capable of overwriting `personal-website`'s SSR backend code and deleting the entire site's content, including apps that aren't theirs.
2. **The credential itself is a long-lived static secret**, copied into multiple places (Secrets Manager + N GitHub repos' secret stores). Each copy is an independent leak surface, and if one ever leaks, it keeps working until someone notices and manually rotates it — there's no automatic expiry.

## Goals

- Each app (`personal-website`, `pokedex`, `sand-box`) deploys using credentials that can only touch that app's own S3 bucket, plus the unavoidable shared CloudFront invalidation permission (see Technical Considerations — this one permission cannot be scoped narrower given today's single shared distribution).
- No static, long-lived AWS credentials exist anywhere in this system after migration — GitHub Actions authenticates via OIDC and receives short-lived, automatically-expiring credentials per run.
- The pattern is reusable: adding a fourth app (e.g. Storybook, once that initiative resumes) means following the same bucket + Role template, not inventing a new one.
- No change in what visitors see — `akli.dev/apps/pokedex` and `akli.dev/apps/sand-box` continue to work exactly as before, just backed by different S3 buckets.

## Non-Goals

- Subdomain-per-app (`pokedex.akli.dev` instead of `/apps/pokedex`) — separate, already-planned follow-up PRD. Paths and `base` config in each app's Vite build are unchanged here.
- Scoping down the separate `cdk-github-actions` IAM User (currently `AdministratorAccess`, used for CDK's own deploys) — a bigger, separate initiative; CDK inherently needs broad permissions to manage arbitrary infrastructure, and narrowing that safely is its own project. Explicitly not attempted here.
- Per-path CloudFront invalidation scoping — not achievable with the current single-distribution architecture (see Technical Considerations). Accepted as a documented limitation, not solved here.
- Any change to `pokedex`'s or `sand-box`'s application code, build output, or `base` path — this PRD only touches deploy credentials and the S3/CloudFront target.
- Setting up Storybook's own bucket/Role — the pattern is documented for reuse, but the fourth bucket/Role isn't created until the Storybook initiative actually resumes.

## User Stories

- As the site owner, I want Pokedex and Sand-box's CI to be physically incapable of touching personal-website's Lambda or bucket content, so a compromised dependency in one app's build can't affect the others.
- As the site owner, I want no long-lived AWS secret sitting in any GitHub repo's settings, so there's nothing static to leak or rotate.
- As the site owner, I want to add a new app's deploy pipeline later by following one documented pattern, not re-deriving IAM policy from scratch each time.

## Design & UX

No UI — this is CDK/infrastructure and CI configuration only. Visitors to `akli.dev/apps/pokedex` and `akli.dev/apps/sand-box` see no difference before, during (aside from the brief planned migration window, see below), or after this change.

## Technical Considerations

### GitHub OIDC provider (one-time, account-level)

- Use `iam.OidcProviderNative` (backed by the native `AWS::IAM::OIDCProvider` CloudFormation resource), not `iam.OpenIdConnectProvider`. The latter is CDK's legacy construct — its own doc comment in the installed CDK version states it should not receive new usage and is maintained for backward compatibility only; it's also backed by a Lambda-based custom resource whose singleton handler holds a broad `Resource: "*"` IAM grant, which sits awkwardly in a PRD about eliminating over-broad permissions.
- **Correction**: `OidcProviderNative` requires an explicit thumbprint (unlike the legacy construct's automatic retrieval) — this is a real tradeoff of using the recommended construct, not an oversight. GitHub Actions' commonly-documented OIDC thumbprint is `6938fd4d98bab03faadb97b34396831e3780aea`, but thumbprints are tied to GitHub's current TLS certificate chain and have changed before (GitHub rotated theirs in 2023, breaking anyone with a hardcoded stale value) — whoever implements this must verify the current correct value against AWS's or GitHub's current published OIDC setup docs at deploy time, not trust a value copied from this PRD without checking.
- URL `https://token.actions.githubusercontent.com`, audience/client ID `sts.amazonaws.com`.
- Confirm no `token.actions.githubusercontent.com` provider already exists in this AWS account before the first deploy — CDK/CloudFormation hard-fails (rather than importing) if you try to register the same OIDC provider URL twice in one account. Unlikely given the account's current all-static-key setup, but cheap to check.
- This is created once and reused by every per-app Role below; adding a future app never requires touching this provider again.

### Per-app IAM Roles (replacing the single IAM User)

- One `iam.Role` per app — `PersonalWebsiteDeployRole`, `PokedexDeployRole`, `SandboxDeployRole` — each with a web-identity trust policy scoped to:
  - Audience: `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com`
  - Subject: `token.actions.githubusercontent.com:sub` = `repo:vandelay87/<repo>:ref:refs/heads/main` (exact repo, main branch only — matches where each app's deploy step actually runs today; confirmed via each repo's real GitHub remote and deploy.yml branch guards)
- Each Role's inline policy is scoped to that app's own bucket only: `s3:GetObject/PutObject/DeleteObject/ListBucket` on that bucket's ARN + `ARN/*`. No app's Role can reference another app's bucket ARN.
- **`cloudfront:CreateInvalidation` is necessarily shared across all three Roles**, scoped to the one distribution ARN. This is a real architectural constraint, not an oversight: IAM's CloudFront actions are scoped by distribution, not by path pattern within a distribution — there's no IAM syntax that means "can invalidate `/apps/pokedex/*` but not `/apps/sand-box/*`" on a shared distribution. Full invalidation isolation isn't achievable until each app has its own distribution (the future subdomain PRD). This is still a large improvement over today: every app previously had unscoped S3 access to the entire bucket; now only the invalidation action (which can force a cache refresh but can't read, write, or delete any object) remains shared.
- `PersonalWebsiteDeployRole` additionally keeps `lambda:UpdateFunctionCode`/`GetFunction` scoped to the SSR function's ARN, matching what only that app actually needs. `PokedexDeployRole` and `SandboxDeployRole` get neither — today's shared credential over-grants this to both, and that over-grant goes away.
- `github-actions-deploy` (the IAM User) and its Secrets Manager secret (`github-actions-credentials`) are deleted once all three apps have migrated and been verified — not left around unused.

### New S3 buckets

- `PokedexBucket`, `SandboxBucket` (named `sandbox`, no hyphen, anticipating a future `sandbox.akli.dev` subdomain — the `sand-box` GitHub repo itself keeps its existing hyphenated name; only the AWS-side resource naming differs). Same hardening as the existing `SiteBucket`: `BlockPublicAccess.BLOCK_ALL`, `RemovalPolicy.DESTROY` + `autoDeleteObjects: true` (matches this project's existing low-stakes personal-site convention), `BucketEncryption.S3_MANAGED`, `enforceSSL: true`.
- `SiteBucket` is kept as-is for `personal-website`'s own content — it already excludes the other two apps' prefixes from its own sync (`--exclude "apps/sand-box/*" --exclude "apps/pokedex/*"` in `personal-website/deploy.yml`), so no change needed there beyond the credential swap.

### CloudFront changes

- Reuse the existing single `S3OriginAccessControl` construct — one distribution, so one OAC is correct; CDK's OAC can back multiple bucket origins. Each new bucket gets its own resource-policy statement (mirroring `SiteBucket`'s existing `AllowCloudFrontServicePrincipal` statement) granting the shared OAC's distribution `s3:GetObject`/`s3:ListBucket`, conditioned on `AWS:SourceArn` matching the one distribution — same pattern, new bucket.
- New S3 origins for `PokedexBucket` and `SandboxBucket`. The `additionalBehaviors` entries for `apps/pokedex*` and `apps/sand-box*` (currently pointing at the shared `SiteBucket`-backed origin) are repointed to their own new origins. The existing `subdirectoryIndexHandler` CloudFront Function association is unchanged on both — that logic (index-file fallback within a subdirectory) is unrelated to which bucket backs the origin.
- **Important, easy to get wrong**: CloudFront does not strip the matched `apps/pokedex*`/`apps/sand-box*` path pattern before forwarding to origin — the full request URI becomes the S3 object key (there's no `OriginPath`-style prefix-stripping applied here, and the existing CloudFront Function only does index-file fallback, not URI rewriting). This means each new dedicated bucket must still store its objects under the same `apps/pokedex/`/`apps/sand-box/` key prefix it uses today — even though the bucket now belongs to only that one app — not at the bucket root. Deploying to bucket root would silently 403/404 at cutover, since CloudFront would still request `apps/pokedex/index.html` from a bucket that only has `index.html`. The companion PRDs in `pokedex` and `sand-box` must sync to `s3://<bucket>/apps/pokedex`/`s3://<bucket>/apps/sand-box`, not bucket root.

### Migration & cutover (brief downtime accepted, per explicit product decision)

**This requires two separate `cdk deploy` operations, not one PR/one deploy implementing the whole Technical Considerations section at once.** If bucket creation and the CloudFront behavior repoint land in the same deploy, the distribution starts serving the new (still-empty) buckets the instant that deploy completes — live 403s on `/apps/pokedex` and `/apps/sand-box` until the companion repos happen to redeploy afterward, an indeterminate gap since that depends on a separate repo's CI running.

1. **Deploy A** (`akli-infrastructure`): create the OIDC provider, the three IAM Roles, and the two new buckets + their resource policies. CloudFront's `additionalBehaviors` still point at the old shared-bucket origin — no visible change yet.
2. In `pokedex` and `sand-box`: switch each repo's `deploy.yml` to OIDC and the new bucket target (per their companion PRDs), and run a real deploy — this populates the new dedicated buckets while they're still not receiving any live traffic.
3. Verify directly that each new bucket actually holds the expected content (e.g. a signed/temporary check, or CloudFront-independent verification) before proceeding — CloudFront isn't pointed at them yet, so this can't yet be checked via the live URL.
4. **Deploy B** (`akli-infrastructure`, only after step 3 is confirmed for both apps): repoint `additionalBehaviors` to the new origins.
5. Verify the live URLs (`akli.dev/apps/pokedex`, `akli.dev/apps/sand-box`) serve correctly from the new origins.
6. Once both apps are verified, remove the now-unused `github-actions-deploy` IAM User and its Secrets Manager secret — a third, final `cdk deploy`.
7. Delete the now-stale `apps/pokedex/` and `apps/sand-box/` prefixes from `SiteBucket` (e.g. `aws s3 rm s3://<SiteBucket>/apps/pokedex --recursive` and the equivalent for sand-box). This is an explicit step, not left "opportunistic" — unreferenced copies of app content sitting in a bucket they no longer belong to is exactly the kind of drift this PRD exists to eliminate, and it's cheap to do immediately once step 5's verification passes rather than relying on remembering to do it later.

### GitHub Actions workflow shape (for the companion PRDs to implement)

- `aws-actions/configure-aws-credentials@v5` supports `role-to-assume` directly — no `aws-access-key-id`/`aws-secret-access-key` inputs at all once migrated.
- **Critical, easy-to-miss requirement**: the workflow (or the specific job) must declare `permissions: id-token: write` — without this, GitHub won't issue an OIDC token for the step to exchange, and `configure-aws-credentials` fails. This is the single most common OIDC setup mistake and is called out explicitly in each companion PRD's Acceptance Criteria.
- IAM Role ARNs are **not sensitive** (unlike the static keys they replace) — they can be committed directly in each repo's `deploy.yml` rather than stored as a GitHub secret, if preferred. Whether to keep them as repo variables/secrets anyway (for easier updates without a code change) or hardcode them is left to whoever implements each companion PRD — not a blocking decision here.

### Testing

- CDK assertion tests (Jest, following the existing shape in `test/akli-infrastructure.test.ts`) verify:
  - The `AWS::IAM::OIDCProvider` resource exists with the correct URL and client ID — generic `hasResourceProperties`/`Match` is sufficient here (single resource)
  - The CloudFront distribution's `additionalBehaviors` route `apps/pokedex*`/`apps/sand-box*` to the correct new origins — generic `hasResourceProperties` is sufficient
  - **Per-bucket and per-role checks need the manual per-logical-ID template-walk pattern already established in this file** (`cfnDistribution`/`distributionConfig`/`isFunctionUrlOrigin` helpers), not a bare `hasResourceProperties`/`Match.arrayWith` call — those only prove *at least one* matching resource exists in the whole template, not that *each* of the three buckets/Roles independently satisfies the property. This matters most for the negative assertion ("Role X's policy does NOT reference Role Y's bucket ARN"), which a positive `Match` pattern can't express at all — write a helper that resolves each Role's logical ID to its actual policy document and asserts on that specific object, mirroring how the existing file resolves specific origins by ID rather than asserting generically across "some origin somewhere."

## Acceptance Criteria

- [ ] `iam.OidcProviderNative` (native `AWS::IAM::OIDCProvider`) exists for `token.actions.githubusercontent.com` with audience `sts.amazonaws.com` and a thumbprint verified against current AWS/GitHub docs at implementation time (not blindly copied from this PRD)
- [ ] `PersonalWebsiteDeployRole`, `PokedexDeployRole`, `SandboxDeployRole` each exist with a trust policy scoped to their own exact repo (`vandelay87/<repo>`) and `ref:refs/heads/main` only
- [ ] Each Role's policy grants S3 access only to that app's own bucket (`SiteBucket` for personal-website, `PokedexBucket`, `SandboxBucket`) — verified by asserting no cross-app bucket ARN appears in another app's Role policy
- [ ] `PersonalWebsiteDeployRole` includes `lambda:UpdateFunctionCode`/`GetFunction` scoped to the SSR function; `PokedexDeployRole` and `SandboxDeployRole` do not
- [ ] All three Roles include `cloudfront:CreateInvalidation` scoped to the one shared distribution (documented as an accepted limitation, not a gap)
- [ ] `PokedexBucket` and `SandboxBucket` exist with the same hardening as `SiteBucket` (BLOCK_ALL, DESTROY + autoDeleteObjects, SSE-S3, enforceSSL)
- [ ] CloudFront `additionalBehaviors` for `apps/pokedex*`/`apps/sand-box*` route to their own new bucket origins, with the existing `subdirectoryIndexHandler` function association preserved unchanged
- [ ] Each new bucket's content is verified to live under the same `apps/<name>/` key prefix CloudFront forwards (not bucket root) — confirmed by a real request to `https://akli.dev/apps/pokedex` (and sand-box) resolving correctly against the new origin, not a 403/404
- [ ] After migration, `github-actions-deploy` IAM User and the `github-actions-credentials` Secrets Manager secret no longer exist in the stack
- [ ] Deploy A's `cdk diff` shows only resource creation (`[+]`) — new provider, new roles, new buckets, new bucket policies — with no changes to the existing CloudFront distribution
- [ ] Deploy B's `cdk diff` shows only an in-place update (`[~]`) to the existing distribution's `additionalBehaviors` — no replacements or deletions
- [ ] The destructive removal of the old IAM User/secret is its own explicit, separate deploy (Deploy C) after both apps are verified working on their new buckets
- [ ] The stale `apps/pokedex/` and `apps/sand-box/` content is deleted from `SiteBucket` after cutover is verified — not left behind indefinitely
- [ ] `https://akli.dev/apps/pokedex` and `https://akli.dev/apps/sand-box` both serve correctly after cutover
- [ ] All CDK assertion tests described above pass (`pnpm test`)

## Open Questions

- None — all resolved during PRD discovery (IAM primitive, cross-repo handling, and migration approach were explicitly decided by the user before this PRD was written).

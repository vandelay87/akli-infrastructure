# PRD: Storybook Bucket, OIDC Deploy Role & Subdomain

> Companion PRDs: `akli-ui-package-and-storybook.md` in `akli-ui`, `akli-ui-component-classification.md` in `personal-website`.
>
> Builds directly on `per-app-buckets-and-oidc-deploy.md` and `subdomain-per-app-migration.md` (both now shipped) — reuses the existing OIDC provider and follows the same per-app bucket + Role + dedicated-subdomain-distribution pattern established for Pokedex and Sand-box.

## Overview

Provision the AWS infrastructure for the new Storybook static site (published from the `akli-ui` repo): a dedicated `StorybookBucket`, an OIDC-based `StorybookDeployRole`, and a dedicated `storybook.akli.dev` subdomain served by its own CloudFront distribution (`StorybookSiteStack`) — mirroring `PokedexBucket`/`PokedexDeployRole`/`PokedexSiteStack` exactly.

## Problem Statement

This PRD originally planned to route Storybook via the shared distribution's path-based `additionalBehaviors` (matching the old `apps/pokedex`/`apps/sand-box` pattern) and to reuse the static `github-actions-deploy` IAM user's credentials. Neither of those exists anymore: `per-app-buckets-and-oidc-deploy.md` and `subdomain-per-app-migration.md` have since shipped, replacing that shared-bucket/shared-distribution/static-credential setup with per-app buckets, OIDC-federated per-app deploy Roles, and dedicated per-app subdomains each on their own CloudFront distribution. The old `apps/pokedex*`/`apps/sand-box*` `additionalBehaviors`, the `subdirectoryIndexHandler` CloudFront Function, and the `github-actions-deploy` IAM user/secret were all removed as part of that work (Deploy B/C of the respective PRDs). Building Storybook against the retired pattern isn't an option — it targets infrastructure that no longer exists. Storybook should be provisioned directly on the current pattern instead.

## Goals

- `storybook.akli.dev` serves the deployed Storybook build correctly, including deep-linked story URLs, via its own dedicated CloudFront distribution (mirroring `PokedexSiteStack`/`SandboxSiteStack`)
- `akli-ui`'s CI authenticates via GitHub OIDC through a dedicated `StorybookDeployRole` scoped only to `StorybookBucket` (plus invalidation on its own distribution) — no static credentials, no bucket-wide or cross-app access
- Reuse the existing GitHub OIDC provider (`token.actions.githubusercontent.com`, created by `per-app-buckets-and-oidc-deploy.md`) — no new provider
- Reuse the existing per-subdomain ACM certificate convention (`StorybookCert`, DNS-validated, independent — no wildcard/shared cert), consistent with `PokedexCert`/`SandboxCert`

## Non-Goals

- Any change to Pokedex's, Sand-box's, or `personal-website`'s own buckets, Roles, certs, distributions, or routing
- A path-based `akli.dev/apps/storybook` route — not built. The shared-distribution path pattern this PRD originally specified was superseded by the subdomain architecture before any of this PRD's implementation began, so there's no intermediate path-based version to build or migrate away from
- A phased/two-deploy migration like PRD #1/#2 needed — those were required because Pokedex/Sand-box were already live on the old path-based URLs and couldn't have downtime. Nothing is live for Storybook yet at any URL, so bucket + Role + cert + site stack can land additively in one PR (see Technical Considerations)
- A wildcard certificate for app subdomains — same standing decision as `subdomain-per-app-migration.md`
- Redirects from any old URL — no `akli.dev/apps/storybook` URL ever went live, so there is nothing to redirect from
- New IAM users or shared/bucket-wide credentials — every deploy target in this repo now uses per-app OIDC Roles; introducing a fourth static credential would regress the pattern this PRD is built on

## User Stories

- As a visitor to akli.dev, I want `storybook.akli.dev` (and deep-linked story URLs, e.g. `storybook.akli.dev/?path=/story/button--primary`) to load correctly, so I can browse the design system.
- As the site owner, I want Storybook's CI to hold only short-lived, narrowly-scoped credentials — consistent with how Pokedex and Sand-box already deploy — so a fourth app doesn't reintroduce the over-broad, long-lived credential problem PRD #1 eliminated.

## Design & UX

No UI — this is CDK/infrastructure only.

## Technical Considerations

### New S3 bucket

- `StorybookBucket`, created in `AkliInfrastructureStack` and exposed as a `public readonly` property (same as `PokedexBucket`/`SandboxBucket`), so `StorybookSiteStack` can import it cross-stack.
- Same hardening as the existing app buckets: `BlockPublicAccess.BLOCK_ALL`, `RemovalPolicy.DESTROY` + `autoDeleteObjects: true`, `BucketEncryption.S3_MANAGED`, `enforceSSL: true`.
- Content is deployed to the bucket **root**, not an `apps/storybook/` prefix — there is no shared distribution stripping/forwarding a path pattern here, so (unlike PRD #1's interim state for Pokedex/Sand-box) there's no prefix concern to get wrong.

### OIDC deploy Role (reusing the existing provider)

- `StorybookDeployRole`, following the exact shape of `PokedexDeployRole`/`SandboxDeployRole`: web-identity trust policy scoped to audience `sts.amazonaws.com` and subject `repo:vandelay87/akli-ui:ref:refs/heads/main`.
- Policy grants `s3:GetObject/PutObject/DeleteObject/ListBucket` on `StorybookBucket` only, plus `cloudfront:CreateInvalidation` scoped to `StorybookSiteStack`'s **own** distribution ARN. This is actually simpler than PRD #1's interim Pokedex/Sand-box Roles: because Storybook gets its own dedicated distribution from day one (see below), there's no shared-distribution invalidation permission to reason about or later narrow — the Role is fully self-contained from the start.
- No new OIDC provider is created — reuses the one `per-app-buckets-and-oidc-deploy.md` already provisioned for `token.actions.githubusercontent.com`.

### Per-app certificate (`CertificateStack`, us-east-1)

- `StorybookCert` (`certificatemanager.Certificate` for `storybook.akli.dev`), DNS-validated against the existing hosted zone — same pattern as `PokedexCert`/`SandboxCert`. `SiteCert`/`ApiCert`/`ImagesCert`/`PokedexCert`/`SandboxCert` are untouched.
- Exported from `CertificateStack` for `StorybookSiteStack` to consume, with `crossRegionReferences: true` where instantiated in `bin/akli-infrastructure.ts` (matching `ImagesStack`/`PokedexSiteStack`/`SandboxSiteStack`).

### `StorybookSiteStack`

Mirrors `PokedexSiteStack`/`SandboxSiteStack` exactly:

- Own `cloudfront.S3OriginAccessControl`
- Cross-stack import of `StorybookBucket` via `s3.Bucket.fromBucketAttributes(...)` for the CloudFront origin — but `.addToResourcePolicy()` is called on the **original** bucket reference passed into the stack, not the imported handle (the same easy-to-misapply gotcha `subdomain-per-app-migration.md` documented: calling it on the imported handle silently no-ops and leaves the bucket permanently 403ing)
- `cloudfront.Distribution` with `domainNames: ['storybook.akli.dev']`, `certificate: storybookCert`, `defaultRootObject: 'index.html'`, default behavior with `viewerProtocolPolicy: REDIRECT_TO_HTTPS` and `responseHeadersPolicy: createSecurityHeadersPolicy(this)`
- `errorResponses`: `403`/`404` → `responsePagePath: '/index.html'`, `responseHttpStatus: 200` — the current SPA-fallback convention, not the retired `subdirectoryIndexHandler` CloudFront Function (which no longer exists anywhere in this stack). Storybook's own navigation is entirely query-string-driven against one static `index.html`/`iframe.html`, so in practice `errorResponses` will rarely trigger — but it's the correct, consistent default rather than a special-cased exception, and it means Storybook doesn't skip the same catch-all safety net every other app subdomain has.
- `route53.ARecord` and `route53.AaaaRecord` aliasing to the distribution
- `applyStackTags(this, props)`

### Deploy target

- `akli-ui`'s CI syncs `build-storybook` output to `s3://<StorybookBucket>` root (not a prefix), authenticating via `aws-actions/configure-aws-credentials@v5` with `role-to-assume: <StorybookDeployRole ARN>` and `permissions: id-token: write` declared on the job — matching the OIDC workflow shape `per-app-buckets-and-oidc-deploy.md` established for Pokedex/Sand-box's companion PRDs. No static AWS credentials are stored in the `akli-ui` repo at any point — this repo never had the old `github-actions-deploy` credential copied into it.
- The Role ARN is not sensitive and can be committed directly in `akli-ui`'s `deploy.yml` (or kept as a repo variable), per the same precedent as PRD #1.

### Cutover

No phased migration is needed: unlike Pokedex/Sand-box (which had to stay live on the old path-based URLs throughout PRD #1/#2's rollout), nothing currently serves Storybook at any URL. `StorybookBucket`, `StorybookDeployRole`, `StorybookCert`, and `StorybookSiteStack` can all land in a single additive `cdk deploy` here; the `akli-ui` repo then points its `deploy.yml` at the new bucket/Role once this merges. Verify the first real `akli-ui` CI deploy populates `StorybookBucket` and that `https://storybook.akli.dev` serves correctly before calling this done.

### Testing

- CDK assertion tests (Jest, following the existing per-logical-ID template-walk pattern from `test/akli-infrastructure.test.ts`) verify:
  - `StorybookBucket` exists with the same hardening as `PokedexBucket`/`SandboxBucket`
  - `StorybookDeployRole`'s trust policy is scoped to `repo:vandelay87/akli-ui:ref:refs/heads/main` only, and its inline policy grants S3 access only to `StorybookBucket`'s ARN (verified by asserting no other app's bucket ARN appears in this Role's policy, and this Role's own bucket ARN doesn't appear in another app's Role)
  - `StorybookDeployRole` includes `cloudfront:CreateInvalidation` scoped to `StorybookSiteStack`'s distribution ARN only — not the main shared distribution and not another app's distribution
  - `StorybookCert` exists as an independent, DNS-validated certificate for `storybook.akli.dev`, distinct from every other certificate in the stack
  - `StorybookSiteStack`'s distribution has `domainNames: ['storybook.akli.dev']`, the correct certificate, `defaultRootObject: 'index.html'`, `viewerProtocolPolicy: redirect-to-https`, the security headers response policy, and `errorResponses` covering 403/404 → `/index.html`/200 (single-resource-per-template case, so a plain `hasResourceProperties` against `Template.fromStack(storybookSiteStack)` is sufficient, per `subdomain-per-app-migration.md`'s testing note)
  - `StorybookSiteStack`'s bucket resource policy is attached to the correct (original, not imported) bucket handle
  - `StorybookSiteStack` has both an `ARecord` and an `AaaaRecord` for `storybook.akli.dev`
  - `StorybookSiteStack` is instantiated with `crossRegionReferences: true`

## Acceptance Criteria

- [ ] `StorybookBucket` exists in `AkliInfrastructureStack` as a `public readonly` property, with the same hardening as `PokedexBucket`/`SandboxBucket`
- [ ] `StorybookDeployRole` exists with a trust policy scoped to `repo:vandelay87/akli-ui:ref:refs/heads/main` only, reusing the existing OIDC provider (no new provider created)
- [ ] `StorybookDeployRole`'s policy grants S3 access only to `StorybookBucket` and `cloudfront:CreateInvalidation` only on `StorybookSiteStack`'s own distribution — verified no cross-app bucket or distribution ARN appears in its policy
- [ ] `StorybookCert` exists in `CertificateStack` as an independent, DNS-validated certificate for `storybook.akli.dev`; no other certificate is modified
- [ ] `StorybookSiteStack` exists with its own `cloudfront.Distribution`, `S3OriginAccessControl`, `ARecord`, and `AaaaRecord`, mirroring `PokedexSiteStack`/`SandboxSiteStack`
- [ ] The distribution uses `errorResponses` for SPA fallback (403/404 → `/index.html`, 200) — not a CloudFront Function
- [ ] The distribution sets `defaultRootObject: 'index.html'`, `viewerProtocolPolicy: REDIRECT_TO_HTTPS`, and the shared `createSecurityHeadersPolicy()` response headers policy
- [ ] The bucket is imported via `Bucket.fromBucketAttributes` for the CloudFront origin, but `.addToResourcePolicy()` is called on the original bucket reference — verified the policy actually attaches
- [ ] `StorybookSiteStack` is deployed with `crossRegionReferences: true` to consume `StorybookCert` from `CertificateStack`
- [ ] `cdk diff` shows only resource creation — no changes to any existing bucket, Role, certificate, or distribution
- [ ] All CDK assertion tests described above pass (`pnpm test`)
- [ ] `https://storybook.akli.dev` serves the deployed Storybook build correctly, including a deep-linked story URL, once `akli-ui`'s first real deploy runs (tracked as a follow-up verification, not blocking this PRD's own AWS resources — the Storybook build doesn't exist yet at the point this infra ships)

## Open Questions

- ~~Does Storybook's static build need explicit base-path configuration?~~ — resolved: no. `@storybook/react-vite` defaults to `base: '/'` unless overridden via `viteFinal`, which is exactly correct for a dedicated subdomain served from bucket root. An explicit override (`base: '/apps/storybook/'`) would only have been needed under the old path-prefixed design — retired, see Problem Statement. No action needed in the `akli-ui` repo's Storybook config.

# PRD: Images CDN — Phase 2 (Blog Origin on `images.akli.dev`)

> **Sibling PRD:** [`personal-website/docs/prds/images-cdn-phase-2.md`](../../../personal-website/docs/prds/images-cdn-phase-2.md) — covers moving `public/images/blog/` to `public/blog/` in the personal-website repo and updating MDX/component references from `akli.dev/images/blog/*` → `images.akli.dev/blog/*`. **Must deploy after this PRD ships.**
>
> **Builds on:** [`images-cdn-phase-1.md`](./images-cdn-phase-1.md) — phase 1 stood up `images.akli.dev` with the recipe-images bucket as the first origin. This PRD adds the site bucket as a second origin, completing the unified images CDN.
>
> **Epic context:** PRD 3 of 4 in the unified images CDN epic.
> 1. `akli-infrastructure` phase 1 (done) — subdomain + recipe-images origin.
> 2. `personal-website` phase 1 (done) — frontend cutover for recipe URLs.
> 3. **THIS PRD** — `akli-infrastructure` phase 2: add blog origin under the same subdomain.
> 4. `personal-website` phase 2 (sibling above) — restructure `public/blog/` directory + MDX migration.

## Overview

Add the existing site bucket (`SiteBucket` in `AkliInfrastructureStack`) as a second origin on the `images.akli.dev` CloudFront distribution. Serves blog images at `https://images.akli.dev/blog/<filename>.webp` once the personal-website side moves files from `public/images/blog/` to `public/blog/`. After this phase ships across both repos, `images.akli.dev` is the single canonical surface for all images on the site.

## Problem Statement

Phase 1 set up `images.akli.dev` as a dedicated images CDN but only wired the recipe-images bucket. Blog images still live at `akli.dev/images/blog/<file>.webp` served via the existing `images/*` behavior on the site distribution. The unified images CDN goal — one subdomain, one mental model, one place to evolve image-serving policy — is half-done. Phase 2 finishes it.

## Goals

- The `images.akli.dev` distribution serves blog images at `https://images.akli.dev/blog/<filename>.webp` after the personal-website side ships.
- The site bucket exposes content through two distributions concurrently (the existing `akli.dev` site distribution AND the new `images.akli.dev` distribution), each with its own OAC and bucket-policy statement.
- Blog image S3 keys move from `images/blog/<file>` to `blog/<file>` (driven by the sibling PRD changing `public/` directory layout). The new `images.akli.dev/blog/*` behavior maps URL → S3 key 1:1 with no rewrite layer.
- The existing `akli.dev/images/*` behavior on the site distribution stays in place during the cutover window, then becomes a candidate for removal once all consumers are confirmed to use the new URLs (tracked separately).

## Non-Goals

- **301 redirects from `akli.dev/images/blog/*` to `images.akli.dev/blog/*`.** Explicitly rejected: the principal reason is keeping legacy URL patterns out of IaC code. Trade-off accepted: any previously-shared blog-image URLs (social shares, image-search results, RSS clients caching old URLs) will 404 after the personal-website cutover relocates the bucket keys. Acceptable for a personal-blog scale. If a reversal is ever needed, the cleanest path is a separate short-lived `LegacyRedirectsStack` that can be removed when the redirect period ends.
- **MDX / component reference updates** in personal-website (sibling PRD).
- **Vite `public/` directory restructure** (sibling PRD).
- **Removing the existing `akli.dev/images/*` behavior** on the site distribution. Stays in place during cutover; removal is a separate small change tracked outside this PRD.
- **Image optimization, format conversion, signed URLs, watermarking, CDN-side resize.** Future work.
- **CORS rules on the site bucket.** Blog images are loaded via standard `<img src>` tags which don't trigger CORS. No change.
- **Lifecycle policies for old `images/blog/*` keys.** Cleanup of old keys belongs to the personal-website sibling PRD's runbook (it controls the deploy that may or may not pass `--delete`).

## User Stories

- **As a public reader** of the site, I want every image on the page (recipe or blog) to load from `images.akli.dev`, so the site has a coherent image-serving story and I get consistent caching/headers.
- **As the architect**, I want a single distribution / single subdomain to evolve image policy on (cache, headers, future signed URLs), so I'm not running parallel CDN configurations.
- **As the operator**, I want the site bucket to be readable from both the existing site distribution and the new images distribution via separate OACs with separate `aws:SourceArn` conditions, so each path has its own audit trail.

## Design & UX

Backend / infrastructure only. No UI.

### URL pattern

```
https://images.akli.dev/blog/<filename>.webp
```

Concrete examples:
```
https://images.akli.dev/blog/system-prompt-engineering.webp
https://images.akli.dev/blog/typescript-utility-types-cover.webp
```

### S3 key shape (changing in sibling PRD)

| | Before sibling PRD ships | After sibling PRD ships |
|---|---|---|
| Source in personal-website | `public/images/blog/<file>.webp` | `public/blog/<file>.webp` |
| Site bucket key | `images/blog/<file>.webp` | `blog/<file>.webp` |
| URL on existing distribution | `akli.dev/images/blog/<file>.webp` (works) | (still works against old keys until they're removed) |
| URL on new distribution | n/a | `images.akli.dev/blog/<file>.webp` (this PRD) |

URL maps 1:1 to S3 key on `images.akli.dev` — no CloudFront Function rewrite (consistent with phase 1's principle).

### `ImagesStack` distribution layout after this PRD

| Path pattern | Origin | Cache policy | Notes |
|---|---|---|---|
| `recipes/*` | recipe-images bucket | `imageCachePolicy` | Phase 1, unchanged |
| `blog/*` | site bucket | `imageCachePolicy` | **NEW (this PRD)** |
| Default | recipe-images bucket (formality) | n/a | Phase 1: CF Function returns 404, never reaches origin |

## Technical Considerations

### Cross-stack: site bucket reference (and the circular-dependency trap)

The site bucket (`SiteBucket` in `lib/akli-infrastructure-stack.ts:41`) is currently a `const` inside `AkliInfrastructureStack`'s constructor. To consume it from `ImagesStack`, it must be hoisted to a public readonly property — same pattern phase 1 used for the recipe-images bucket on `RecipeStack`.

```ts
// lib/akli-infrastructure-stack.ts — refactor required:
export class AkliInfrastructureStack extends Stack {
  public readonly siteBucket: s3.Bucket   // NEW — was a local const
  // …
  constructor(scope, id, props) {
    super(scope, id, props)
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', { /* unchanged */ })
    // All references to `siteBucket` in this file become `this.siteBucket`:
    //   line 125: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket, …)
    //   line 223: this.siteBucket.addToResourcePolicy(…)
    //   lines 229–230, 284–285, 343: ARN/name references via this.siteBucket
  }
}
```

`ImagesStack` accepts the bucket via stack props alongside `recipeImageBucket`.

Both stacks are in `eu-west-2` (intra-region for this reference).

**The circular-dependency trap:** the obvious next step — having `ImagesStack` call `siteBucket.addToResourcePolicy(...)` with a statement scoped via `aws:SourceArn` to ImagesStack's own distribution ARN — would create a circular cross-stack reference. CDK routes `addToResourcePolicy` calls back to the bucket-owning stack (`AkliInfrastructureStack`), so the policy statement (which references a CDK token from ImagesStack's distribution) ends up creating an `AkliInfrastructureStack → ImagesStack` Fn::ImportValue. Combined with the existing `ImagesStack → AkliInfrastructureStack` reference (via the bucket prop), CDK fails synth with a circular-dependency error.

### Resolution: scope the new grant via `aws:SourceAccount`, not `aws:SourceArn`

The new policy statement on the site bucket is added INSIDE `AkliInfrastructureStack` (where the bucket lives) and uses `aws:SourceAccount` to scope CloudFront access to this AWS account, not `aws:SourceArn` to a specific distribution. This eliminates the need to reference ImagesStack's distribution ARN at all — no cross-stack reference, no circular dependency.

```ts
// lib/akli-infrastructure-stack.ts — add ALONGSIDE the existing statement at line 223
this.siteBucket.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'AllowImagesAccountCloudFront',
  effect: iam.Effect.ALLOW,
  principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
  actions: ['s3:GetObject'],
  resources: [`${this.siteBucket.bucketArn}/*`],
  conditions: {
    StringEquals: {
      'aws:SourceAccount': this.account,
    },
  },
}))
```

**Trade-off (deliberate, documented):** any CloudFront distribution in this AWS account could read from the site bucket via OAC, not just `ImagesDistribution`. Mitigations:
- Single-tenant personal AWS account; you control every distribution that exists.
- Existing site distribution still has its tighter `aws:SourceArn` grant — it's not affected.
- The bucket retains `BlockPublicAccess.BLOCK_ALL`; no public access is opened.
- If the project ever needs multi-tenancy or stricter scoping, the right fix is to extract `SiteBucket` into its own dedicated stack (`SiteBucketStack`) so both consumers can add `aws:SourceArn`-scoped grants from a stack that has no upstream dependency. That's a larger refactor — out of scope here, tracked as future work.

### `S3BucketOrigin.withOriginAccessControl` for cross-stack bucket — defaults are correct

`origins.S3BucketOrigin.withOriginAccessControl(siteBucket, { originAccessControl: siteOac })` defaults `originAccessLevels` to `[READ]` — which is exactly what's needed (CloudFront issues `GetObject`/`HeadObject`, never `ListBucket` for static content). No override needed. Per phase 1's caveat, the auto-bucket-policy attachment is skipped for cross-stack buckets — that's fine, because the policy statement is now added in `AkliInfrastructureStack` directly per above.

### Dual-OAC on the site bucket

The site bucket already has one OAC granting access to the existing site distribution (created by `S3BucketOrigin.withOriginAccessControl(siteBucket)` at `lib/akli-infrastructure-stack.ts:125`, with the bucket policy statement at `lib/akli-infrastructure-stack.ts:223`).

Phase 2 adds a **second OAC** owned by `ImagesStack` (used by the new `siteOrigin` on `ImagesDistribution`) and a **second policy statement** on the site bucket — added in `AkliInfrastructureStack` per the resolution above. The policy statement uses `aws:SourceAccount` rather than `aws:SourceArn` to avoid the circular-dependency trap; the OAC itself is still scoped to the new distribution (the OAC is what signs origin requests with `sigv4`; the bucket-policy condition controls which principals are allowed).

```ts
// lib/images-stack.ts — phase 2 additions
const siteOac = new cloudfront.S3OriginAccessControl(this, 'SiteImagesOAC')
const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket, {
  originAccessControl: siteOac,
})
// NOTE: do NOT call siteBucket.addToResourcePolicy here — would route back to
// AkliInfrastructureStack and create a circular ref via distribution.distributionId.
// The grant is added in AkliInfrastructureStack itself (see Resolution section above).
```

The new statement (added in `AkliInfrastructureStack`) does **not** include `s3:ListBucket` (unlike the existing site distribution's grant which includes both `s3:GetObject` and `s3:ListBucket`). CloudFront serving objects only needs `GetObject` / `HeadObject` — not granting `ListBucket` is least-privilege.

**Sid uniqueness:** the new statement uses `Sid: 'AllowImagesAccountCloudFront'`. The existing one uses `Sid: 'AllowCloudFrontServicePrincipal'`. Both Sids must remain distinct; CDK does not deduplicate by Sid, but matching Sids in a single policy is invalid IAM.

### Adding the `blog/*` behavior

Add to the `additionalBehaviors` map on the existing `ImagesDistribution`:

```ts
additionalBehaviors: {
  'recipes/*': { /* phase 1, unchanged */ },
  'blog/*': {
    origin: siteOrigin,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    cachePolicy: imageCachePolicy,         // shared module from phase 1
    responseHeadersPolicy: securityHeadersPolicy,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    compress: true,
  },
},
```

Default behavior is unaffected — phase 1's CF Function still returns 404 for any path that doesn't match `recipes/*` or `blog/*`.

### Cache and headers policies

Reuse the shared `lib/cdn-policies.ts` module created in phase 1. No new policies introduced. The blog `blog/*` behavior gets the same cache TTL (30-day default, 365-day max, query-string-aware) and security headers as recipes — appropriate because both serve immutable image variants.

### Deployment ordering

```
1. akli-infrastructure deploy (this PRD) — single CI deploy
   - AkliInfrastructureStack:
     - siteBucket hoisted to public property
     - Adds 2nd policy statement on site bucket (aws:SourceAccount)
   - ImagesStack:
     - 2nd OAC (SiteImagesOAC)
     - 2nd origin pointing at siteBucket
     - blog/* behavior on the distribution

2. (Verify) curl https://images.akli.dev/blog/anything.webp
   - Returns 404 NoSuchKey (no blog/* keys in site bucket yet — sibling PRD ships them)
   - Verifies the route + OAC + bucket policy are functional (404 is from S3, not 403)

3. personal-website deploy (sibling PRD)
   - Move public/images/blog/* → public/blog/*
   - Vite deploy puts files at blog/<file> in site bucket
   - MDX find-replace updates references to images.akli.dev/blog/*
   - Decide --delete behavior: keep old keys around briefly, or delete immediately

4. (Verify) Visit a blog post on akli.dev — images load from images.akli.dev/blog/...
```

If sibling ships first (wrong order): MDX references `images.akli.dev/blog/*` but the route doesn't exist yet on the distribution → 404. All blog images in newly-deployed pages broken until infra catches up. Order matters; sequence carefully.

### Cold-cache latency on first request post-cutover

Each blog image's first request to `images.akli.dev/blog/<file>.webp` after the sibling deploy is a CloudFront cache miss → S3 origin fetch (~50–200ms added). Steady-state requests are edge-cached. Not a blocker but worth knowing so the operator isn't surprised when the first page-view per blog post feels slightly slower than baseline. Subsequent loads benefit from the existing 30-day default TTL on the shared image cache policy.

### Tagging

`ImagesStack` already follows `applyStackTags` (per phase 1). No change.

### TDD approach

Per project convention — assertion-only tests with `aws-cdk-lib/assertions` (no snapshots; phase 1 dropped that pattern). Extend the existing `ImagesStack` and `AkliInfrastructureStack` assertion tests:
- `ImagesStack`: assert the second origin, `blog/*` behavior, second OAC.
- `AkliInfrastructureStack`: assert the site bucket policy gains a SECOND statement, with the existing one unchanged.
- Tests written before implementation. Documentation and Manual-section ACs are TDD-exempt.

## Acceptance Criteria

ACs are split into automated (Jest + `aws-cdk-lib/assertions`; testable via `pnpm test` pre-deploy) and manual (post-deploy verification, runbook).

### Automated — `AkliInfrastructureStack` exposes site bucket

- [ ] `AkliInfrastructureStack` declares `public readonly siteBucket: s3.Bucket` (TypeScript signature change verified by `tsc --noEmit` succeeding). All previous internal references to the local `const siteBucket` are migrated to `this.siteBucket`.
- [ ] `bin/akli-infrastructure.ts` consumes `akliInfrastructureStack.siteBucket` and passes it to `ImagesStack` props.

### Automated — `AkliInfrastructureStack` adds second site-bucket policy statement

- [ ] After phase 2 synth, the `AWS::S3::BucketPolicy` for the site bucket (synthesized in `AkliInfrastructureStack`'s template) has TWO statements: the original `AllowCloudFrontServicePrincipal` statement AND a new `AllowImagesAccountCloudFront` statement.
- [ ] The new statement has `Effect: Allow`, `Action: s3:GetObject` (only — NOT `s3:ListBucket`), `Principal: { Service: 'cloudfront.amazonaws.com' }`, `Resource: <site-bucket-arn>/*`.
- [ ] The new statement's `Condition.StringEquals.aws:SourceAccount` resolves to the AWS account ID (`{ "Ref": "AWS::AccountId" }` or equivalent token).
- [ ] **Negative assertion:** the new statement does NOT use `aws:SourceArn` (would create the circular dependency the resolution avoids).
- [ ] **Negative assertion:** the new statement does NOT include `s3:ListBucket` (least-privilege regression guard).
- [ ] **Negative assertion:** no statement grants `Principal: '*'`.
- [ ] **Regression guard:** the original `AllowCloudFrontServicePrincipal` statement is unchanged — same `Sid`, same actions (`s3:GetObject`, `s3:ListBucket`), same resources, same condition shape (`aws:SourceArn` to the existing site distribution).
- [ ] **Sid uniqueness:** the two statements have distinct `Sid` values (`AllowCloudFrontServicePrincipal` vs `AllowImagesAccountCloudFront`).
- [ ] The site bucket retains `BlockPublicAccess.BLOCK_ALL`.
- [ ] **Casing consistency:** both statements use the same casing for their condition key (e.g. both `aws:SourceArn`/`aws:SourceAccount`, or both `AWS:SourceArn`/`AWS:SourceAccount` — IAM treats them equivalently but house style should be consistent; pick lowercase per AWS docs and assert).

### Automated — `AkliInfrastructureStack` regression (existing site distribution untouched)

- [ ] The existing `Distribution` resource in `AkliInfrastructureStack`'s template has unchanged origin count (one origin, the site bucket).
- [ ] The existing site distribution's `CacheBehaviors` array is unchanged from phase 1 baseline (same path patterns, same count).
- [ ] The existing site OAC resource is unchanged.

### Automated — `ImagesStack` second origin + behavior

- [ ] The synthesized `AWS::CloudFront::Distribution` for `ImagesDistribution` has TWO origins: the recipe-images bucket origin (existing from phase 1) and a new site-bucket origin.
- [ ] The new origin's `DomainName` matches the site bucket's regional domain.
- [ ] The two origins reference DIFFERENT `OriginAccessControlId` values (asserted by checking the two `Origin.OriginAccessControlId` Refs resolve to distinct OAC resources, not just that two OAC resources exist).
- [ ] The distribution's `CacheBehaviors` array now has exactly TWO entries: `recipes/*` (unchanged from phase 1) and a new `blog/*` (use `Match.arrayWith` plus a length assertion).
- [ ] The `blog/*` behavior has `PathPattern: 'blog/*'`, `AllowedMethods: ['GET', 'HEAD']`, `Compress: true`, `ViewerProtocolPolicy: redirect-to-https`.
- [ ] The `blog/*` behavior's `CachePolicyId` references the shared `imageCachePolicy` (asserted by stable `cachePolicyName` per phase 1).
- [ ] The `blog/*` behavior's `ResponseHeadersPolicyId` references the shared `securityHeadersPolicy`.
- [ ] The `blog/*` behavior's `TargetOriginId` matches the site-bucket origin's `Id` AND does NOT match the recipe-images origin's `Id` (catches the "wrong origin" footgun — use the existing `cfnDistribution`/`distributionConfig` helper pattern from `test/akli-infrastructure.test.ts`).
- [ ] **Regression guard:** the `recipes/*` behavior's `TargetOriginId` is unchanged (still the recipe-images origin).
- [ ] **Default behavior unchanged from phase 1:** `DefaultCacheBehavior.FunctionAssociations` array length is unchanged (still 1, still the 404-returning CF Function from phase 1).

### Automated — `ImagesStack` OAC

- [ ] The synthesized `ImagesStack` template contains exactly TWO `AWS::CloudFront::OriginAccessControl` resources (recipe-images OAC from phase 1 + new site-images OAC).
- [ ] The new OAC's `OriginAccessControlConfig.SigningProtocol: sigv4` and `SigningBehavior: always`.

### Automated — Quality gates

- [ ] `pnpm test` passes (all suites green).
- [ ] `pnpm lint` passes.
- [ ] `pnpm exec tsc --noEmit` produces no new errors beyond phase 1's pre-existing baseline.

### Manual — Post-deploy verification (before sibling PRD ships) — TDD-exempt

- [ ] `cdk diff` for `ImagesStack` shows the additive changes only (new origin, new OAC, new behavior).
- [ ] `cdk diff` for `AkliInfrastructureStack` shows only `siteBucket` field exposure + the new bucket-policy statement (no other drift).
- [ ] `cdk diff` exit-code interpretation: changes-detected (exit 1) is expected; non-zero only if there are unexpected resource modifications.
- [ ] After deploy: `curl -I https://images.akli.dev/blog/anything.webp` returns `HTTP/2 404` with an S3 `NoSuchKey` XML body (proves the route + OAC + bucket policy are functional — the 404 comes from S3 reading the bucket, NOT a 403 from a misconfigured policy).
- [ ] After deploy: `curl -I https://images.akli.dev/recipes/<id>/cover-medium.webp` for a known existing key still returns 200 (phase 1 regression guard).
- [ ] After deploy: `curl -I https://akli.dev/images/blog/<existing-file>.webp` still returns 200 (legacy route still works **only until the sibling PRD's `--delete` deploy removes old keys**; after that, expect 404 — not a regression).

### Manual — Post-cutover verification (after sibling PRD ships) — TDD-exempt

- [ ] `curl -I https://images.akli.dev/blog/<file-from-public-blog>.webp` returns `HTTP/2 200` with `content-type: image/webp`.
- [ ] Visiting a blog post on akli.dev shows blog images loaded from `images.akli.dev` (verified via DevTools network panel).
- [ ] Direct site-bucket URL access still returns 403 (OAC enforcement preserved): `curl -I https://<site-bucket-domain>.s3.<region>.amazonaws.com/blog/<file>.webp` returns 403.
- [ ] Cache hit on second request: a second `curl -I https://images.akli.dev/blog/<file>.webp` returns `x-cache: Hit from cloudfront`.

### Documentation — TDD-exempt

- [ ] `CLAUDE.md` "Architecture" section updated: the `ImagesStack` bullet mentions both recipe-images and site-bucket as origins.
- [ ] `docs/prds/images-cdn-phase-1.md` gets a "Followed by: phase 2 (this PRD)" cross-reference at the top.

### Process

- [ ] Tests are written before implementation (TDD) for all **automated** ACs above. Manual and Documentation ACs are TDD-exempt.
- [ ] `pnpm test` and `pnpm lint` pass locally before deploy.

## Open Questions

All resolved during PRD review:

- **301 redirect strategy** → resolved to **none**. Explicit user decision: keeps legacy URL patterns out of IaC. Documented as Non-Goal with the trade-off (broken inbound links to old image URLs after sibling PRD ships).
- **OAC reuse vs. new** → resolved to **new dedicated OAC** (`SiteImagesOAC`) for the ImagesStack distribution against the site bucket.
- **Cross-stack site bucket reference** → resolved to **expose as public readonly property on `AkliInfrastructureStack`**, consume directly in `ImagesStack` props. Same pattern as phase 1's `RecipeStack.imageBucket`.
- **Cross-stack policy mutation circular dependency** (surfaced in CDK review) → resolved to **add the new bucket-policy statement inside `AkliInfrastructureStack`** (where the bucket lives) and **scope it via `aws:SourceAccount`** (not `aws:SourceArn`) so no reference to ImagesStack's distribution ARN is needed. Trade-off documented in Technical Considerations.
- **Cache and headers policies** → resolved to **reuse phase 1's shared `lib/cdn-policies.ts` module**. No new policies introduced.
- **Future hardening if `aws:SourceAccount` becomes too permissive** → out of scope, but the right path is to extract `SiteBucket` into its own dedicated stack so multiple distribution-scoped grants can be added without circular dependencies. Tracked as a future consideration, not blocking phase 2.

No remaining open questions for phase 2.

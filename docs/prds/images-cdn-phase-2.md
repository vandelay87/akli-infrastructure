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

- The `images.akli.dev` distribution serves blog images at `https://images.akli.dev/blog/<post-slug>/<filename>.webp` after the personal-website side ships (nested by post slug, not flat — see 2026-09 note below).
- The site bucket exposes content through two distributions concurrently (the existing `akli.dev` site distribution AND the new `images.akli.dev` distribution), each with its own OAC and bucket-policy statement.
- Blog image S3 keys move from `images/blog/<file>` to `blog/<post-slug>/<file>` (driven by the sibling PRD changing `public/` directory layout). The `blog/*` behavior's `*` matches everything after the prefix including slashes, so nested keys route with no CloudFront-side change and no rewrite layer.
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
- **As the operator**, I want the site bucket to be readable from both the existing site distribution and the new images distribution via separate OACs and separate bucket-policy statements, so each path has its own audit trail — the existing distribution keeps an exact-`aws:SourceArn` grant, the new one uses the account's established wildcard-`aws:SourceArn` cross-stack pattern (see Technical Considerations).

## Design & UX

Backend / infrastructure only. No UI.

### URL pattern

```
https://images.akli.dev/blog/<post-slug>/<filename>.webp
```

Concrete examples (matching the personal-website sibling PRD's actual posts):
```
https://images.akli.dev/blog/building-a-pokedex/pokedex-desktop-full.webp
https://images.akli.dev/blog/akli-ui-storybook/storybook-button-docs-medium.webp
```

**2026-09 note:** originally specified as flat (`blog/<filename>.webp`). Changed to nest by post slug before either sibling PRD was implemented — see the personal-website PRD's "Image organization: nested by post slug" section for the rationale (consistency with the `recipes/<id>/<file>` convention, collision avoidance, scoped cleanup). No change to this stack's CloudFront config as a result: the `blog/*` `additionalBehaviors` path pattern already matches nested paths, since CloudFront's `*` wildcard matches everything after the prefix, slashes included.

**2026-09 second note:** the personal-website sibling PRD separately added responsive image sizing ([PR #445](https://github.com/vandelay87/personal-website/pull/445), landed ahead of this migration on the current live path) — every blog image is now three sized files (`-thumb`/`-medium`/`-full` suffix, matching the recipe `ImageResizer`'s own width/quality scheme), not one. Examples above updated to show a real suffixed filename. Again, no change needed to this stack: the `-thumb`/`-medium`/`-full` suffix is just part of the filename as far as CloudFront/S3 are concerned, no different from any other object key.

### S3 key shape (changing in sibling PRD)

| | Before sibling PRD ships | After sibling PRD ships |
|---|---|---|
| Source in personal-website | `public/images/blog/<file>.webp` | `public/blog/<post-slug>/<file>.webp` |
| Site bucket key | `images/blog/<file>.webp` | `blog/<post-slug>/<file>.webp` |
| URL on existing distribution | `akli.dev/images/blog/<file>.webp` (works) | (still works against old keys until they're removed) |
| URL on new distribution | n/a | `images.akli.dev/blog/<post-slug>/<file>.webp` (this PRD) |

URL maps 1:1 to S3 key on `images.akli.dev` — no CloudFront Function rewrite (consistent with phase 1's principle). The added `<post-slug>` segment is just another path component; the 1:1 mapping and no-rewrite principle both still hold.

### `ImagesStack` distribution layout after this PRD

| Path pattern | Origin | Cache policy | Notes |
|---|---|---|---|
| `recipes/*` | recipe-images bucket | `imageCachePolicy` | Phase 1, unchanged |
| `blog/*` | site bucket | `imageCachePolicy` | **NEW (this PRD)** |
| Default | recipe-images bucket (formality) | n/a | Phase 1: CF Function returns 404, never reaches origin |

## Technical Considerations

### Cross-stack: site bucket reference (and the circular-dependency trap)

The site bucket (`SiteBucket` in `lib/akli-infrastructure-stack.ts:50`, created via the `createHardenedAppBucket` helper) is currently a `const` inside `AkliInfrastructureStack`'s constructor. To consume it from `ImagesStack`, it must be hoisted to a public readonly property — same pattern phase 1 used for the recipe-images bucket on `RecipeStack`.

```ts
// lib/akli-infrastructure-stack.ts — refactor required:
export class AkliInfrastructureStack extends Stack {
  public readonly siteBucket: s3.Bucket   // NEW — was a local const
  // …
  constructor(scope, id, props) {
    super(scope, id, props)
    this.siteBucket = createHardenedAppBucket(this, 'SiteBucket')
    // All references to the local `siteBucket` const in this file become
    // `this.siteBucket` — as of this PRD's writing that's the origin
    // construction (line 90), the existing `grantCloudFrontRead` call
    // (line 179), the personal-website deploy-role policy grant (line 246),
    // and the CfnOutput (line 319). Re-verify these line numbers against the
    // file at implementation time — the hoist itself will shift some of them.
  }
}
```

`ImagesStack` accepts the bucket via stack props alongside `recipeImageBucket`.

Both stacks are in `eu-west-2` (intra-region for this reference).

**The circular-dependency trap:** the obvious next step — having `ImagesStack` call `siteBucket.addToResourcePolicy(...)` with a statement scoped via `aws:SourceArn` to ImagesStack's own distribution ARN — would create a circular cross-stack reference. CDK routes `addToResourcePolicy` calls back to the bucket-owning stack (`AkliInfrastructureStack`), so the policy statement (which references a CDK token from ImagesStack's distribution) ends up creating an `AkliInfrastructureStack → ImagesStack` Fn::ImportValue. Combined with the existing `ImagesStack → AkliInfrastructureStack` reference (via the bucket prop), CDK fails synth with a circular-dependency error.

### Resolution: reuse the existing cross-stack OAC helpers — don't re-derive a bespoke grant

**This section originally designed a one-off `aws:SourceAccount`-scoped policy statement to work around the cycle. That's now unnecessary — don't build it.** Since this PRD was written, exactly this problem was solved and extracted into two shared helpers in `lib/s3-policies.ts`, already exercised by `ImagesStack` itself (for `recipeImageBucket`) and by `AppSiteStack` (for each per-app bucket):

- `createCrossStackOacOrigin(scope, oacId, importedBucketId, bucket)` — re-imports the bucket via `fromBucketAttributes` (so CDK's auto-bucket-policy-attachment, which would try to scope `aws:SourceArn` to the exact distribution and trigger the cycle, is skipped) and returns a ready-to-use origin backed by a fresh `S3OriginAccessControl`.
- `grantCloudFrontReadCrossStack(bucket, account)` — adds the bucket-policy statement from the bucket-owning stack, scoped via `StringLike` to `aws:SourceArn: arn:aws:cloudfront::<account>:distribution/*` (wildcard, not the exact distribution — same reason the exact ARN isn't knowable without creating the cycle).

Use both directly — no new policy design needed:

```ts
// lib/images-stack.ts — phase 2 addition, mirrors the existing recipeImageOrigin call
const siteOrigin = createCrossStackOacOrigin(this, 'SiteImagesOAC', 'ImportedSiteBucket', siteBucket)
```

```ts
// lib/akli-infrastructure-stack.ts — call alongside the existing grantCloudFrontRead(this.siteBucket, …) call
grantCloudFrontReadCrossStack(this.siteBucket, this.account)
```

**Trade-off (inherited from the existing pattern, not new to this PRD):** the wildcard `StringLike` grant means any CloudFront distribution in this AWS account could read from the site bucket via OAC, not just `ImagesDistribution` — the same trade-off `RecipeStack`'s image bucket and every app-site bucket already accept via this same helper. Mitigations (same as those existing call sites): single-tenant personal AWS account; the bucket retains `BlockPublicAccess.BLOCK_ALL`; the existing site distribution keeps its own tighter, non-cross-stack `aws:SourceArn`-scoped grant via `grantCloudFrontRead`, unaffected by this addition.

### Dual-OAC on the site bucket

The site bucket already has one OAC granting access to the existing site distribution (created via `S3BucketOrigin.withOriginAccessControl(siteBucket)` inside `AkliInfrastructureStack`, paired with the existing `grantCloudFrontRead` policy statement — see line references above).

Phase 2 adds a **second OAC**, created by `createCrossStackOacOrigin` inside `ImagesStack` for the new `siteOrigin`, and a **second policy statement** on the site bucket, added by `grantCloudFrontReadCrossStack` inside `AkliInfrastructureStack` per the resolution above. Nothing in the codebase today has one bucket served by two separate distributions simultaneously, so this specific combination is new — but it's composed entirely from the same two helper functions already proven at three other call sites, not a new mechanism.

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
     - Adds 2nd policy statement on site bucket (`grantCloudFrontReadCrossStack`)
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

- [ ] After phase 2 synth, the `AWS::S3::BucketPolicy` for the site bucket (synthesized in `AkliInfrastructureStack`'s template) has TWO statements: the original `AllowCloudFrontServicePrincipal` statement (from `grantCloudFrontRead`) AND a new statement (from `grantCloudFrontReadCrossStack`).
- [ ] The new statement has `Effect: Allow`, `Action: s3:GetObject` (only — NOT `s3:ListBucket`), `Principal: { Service: 'cloudfront.amazonaws.com' }`, `Resource: <site-bucket-arn>/*`.
- [ ] The new statement's `Condition.StringLike.'aws:SourceArn'` resolves to `arn:aws:cloudfront::<account>:distribution/*` (wildcard-scoped — matches `grantCloudFrontReadCrossStack`'s existing, already-tested behavior at its other call sites, not a new design).
- [ ] **Negative assertion:** the new statement does NOT include `s3:ListBucket` (least-privilege regression guard).
- [ ] **Negative assertion:** no statement grants `Principal: '*'`.
- [ ] **Regression guard:** the original `AllowCloudFrontServicePrincipal` statement is unchanged — same `Sid`, same actions (`s3:GetObject`, `s3:ListBucket`), same resources, same condition shape (exact `aws:SourceArn` to the existing site distribution).
- [ ] The site bucket retains `BlockPublicAccess.BLOCK_ALL`.

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
- **Cross-stack policy mutation circular dependency** (surfaced in CDK review) → originally resolved to a bespoke `aws:SourceAccount`-scoped statement added inside `AkliInfrastructureStack`. **Superseded** (2026-09, PRD refresh): the shared `grantCloudFrontReadCrossStack`/`createCrossStackOacOrigin` helpers in `lib/s3-policies.ts` — extracted after this PRD was originally written, already reused by `ImagesStack` and `AppSiteStack` — solve the identical problem via a `StringLike`-wildcarded `aws:SourceArn` instead. Use the helpers directly; no new policy design needed. Trade-off (same shape, different condition key) documented in Technical Considerations.
- **Cache and headers policies** → resolved to **reuse phase 1's shared `lib/cdn-policies.ts` module**. No new policies introduced.
- **Future hardening if the wildcard cross-stack grant becomes too permissive** → out of scope, but the right path is to extract `SiteBucket` into its own dedicated stack so multiple distribution-scoped grants can be added without circular dependencies. Tracked as a future consideration, not blocking phase 2.

No remaining open questions for phase 2.

### 2026-09 refresh note

This PRD sat unimplemented long enough that the codebase moved under it (confirmed via GitHub: no epic, no issues, nothing merged — genuinely never built, not lost work). Re-verified against current `main` and updated: the circular-dependency workaround now reuses `grantCloudFrontReadCrossStack`/`createCrossStackOacOrigin` (extracted into `lib/s3-policies.ts` after this PRD was written) instead of a bespoke `aws:SourceAccount` statement, and stale line references into `akli-infrastructure-stack.ts` were corrected. No change to the PRD's actual design — same distribution layout, same S3 key scheme, same no-redirects decision. Sibling PRD: `personal-website/docs/prds/images-cdn-phase-2.md` was refreshed alongside this one (its scope grew from 1 to 3 MDX posts).

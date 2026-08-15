# PRD: Subdomain-Per-App Migration

> Companion PRDs: `subdomain-migration.md` in `personal-website`, `pokedex`, and `sand-box`. This is the primary/detailed PRD.
>
> This is infra PRD #2 of 2 in the hosting re-architecture. **Written assuming PRD #1 (`per-app-buckets-and-oidc-deploy.md`) is already fully implemented and live** — each app already has its own dedicated S3 bucket (`PokedexBucket`, `SandboxBucket`) and its own OIDC-based IAM deploy Role. The only thing PRD #1 did *not* change is that Pokedex and Sand-box are still routed via path-pattern CloudFront behaviors (`apps/pokedex*`, `apps/sand-box*`) on the one shared distribution, still under an `apps/<name>/` key prefix within their own dedicated buckets. This PRD moves that routing to dedicated per-app subdomains.

## Overview

Move Pokedex and Sand-box off path-based URLs (`akli.dev/apps/pokedex`, `akli.dev/apps/sand-box`) onto dedicated subdomains (`pokedex.akli.dev`, `sandbox.akli.dev`), each served by its own CloudFront distribution — mirroring the existing `images.akli.dev` pattern rather than continuing to share the main site's distribution.

## Problem Statement

Path-based hosting on the shared distribution has real, verified fragility that subdomain hosting doesn't: it depends on a CloudFront Function (`subdirectoryIndexHandler`) that only handles "naked directory" index-file fallback, not true SPA catch-all routing — currently harmless only because neither app happens to use path-based client routing today, not because the mechanism is actually correct. It also means every new app added to akli.dev needs its own CloudFront Function reasoning, its own `additionalBehaviors` entry, and (per PRD #1) careful attention to whether the app is deploying to the bucket root or a matching prefix. A dedicated subdomain per app is simpler per-app (each app's origin is just its own bucket root, no path-stripping to reason about) and matches the pattern already established for `images.akli.dev`.

## Goals

- `pokedex.akli.dev` and `sandbox.akli.dev` serve their respective apps correctly, each via its own dedicated CloudFront distribution
- New per-app distributions use correct CloudFront `errorResponses`-based SPA fallback (403/404 → `/index.html`, HTTP 200) rather than the old CloudFront Function hack
- Each app subdomain gets its own dedicated ACM certificate, consistent with the existing `SiteCert`/`ApiCert`/`ImagesCert` pattern — no shared/wildcard certificate
- The old shared-distribution path-based routes and their supporting CloudFront Function are removed once no longer needed — no dead infrastructure left behind

## Non-Goals

- Redirecting the old `akli.dev/apps/pokedex`/`akli.dev/apps/sand-box` URLs to the new subdomains — **explicitly decided against** during PRD discovery. Old links will 404 once the old behaviors are removed. This was a deliberate choice against the default recommendation (redirects preserve SEO/backlinks); revisiting this later is possible but out of scope now.
- Storybook's subdomain — doesn't exist yet. The pattern here (dedicated site stack + dedicated cert) is documented for reuse when that initiative resumes, not built now.
- Any change to `personal-website`'s own domain (`akli.dev`/`www.akli.dev`) or its existing `SiteCert` — untouched.
- Any change to `api.akli.dev` or `images.akli.dev` and their existing dedicated certificates/distributions — untouched.
- A wildcard certificate for app subdomains — considered during PRD discovery, ultimately not chosen (not a security concern either way given ACM's non-exportable key handling, but the user opted to keep the existing per-subdomain-cert precedent rather than introduce a different pattern).
- Scoping down `cdk-github-actions`'s `AdministratorAccess` — same standing non-goal as PRD #1, still a separate, bigger initiative.

## User Stories

- As a visitor, I want `pokedex.akli.dev` to load the Pokedex app directly, so the URL reads as a real, dedicated destination rather than a subpath of the portfolio site.
- As the site owner, I want each app subdomain's certificate to be independent (not shared), so an issue with one certificate can never affect another app's distribution, consistent with how `api.akli.dev`/`images.akli.dev` already work.
- As the site owner, I want the old path-based routing and its supporting CloudFront Function fully removed once nothing depends on them, so the stack doesn't accumulate dead infrastructure.

## Design & UX

No UI — this is CDK/infrastructure and CI configuration only. Visitors to the new subdomains see the same apps as today; visitors to the old `/apps/pokedex`/`/apps/sand-box` paths get a 404 once cutover completes (see Non-Goals — deliberate).

## Technical Considerations

### Per-app certificates (`CertificateStack`, us-east-1)

- Add two new certificates, following the existing precedent exactly: `PokedexCert` (`certificatemanager.Certificate` for `pokedex.akli.dev`) and `SandboxCert` (for `sandbox.akli.dev`), each DNS-validated against the existing hosted zone, each a separate `Certificate` resource — matching `SiteCert`/`ApiCert`/`ImagesCert`'s existing pattern (one cert per subdomain, never a SAN added to an existing cert). `SiteCert`, `ApiCert`, and `ImagesCert` are untouched.
- A wildcard certificate (`*.akli.dev`) covering all app subdomains was considered during PRD discovery — technically sound (ACM never exposes the private key, so the usual wildcard blast-radius concern doesn't really apply here) but ultimately not chosen, in favor of keeping the existing one-cert-per-subdomain convention consistent across the whole stack. The tradeoff being accepted: a future app subdomain (e.g. Storybook) will need its own new `Certificate` resource too, same as this PRD's two.
- `PokedexCert`/`SandboxCert` are exported from `CertificateStack` alongside the existing three certificates, for their respective new site stacks to consume.

### New per-app site stacks

- `PokedexSiteStack` and `SandboxSiteStack` — new stacks, separate from the existing data/API `PokedexStack` (which only holds DynamoDB/API Gateway/Lambda for the Pokedex API and is unrelated to site hosting), mirroring how `ImagesStack` is kept separate from `RecipeStack`. Sand-box has no existing stack today, so `SandboxSiteStack` is its first.
- Each stack mirrors `ImagesStack`'s structure closely:
  - Own `cloudfront.S3OriginAccessControl`
  - Cross-stack import of its bucket (`PokedexBucket`/`SandboxBucket`, created in the main `AkliInfrastructureStack` per PRD #1) via `s3.Bucket.fromBucketAttributes(...)` — this requires `AkliInfrastructureStack` to expose them as `public readonly` properties (they're currently local `const`s inside the constructor, not exposed), mirroring `RecipeStack.imageBucket: s3.IBucket`, the actual existing precedent `ImagesStack` consumes via `bin/akli-infrastructure.ts`. State this as an explicit prerequisite rather than leaving it implied by "mirrors ImagesStack" — the main stack needs a small change too, not just the two new stacks. — **not** a direct reference — to avoid the OAC auto-attach cyclic-dependency problem `ImagesStack` already solved and documented: auto-attach would scope `aws:SourceArn` to this new distribution's ID and create a cycle between the main stack (bucket) and this stack (distribution). Re-attach the bucket policy manually afterward with a wildcard `SourceArn` (`arn:aws:cloudfront::<account>:distribution/*`, `StringLike` not `StringEquals`), exactly as `ImagesStack` does for `recipeImageBucket`.
  - **Easy to misapply**: `ImagesStack`'s real code calls `.addToResourcePolicy()` on the *original* cross-stack bucket prop (`recipeImageBucket`, the one passed into the stack), not on the `fromBucketAttributes(...)`-imported handle used for the CloudFront origin. Calling it on the imported handle silently no-ops — the policy never actually attaches, leaving the bucket permanently inaccessible (a 403 that not even `errorResponses` can paper over, since `/index.html` itself would also 403). Use two distinct handles: the original bucket reference for `.addToResourcePolicy()`, the `fromBucketAttributes(...)` import only for constructing the CloudFront origin.
  - `cloudfront.Distribution` with `domainNames: ['pokedex.akli.dev']` (or `sandbox.akli.dev`), `certificate: pokedexCert` (or `sandboxCert` — each stack consumes only its own certificate, not a shared one), `defaultRootObject: 'index.html'` (missing this means every request to `/` 403s at the origin and round-trips through the `errorResponses` fallback instead of being served directly — cheap to avoid), default behavior pointing at the imported bucket origin with `viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS` and `responseHeadersPolicy: createSecurityHeadersPolicy(this)` (the existing shared factory in `lib/cdn-policies.ts`, reused here rather than reinvented) — every other distribution in this codebase sets both; the new ones shouldn't be the exception
  - **`errorResponses`**: `403`/`404` → `responsePagePath: '/index.html'`, `responseHttpStatus: 200` — proper SPA fallback, not the old `subdirectoryIndexHandler` Function. This is a genuine correctness improvement, not just a different mechanism: the old Function only rewrites "naked directory" paths to append `index.html`, it does not catch arbitrary unmatched paths the way `errorResponses` does. Both statuses matter, not just 404: the bucket policy (mirroring `ImagesStack`) grants only `s3:GetObject`, not `s3:ListBucket`, so S3 returns 403 rather than 404 for a missing object.
  - `route53.ARecord` **and** `route53.AaaaRecord` (IPv6) aliasing to the distribution, matching `ImagesStack`'s pattern exactly (not just an A record)
  - `applyStackTags(this, props)`
  - Deploys to the same region as the main stack (eu-west-2) while consuming its own certificate (`pokedexCert`/`sandboxCert`) from the us-east-1 `CertificateStack` — like `ImagesStack`, this requires `crossRegionReferences: true` set where each stack is instantiated in `bin/akli-infrastructure.ts`, matching how `ImagesStack` already does this for `imagesCertificate`. State this explicitly rather than leaving it implied by "mirrors ImagesStack."

### Removing the old path-based routing (main `AkliInfrastructureStack`)

- Once both new subdomains are live and verified (see Migration below), remove the `apps/pokedex*`/`apps/sand-box*` entries from `additionalBehaviors` on the main distribution.
- Remove the `subdirectoryIndexHandler` CloudFront Function entirely — once both its only consumers are gone, it's dead code. (If a future path-based app is ever added, a fresh function can be written with correct catch-all semantics rather than reviving this one.)
- **Correction**: removing these behaviors does not, by itself, guarantee `akli.dev/apps/pokedex` returns a clean 404. Unmatched paths simply fall through to the main distribution's `defaultBehavior`, which serves `personal-website`'s own SSR Lambda/S3 origin group — currently documented in that stack's own code as "a placeholder handler until the React server bundle is deployed." What HTTP status that path actually returns afterward depends entirely on how `personal-website`'s own routing handles an unmatched path (a real 404, a 200 "not found" page, or even the homepage) — not something this PRD controls. The AC below is scoped accordingly.

### Bucket content: prefix → root

- `PokedexBucket`/`SandboxBucket` currently hold content under an `apps/pokedex/`/`apps/sand-box/` key prefix (per PRD #1 — that prefix was required because the *old* shared-distribution path-pattern behavior forwarded the full request path as the object key). The new dedicated distributions have no path-pattern behavior — their origin *is* the bucket root — so each app's deploy target moves to bucket root, and the old prefixed copies become stale once the new deploy lands (see companion PRDs).

### Migration & cutover sequencing

Mirrors the two-phase lesson from PRD #1's review (additive changes and destructive changes must not land in the same deploy):

1. **Deploy A**: `PokedexCert` + `SandboxCert` + `PokedexSiteStack` + `SandboxSiteStack`, fully additive — the old shared-distribution behaviors are untouched, so `akli.dev/apps/pokedex`/`akli.dev/apps/sand-box` keep working exactly as before throughout this step.
2. In `pokedex` and `sand-box`: switch `base` to `/` and the deploy target to bucket root (per their companion PRDs), and redeploy. Verify each app directly against its new distribution's default `*.cloudfront.net` hostname — **not** the final subdomain yet, since DNS hasn't cut over. This means verification never touches live production traffic.
3. Once each new distribution is confirmed serving correctly via its `*.cloudfront.net` hostname, DNS is already live (the `ARecord`/`AaaaRecord` created in Deploy A already point `pokedex.akli.dev`/`sandbox.akli.dev` at the distribution) — so `https://pokedex.akli.dev` and `https://sandbox.akli.dev` should now also work. Verify both directly.
4. Update `personal-website`'s Apps page hrefs and sitemap (per its companion PRD) to point at the new subdomains, and deploy.
5. **Deploy B** (`akli-infrastructure`, only after steps 2–4 are all verified): remove the `apps/pokedex*`/`apps/sand-box*` behaviors and the `subdirectoryIndexHandler` Function from the main stack.
6. Delete the stale `apps/pokedex/`/`apps/sand-box/` prefixed content from `PokedexBucket`/`SandboxBucket` (mirrors PRD #1's stale-content cleanup step) — explicit step, not left opportunistic.

### Testing

- CDK assertion tests (Jest, following existing patterns in `test/akli-infrastructure.test.ts`) verify:
  - `PokedexCert` (`pokedex.akli.dev`) and `SandboxCert` (`sandbox.akli.dev`) each exist as independent certificates, distinct from `SiteCert`/`ApiCert`/`ImagesCert` (none of the existing three are modified) and from each other
  - `PokedexSiteStack`'s distribution has `domainNames: ['pokedex.akli.dev']`, the correct certificate, `defaultRootObject: 'index.html'`, `viewerProtocolPolicy: redirect-to-https`, the security headers response policy, and `errorResponses` covering 403/404 → `/index.html`/200 — and `SandboxSiteStack`'s independently matches for `sandbox.akli.dev`. **Note on testing precision**: unlike PRD #1's shared-template case, `PokedexSiteStack`/`SandboxSiteStack` are separate `Stack` instances, each producing its own template with exactly one `CloudFront::Distribution` — so `Template.fromStack(pokedexSiteStack)` plus a plain `hasResourceProperties` is already unambiguous here; the heavier per-logical-ID template-walk pattern from PRD #1's review isn't needed for these single-resource-per-template checks. Reserve that heavier pattern for genuinely ambiguous cases within one template — e.g. the bucket resource-policy check below, if it ever needs to assert something isn't also true of an unrelated policy in the same template.
  - Each site stack's bucket resource policy grants the CloudFront service principal access scoped correctly (wildcard `SourceArn`, matching `ImagesStack`'s pattern) — and is attached to the correct bucket handle (see the two-handles note above; a test that only checks "a policy with this shape exists somewhere" wouldn't catch the no-op case)
  - Each site stack has both an `ARecord` and an `AaaaRecord` for its subdomain
  - Each site stack is instantiated with `crossRegionReferences: true` where wired up in `bin/akli-infrastructure.ts`
  - After Deploy B: `additionalBehaviors` on the main distribution no longer contains `apps/pokedex*`/`apps/sand-box*`, and `subdirectoryIndexHandler` no longer exists in the template

## Acceptance Criteria

- [ ] `PokedexCert` (`pokedex.akli.dev`) and `SandboxCert` (`sandbox.akli.dev`) each exist in `CertificateStack` as independent, DNS-validated certificates; `SiteCert`/`ApiCert`/`ImagesCert` are unmodified
- [ ] `AkliInfrastructureStack` exposes `PokedexBucket`/`SandboxBucket` as `public readonly` properties (currently local `const`s), so the new site stacks can import them cross-stack
- [ ] `PokedexSiteStack` and `SandboxSiteStack` exist, each with their own `cloudfront.Distribution`, `S3OriginAccessControl`, `ARecord`, and `AaaaRecord`
- [ ] Each distribution uses `errorResponses` for SPA fallback (403/404 → `/index.html`, 200) — not the old CloudFront Function
- [ ] Each distribution sets `defaultRootObject: 'index.html'`, `viewerProtocolPolicy: REDIRECT_TO_HTTPS`, and the shared `createSecurityHeadersPolicy()` response headers policy — matching every other distribution in this codebase
- [ ] Each site stack imports its bucket via `Bucket.fromBucketAttributes` for the CloudFront origin, but calls `.addToResourcePolicy()` on the *original* bucket reference (not the imported handle) — verified the policy actually attaches, not silently no-ops
- [ ] Each site stack is deployed with `crossRegionReferences: true` to consume its own certificate from the us-east-1 `CertificateStack`
- [ ] Deploy A's `cdk diff` shows only resource creation — no changes to the existing shared distribution's behaviors
- [ ] `https://pokedex.akli.dev` and `https://sandbox.akli.dev` both serve their apps correctly after cutover
- [ ] Deploy B removes `apps/pokedex*`/`apps/sand-box*` from the main distribution's `additionalBehaviors` and removes `subdirectoryIndexHandler` entirely
- [ ] Deploy B's `cdk diff` shows only removals/in-place updates to the main stack — no changes to the new site stacks
- [ ] Stale `apps/pokedex/`/`apps/sand-box/` prefixed content is deleted from `PokedexBucket`/`SandboxBucket` after cutover is verified
- [ ] `https://akli.dev/apps/pokedex` and `https://akli.dev/apps/sand-box` no longer serve the Pokedex/Sand-box apps after Deploy B (no redirect, per the Non-Goals decision) — the exact HTTP status returned is whatever `personal-website`'s own unmatched-route handling produces, not independently guaranteed to be a clean 404 by this PRD
- [ ] All CDK assertion tests described above pass (`pnpm test`)

## Open Questions

- None — both open questions (certificate strategy, redirect strategy) were resolved during PRD discovery.

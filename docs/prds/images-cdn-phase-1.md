# PRD: Images CDN — Phase 1 (Recipe Images Subdomain)

> **Sibling PRD:** [`personal-website/docs/prds/images-cdn-phase-1.md`](../../../personal-website/docs/prds/images-cdn-phase-1.md) — covers the frontend cutover: `recipeImageUrl` rewrite, call-site updates, and tests in `personal-website`.
>
> **Epic context:** This is PRD 1 of 4 in the unified images CDN epic.
> 1. **THIS PRD** — `akli-infrastructure` phase 1: stand up `images.akli.dev` with the recipe-images bucket as the first origin.
> 2. `personal-website` phase 1 (sibling above) — switch `recipeImageUrl` to use the new subdomain.
> 3. `akli-infrastructure` phase 2 (future) — add the blog/site bucket as a second origin under the same subdomain.
> 4. `personal-website` phase 2 (future) — migrate MDX/component image references from `akli.dev/images/*` to `images.akli.dev/blog/*`.
>
> **Supersedes:** the image-serving section of [`recipe-api-infrastructure.md`](./recipe-api-infrastructure.md), specifically the planned `images/recipes/*` behavior on the site CloudFront distribution and the related cache policy/AC. That plan was never implemented; this PRD replaces it with a dedicated subdomain.

## Overview

Stand up `images.akli.dev` as a dedicated CloudFront distribution backed by the existing private `akli-recipe-images-…` S3 bucket. Recipe images become reachable end-to-end for the first time. The subdomain is the foundation for a unified images CDN — phase 2 will add the blog/site bucket as a second origin under the same domain.

## Problem Statement

The recipe upload→process→serve pipeline is broken at the last hop. Today:

1. The frontend uploads a cover image via presigned URL → S3 (working).
2. The image-resizer Lambda fires on the `uploads/` prefix, generates three WebP variants, and writes them to `processed/recipes/<id>/<file>.webp` in the recipe-images bucket (working — see [`image-processing-readiness.md`](./image-processing-readiness.md)).
3. The frontend constructs `https://akli.dev/images/processed/recipes/<id>/<file>.webp` and gets back **`404 NoSuchKey` (XML body) from S3**, because:
   - CloudFront's `images/*` behavior on `akli.dev` routes to the **site bucket**, not the recipe-images bucket.
   - Even if it did route there, the URL path includes a leading `images/` segment that has no counterpart in the bucket key.

The original [`recipe-api-infrastructure.md`](./recipe-api-infrastructure.md) PRD specified a `images/recipes/*` behavior on the site CloudFront distribution to handle this, but it was never implemented (verified in `lib/akli-infrastructure-stack.ts` — only `images/*` exists, pointing at the site bucket). The result is that the entire recipes feature is unverifiable end-to-end via the production-shaped URL path.

## Goals

- Recipe-image variants are reachable at a stable, public URL: `https://images.akli.dev/recipes/<recipeId>/<imageType>-<variant>.webp`.
- The recipe-images S3 bucket stays fully private (`BLOCK_ALL` public access); only the new CloudFront distribution can read via OAC.
- The S3 key shape is restructured so URL maps 1:1 to S3 key with no rewrite layer (no CloudFront Function needed).
- The new subdomain is the explicit foundation for phase 2 — the design reserves URL namespaces (`/recipes/*`, `/blog/*`, …) so adding the second origin is purely additive.
- All infrastructure follows existing project conventions (CDK, OAC, tagging, TDD, snapshot/assertion tests).

## Non-Goals

- **Migrating blog images to the subdomain.** Phase 2; tracked separately. Blog images continue to be served via the existing `akli.dev/images/*` behavior on the site distribution unchanged.
- **301 redirects from old `akli.dev/images/processed/recipes/*` URLs.** No external/public links exist to those URLs (they are constructed only by the frontend, which switches in the sibling PRD). No redirect needed.
- **Frontend changes** (`recipeImageUrl` rewrite, call-site updates, MDX changes). Covered by the sibling PRD in `personal-website`.
- **Image optimization, format conversion, signed URLs, watermarking, on-the-fly resizing.** Future work; not in scope.
- **Removing the existing `akli.dev/images/*` behavior.** It still serves blog images and stays unchanged in this phase.
- **Wildcard SAN cert for `*.akli.dev`.** This PRD adds `images.akli.dev` as a SAN on the existing cert (or a new dedicated cert) — not a wildcard. Wildcards are out of scope.
- **Backfill / re-processing of recipe images** uploaded before the cutover. Migration approach is "accept breakage" because there are no production recipes (test data only).

## User Stories

- As the **frontend**, I need recipe-image URLs that successfully serve the WebP variants so users see processed images instead of broken-image placeholders on the editor and (eventually) public recipe pages.
- As the **resizer Lambda**, I need to write to a bucket key shape that the CDN exposes 1:1 to the URL, so debugging a 404 is `aws s3 ls <key>` with no mental rewrite step.
- As the **operator**, I need the recipe-images bucket to stay private (only CloudFront can read it via OAC) so direct S3 URL access is blocked and the bucket isn't exposed beyond the intended CDN edge.
- As the **architect**, I need the subdomain set up so phase 2 (blog migration) plugs in as a second origin/behavior without redoing the foundation — cert, DNS, and distribution shell stay the same.

## Design & UX

Backend / infrastructure only. No UI.

### URL pattern

```
https://images.akli.dev/recipes/<recipeId>/<imageType>-<variant>.webp
```

Concrete examples:
```
https://images.akli.dev/recipes/9d904a59-…/cover-medium.webp
https://images.akli.dev/recipes/9d904a59-…/cover-thumb.webp
https://images.akli.dev/recipes/9d904a59-…/cover-full.webp
https://images.akli.dev/recipes/9d904a59-…/step-1-medium.webp
```

### S3 key shape (changed)

| Phase | Current key | New key |
|---|---|---|
| Raw upload | `uploads/recipes/<id>/<imageType>` | unchanged |
| Processed variant | `processed/recipes/<id>/<imageType>-<variant>.webp` | `recipes/<id>/<imageType>-<variant>.webp` |

URL maps 1:1 to S3 key — no CloudFront Function rewrite layer.

**Self-trigger prevention is preserved:** the S3 event notification on the recipe-images bucket continues to filter on the `uploads/` prefix only. Resized outputs land under `recipes/`, never under `uploads/`, so the resizer cannot trigger itself.

**Why drop the `processed/` prefix:** the bucket is dedicated to processed recipe images; the `processed/` prefix was meaningless namespace repeating information already encoded in the bucket name (`akli-recipe-images-…`). Dropping it lets URL match key 1:1, which removes the need for a CloudFront Function rewrite forever. The `uploads/` prefix is kept because it carries genuinely different information (lifecycle stage; raw vs processed).

### Reserved namespaces under `images.akli.dev`

| Path prefix | Origin | Phase |
|---|---|---|
| `/recipes/*` | `akli-recipe-images-…` bucket (this PRD) | 1 (this PRD) |
| `/blog/*` | site bucket (with appropriate origin path / rewrite) | 2 (future) |
| Other prefixes | reserved | future |

Default behavior on the distribution: 404 (no fall-through). Every served path must be explicitly routed.

## Technical Considerations

### Stack: new `ImagesStack`

A new stack at `lib/images-stack.ts`, deployed to `eu-west-2`. Owns: the CloudFront distribution for `images.akli.dev`, OAC, bucket policy attachment for the recipe-images bucket, and the Route 53 alias record.

**Why a new stack** rather than adding to `AkliInfrastructureStack`:
- Distinct ownership — the subdomain has a different lifecycle and concerns from the main site.
- Phase 2 changes (adding the blog origin) live cleanly inside `ImagesStack`, isolated from the rest of the platform.
- Tests for CDN behaviors stay scoped to one stack.
- Deploys can target this stack alone (`cdk deploy ImagesStack`) for cache invalidations or behavior changes without affecting the main site.
- Consistent with existing `RecipeStack`, `AuthStack`, `PokedexStack` pattern: one stack per domain concern.

### Cross-stack: bucket reference

The `RecipeImagesBucket` construct lives in `RecipeStack` (`lib/recipe-stack.ts:52`). `ImagesStack` needs a reference to it to:
1. Create an OAC on it.
2. Add a resource policy granting `s3:GetObject` to that OAC.

**Approach:** expose the bucket as a public readonly property on `RecipeStack` (mirrors how `httpApi` is exposed today). `ImagesStack` receives it via stack props.

**Important caveat — OAC bucket policy is NOT auto-attached for cross-stack buckets.** `S3BucketOrigin.withOriginAccessControl(bucket)` only auto-adds the bucket policy when the bucket and the distribution are constructed in the same stack. Here the bucket is owned by `RecipeStack` and consumed via props in `ImagesStack` — CDK treats the prop reference as effectively imported and skips the policy attachment. `ImagesStack` must call `recipeImageBucket.addToResourcePolicy(...)` explicitly, mirroring the existing pattern at `lib/akli-infrastructure-stack.ts:223` (`siteBucket.addToResourcePolicy`).

**Region note:** `RecipeStack` and `ImagesStack` are both in `eu-west-2`, so the bucket reference itself is intra-region. (The hosted zone and cert references are not — see "Cross-region references" below.)

```ts
// lib/recipe-stack.ts
export class RecipeStack extends Stack {
  public readonly httpApi: HttpApi
  public readonly imageBucket: s3.IBucket   // NEW
  // …
}

// bin/akli-infrastructure.ts
const imagesStack = new ImagesStack(app, 'ImagesStack', {
  env: euWest2Env,
  imagesCert,                  // from CertificateStack
  hostedZone,                  // from CertificateStack
  recipeImageBucket: recipeStack.imageBucket,
  imageCachePolicy,            // shared from AkliInfrastructureStack (or extracted to a SharedPoliciesStack)
  securityHeadersPolicy,
})
```

**Cache and headers policies** (`imageCachePolicy`, `securityHeadersPolicy`) currently live inside `AkliInfrastructureStack`. They need to be shared with `ImagesStack`. Two options:
- Pass them as props from the existing stack (creates an `ImagesStack → AkliInfrastructureStack` dependency).
- Extract into a small shared module that both stacks construct from. **Recommended** — avoids artificial cross-stack coupling.

When extracting, give the cache policy a stable explicit `cachePolicyName` (e.g. `'AkliImageCachePolicy'`) so CDK assertion tests can match by name rather than by auto-generated CFN logical ID. Same for `securityHeadersPolicy`.

### CORS on the recipe-images bucket

The bucket currently allows `PUT` from `https://akli.dev` only (for presigned URL uploads). After the cutover, the frontend (`personal-website`) loads images from `https://images.akli.dev/recipes/...`. A standard `<img src>` tag does not require CORS, so no rule change is needed for the common case. If the frontend ever uses `fetch()` to retrieve image bytes (e.g. for `<canvas>` operations, dragging, sharing) against the new subdomain, a CORS `GET` rule allowing `https://akli.dev` would be required. Out of scope for phase 1; flagged so a future feature doesn't hit a silent CORS wall.

### Certificate (us-east-1) — new dedicated cert

Create a **new dedicated certificate** for `images.akli.dev` in `CertificateStack`. Do **not** add `images.akli.dev` as a SAN on the existing `SiteCert`.

**Why a new cert, not a SAN extension:**
- Adding a SAN to an existing ACM cert is a CloudFormation **resource replacement** of the certificate.
- The existing `SiteCert` is consumed cross-region by `AkliInfrastructureStack` (eu-west-2) via SSM/cross-region exports.
- A replacement during a single-deploy run risks ordering issues where the consuming stack tries to read the old cert ARN while it's mid-recreate.
- A separate `ImagesCert` is cheap (ACM certs are free), avoids any risk to the production-serving site cert, and keeps the failure radius scoped to the new feature.

### Cross-region references

`ImagesStack` (eu-west-2) needs to consume:
- The new `ImagesCert` from `CertificateStack` (us-east-1).
- The hosted zone construct from `CertificateStack` (us-east-1) — Route 53 itself is global, but the construct reference lives in us-east-1.

This is the same pattern `AkliInfrastructureStack` uses today. Both `CertificateStack` and `ImagesStack` must enable `crossRegionReferences: true`. CDK handles the wiring via SSM parameters under the hood.

### Route 53

Add an A and AAAA alias record `images.akli.dev → ImagesDistribution` using `route53.ARecord` and `route53.AaaaRecord` with `CloudFrontTarget`. The hosted zone is consumed cross-region from `CertificateStack` per the section above.

### CloudFront distribution

```ts
// lib/images-stack.ts (sketch)
const distribution = new cloudfront.Distribution(this, 'ImagesDistribution', {
  domainNames: ['images.akli.dev'],
  certificate: imagesCert,
  defaultBehavior: {
    origin: /* sentinel — see below */,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    responseHeadersPolicy: securityHeadersPolicy,
  },
  additionalBehaviors: {
    'recipes/*': {
      origin: recipeImageOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: imageCachePolicy,
      responseHeadersPolicy: securityHeadersPolicy,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      compress: true,
    },
  },
})
```

**Default behavior implementation (decided):**

CloudFront requires every behavior — including the default — to declare an origin. A behavior cannot exist with "no origin." Two implementations are realistic:

- **Recommended:** point the default behavior at the recipe-images bucket origin (same origin used by `recipes/*`) and attach a viewer-request CloudFront Function that returns a synthetic 404 before the origin is ever hit. The origin reference is a formality required by the CloudFront API; the function ensures the origin is never queried for default-behavior requests.
- Alternative: point the default at the same origin without a function and rely on S3 returning `NoSuchKey` for any non-`recipes/*` path. Simpler but produces noisier S3 access logs and exposes raw S3 XML error bodies.

Pick the CloudFront Function approach. The function is ~5 lines:

```js
function handler(event) {
  return { statusCode: 404, statusDescription: 'Not Found' };
}
```

Wired as:
```ts
defaultBehavior: {
  origin: recipeImageOrigin,    // formality — function returns 404 before origin is queried
  functionAssociations: [{
    function: defaultDeny404,
    eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
  }],
  // … cache policy, viewer protocol, etc.
}
```

### S3 + OAC

```ts
const oac = new cloudfront.S3OriginAccessControl(this, 'ImagesOAC')
const recipeImageOrigin = origins.S3BucketOrigin.withOriginAccessControl(recipeImageBucket, {
  originAccessControl: oac,
})
```

Because `recipeImageBucket` is a cross-stack reference (owned by `RecipeStack`), CDK does **not** auto-attach the bucket policy. `ImagesStack` must explicitly add the policy statement granting `s3:GetObject` to the CloudFront service principal scoped via `aws:SourceArn`:

```ts
recipeImageBucket.addToResourcePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
  actions: ['s3:GetObject'],
  resources: [`${recipeImageBucket.bucketArn}/*`],
  conditions: {
    StringEquals: {
      'aws:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
    },
  },
}))
```

The recipe-images bucket retains `blockPublicAccess: BlockPublicAccess.BLOCK_ALL`. Direct S3 URL access (e.g. `https://akli-recipe-images-….s3.eu-west-2.amazonaws.com/recipes/<id>/cover-medium.webp`) must return 403 — verified in the AC.

The bucket policy must NOT grant any public principal. The negative assertion is in the testing ACs.

### Resizer key shape change

`lambda/image-variants.ts` defines:

```ts
export const PROCESSED_PREFIX = 'processed/'
export const toProcessedKey = (uploadKey: string): string => {
  if (!uploadKey.startsWith(UPLOAD_PREFIX)) {
    throw new Error(...)
  }
  return PROCESSED_PREFIX + uploadKey.slice(UPLOAD_PREFIX.length)
}
```

Change `PROCESSED_PREFIX` from `'processed/'` to `'recipes/'`. That's the only line change in the variants helper.

**Side effects:**
- The resizer (`lambda/image-resizer.ts`) and the upload-URL handler (`lambda/recipe-image-handler.ts`) both use `toProcessedKey`. They stay consistent because they share the same constant.
- The recipe handler (`lambda/recipe-handler.ts`) stores `imageStatus[processedKey] = ts` keyed by whatever the resizer wrote. After the change, new entries are keyed by the new shape. Old `processed/recipes/*` entries (if any) become stale and need cleanup (see Migration).

**Cross-repo contract change (load-bearing):** the `key` field returned by `POST /recipes/images/upload-url` and persisted into DynamoDB on every recipe item changes shape. The frontend (sibling PRD) reads this `key` field both as part of recipe data and as a lookup into the `imageStatus` map for `processedAt`. The frontend's `recipeImageUrl` URL builder must be updated in the same window — there is no backwards-compat shim. The two PRDs must deploy together.

### Migration

The recipe-images bucket has only test data today (verified via `aws s3 ls` during the diagnostic for this PRD — three files for one test recipe: `cover-{thumb,medium,full}.webp`).

**Recommended approach: accept breakage.**
- Delete pre-existing `processed/recipes/*` keys from the bucket as part of cutover.
- Delete (or update) DynamoDB items whose `imageStatus` map references the old key shape, so the recipe-handler's polling doesn't return stale `processedAt` values pointing to dead URLs.
- Test recipes can be re-uploaded after cutover.

**Alternative (not recommended, listed for completeness):** `aws s3 cp s3://bucket/processed/ s3://bucket/recipes/ --recursive` then `aws s3 rm s3://bucket/processed/ --recursive` followed by a one-shot script that updates the `imageStatus` map keys in DynamoDB. Worth doing if there's ever real production data; trivial to write a `bin/migrate-image-keys.ts` script if needed.

### Deployment ordering

```
1. CertificateStack       (us-east-1 — adds images.akli.dev SAN or new cert)
2. RecipeStack            (eu-west-2 — exposes imageBucket as public property; resizer key change)
3. ImagesStack            (eu-west-2 — distribution + OAC + Route 53 record)
4. (Cleanup)              Delete pre-existing processed/recipes/* keys from S3 + stale imageStatus from DynamoDB
5. personal-website deploy (sibling PRD — switches frontend to new URL pattern)
```

CI deploys all stacks via `cdk deploy --all` so steps 1–3 happen in one CI run; CDK's dependency graph orders them correctly. Steps 4 and 5 are manual.

**Cutover gap:** between step 3 (old keys no longer being written; new keys live) and step 5 (frontend cuts over), the frontend would still construct old URLs and 404. This is acceptable because:
- The only consumer is the admin editor.
- The whole feature is currently broken anyway (every URL 404s).
- The cutover window is short (single CI deploy + frontend deploy).

### Tagging

`ImagesStack` follows the existing `applyStackTags` convention (`lib/utils.ts`). Tags: Owner, CostCenter, Project, Environment, ManagedBy.

### TDD approach

Per `CLAUDE.md` and the precedent set by other infra PRDs (`recipe-api-infrastructure.md`, `image-processing-readiness.md`):

- **Write CDK assertion tests first** for `ImagesStack` — verify the distribution, behaviors, cache policy, security headers, OAC, bucket policy, Route 53 record, and certificate references are present and configured correctly.
- **Update `lambda/image-variants.ts` tests** to assert the new prefix.
- **Update `lambda/image-resizer.ts` tests** to verify outputs land at the new key shape.
- **Update `lambda/recipe-handler.ts` tests** for `composeImageProcessedAt` with new key shape (a few tests need updated fixtures).

## Acceptance Criteria

ACs are split into automated (Jest + `aws-cdk-lib/assertions` + Lambda unit tests; testable pre-deploy via `pnpm test`) and manual (post-deploy verification, runbook). TDD applies only to automated ACs.

### Automated — Certificate

- [ ] A new dedicated certificate `ImagesCert` is added to `CertificateStack` for the domain `images.akli.dev`. The existing `SiteCert` is unchanged (asserted: `SiteCert` `DomainName` and `SubjectAlternativeNames` are unchanged from the prior synthesized template).
- [ ] `CertificateStack` adds a CloudFormation Output `ImagesCertArn` (or equivalent) so cross-region consumers and tests have a stable handle.
- [ ] `CertificateStack` test asserts a second `AWS::CertificateManager::Certificate` resource exists with `DomainName: images.akli.dev` and validation method `DNS`.

### Automated — `ImagesStack` synthesis

- [ ] A new `AWS::CloudFront::Distribution` resource exists with `Aliases: ['images.akli.dev']` and a `ViewerCertificate.AcmCertificateArn` referencing `ImagesCert`.
- [ ] The distribution's `DefaultCacheBehavior` has a `FunctionAssociations` entry with `EventType: viewer-request` and references a CloudFront Function whose inline code returns `statusCode: 404`.
- [ ] The distribution's `CacheBehaviors` array has exactly **one** entry, with `PathPattern: 'recipes/*'`.
- [ ] The `recipes/*` behavior has `AllowedMethods: ['GET', 'HEAD']` (asserted explicitly to ensure `OPTIONS` is excluded), `Compress: true`, `ViewerProtocolPolicy: redirect-to-https`.
- [ ] The `recipes/*` behavior's `CachePolicyId` references the shared image cache policy (asserted by the policy's stable `cachePolicyName` rather than auto-generated logical ID).
- [ ] The `recipes/*` behavior's `ResponseHeadersPolicyId` references the shared security headers policy.
- [ ] The `recipes/*` behavior references the recipe-images origin via OAC (asserted by checking `OriginAccessControlId` is non-null on the origin and the origin's `DomainName` matches the recipe-images bucket regional domain).
- [ ] An `AWS::CloudFront::OriginAccessControl` resource exists with `OriginAccessControlConfig.SigningProtocol: sigv4` and `SigningBehavior: always`.

### Automated — Route 53

- [ ] An `AWS::Route53::RecordSet` resource exists with `Name: 'images.akli.dev.'`, `Type: 'A'`, `AliasTarget.DNSName: { 'Fn::GetAtt': [<distribution>, 'DomainName'] }`, `AliasTarget.HostedZoneId: 'Z2FDTNDATAQYW2'` (the global CloudFront alias hosted-zone ID), and `HostedZoneId` referencing the akli.dev hosted zone.
- [ ] An equivalent `AWS::Route53::RecordSet` resource exists with `Type: 'AAAA'`.

### Automated — S3 bucket policy on `RecipeImagesBucket`

- [ ] The bucket's `AWS::S3::BucketPolicy` resource gains an additional statement with `Effect: Allow`, `Action: s3:GetObject`, `Principal: { Service: 'cloudfront.amazonaws.com' }`, `Resource: '<bucket-arn>/*'`, and `Condition.StringEquals.aws:SourceArn` resolving to the new distribution's ARN.
- [ ] **Negative assertions on the bucket policy:** no statement grants `Principal: '*'`, no statement grants `s3:ListBucket` to the CloudFront principal, no statement omits the `aws:SourceArn` condition for the new principal, and the bucket retains `PublicAccessBlockConfiguration.BlockPublicAcls/IgnorePublicAcls/BlockPublicPolicy/RestrictPublicBuckets: true`.
- [ ] **Negative assertion on S3 event notification:** the `LambdaConfigurations` on the bucket's `NotificationConfiguration` continues to filter on `prefix: 'uploads/'` and contains **no** filter matching `prefix: 'recipes/'` (verifies the resizer cannot self-trigger after the key-shape change).

### Automated — Cross-stack reference

- [ ] `RecipeStack` exposes the `RecipeImagesBucket` construct as a `public readonly imageBucket: s3.IBucket` property (TypeScript signature change verified by compilation; usage verified by `bin/akli-infrastructure.ts` consuming it).
- [ ] `ImagesStack` accepts `recipeImageBucket: s3.IBucket` in its props interface.
- [ ] Both `ImagesStack` and `CertificateStack` enable `crossRegionReferences: true` (asserted by reading the stack instances' `crossRegionReferences` property in the test harness).

### Automated — Shared CDN policies module

- [ ] A new helper module exports the `imageCachePolicy` and `securityHeadersPolicy` constructors (e.g. `lib/cdn-policies.ts`).
- [ ] `AkliInfrastructureStack` and `ImagesStack` both import from this module — neither inlines the policy definition.
- [ ] `imageCachePolicy` has an explicit `cachePolicyName: 'AkliImageCachePolicy'` (or equivalent stable name) so test assertions can match by name.

### Automated — `lambda/image-variants.ts`

- [ ] A new test file `test/lambda/image-variants.test.ts` is created with direct unit coverage for `toProcessedKey`. Existing indirect coverage via resizer/handler tests is insufficient given the contract change.
- [ ] Test asserts `toProcessedKey('uploads/recipes/<id>/cover')` returns `'recipes/<id>/cover'`.
- [ ] Test asserts `toProcessedKey('not-uploads/foo')` throws (does not start with `uploads/`).
- [ ] Test asserts `toProcessedKey('uploads/')` throws or returns an explicit zero-suffix value (define behavior — recommend throw).
- [ ] Test asserts `toProcessedKey('uploads//double-slash')` produces `'recipes//double-slash'` (or throws — define behavior).
- [ ] Test asserts `PROCESSED_PREFIX === 'recipes/'`.

### Automated — `lambda/image-resizer.ts`

- [ ] Existing tests are updated for the new output key shape (asserting `PutObjectCommand` is called with `Key: 'recipes/<id>/<type>-<variant>.webp'`).
- [ ] Existing tests are updated for the new `imageStatus` write key (asserting the DynamoDB `UpdateCommand`'s `ExpressionAttributeNames['#k']` value is `'recipes/<id>/<type>'`, not `'processed/recipes/<id>/<type>'`).

### Automated — `lambda/recipe-image-handler.ts`

- [ ] Existing tests are updated to assert the response body's `key` field equals `'recipes/<id>/<type>'` (the value returned by `toProcessedKey`).

### Automated — `lambda/recipe-handler.ts`

- [ ] Existing tests for `composeImageProcessedAt` are updated to use the new key shape in fixtures, and continue to pass.
- [ ] A regression test asserts that an `imageStatus` map keyed with the old `processed/recipes/...` shape produces `processedAt: undefined` on the composed response (so stale data doesn't render as "ready" with a broken URL).

### Manual — Cutover migration (runbook, post-deploy)

- [ ] All pre-existing keys under `processed/recipes/*` in the recipe-images bucket are deleted via `aws s3 rm s3://akli-recipe-images-<account>-eu-west-2/processed/ --recursive`.
- [ ] DynamoDB recipe items whose `imageStatus` map keys start with `processed/` are deleted or have those map entries removed (test recipes only — verified beforehand via `aws dynamodb scan` that no production recipes exist).
- [ ] Post-cleanup verification: `aws dynamodb scan --projection-expression imageStatus | grep -c 'processed/'` returns 0.

### Manual — End-to-end verification (post-deploy, runbook)

- [ ] DNS resolution: `dig +short images.akli.dev` returns CloudFront IPs.
- [ ] Upload happy path: uploading a recipe cover image via the admin editor produces three variant files at `recipes/<id>/cover-{thumb,medium,full}.webp` in the bucket (verified by `aws s3 ls s3://akli-recipe-images-<account>-eu-west-2/recipes/<id>/`).
- [ ] CDN serves: `curl -I https://images.akli.dev/recipes/<id>/cover-medium.webp` returns `HTTP/2 200`, `content-type: image/webp`, and `content-length` > 0.
- [ ] OAC enforcement: `curl -I https://akli-recipe-images-<account>-eu-west-2.s3.eu-west-2.amazonaws.com/recipes/<id>/cover-medium.webp` returns `HTTP/1.1 403`.
- [ ] Default behavior 404: `curl -I https://images.akli.dev/anything-not-recipes` returns `HTTP/2 404` (and request never reaches S3 — verified by absence of an S3 access log entry, optional).
- [ ] Cache hit: a second request to the same `images.akli.dev/recipes/...` URL returns `x-cache: Hit from cloudfront`.
- [ ] Admin editor integration: after the sibling PRD ships, the editor's `<ImageUpload>` preview renders the processed image after a page refresh (no "Failed to load image" overlay).

### Documentation

- [ ] `CLAUDE.md` "Architecture" section adds a bullet for `ImagesStack` (eu-west-2): "CloudFront distribution serving `images.akli.dev` with the recipe-images bucket as origin."
- [ ] `recipe-api-infrastructure.md` PRD gets a "**Superseded by:**" note at the top of the "Image URLs" / "CloudFront/API Stack Changes" sections, pointing to this PRD.
- [ ] `image-processing-readiness.md` PRD gets a brief informational note that the URL pattern in its problem statement is replaced by the new pattern in this PRD; the readiness contract itself is unaffected.

### Process

- [ ] Tests are written before implementation (TDD) for all automated ACs above.
- [ ] `pnpm test` passes locally.
- [ ] `pnpm lint` passes locally.
- [ ] `cdk synth` produces a clean template (no diff churn beyond the intended additions).

## Open Questions

All previous open questions resolved during PRD review:

- **Cert approach** → resolved to **new dedicated `ImagesCert`** (not SAN extension), because SiteCert is consumed cross-region and a SAN extension would be a CFN replacement that risks ordering issues during a single deploy.
- **Default behavior implementation** → resolved to **CloudFront Function returning synthetic 404**, with the recipe-images origin attached as a formality (CloudFront requires every behavior to declare an origin).
- **Cache and headers policies sharing** → resolved to **shared `lib/cdn-policies.ts` module**, with a stable `cachePolicyName` to enable test assertions by name.

No remaining open questions for phase 1.

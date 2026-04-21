# PRD: Image Processing Readiness — Infrastructure

> **Sibling PRD:** [`personal-website/docs/prds/image-processing-readiness.md`](../../../personal-website/docs/prds/image-processing-readiness.md) — covers the editor polling hook, processing skeletons across all image surfaces, and client-side publish-guard mirroring.
>
> **Context:** Follow-up to [`draft-recipes.md`](./draft-recipes.md), which shipped the async upload contract without a readiness signal, causing processed-variant 404s on admin surfaces.

## Overview
The recipes DynamoDB item gains a per-image readiness signal written by the image-resizer Lambda after variant PUTs succeed. The recipe handler composes that signal into the API response, extends publish validation to require readiness on every image, and adds a lightweight admin single-recipe endpoint that the frontend uses for polling.

## Problem Statement
The image-resizer Lambda is triggered asynchronously by S3 `ObjectCreated` on the `uploads/` prefix and writes `processed/recipes/<id>/cover-{thumb,medium,full}.webp`. The API returns the processed `key` to the client before the resizer runs. The client persists that key to DynamoDB via autosave within 2s, and any surface that renders the variant URL gets a 404 until the resizer completes (typically several seconds). There is no current way for the client or the server to know whether a given image's variants exist in S3. Concretely, this was observed as `GET https://akli.dev/images/processed/recipes/4e355925-cb5a-4708-bde8-3ba45ed2bf8b/cover-{medium,full}.webp 404 (Not Found)` on the admin preview page shortly after the draft-recipes epic shipped.

## Goals
- Each image on a recipe carries a readiness timestamp (`processedAt`) that reflects when the resizer completed writing its variants.
- `PATCH /recipes/{id}/publish` rejects a recipe whose cover image or any step image with a key is not yet ready.
- The resizer's write-back is safe against a recipe being deleted mid-processing — no resurrection of the row.
- Image-swap cleanup on `PATCH /recipes/{id}` removes the now-orphan readiness entries alongside the orphan S3 variants, keeping the `imageStatus` map bounded by live image keys.
- A single admin endpoint for fetching one recipe by id is exposed so the frontend does not need to re-fetch the entire admin list on every poll tick.

## Non-Goals
- Retry / failure-recovery for the resizer. If the resizer crashes, the image stays unready forever and the user must re-upload. Observability follow-up: alarm on resizer error rate (tracked separately).
- WebSocket / SSE push from the resizer to the client.
- Backfill of `imageStatus` for pre-existing recipe items. The table has no items carrying an image that predates this change (the sole current draft with an image will be deleted before rollout). The resizer writes `imageStatus` for every image going forward, so the attribute is always present on any image shipped under this contract.
- Per-image failure status (`failed` state). Readiness is binary: `processedAt` is either present (ready) or absent (still processing / never processed).
- Removing the unused `authorId-createdAt-index` GSI. Still tracked separately.

## User Stories
- As the frontend, I need each image in API responses to tell me whether the resizer has finished, so I can render a placeholder instead of a broken image.
- As the frontend, I need a single-recipe admin endpoint so I can poll one recipe cheaply while images are processing.
- As the product, I need the server to refuse to publish a recipe with unready images, so a stale frontend tab or a direct API call cannot flip a recipe live with broken image URLs.
- As the storage owner, I need the readiness map cleaned up alongside the S3 variants when an image is swapped, so `imageStatus` does not accumulate orphan keys.
- As the operator, I need the resizer's write-back to be defensive against a deleted recipe, so a race between delete and processing does not resurrect the row.

## Design & UX
Back-end only; client UX lives in the sibling PRD. The contract matters.

**Shared API contract (repeated so this PRD is self-contained):**

`RecipeImage` in API responses:
```ts
{
  key: string
  alt: string
  processedAt?: number  // unix ms set when the resizer finished writing variants; absent = still processing
}
```

Recipe responses (`GET /recipes`, `GET /recipes/{slug}`, `GET /me/recipes`, `GET /recipes/admin`, the new `GET /recipes/admin/{id}`, `PATCH /recipes/{id}`, `PATCH /recipes/{id}/publish`, `PATCH /recipes/{id}/unpublish`) compose `processedAt` onto `coverImage` and each `step.image` by looking up the image's `key` in the item's internal `imageStatus` map.

New endpoint:
- `GET /recipes/admin/{id}` → admin JWT. Response: the full `Recipe` with composed `processedAt` values. Used by the frontend polling hook. Returns 404 if the item does not exist. Works for drafts and published alike.

Modified endpoint:
- `PATCH /recipes/{id}/publish` → validation rejects with 400 when any image on the recipe has a `key` but no `processedAt` in `imageStatus`. Error shape:
  ```json
  {
    "errors": {
      "coverImage": { "processedAt": "Cover image still processing" },
      "stepImages": [
        { "order": 3, "processedAt": "Step image still processing" }
      ]
    }
  }
  ```
  The new `errors.stepImages` key is distinct from the existing `errors.steps` (empty-text check), which keeps its current string shape.
- `PATCH /recipes/{id}` → when the image-swap diff identifies keys to delete from S3, the same UpdateExpression also REMOVEs the corresponding entries from `imageStatus`.
- `PATCH /recipes/{id}` also strips any client-supplied `processedAt` fields from the request body before the UpdateCommand, alongside the existing strips of `id`, `slug`, `authorId`, `createdAt`, `status`, `ttl`. Readiness is server-computed.

States in the API:
- Image present, ready: `processedAt: <number>`.
- Image present, processing: `processedAt` absent.
- No image set: image field absent from the recipe (unchanged semantics).

## Technical Considerations

**DynamoDB (`recipes` table, table name `recipes`)**
- New attribute on each recipe item: `imageStatus: Map<string, number>`. Keys are processed S3 keys (e.g. `processed/recipes/<id>/cover`, `processed/recipes/<id>/step-3`); values are unix-ms timestamps of when the resizer finished. Document-level map; no schema migration at the CDK/CFN level.
- No new indexes. No change to the existing `status-createdAt-index` or `authorId-createdAt-index`.
- TTL attribute unchanged.

**No backfill** — the table has no items whose images were uploaded before this work (the sole current draft will be deleted before rollout). Every image uploaded after this ships will have its `imageStatus` entry written by the resizer. If a future manual import bypasses the resizer, that import will need to seed `imageStatus` — out of scope here.

**Image-resizer Lambda (`lambda/image-resizer.ts`)**
- After all variant PUTs in the `Promise.all` block succeed (the current code at lines 42-58), **before** the final `DeleteObjectCommand` on the source upload (line 60-62), parse the recipe id from the S3 key and fire a conditional `UpdateItem` on the recipes table:
  ```
  UpdateExpression:     'SET imageStatus.#k = :ts'
  ConditionExpression:  'attribute_exists(id)'
  ExpressionAttributeNames:  { '#k': processedKey }
  ExpressionAttributeValues: { ':ts': Date.now() }
  ```
- Parse logic: the S3 upload key has the shape `uploads/recipes/<id>/cover` or `uploads/recipes/<id>/step-<N>`. The `toProcessedKey` helper already exists at `lambda/image-variants.ts:11`. Recipe id is the third segment of the upload key path; reject/no-op keys that don't match the `uploads/recipes/<id>/...` shape (defensive — the resizer is only wired to the `uploads/` prefix, but the shape check protects against a misconfigured notification).
- On `ConditionalCheckFailedException` (recipe was deleted before the resizer finished), log a structured info-level line `console.info({ event: 'resizer.writeback.skipped', reason: 'recipe_deleted', key })` and swallow. The variants in S3 are orphaned and will be cleaned up by a future `DELETE /recipes/{id}` on that recipe id (if it's ever recreated) or manually.
- On any other DDB error, log and re-throw so the S3 event is retried per the Lambda async retry policy. Do **not** retry variant writes on a failed DDB write — the variants are already persisted, so the retry only re-runs the write-back. Retry causes `:ts` to drift forward (last writer wins); consumers must not assume monotonic "first-ready" semantics.
- Resizer requires a new env var `TABLE_NAME`. Mirror the existing `IMAGE_BUCKET_NAME` guard at `image-resizer.ts:27` — throw at invocation if unset.

**Accepted race — image-swap vs resizer write-back**
- If a user swaps a cover image while a resizer run for the prior image is still in flight, the following interleaving is possible: (1) user uploads image A, (2) resizer for A starts, (3) user uploads image B (same S3 path `uploads/recipes/<id>/cover` overwrites A), (4) PATCH from autosave updates `coverImage.key` but leaves `imageStatus` entries unchanged for the same key, (5) resizer for B starts, (6) resizer for A completes writing `imageStatus.#<cover-key> = tA`, (7) resizer for B completes writing `imageStatus.#<cover-key> = tB`. Because the cover key is stable across the swap (both resolve to `processed/recipes/<id>/cover`), the final state is correct — last writer wins, value is a valid timestamp, variants on disk are B's.
- The genuine race: if the user swaps to a **different** cover key mid-flight (not supported by the current upload handler — the cover path is always `cover` — but possible for step images where the path embeds an order). A resizer finishing for an orphan key after the PATCH has REMOVEd its `imageStatus` entry will re-add the orphan. The map stays small (keyed by live step orders), and the next PATCH that swaps again or the `DELETE /recipes/{id}` path clears it. Accept this race — the cost is a few stale bytes in a map attribute, not a correctness problem.

**Recipe handler (`lambda/recipe-handler.ts`)**

Draft creation must initialise `imageStatus`:
- `handleCreateDraft` at `recipe-handler.ts:247` must add `imageStatus: {}` to the new item. This is load-bearing: `SET imageStatus.#k = :ts` on a missing top-level map fails with `ValidationException: The document path provided in the update expression is invalid for update`. Without this init, the very first upload on any newly-created draft will blow up the resizer's write-back.
- The alternative — using `SET imageStatus = if_not_exists(imageStatus, :empty), imageStatus.#k = :ts` in the resizer — is fragile across SDK versions and harder to reason about. Eager init at draft creation is the right call.

Response composition — new helper:
```ts
function composeImageProcessedAt(item: Record<string, unknown>): Record<string, unknown> {
  const imageStatus = (item.imageStatus as Record<string, number> | undefined) ?? {}
  const coverImage = item.coverImage as { key?: string } | undefined
  const coverProcessedAt = coverImage?.key ? imageStatus[coverImage.key] : undefined
  const steps = Array.isArray(item.steps) ? item.steps.map((step) => {
    const img = (step as { image?: { key?: string } }).image
    if (!img?.key) return step
    const processedAt = imageStatus[img.key]
    return processedAt !== undefined ? { ...step, image: { ...img, processedAt } } : step
  }) : item.steps
  const nextCover = coverImage && coverProcessedAt !== undefined
    ? { ...coverImage, processedAt: coverProcessedAt }
    : coverImage
  const { imageStatus: _stripped, ...rest } = item
  return { ...rest, coverImage: nextCover, steps }
}
```
Every existing response-shaping helper (`convertRecipeTags`, `lightweightRecipe`, `lightweightAdminRecipe`) is composed with `composeImageProcessedAt` so every route returns `processedAt` when known. `imageStatus` itself is **stripped from every response** — it's an internal attribute.

Publish validation (`validatePublishInput` at `recipe-handler.ts:411`):
- After the existing cover/alt/ingredients/steps checks, inspect the item's `imageStatus` map.
- If `coverImage.key` is present and `imageStatus[coverImage.key]` is absent → push `errors.coverImage = { ...errors.coverImage, processedAt: 'Cover image still processing' }`.
- For each step with `image.key` and no `imageStatus[image.key]` → accumulate into a new `errors.stepImages` array of `{ order, processedAt: 'Step image still processing' }`. The existing `errors.steps` single-string output (from the empty-text check) is unchanged — the readiness errors go in `errors.stepImages`, preserving backward compatibility with the existing 400 contract the frontend knows about.

Image-swap cleanup (`handleUpdateRecipe`):
- The existing diff at `recipe-handler.ts:300-318` returns `keysToDelete` — an array of full variant keys (`<key>-<variant>.webp`). Compute the **base** keys alongside: cover's old key when cover is swapped, and any step image keys present on old but absent on new.
- Extend the UpdateExpression so that, in addition to `SET`ting fields, it `REMOVE`s `imageStatus.#old_<n>` for each base key being dropped. This keeps the map bounded.
- Call ordering remains: DDB `UpdateCommand` first (with `ReturnValues: 'ALL_OLD'` — unchanged), S3 `DeleteObjectsCommand` second. The REMOVE is part of the DDB UpdateCommand, so no additional round trip.

Client-supplied readiness — defensive strip:
- In `handleUpdateRecipe`, the existing body-sanitisation strip (`recipe-handler.ts:335-340`) is extended to also remove any client-supplied `processedAt` from inside `coverImage` and each `step.image` on the incoming payload. Readiness is server-computed; a misbehaving client cannot write it.

New route (`GET /recipes/admin/{id}`):
- Handler function `handleGetAdminRecipeById`:
  1. `decodeJwt` → 401 if missing.
  2. `isAdmin` → 403 if not admin.
  3. `getRecipeById(id)` → 404 if missing.
  4. Return `json(200, composeImageProcessedAt(convertRecipeTags(item)))`.
- Dispatch switch gets a new case `GET /recipes/admin/{id}` → `handleGetAdminRecipeById`.
- Distinct from `GET /recipes/{slug}` which is public and filters by `slug`; the admin route is id-based and returns drafts too.

**CDK (`lib/recipe-stack.ts`)**
- `ImageResizer` Lambda: pass `TABLE_NAME: table.tableName` in its environment (currently only `IMAGE_BUCKET_NAME` is set at line 128-130).
- Grant scoped DDB permission: `table.grant(imageResizer, 'dynamodb:UpdateItem')`. Prefer the narrow grant over `grantWriteData` — the resizer should only UpdateItem, not Put or Delete on the recipes table.
- New HTTP API route:
  ```ts
  new apigwv2.CfnRoute(this, 'AdminGetRecipeByIdRoute', {
    apiId: this.httpApi.httpApiId,
    routeKey: 'GET /recipes/admin/{id}',
    target: `integrations/${recipeIntegration.ref}`,
    authorizationType: 'JWT',
    authorizerId: jwtAuthorizer.ref,
  })
  ```
- Matches the existing pattern in `recipe-stack.ts:212-218` for `GET /recipes/admin`.
- **No new `addPermission` call** — the existing `recipeHandler.addPermission('ApiGatewayInvoke', ..., sourceArn: '.../*/*')` at `recipe-stack.ts:171-174` already covers any new route targeting the same integration.

**IAM — defence-in-depth**
- The resizer's new DDB grant is additive; no removal of existing permissions.
- The recipe-handler's IAM is unchanged — composing `imageStatus` is a read-side transformation; it already has `grantReadWriteData` on the table.

**Testing approach (TDD for the resizer write-back and the handler extensions)**

Resizer (`test/lambda/image-resizer.test.ts`):
- Extend the existing harness (mocked S3 via `aws-sdk-client-mock`) with a `DynamoDBDocumentClient` mock.
- Assert on a cover-image event: after the three variant PUTs, an `UpdateCommand` is sent with `UpdateExpression: 'SET imageStatus.#k = :ts'`, `ConditionExpression: 'attribute_exists(id)'`, `#k = 'processed/recipes/<id>/cover'`, `:ts` is a number.
- Assert on a step-image event (key `uploads/recipes/<id>/step-2`): `#k = 'processed/recipes/<id>/step-2'`.
- Assert on `ConditionalCheckFailedException`: resizer logs and resolves without throwing; the final source-delete still runs.
- Assert on other DDB errors: resizer throws (Lambda async retry kicks in).
- Assert call order: DDB UpdateCommand is invoked before the source DeleteObjectCommand.
- Malformed keys (e.g. `uploads/not-recipes/x`): resizer does not attempt a DDB write; logs and no-ops.

Handler (`test/lambda/recipe-handler.test.ts`):
- Response composition: existing route tests asserting on a response body gain a variant with `imageStatus` populated; the composed response contains `coverImage.processedAt` and `step.image.processedAt` where expected. `imageStatus` itself is absent from the response.
- Publish validation readiness: a recipe with `coverImage.key` but no `imageStatus[key]` → 400 with `errors.coverImage.processedAt = 'Cover image still processing'`. A recipe with a step image key but no matching `imageStatus` → 400 with `errors.stepImages` containing the step order.
- Publish validation readiness does not interfere with existing checks — a recipe missing both `title` and `coverImage.processedAt` surfaces both errors.
- `GET /recipes/admin/{id}`: admin JWT → 200 with the composed recipe; non-admin → 403; missing JWT → 401; unknown id → 404; returns drafts (not filtered by status).
- Image-swap cleanup: `PATCH /recipes/{id}` with a new `coverImage.key` sends an UpdateCommand whose expression includes both `SET` for the new field and `REMOVE imageStatus.#oldKey` for the dropped one.
- Client-supplied `processedAt` on a PATCH body is stripped before the UpdateCommand (assert the outgoing command does not carry a `processedAt` ExpressionAttributeValue).

CDK (`test/recipe-stack.test.ts`):
- `GET /recipes/admin/{id}` route exists with `AuthorizationType: JWT`, pointing at the recipe integration.
- Image-resizer Lambda environment includes `TABLE_NAME`.
- Image-resizer role policy grants `dynamodb:UpdateItem` on the recipes table ARN (regression assertion — asserts the grant was added, does not over-specify the policy document structure).
- Regression: resizer does **not** gain DDB Put / Delete / Scan permissions.

## Acceptance Criteria

CDK (`lib/recipe-stack.ts` + template tests):
- [ ] Image-resizer Lambda environment includes `TABLE_NAME = <recipes table name>`, asserted via `Template.fromStack` matching the resizer's `Environment.Variables`.
- [ ] Image-resizer role has `dynamodb:UpdateItem` on the recipes table ARN, with Resource resolving to `Fn::GetAtt: [RecipesTable..., 'Arn']`.
- [ ] Regression: the **image-resizer's** role policy specifically (scoped via `Roles: [{ Ref: stringLikeRegexp('^ImageResizerServiceRole.*') }]`) does NOT include `dynamodb:PutItem`, `dynamodb:DeleteItem`, or `dynamodb:Scan`. The recipe-handler's role legitimately has some of these and is not asserted against.
- [ ] `AWS::ApiGatewayV2::Route` for `GET /recipes/admin/{id}` exists with `AuthorizationType: JWT` pointing at the recipe integration.
- [ ] No new `AWS::Lambda::Permission` resource is added for the new route (the existing `/*/*` sourceArn on `recipeHandler` covers it).

Image resizer (`lambda/image-resizer.ts` + tests):
- [ ] Throws at invocation with a clear error when `TABLE_NAME` env var is unset (mirrors the existing `IMAGE_BUCKET_NAME` guard at line 27).
- [ ] After variant PUTs succeed, the resizer sends an `UpdateCommand` with `UpdateExpression: 'SET imageStatus.#k = :ts'` and `ConditionExpression: 'attribute_exists(id)'`.
- [ ] The attribute name value is the processed S3 key derived via `toProcessedKey`.
- [ ] The timestamp is a number produced by `Date.now()` at the point of the UpdateItem call.
- [ ] On `ConditionalCheckFailedException`, the resizer emits `console.info({ event: 'resizer.writeback.skipped', reason: 'recipe_deleted', key })` and resolves successfully — the source-delete still runs.
- [ ] On other DDB errors, the resizer throws so the Lambda async retry policy kicks in.
- [ ] Malformed keys that don't match `uploads/recipes/<id>/...` do not trigger a DDB write; the resizer logs and no-ops on the DDB side.
- [ ] Test asserts that DDB `UpdateCommand` is called **before** the final `DeleteObjectCommand` on the source upload.

Recipe handler — draft creation:
- [ ] `POST /recipes/drafts` persists `imageStatus: {}` on the new item alongside the existing fields (title, intro, status, ttl, etc.). Without this, the first upload on any new draft will throw `ValidationException` at the resizer's write-back.

Recipe handler — response composition (`lambda/recipe-handler.ts` + tests):
- [ ] Every recipe-returning route — including `GET /recipes`, `GET /recipes/{slug}`, `GET /me/recipes`, `GET /recipes/admin`, `GET /recipes/admin/{id}`, `PATCH /recipes/{id}`, `PATCH /recipes/{id}/publish`, `PATCH /recipes/{id}/unpublish` — composes `processedAt` onto `coverImage` and each `step.image` where `imageStatus[key]` exists.
- [ ] `imageStatus` itself is stripped from every response body.
- [ ] `lightweightRecipe`, `lightweightAdminRecipe`, and `convertRecipeTags` all flow through the new `composeImageProcessedAt` helper.

Recipe handler — new admin endpoint:
- [ ] `GET /recipes/admin/{id}` dispatch case added to the handler switch.
- [ ] Handler returns 401 without a JWT, 403 without admin group, 404 for a missing item, 200 for a valid admin request.
- [ ] Returns drafts as well as published items (not filtered by status).
- [ ] Response body uses `composeImageProcessedAt(convertRecipeTags(item))`.

Recipe handler — publish validation:
- [ ] `validatePublishInput` rejects with `errors.coverImage.processedAt = 'Cover image still processing'` when `coverImage.key` is present but `imageStatus[coverImage.key]` is not.
- [ ] `validatePublishInput` rejects with `errors.stepImages = [{ order, processedAt: 'Step image still processing' }, ...]` for any step with an `image.key` and no matching `imageStatus` entry.
- [ ] Existing `errors.steps` (empty-text check) is unchanged in shape and key.
- [ ] Readiness errors coexist with other validation errors on the same 400 response.
- [ ] Publishing an already-published recipe still re-runs validation (existing idempotency rule preserved); a republish after an image-swap with an unready new image fails with the readiness error.

Recipe handler — image-swap cleanup:
- [ ] `PATCH /recipes/{id}` that drops an image key includes `REMOVE imageStatus.#oldKey` in the same UpdateCommand as the `SET` for updated fields.
- [ ] `imageStatus` entries for keys still present on the recipe are preserved.

Recipe handler — input sanitisation:
- [ ] `PATCH /recipes/{id}` strips any client-supplied `processedAt` fields from nested `coverImage` and `step.image` bodies before the UpdateCommand runs.

Cross-cutting:
- [ ] All existing tests pass (`pnpm test` green).
- [ ] Lint passes with zero errors.

PR checklist (operator verification, not automated tests):
- [ ] `cdk diff --all` shows only the expected additions (resizer env var, resizer DDB grant, new route); no other resource churn.

## Open Questions
- None. Failure-mode for a stuck resizer (alarm / retry UI) is explicitly deferred as a follow-up.

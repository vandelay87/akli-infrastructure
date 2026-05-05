# PRD: Editable Recipe Slugs (Backend)

> **Sibling PRD:** [`personal-website/docs/prds/editable-recipe-slugs.md`](../../../personal-website/docs/prds/editable-recipe-slugs.md) — covers the slug input UX in the admin editor, the lock-state UI, and the `recipeImageUrl` signature change.
>
> **Epic context:** "Phase 1.5" between [`images-cdn-phase-1.md`](./images-cdn-phase-1.md) (just shipped) and the planned phase 2 (blog images). Replaces UUID-based recipe image keys with slug-based keys, exposes the slug as user-editable in the admin UI, and enforces a single lock rule: slug becomes immutable once any recipe image has been uploaded. The two PRDs deploy in lockstep.

## Overview

Switch recipe image S3 keys from `recipes/<uuid>/<imageType>-<variant>.webp` to `recipes/<slug>/<imageType>-<variant>.webp`, drop the stored `coverImage.key` and `step.image.key` fields in favour of derive-from-slug URLs, and make the slug user-editable on draft creation and PATCH (with a server-side lock once any image exists).

## Problem Statement

The image URL shipped in [`images-cdn-phase-1.md`](./images-cdn-phase-1.md) embeds the recipe's UUID:

```
https://images.akli.dev/recipes/8f005719-275a-4595-a129-c6639671d951/cover-medium.webp
```

That's a 36-character opaque identifier. The user-facing recipe URL already uses a slug (`/recipes/beans-on-toast`); having the image URL diverge from that makes social sharing, debugging, and SEO weaker than they need to be:

```
# wanted
https://images.akli.dev/recipes/beans-on-toast/cover-medium.webp
```

A second gap: the slug today is server-generated at `POST /recipes/drafts` time and is **never user-editable** — `findUniqueSlug` auto-suffixes on collision (`spaghetti-bolognese-2`) without surfacing the conflict. There is no UI to set or change it. Users have no control over their public URL.

## Goals

- Recipe image S3 keys use the recipe's slug: `recipes/<slug>/<imageType>-<variant>.webp`. URL maps 1:1 to S3 key — same convention as Phase 1 establishes.
- The API supports a user-supplied slug at draft creation and PATCH; uniqueness is enforced server-side and collisions return `409 Conflict` (no auto-suffix).
- The slug is **immutable** once any image has been uploaded for the recipe. Server enforces (`PATCH` rejects with `409`); the sibling frontend PRD enforces in the UI.
- Stored `coverImage.key` and `step.image.key` fields are dropped from the recipe data model. Image URLs are derived from `(recipe.slug, imageType[, stepOrder])` ("Option B" from the design discussion).
- A new GSI on `slug` allows the resizer Lambda to look up a recipe by slug in O(1) instead of scanning, and replaces the current `Scan`-based `findUniqueSlug`.

## Non-Goals

- **Migration of existing recipes.** Verified: no production recipes exist (the user confirmed during the Phase 1 cutover). The cutover is "accept breakage"; we do not write a backfill script. Documented and re-confirmed at deploy time.
- **Slug changes after the first image is uploaded.** Server returns `409` with `error: 'slug_locked'`. Users must delete the image (existing flow — see "Image deletion clears imageStatus" below) before changing the slug. The escape hatch is documented; no atomic batch-rename of S3 objects.
- **Step reordering with uploaded step images.** Step image keys use `step-<order>`; reordering after upload would orphan S3 objects, identical in shape to the slug-change problem. Out of scope for this PRD — open as a follow-up if users hit it.
- **Blog images.** Phase 2 sibling PRD. The blog post route already uses slugs (`/blog/<slug>`); the same pattern this PRD establishes will carry over.
- **Backwards compatibility** with the UUID-based key shape. No production data exists; clean cutover, no shim.
- **Custom slugs above the 100-character limit** or with non-ASCII characters. Validation rejects.

## User Stories

- As an admin uploading a recipe, I want my image URLs to use the recipe's slug instead of a UUID so the URL is human-readable, shareable, and consistent with the public recipe page URL.
- As an admin who's uploaded an image, I want the system to refuse a slug change with a clear error rather than silently break my image URLs.
- As an admin trying to use a slug another recipe has, I want a clear `409 Conflict` so I can pick a different one — not a silent auto-suffix that gives me a slug I didn't choose.
- As a developer debugging a 404 in production, I want to be able to read the URL and know which recipe's image it points at without having to look up a UUID.

## Design & UX

Backend / API only. UI surface lives in the [sibling PRD](../../../personal-website/docs/prds/editable-recipe-slugs.md).

### API contract changes

#### `POST /recipes/drafts`

```diff
- request: (no body)
+ request: { slug?: string }
  response: { id: string, slug: string }
```

- If `slug` is omitted, the server returns `slug = \`draft-${id.slice(0, 8)}\`` (e.g. `draft-8f005719`). The existing implementation at `lambda/recipe-handler.ts` uses the full UUID — the slice change is part of this PRD. The frontend overrides on first title input; the placeholder rarely reaches a saved state but is a valid slug if it does.
- If `slug` is supplied, it is validated (see "Slug validation" below) and uniqueness-checked. On collision, return `409 Conflict` with body `{ error: 'slug_taken', message: 'Slug "beans-on-toast" is already in use.' }`.

#### `PATCH /recipes/{id}`

```diff
  request: { title?, slug?, intro?, ingredients?, steps?, coverImage?, tags?, ... }
  response: 200 with updated recipe, or 409
```

- New behaviour: if `slug` is included in the patch body **and** the recipe's `imageStatus` map contains any entry, return `409 Conflict` with body `{ error: 'slug_locked', message: 'Cannot change slug after images have been uploaded. Delete uploaded images first.' }`.
- If `slug` is included **and** the new value is taken by another recipe, return `409 Conflict` with body `{ error: 'slug_taken', message: 'Slug "beans-on-toast" is already in use.' }`.
- Slug validation (regex below) applies; invalid slugs return `400 Bad Request`.
- Patches that don't include `slug` are unaffected.

#### `POST /recipes/images/upload-url`

```diff
  request: { recipeId: string, imageType: 'cover' | 'step', stepOrder?: number }
- response: { uploadUrl: string, key: string }
+ response: { uploadUrl: string }
```

- Body is unchanged — frontend still sends `recipeId`. Backend looks up the recipe by id (one extra `GetItem` per upload — negligible) to read its slug, then constructs the upload key as `uploads/recipes/<slug>/<imageType>` (or `uploads/recipes/<slug>/step-<order>`).
- Response **drops the `key` field**. The frontend derives the public image URL from `(recipe.slug, imageType[, stepOrder])` — see sibling PRD.

#### `DELETE /recipes/{id}` (existing — internals change)

S3 list-and-delete prefix flips from `recipes/${id}/` to `recipes/${slug}/`. Same `ListObjectsV2Command` + `DeleteObjectsCommand` flow; only the prefix changes.

### Recipe data model

| Field | Before | After |
|---|---|---|
| `coverImage.key` | `string` (`recipes/<id>/cover`) | **dropped** |
| `coverImage.alt` | `string` | unchanged |
| `coverImage.processedAt` | `number?` (composed by handler) | unchanged — composed from a derived key |
| `step.image.key` | `string` (`recipes/<id>/step-N`) | **dropped** |
| `step.image.alt` | `string` | unchanged |
| `step.image.processedAt` | `number?` (composed by handler) | unchanged — composed from a derived key |
| `imageStatus` map | server-only, keyed by processed-key | unchanged shape; key now `recipes/<slug>/<type>` |

### Slug validation rules

```
^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$
```

- Lowercase ASCII letters, digits, and hyphens.
- Must not start or end with a hyphen.
- 1–100 characters.
- Reserved words rejected: `new`, `admin`, `drafts`, `images` (collision risk with route patterns).

The existing `generateSlug(title)` helper (`lambda/recipe-handler.ts`) is preserved for the auto-fill default produced server-side when the frontend doesn't send a slug; its output is then validated against the regex above.

### Slug-lock enforcement (server-side)

In the PATCH handler, the slug-change branch:

```ts
// pseudo
if (patch.slug !== undefined && patch.slug !== existing.slug) {
  if (Object.keys(existing.imageStatus ?? {}).length > 0) {
    return json(409, { error: 'slug_locked', message: '...' })
  }
  if (!isValidSlug(patch.slug)) return json(400, { error: 'invalid_slug' })
  if (await slugExists(patch.slug, existing.id)) {
    return json(409, { error: 'slug_taken', message: '...' })
  }
}
```

**TOCTOU race protection.** Two concurrent PATCHes could both pass the in-memory `imageStatus`-empty check and race to set different slugs. The actual `UpdateCommand` writes a `ConditionExpression`:

```ts
ConditionExpression:
  'attribute_exists(id) AND ' +
  '(attribute_not_exists(imageStatus) OR size(imageStatus) = :zero) AND ' +
  'slug = :expectedOldSlug',
ExpressionAttributeValues: {
  ':zero': 0,
  ':expectedOldSlug': existing.slug,
  // ...
}
```

A `ConditionalCheckFailedException` is mapped to `409 slug_locked` (if `imageStatus` no longer empty) or to a generic `409 conflict` (if `slug` changed underneath). Frontend mirrors the rule for UX (see sibling PRD); server is the source of truth.

### `imageStatus` → `processedAt` composition

`composeImageProcessedAt` (`lambda/recipe-handler.ts:96`) currently looks up `imageStatus[coverImage.key]` and `imageStatus[step.image.key]`. After this PRD it derives the key from the recipe:

```ts
// before
const coverProcessedAt = coverImage?.key ? imageStatus[coverImage.key] : undefined

// after
const coverDerivedKey = `recipes/${recipe.slug}/cover`
const coverProcessedAt = imageStatus[coverDerivedKey]
```

Step images: derived key `recipes/${recipe.slug}/step-${step.order}`.

The `coverImage.key` field is no longer read from the item; the function works off `recipe.slug` (already in the item). Helper signature changes to take the full recipe, not just the cover image / step.

### Image deletion clears `imageStatus`

The existing PATCH flow that handles "swap cover image" and "remove step image" (`recipe-handler.ts` — see step-image swap test fixtures) updates `imageStatus` via `REMOVE imageStatus.#<oldKey>`. This pattern continues — but the keys are now derived. After this PRD, deleting an image:

1. Removes the matching `imageStatus[<derivedKey>]` entry.
2. Issues an S3 `DeleteObjects` for the variant files at `recipes/<slug>/<imageType>-{thumb,medium,full}.webp`.

Once the last `imageStatus` entry is removed, the slug-lock condition becomes false and the slug is editable again. This is the **escape hatch** referenced in non-goals.

## Technical Considerations

### Stack

- AWS CDK 2 + TypeScript Lambdas (existing). No new constructs.
- DynamoDB Recipes table gains a third GSI; partition key `slug`, projection `KEYS_ONLY` (only need `id` to satisfy the resizer lookup).
- IAM: image-resizer Lambda gains `dynamodb:Query` on the new GSI ARN.

### New `slug-index` GSI

```ts
table.addGlobalSecondaryIndex({
  indexName: 'slug-index',
  partitionKey: { name: 'slug', type: AttributeType.STRING },
  projectionType: ProjectionType.KEYS_ONLY,
})
```

Replaces the `Scan`-based `findUniqueSlug` in `recipe-handler.ts`. New helper:

```ts
async function slugExists(slug: string, excludeId?: string): Promise<boolean> {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'slug-index',
    KeyConditionExpression: 'slug = :slug',
    ExpressionAttributeValues: { ':slug': slug },
  }))
  if (!result.Items || result.Items.length === 0) return false
  if (excludeId) return result.Items.some((i) => (i as { id: string }).id !== excludeId)
  return true
}
```

`excludeId` lets PATCH check uniqueness while ignoring the recipe being patched (so an unchanged-slug PATCH doesn't false-positive).

### Resizer changes

`image-resizer.ts` `parseRecipeId` becomes `parseRecipeSlug`:

```ts
function parseRecipeSlug(uploadKey: string): string | undefined {
  if (!uploadKey.startsWith(UPLOAD_PREFIX)) return undefined  // 'uploads/recipes/'
  const segments = uploadKey.slice(UPLOAD_PREFIX.length).split('/')
  if (segments.length !== 2) return undefined
  const slug = segments[0]
  return slug || undefined
}
```

The handler then queries `slug-index` to recover the recipe `id`, which it uses for the `UpdateCommand.Key` (DynamoDB primary key is still `id`):

```ts
const slug = parseRecipeSlug(key)
if (!slug) { logSkip('unrecognised_key_shape'); continue }

const lookup = await docClient.send(new QueryCommand({
  TableName: tableName,
  IndexName: 'slug-index',
  KeyConditionExpression: 'slug = :slug',
  ExpressionAttributeValues: { ':slug': slug },
}))
const recipeId = (lookup.Items?.[0] as { id?: string } | undefined)?.id
if (!recipeId) { logSkip('recipe_not_found'); continue }

await docClient.send(new UpdateCommand({
  TableName: tableName,
  Key: { id: recipeId },
  UpdateExpression: 'SET imageStatus.#k = :ts',
  ExpressionAttributeNames: { '#k': processedKey },
  // ...
}))
```

`ConditionalCheckFailedException` handling stays — covers the "recipe deleted while image was processing" race.

### Recipe-image-handler changes

```ts
async function handleUploadUrl(event) {
  // ... existing auth/parse ...
  const recipe = await getRecipeById(recipeId)
  if (!recipe) return json(404, { error: 'Recipe not found' })

  const slug = recipe.slug as string
  const uploadKey = imageType === 'cover'
    ? `${UPLOAD_PREFIX}${slug}/cover`
    : `${UPLOAD_PREFIX}${slug}/step-${stepOrder}`

  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: uploadKey }), { expiresIn: 900 })

  return json(200, { uploadUrl })  // no `key`
}
```

**New IAM + env requirements.** The current `recipe-image-handler` has no DynamoDB integration. This PRD adds:

- `TABLE_NAME` environment variable on the Lambda (existing pattern at `lib/recipe-stack.ts` `recipeHandler`).
- `dynamodb:GetItem` IAM grant on the Recipes table ARN. Add via `table.grantReadData(recipeImageHandler)` — the read includes `BatchGetItem`/`Query`/`Scan` but is acceptable for this Lambda; alternatively scope tighter via an explicit `addToRolePolicy` with `actions: ['dynamodb:GetItem']` and `resources: [table.tableArn]`. Pick the explicit form to match the existing narrow-scoping pattern at `lib/recipe-stack.ts:155`.

One extra `GetItem` per upload-URL request. Acceptable cost (~5–10 ms inside Lambda).

### Recipe-handler changes

- `createDraft`: accept optional `slug` in body. If supplied, validate + uniqueness-check, return 400/409 as appropriate. If absent, default to `draft-${id.slice(0, 8)}`.
- `handlePatchRecipe`: add the slug-lock + uniqueness branch described above.
- `handleDeleteRecipe`: list/delete by `recipes/${slug}/` prefix.
- `composeImageProcessedAt`: derive image key from `(recipe.slug, imageType[, stepOrder])`. Drop reads of `coverImage.key` / `step.image.key`.

### Cross-stack contract change

The frontend (sibling PRD) drops reads of `coverImage.key`. Both PRDs deploy in lockstep — same pattern as Phase 1. No backwards-compat shim.

### TDD approach

Per `CLAUDE.md` and Phase 1 precedent:

- Stack synthesis tests in `test/recipe-stack.test.ts` assert the new GSI exists with the expected partition key + projection. Use `Match.objectLike` against the table's `GlobalSecondaryIndexes` array entry — see existing patterns in the same file.
- Lambda unit tests in `test/lambda/` use `aws-sdk-client-mock` for DynamoDB / S3 mocking, matching the existing pattern across `recipe-handler.test.ts`, `image-resizer.test.ts`, and `recipe-image-handler.test.ts`:
  - `recipe-handler.test.ts` — new tests for slug-validation, slug-collision (409), slug-lock-on-patch (409 with `ConditionalCheckFailedException` mapping), draft-default-slug shape (`/^draft-[a-z0-9]{8}$/`), GSI-backed uniqueness check via `QueryCommand` mock.
  - `image-resizer.test.ts` — replace `parseRecipeId` tests with `parseRecipeSlug`; add tests for the slug → id GSI lookup; add a `recipe_not_found` skip test.
  - `recipe-image-handler.test.ts` — assert response shape `{ uploadUrl }` (no `key`); upload key is built from a `GetItem`-fetched slug; 404 if the recipe doesn't exist.
  - `image-variants.test.ts` — unchanged (the prefix constants stay the same).

### Performance

- Each recipe write incurs an additional GSI write unit (`KEYS_ONLY` projection — the cheapest option) under `PAY_PER_REQUEST`. No upfront capacity provisioning.
- One extra `GetItem` in the upload-URL endpoint and one extra `Query` on the GSI in the resizer. Both are sub-10 ms inside Lambda; total upload-URL latency unchanged within the noise floor.
- `findUniqueSlug`'s old `Scan` is removed. Net win — `Scan` is O(table size); `Query` on the new GSI is O(matches).
- No backfill needed: production has no recipes; the GSI populates lazily on write. (Pre-existing items in a non-prod environment without a `slug` attribute won't appear in the index — they would need a one-shot UpdateItem to backfill.)

### Security

- No new principals or grants beyond `dynamodb:Query` for the resizer on the new GSI ARN.
- Slug validation regex prevents path traversal (no `/`, no `..`, no `%`).
- Reserved-word rejection prevents collision with route patterns.

## Acceptance Criteria

ACs are split into automated (Jest + `aws-cdk-lib/assertions` + Lambda unit tests; testable pre-deploy via `pnpm test`) and manual (post-deploy verification, runbook). TDD applies only to automated ACs.

### Automated — `slug-index` GSI on RecipeStack

- [ ] `test/recipe-stack.test.ts` asserts the Recipes table has a GSI with `IndexName: 'slug-index'`.
- [ ] The GSI has `KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }]`.
- [ ] The GSI has `Projection: { ProjectionType: 'KEYS_ONLY' }`.
- [ ] The table's `AttributeDefinitions` includes `{ AttributeName: 'slug', AttributeType: 'S' }`.
- [ ] The image-resizer Lambda's IAM policy includes a statement matching:
  ```ts
  Match.objectLike({
    Action: 'dynamodb:Query',
    Effect: 'Allow',
    Resource: Match.objectLike({
      'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('/index/slug-index$')])])
    }),
  })
  ```
- [ ] The recipe-image-handler Lambda's IAM policy includes a statement granting `dynamodb:GetItem` (or `BatchGetItem`/equivalent) on the Recipes table ARN (table-level, not GSI).
- [ ] The recipe-image-handler Lambda has `TABLE_NAME` in its `Environment.Variables`.

### Automated — `lambda/recipe-handler.ts` slug enforcement

- [ ] `POST /recipes/drafts` with no body returns `slug` matching `/^draft-[a-z0-9]{8}$/` (server slices `id.slice(0, 8)`).
- [ ] `POST /recipes/drafts` with `{ slug: 'beans-on-toast' }` (unused) returns the same slug.
- [ ] `POST /recipes/drafts` with `{ slug: 'BEANS' }` returns 400 (validation: lowercase only).
- [ ] `POST /recipes/drafts` with `{ slug: '  beans  ' }` returns 400 (whitespace not permitted by regex).
- [ ] `POST /recipes/drafts` with `{ slug: 'admin' }` returns 400 (reserved word — collides with `GET /recipes/admin`).
- [ ] `POST /recipes/drafts` with `{ slug: 'drafts' }` returns 400 (reserved word — collides with `POST /recipes/drafts`).
- [ ] `POST /recipes/drafts` with `{ slug: 'beans-on-toast' }` while another recipe has that slug returns 409 with body `{ error: 'slug_taken', message: ... }`.
- [ ] `PATCH /recipes/{id}` with `{ slug: 'new-slug' }` on a recipe with empty `imageStatus` map and unique slug returns 200 and the updated recipe.
- [ ] `PATCH /recipes/{id}` with `{ slug: 'INVALID' }` returns 400 (PATCH validation symmetry with POST).
- [ ] `PATCH /recipes/{id}` with `{ slug: 'new-slug' }` on a recipe with at least one `imageStatus` entry returns 409 with `{ error: 'slug_locked', ... }`.
- [ ] `PATCH /recipes/{id}` `UpdateCommand` includes a `ConditionExpression` that gates on `size(imageStatus) = 0` AND `slug = :expectedOldSlug` (TOCTOU race protection).
- [ ] When the `UpdateCommand` throws `ConditionalCheckFailedException`, the handler maps to `409 slug_locked` (re-reads to confirm) or `409 conflict` (slug changed underneath).
- [ ] `PATCH /recipes/{id}` with `{ slug: existingOtherSlug }` returns 409 with `{ error: 'slug_taken', ... }`.
- [ ] `PATCH /recipes/{id}` with `{ slug: existing.slug }` (same value) returns 200 (no-op, not a collision against itself).
- [ ] `composeImageProcessedAt(recipe)` accepts a recipe object and derives the cover key from `recipes/${recipe.slug}/cover`; new signature replaces the old per-image-passing form.
- [ ] `composeImageProcessedAt` no longer reads `coverImage.key` or `step.image.key`.
- [ ] A regression test asserts that a recipe with `imageStatus = { 'recipes/<slug>/cover': <ts> }` and no stored `coverImage.key` produces a `coverImage.processedAt` value on the response.
- [ ] DELETE handler issues `ListObjectsV2Command` with `Prefix: \`recipes/${recipe.slug}/\`` — asserted via `s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix`, not via `expect.stringContaining`.
- [ ] PATCH handler with `coverImage: undefined` (cover removal) deletes S3 variants under `recipes/${slug}/cover-*` and removes the matching `imageStatus` entry, restoring the slug-lock-unlock condition.

### Automated — `lambda/recipe-image-handler.ts`

- [ ] Response body has shape `{ uploadUrl: string }` and **does not** include a `key` field.
- [ ] The presigned `PutObjectCommand` is invoked with `Key: \`uploads/recipes/${slug}/${imageType}\`` for cover, and `Key: \`uploads/recipes/${slug}/step-${order}\`` for steps. Slug is read from a `GetItem` on the recipes table, not from the request body.
- [ ] If the recipe doesn't exist, returns 404.

### Automated — `lambda/image-resizer.ts`

- [ ] `parseRecipeSlug('uploads/recipes/beans-on-toast/cover')` returns `'beans-on-toast'`.
- [ ] `parseRecipeSlug('uploads/something-else/...')` returns `undefined`.
- [ ] Resizer **flow order** (asserted via mock-call ordering): write variants → delete source → query GSI → update DDB. The variant PUTs and source delete fire regardless of whether the GSI lookup succeeds.
- [ ] Resizer queries `slug-index` GSI to resolve slug → id; the resulting `id` is used in the `UpdateCommand.Key`.
- [ ] If no recipe has the slug, the resizer logs `recipe_not_found` and skips the DDB write — variant PUTs and source delete still fire.
- [ ] Documented edge case (no test required): if a slug is changed between upload-URL request and resizer execution, variants land under the old slug and stay orphaned. Frontend mitigates via pessimistic upload lock (sibling PRD).

### Automated — fixture sweep

- [ ] All Lambda test fixtures drop the `coverImage.key` and `step.image.key` fields. Fixtures use realistic slug-based `imageStatus` keys (e.g. `'recipes/spaghetti-bolognese/cover': <ts>`).
- [ ] `grep -rn "coverImage.key\|coverImage\.key" lambda/ test/` returns zero matches in production code (test scaffolding that explicitly tests removal of the field is allowed).

### Manual — Post-deploy

- [ ] After this PR ships, uploading a fresh recipe in the admin produces variant files at `recipes/<slug>/cover-{thumb,medium,full}.webp`. Verified by `aws s3 ls s3://akli-recipe-images-<account>-eu-west-2/recipes/<slug>/`.
- [ ] `curl -I https://images.akli.dev/recipes/<slug>/cover-medium.webp` returns `HTTP/2 200`.
- [ ] `aws dynamodb get-item --table recipes --key '{"id":{"S":"<id>"}}' --query Item.imageStatus` returns a map keyed by `recipes/<slug>/<type>`.
- [ ] No items in the `recipes` table contain a `coverImage.key` field after the cutover (verified via `aws dynamodb scan --projection-expression coverImage`).

### Process

- [ ] Tests are written before implementation (TDD) for all automated ACs above.
- [ ] `pnpm test` passes locally.
- [ ] `pnpm lint` passes locally.
- [ ] `cdk synth` produces a clean template (only the intended additions).


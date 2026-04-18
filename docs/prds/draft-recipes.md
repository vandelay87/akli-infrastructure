# PRD: Draft Recipes — Infrastructure

> **Sibling PRD:** [`personal-website/docs/prds/draft-recipes.md`](../../../personal-website/docs/prds/draft-recipes.md) — covers the React editor, autosave hook, admin list, and `StatusBadge` component that consume the endpoints defined here.

## Overview
Recipes become a two-state resource — `draft` and `published` — backed by DynamoDB with native TTL on drafts and a Cognito-gated CRUD surface. This PRD covers the CDK / Lambda / IAM side: schema changes, route additions, image-swap cleanup on S3, admin authorisation, and the backfill migration.

## Problem Statement
The current recipe API has a direct `POST /recipes` create path and no notion of drafts. This means the admin editor must save a fully-formed recipe before images can be uploaded, because the image handler requires `recipeId` to generate a presigned URL — and `recipeId` only exists after save. There's also no server-side protection against abandoned drafts, and swapping a cover or step image leaves orphaned `*-thumb.webp`, `*-medium.webp`, `*-full.webp` variants in S3. A compliance-adjacent issue: the `isAdmin` helper currently decodes the JWT without verifying its signature (tracked separately as a non-goal here — every new route in this PRD must be attached to the existing Cognito authoriser at the API Gateway level so the helper's gap can't be exploited).

## Goals
- Provide a create-as-draft → edit → publish API lifecycle so the editor can generate a `recipeId` before any image upload.
- Enforce `published`-only output on the public `GET /recipes` and single-item `GET /recipes/{id}` paths.
- Clean up orphaned S3 image variants when a cover or step image key changes on any recipe.
- Automatically expire abandoned drafts via DynamoDB TTL (~30 days, best-effort within 48h per AWS).
- Attach every admin route to the existing Cognito JWT authoriser, verified by a CDK template test.

## Non-Goals
- Fixing the pre-existing unsigned-JWT check in the `isAdmin` helper. Tracked as a follow-up; the authoriser is the real gate.
- Removing the unused `authorId-createdAt-index` GSI. Tracked separately.
- WordPress-style post-publish revisions.
- Multi-author drafts (no `authorId` model).
- Scheduled publishing (`publishAt`).
- Soft-delete / trash bin.

## User Stories
- As the admin app, I need a `POST /recipes/drafts` endpoint so I can obtain a `recipeId` before uploading images.
- As the admin app, I need a way to PATCH partial updates to a recipe (at any status) so autosave can persist edits every few seconds.
- As the admin app, I need to publish, unpublish, and delete recipes via a consistent authenticated API.
- As the public site, I need `GET /recipes` to exclude drafts without any client-side filtering.
- As the storage owner, I need old image variants deleted when a recipe's cover or step image changes, so the bucket doesn't accumulate orphans.

## Design & UX
This PRD is back-end only; UX lives in the sibling frontend PRD. What matters here is the API contract it must honour.

**Shared API contract (repeated here so the infra PRD is self-contained):**

- `POST /recipes/drafts` → admin JWT. Body optional. Response: `{ id: string, slug: string }`. Creates an item with `status: 'draft'`, `ttl = now + 30d`, empty title/intro/ingredients/steps. Slug defaults to `draft-<uuid>` when no title is provided.
- `GET /recipes/admin` → admin JWT. Response: `{ recipes: Recipe[] }` containing both statuses. Queries `status-createdAt-index` twice (once per status) and merges, filtering out items where `ttl <= now`.
- `GET /recipes` → public, unauthenticated. Response: `{ recipes: Recipe[] }` containing only `status === 'published'`. Served by a single GSI query on `status = 'published'`.
- `GET /recipes/{id}` → public, unauthenticated. Returns 404 when `status !== 'published'`.
- `PATCH /recipes/{id}` → admin JWT. Accepts partial recipe fields. Works for both statuses. Bumps `updatedAt`. On drafts, refreshes `ttl`. On published, does not set `ttl`. Detects cover/step image-key changes and deletes old S3 variants (see below).
- `PATCH /recipes/{id}/publish` → admin JWT, admin-only (owner-or-admin branch dropped). Runs server-side validation. On success, flips `status: 'published'` and removes `ttl` via `REMOVE` (not `SET ttl = null` — DynamoDB TTL ignores null). On an already-published recipe: re-runs validation, returns 200 no-op on success or 400 on validation failure.
- `PATCH /recipes/{id}/unpublish` → admin JWT, admin-only. Sets `status: 'draft'`, `ttl = now + 30d`. No-op (200) on an already-draft recipe.
- `DELETE /recipes/{id}` → admin JWT. Unchanged from today. Already cleans up `processed/recipes/<id>/`.
- The old `POST /recipes` direct-create route is **removed** from both CDK and handler. All creation goes through the draft-then-publish flow.

States in the API:
- Empty request body on `POST /recipes/drafts` → 201 with the minimal draft.
- Validation failure on `PATCH /recipes/{id}/publish` → 400 with field-level errors.
- 401 from the authoriser when the JWT is missing or invalid.
- 404 on a non-existent id for PATCH, DELETE, or the single-item public GET when the item is a draft.

## Technical Considerations

**DynamoDB `recipes` table** (actual table name is `recipes`, not `akli-recipes`)
- New attribute `status: 'draft' | 'published'` — required on every item.
- New attribute `ttl: number` (unix seconds) — set on drafts (`updatedAt + 30d`), cleared on publish via UpdateExpression `REMOVE ttl`. Never stored as `null`.
- Existing `status-createdAt-index` GSI (PK `status`, SK `createdAt`) is reused for both public and admin list queries — no table scan.
- Existing `authorId-createdAt-index` GSI stays in place, unused (non-goal).
- Native DynamoDB TTL enabled via `timeToLiveAttribute: 'ttl'` on the L2 `dynamodb.Table` construct in `lib/recipe-stack.ts`. TTL is best-effort — AWS deletes expired items within 48h of expiry. Admin list queries filter `ttl <= now` client-side to hide expired-but-not-yet-deleted items.

**Backfill migration**
- Script at `akli-infrastructure/scripts/backfill-recipe-status.ts`.
- Sets `status: 'published'` on every existing item missing the attribute. Does not set `ttl`.
- Hard requirements:
  - **Account guard** — exits non-zero if `AWS_ACCOUNT_ID` env var is unset or doesn't match `sts:GetCallerIdentity`.
  - **Dry-run** — `--dry-run` flag logs affected ids without writing.
  - **Idempotency** — each `UpdateItem` carries `ConditionExpression: attribute_not_exists(#s)`, so re-runs are safe no-ops on already-migrated items.
  - **Run log** — emits affected ids and a summary count; collects failures rather than halting.
- Run order: deploy (TTL enabled) → backfill → start using new endpoints from the frontend.

**Recipe handler (`lambda/recipe-handler.ts`)**

Route reconciliation:
- Existing `PATCH /recipes/{id}/publish` and `PATCH /recipes/{id}/unpublish` are kept. The `isOwnerOrAdmin` branch is removed from these two routes — publish/unpublish is admin-only.
- Existing `PATCH /recipes/{id}` is extended to work on both draft and published items, and picks up the image-swap cleanup logic described below.
- The old `POST /recipes` direct-create route is removed from both the CDK definition and the handler dispatch.
- New endpoints: `POST /recipes/drafts`, `GET /recipes/admin`.

Image-swap cleanup (triggered from `PATCH /recipes/{id}`):
- Use `ReturnValues: 'ALL_OLD'` on the `UpdateCommand` to get the atomic prior snapshot. **Do not** pre-read with a separate `GetItem` (races against concurrent autosave).
- Diff rules:
  - Cover: compare `old.coverImage?.key` vs `new.coverImage?.key`. If different, schedule the three old variants (`-thumb.webp`, `-medium.webp`, `-full.webp`) for deletion.
  - Steps: compare by the **set** of `step.image?.key` values on old vs new (reorder-safe). Any key present only on the old side → variants scheduled for deletion.
- Delete the union of scheduled keys with a single `DeleteObjectsCommand`. Partial failures (`Errors[]` in the response body — not thrown) are logged to CloudWatch; the PATCH still returns 200, and the DDB write is not rolled back.
- If the `UpdateCommand` itself fails, no S3 delete is attempted (no prior snapshot available).

Idempotency on state transitions:
- Publish on an already-published recipe → re-run validation; return 200 no-op on success or 400 on validation failure.
- Unpublish on an already-draft recipe → 200 no-op.

Empty-draft slug collision:
- `POST /recipes/drafts` with no body uses `slug = 'draft-' + uuid` to avoid slug collisions across concurrent empty drafts. When the user later adds a title, the slug is re-derived on the first `PATCH` that includes a non-empty title.

Public GET leakage:
- `GET /recipes/{id}` (public, unauthenticated) must return 404 when `status !== 'published'`. The existing handler path needs a status check before returning the item. Tested explicitly.

**Auth & IAM**
- Every admin route (`POST /recipes/drafts`, `GET /recipes/admin`, `PATCH /recipes/{id}`, `PATCH /recipes/{id}/publish`, `PATCH /recipes/{id}/unpublish`, `DELETE /recipes/{id}`) is attached to the existing Cognito JWT authoriser in CDK. Asserted by a template test.
- The handler's `isAdmin` helper runs on top of the authoriser as defence-in-depth. Publish/unpublish routes drop `isOwnerOrAdmin` and use `isAdmin` only.
- `s3:DeleteObject` on the image bucket is already granted to the recipe-handler role (used by `handleDeleteRecipe`). Verified by a regression assertion test; no new IAM statements added.

**Testing approach (TDD for handlers and CDK)**
- Jest + `aws-sdk-client-mock` for Lambda handler unit tests. Pattern already established in `test/lambda/recipe-handler.test.ts`.
- `aws-cdk-lib/assertions` for template tests in `test/recipe-stack.test.ts`.
- Backfill script tests run against moto or a local DynamoDB container.

## Acceptance Criteria

CDK (`lib/recipe-stack.ts` + template tests):
- [ ] DynamoDB TTL is enabled on the `recipes` table with `AttributeName: 'ttl'`, asserted via `Template.fromStack` matching `Match.objectLike({ TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } })`.
- [ ] `ttl` is not declared in the table's `AttributeDefinitions` (negative assertion).
- [ ] Every admin route (`POST /recipes/drafts`, `GET /recipes/admin`, `PATCH /recipes/{id}`, `PATCH /recipes/{id}/publish`, `PATCH /recipes/{id}/unpublish`, `DELETE /recipes/{id}`) has `AuthorizationType: JWT` on its `AWS::ApiGatewayV2::Route` resource.
- [ ] The recipe-handler role policy grants `s3:DeleteObject` on the image bucket ARN (regression test).
- [ ] The old `POST /recipes` route is removed from both CDK and the handler dispatch.

Backfill script (`scripts/backfill-recipe-status.ts`):
- [ ] Exits non-zero when `AWS_ACCOUNT_ID` env var is unset or doesn't match `sts:GetCallerIdentity`.
- [ ] `--dry-run` flag logs affected items without writing.
- [ ] Uses `ConditionExpression: attribute_not_exists(#s)` on every update so re-runs are no-ops on already-migrated items.
- [ ] Prints affected ids and a summary count; failures are collected and surfaced at the end, not fatal mid-run.

Handler — new endpoints:
- [ ] `POST /recipes/drafts` requires admin JWT, returns `{ id, slug }`, writes `status: 'draft'` and `ttl = now + 30d`. Defaults `slug` to `draft-<uuid>` when the body has no title.
- [ ] `GET /recipes/admin` requires admin JWT; queries `status-createdAt-index` once per status and merges; filters out items where `ttl <= now`.

Handler — modified endpoints:
- [ ] `PATCH /recipes/{id}` accepts partial fields on both statuses. On a draft, bumps `updatedAt` and refreshes `ttl`. On a published, bumps `updatedAt` and does NOT set `ttl`.
- [ ] `PATCH /recipes/{id}` uses `ReturnValues: 'ALL_OLD'` (no pre-read `GetItem`) to compute image-key diffs atomically.
- [ ] Cover-image-key change deletes the three old variants from S3 after the DDB write succeeds.
- [ ] Step-image changes are diffed by the set of `step.image.key` values; reorder is not treated as a swap; keys present only on the old side have their variants deleted.
- [ ] `DeleteObjectsCommand` partial failures are logged to CloudWatch and do not fail the PATCH or roll back the DDB write.
- [ ] `PATCH /recipes/{id}/publish` runs server-side validation (title, intro, coverImage.key, coverImage.alt, ≥1 ingredient, ≥1 step with non-empty text) and returns 400 with field-level errors on failure; on success flips `status` to `'published'` and removes `ttl` via UpdateExpression `REMOVE`.
- [ ] `PATCH /recipes/{id}/unpublish` sets `status: 'draft'` and `ttl = now + 30d`.
- [ ] Publish on an already-published recipe returns 200 no-op when validation passes, 400 when it fails.
- [ ] Unpublish on an already-draft recipe returns 200 no-op.
- [ ] Publish/unpublish drop the `isOwnerOrAdmin` branch — admin-only.
- [ ] `GET /recipes` (public) returns only `status = 'published'` via the GSI; no code path can leak a draft.
- [ ] `GET /recipes/{id}` (public, unauthenticated) returns 404 when the item's `status !== 'published'`.

Handler call-ordering:
- [ ] Tests assert via `ddbMock.calls()` vs `s3Mock.calls()` comparison that in the image-swap flow, `UpdateCommand` is invoked before `DeleteObjectsCommand`.

Cross-cutting:
- [ ] All existing tests pass (`pnpm test` green).
- [ ] Lint passes with zero errors.

## Open Questions
- None. Follow-up items (unsigned-JWT helper fix, unused `authorId-createdAt-index` GSI removal) are explicit non-goals.

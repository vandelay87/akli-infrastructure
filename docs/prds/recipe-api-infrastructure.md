# PRD: Recipe API & Infrastructure

## Overview

Build the backend infrastructure for a recipe management system on akli.dev. This includes a DynamoDB table for recipe data, S3 bucket for recipe images with automatic resizing, Lambda CRUD handlers, and API Gateway routes. Public users can read published recipes; authenticated users (admin/contributor) can create, edit, and manage their own recipes. This is PRD 2 of 4 in the recipes epic, building on the auth layer from PRD 1.

## Problem Statement

The site owner currently relies on external services (bookmarks, notes apps, third-party recipe sites) to save favourite recipes. There is no self-owned, structured way to store, organise, and share recipes. The auth infrastructure (PRD 1) provides the access control layer, but there is no data store, API, or image handling for recipe content.

## Goals

- Provide a scalable, serverless recipe data store with DynamoDB that supports the full recipe data model (title, images, intro, ingredients, steps, tags, metadata).
- Expose a RESTful API for recipe CRUD operations with appropriate auth protection.
- Handle recipe image uploads via S3 presigned URLs with automatic resizing (thumbnail, medium, full).
- Support draft/published workflow so recipes can be saved privately before publishing.
- Enable tag-based organisation with a lightweight recipe index endpoint for client-side filtering and search.
- Enforce ownership — contributors can only manage their own recipes, admins can manage all.

## Non-Goals

- **Full-text search infrastructure** (OpenSearch, Elasticsearch) — client-side filtering on a lightweight recipe index is sufficient at the expected scale (<200 recipes). Revisit if the collection grows significantly.
- **Application-level versioning/history** — DynamoDB Point-in-Time Recovery (PITR) provides disaster recovery. Application-level version tracking is deferred.
- **Recipe comments or ratings** — not in scope for this iteration.
- **Recipe sharing/embedding** — recipes are viewable on akli.dev only.
- **Nutritional information** — not in scope.
- **Frontend UI** — covered by PRD 3 (Recipe Frontend) and PRD 4 (Admin Interface).

## User Stories

- As the site owner, I want to create a recipe with a title, cover image, intro text, ingredients, steps (with optional images), prep time, cook time, servings, and tags so that I can document my favourite recipes.
- As the site owner, I want to save a recipe as a draft so that I can work on it before publishing.
- As the site owner, I want to publish a draft recipe so that it becomes visible to the public.
- As a contributor, I want to create and edit my own recipes so that I can share recipes I enjoy cooking.
- As a contributor, I must not be able to edit or delete recipes created by other users.
- As an admin, I want to edit or delete any recipe regardless of who created it.
- As a public visitor, I want to fetch all published recipes (with a lightweight index) so that I can browse, filter by tag, and search by keyword on the frontend.
- As a public visitor, I want to fetch a single published recipe with all its details so that I can follow the recipe.
- As an authenticated user, I want to upload recipe images and have them automatically resized so that pages load quickly.
- As the site owner, I want recipes organised by freeform tags so that I can categorise flexibly (e.g. "Italian", "Quick", "Vegetarian") and create new tags on the fly.

## Design & UX

This PRD is infrastructure-only — no UI components. API responses follow the same JSON conventions as the existing Pokedex API.

### API Endpoints

All endpoints are under the existing `api.akli.dev` CloudFront distribution.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/recipes` | Public | List all published recipes (lightweight index: id, title, slug, coverImage thumbnail, tags, prepTime, cookTime, servings, createdAt) |
| GET | `/recipes/{slug}` | Public | Get a single published recipe with full details |
| GET | `/me/recipes` | Bearer token | List all recipes (including drafts) for the authenticated user |
| POST | `/recipes` | Bearer token | Create a new recipe (defaults to draft status) |
| PUT | `/recipes/{id}` | Bearer token | Update a recipe (ownership check: contributor can only edit own, admin can edit any) |
| PATCH | `/recipes/{id}/publish` | Bearer token | Publish a draft recipe |
| PATCH | `/recipes/{id}/unpublish` | Bearer token | Unpublish a recipe (revert to draft) |
| DELETE | `/recipes/{id}` | Bearer token | Delete a recipe (ownership check) |
| POST | `/recipes/images/upload-url` | Bearer token | Generate a presigned S3 upload URL for a recipe image |
| GET | `/recipes/tags` | Public | List all tags with usage counts (for tag autocomplete and filtering) |

### Recipe Data Model

```json
{
  "id": "uuid-v4",
  "slug": "slow-cooked-lamb-ragu",
  "title": "Slow-Cooked Lamb Ragu",
  "intro": "A rich, hearty ragu that's perfect for...",
  "coverImage": {
    "key": "recipes/images/{id}/cover",
    "alt": "A bowl of lamb ragu with pappardelle"
  },
  "ingredients": [
    { "item": "lamb shoulder", "quantity": "1", "unit": "kg" },
    { "item": "tinned tomatoes", "quantity": "2", "unit": "cans" }
  ],
  "steps": [
    {
      "order": 1,
      "text": "Season the lamb and sear on all sides...",
      "image": {
        "key": "recipes/images/{id}/step-1",
        "alt": "Lamb searing in a cast iron pan"
      }
    }
  ],
  "tags": ["Italian", "Slow Cook", "Winter"],
  "prepTime": 20,
  "cookTime": 240,
  "servings": 4,
  "status": "published",
  "authorId": "cognito-sub-uuid",
  "authorName": "Akli",
  "createdAt": "2026-04-08T12:00:00Z",
  "updatedAt": "2026-04-08T14:30:00Z"
}
```

### Image URLs

Images are stored in S3 under the `processed/` prefix and served via the site CloudFront distribution. The image `key` in the data model references the processed path. Three variants are generated on upload:

- `{key}-thumb.webp` — 400px wide (listing cards, thumbnails)
- `{key}-medium.webp` — 800px wide (recipe page, step images)
- `{key}-full.webp` — 1200px wide (full-screen/hero)

Example: a cover image key of `processed/recipes/{id}/cover` produces URLs like `https://akli.dev/images/processed/recipes/{id}/cover-thumb.webp`

## Technical Considerations

### New Stack: `RecipeStack`

A new `RecipeStack` in `lib/recipe-stack.ts` deployed to `eu-west-2`, following the same conventions as `PokedexStack`. It receives the Cognito user pool ID and client ID from `AuthStack` as props for JWT authoriser configuration.

### DynamoDB Table Design

**Table: `recipes`**
- Partition key: `id` (String, UUID v4)
- Billing mode: PAY_PER_REQUEST (consistent with Pokedex table)
- Point-in-Time Recovery: **enabled** (safety net for accidental deletes/overwrites)
- Stream: not required for v1

**Global Secondary Indexes:**
- **`status-createdAt-index`** — Partition key: `status` (String), Sort key: `createdAt` (String). Used by the public listing endpoint to query only published recipes, sorted by newest first.
- **`authorId-createdAt-index`** — Partition key: `authorId` (String), Sort key: `createdAt` (String). Used by the "my recipes" endpoint to fetch a user's recipes efficiently.

**Tags:** Stored as a `StringSet` attribute on the recipe item. The `/recipes/tags` endpoint performs a Scan with a ProjectionExpression for `tags` only, then aggregates in the Lambda. At <200 recipes this is efficient. If scale grows, a separate tags table can be introduced later.

**Slug generation:** The Lambda generates a URL-friendly slug from the title on creation (e.g. "Slow-Cooked Lamb Ragu" → "slow-cooked-lamb-ragu"). Slugs must be unique — the Lambda checks for collisions and appends a numeric suffix if needed (e.g. "slow-cooked-lamb-ragu-2"). A GSI on `slug` would be ideal for uniqueness checks, but at this scale a Scan with a FilterExpression on `slug` is acceptable and avoids an extra GSI.

### S3 Image Bucket

**Bucket: `akli-recipe-images-{account-id}-eu-west-2`**
- Private bucket with Origin Access Control (OAC) — same pattern as the existing website S3 bucket.
- Lifecycle rule: delete incomplete multipart uploads after 1 day.
- CORS: Allow PUT from `https://akli.dev` (for presigned URL uploads from the browser).

**Presigned upload URL flow:**
1. Authenticated user calls `POST /recipes/images/upload-url` with `{ recipeId, imageType: "cover" | "step", stepOrder?: number }`.
2. Lambda generates the S3 key under the `uploads/` prefix (e.g. `uploads/recipes/{recipeId}/cover` or `uploads/recipes/{recipeId}/step-1`) and returns a presigned PUT URL (expires in 15 minutes, max 10MB).
3. Frontend uploads the image directly to S3 using the presigned URL.
4. S3 `PutObject` event (filtered to `uploads/` prefix) triggers the image resizer Lambda.
5. Resizer writes variants to the `processed/` prefix and deletes the original from `uploads/`.

### Image Resizer Lambda

- **`lambda/image-resizer.ts`** — Triggered by S3 `PutObject` events on the `akli-recipe-images` bucket.
- Uses the `sharp` npm library. **Note:** sharp requires platform-specific native binaries (`libvips`). The `NodejsFunction` bundling config must use `nodeModules: ['sharp']` to prevent esbuild from bundling it, and the Lambda must target `linux-arm64`. Sharp v0.33+ auto-downloads the correct platform binary during `npm install`.
- Generates three WebP variants from the uploaded original:
  - `{key}-thumb.webp` — 400px wide, 80% quality
  - `{key}-medium.webp` — 800px wide, 85% quality
  - `{key}-full.webp` — 1200px wide, 90% quality
- Deletes the original after successful resize (only the three variants are kept).
- Memory: 512MB (image processing needs more than the default 256MB).
- Timeout: 30 seconds.
- **Self-trigger prevention:** Original images are uploaded to the `uploads/` prefix (e.g. `uploads/recipes/{recipeId}/cover.jpg`). The S3 event notification is filtered to the `uploads/` prefix only. Resized images are written to the `processed/` prefix (e.g. `processed/recipes/{recipeId}/cover-thumb.webp`). This cleanly prevents re-triggering. The `key` stored in the recipe data model references the `processed/` prefix.

### Lambda Functions

All Lambda functions use Node.js 22, following existing conventions:

- **`lambda/recipe-handler.ts`** — Handles all recipe CRUD operations. Routes based on HTTP method + path. Performs ownership checks by comparing the JWT `sub` claim against the recipe's `authorId` (admin group bypasses this check).
- **`lambda/recipe-image-handler.ts`** — Handles presigned URL generation. Separated for cleaner S3 permissions.
- **`lambda/image-resizer.ts`** — S3-triggered image processing (not exposed via API Gateway).

### API Gateway Integration

- `RecipeStack` creates its own `HttpApi` with a JWT authoriser configured using the Cognito user pool details from `AuthStack`.
- Public routes (`GET /recipes`, `GET /recipes/{slug}`, `GET /recipes/tags`) use no authoriser.
- The `/me/recipes` route is on a separate path prefix from `/recipes/{slug}`, avoiding API Gateway v2 path parameter ambiguity.
- Protected routes use the JWT authoriser. Ownership and admin checks are performed in the Lambda handler, not at the API Gateway level.
- CORS: Allow origin `https://akli.dev`, methods GET/POST/PUT/PATCH/DELETE, headers `Content-Type` and `Authorization`.

### CloudFront/API Stack Changes

- The `ApiStack` receives the recipe API endpoint as a prop (`recipeApiUrl: string`).
- New CloudFront behaviour: `/recipes/*` routed to the recipe API origin.
- Cache policy for `/recipes/*`: **caching disabled**. A TTL-based cache would leak authenticated responses (e.g. `GET /me/recipes`) across users since CloudFront doesn't vary on `Authorization` by default. At this scale, hitting the Lambda on every request is acceptable and avoids cache-related auth bugs.
- Origin request policy: forward `Authorization` header (reuse the auth origin request policy from PRD 1).
- The recipe images S3 bucket must be added as an **additional origin** on the **site CloudFront distribution** (`AkliInfrastructureStack`), not the API distribution. A new behaviour `images/recipes/*` on the site distribution routes to the recipe images bucket with OAC. This is separate from the existing `images/*` behaviour which points to the site S3 bucket.
- Image cache policy: 30-day default TTL, 365-day max TTL (consistent with existing `images/*` behaviour).

### Stack Dependencies

```
AuthStack → RecipeStack → ApiStack
              ↓
         S3 Image Bucket → Image Resizer Lambda
```

`RecipeStack` receives from `AuthStack`: user pool ID, user pool client ID, user pool ARN.
`ApiStack` receives from `RecipeStack`: `httpApi.apiEndpoint`.

### TDD Approach

Follow test-driven development: write CDK assertion tests before implementing the stack. Use `aws-cdk-lib/assertions` for template matching. Write Lambda handler unit tests (mocking DynamoDB and S3 clients) before implementing the handlers.

## Acceptance Criteria

### DynamoDB
- [ ] A `recipes` DynamoDB table is created with `id` (String) as the partition key and PAY_PER_REQUEST billing.
- [ ] Point-in-Time Recovery (PITR) is enabled on the recipes table.
- [ ] GSI `status-createdAt-index` exists with partition key `status` and sort key `createdAt`.
- [ ] GSI `authorId-createdAt-index` exists with partition key `authorId` and sort key `createdAt`.

### Recipe CRUD API
- [ ] `GET /recipes` returns a list of published recipes with lightweight fields only (id, title, slug, coverImage thumbnail URL, tags, prepTime, cookTime, servings, createdAt). Does not return draft recipes.
- [ ] `GET /recipes/{slug}` returns the full recipe object for a published recipe. Returns 404 for drafts or non-existent slugs.
- [ ] `GET /me/recipes` returns all recipes (draft and published) for the authenticated user, sorted by newest first. Returns 401 without a valid token.
- [ ] `POST /recipes` creates a new recipe with `status: "draft"` and `authorId` set from the JWT `sub` claim. Returns 401 without a valid token.
- [ ] `POST /recipes` validates required fields: `title`, `coverImage` (key and alt), at least one ingredient, at least one step. Returns 400 with specific validation errors for missing/invalid fields.
- [ ] `PUT /recipes/{id}` updates a recipe. Contributors can only update recipes where `authorId` matches their JWT `sub`. Admins can update any recipe. Returns 403 for unauthorised access.
- [ ] `PATCH /recipes/{id}/publish` sets `status` to `"published"` and `updatedAt` to the current timestamp. Ownership rules apply.
- [ ] `PATCH /recipes/{id}/unpublish` sets `status` to `"draft"` and `updatedAt` to the current timestamp. Ownership rules apply.
- [ ] `DELETE /recipes/{id}` deletes the recipe item from DynamoDB and all associated S3 images. The Lambda uses `ListObjectsV2` to discover all image keys under the recipe's image prefix, then `DeleteObjects` to remove them in a single batch call. Ownership rules apply. Returns 403 for unauthorised access.
- [ ] Slugs are auto-generated from the title on creation, are URL-friendly (lowercase, hyphenated), are unique (numeric suffix appended on collision), and are **immutable** — updating the title does not change the slug (prevents broken links).
- [ ] Slug uniqueness is checked via a Scan with FilterExpression. **Known limitation:** concurrent creates with identical titles could produce duplicate slugs at this scale; accepted as a trade-off to avoid an additional GSI.
- [ ] `GET /recipes/tags` returns all unique tags across published recipes with usage counts, sorted alphabetically.
- [ ] Tags are stored as a DynamoDB StringSet and converted to JSON arrays in API responses.

### Image Handling
- [ ] An S3 bucket `akli-recipe-images-{account-id}-eu-west-2` is created with OAC, no public access, and a lifecycle rule to clean up incomplete multipart uploads.
- [ ] `POST /recipes/images/upload-url` returns a presigned S3 PUT URL that expires in 15 minutes, with a `Content-Length` condition enforcing a maximum upload size of 10MB. Requires a valid bearer token. Accepts `{ recipeId, imageType, stepOrder? }` and returns `{ uploadUrl, key }`.
- [ ] Uploading an image to the presigned URL triggers the image resizer Lambda.
- [ ] The resizer generates three WebP variants: `-thumb.webp` (400px), `-medium.webp` (800px), `-full.webp` (1200px).
- [ ] The original uploaded image is deleted after successful resize.
- [ ] The resizer Lambda does not trigger itself — S3 event notification is filtered to the `uploads/` prefix only; resized images are written to the `processed/` prefix.
- [ ] Recipe images are served via CloudFront at `akli.dev/images/recipes/*` with 30-day default TTL.

### Infrastructure
- [ ] `RecipeStack` is deployed to `eu-west-2` and follows existing tagging conventions (Owner, CostCenter, Project, Environment, ManagedBy).
- [ ] Recipe API endpoints are accessible via `api.akli.dev/recipes/*` through the CloudFront distribution.
- [ ] CloudFront `/recipes/*` behaviour uses `AllowedMethods.ALLOW_ALL` to support all HTTP methods.
- [ ] The `Authorization` header is forwarded to the recipe API Gateway origin.
- [ ] CORS is configured to allow `https://akli.dev` with GET/POST/PUT/PATCH/DELETE methods and `Content-Type`, `Authorization` headers.
- [ ] S3 CORS allows PUT from `https://akli.dev` for presigned URL uploads.

### Testing
- [ ] CDK assertion tests verify the DynamoDB table, GSIs, PITR, S3 bucket, Lambda functions, and API Gateway routes are created with the correct configuration.
- [ ] CDK assertion tests verify the JWT authoriser is configured with the correct Cognito user pool details.
- [ ] Lambda recipe handler unit tests cover: create recipe, get published recipe, get draft (404 for public), list published, list user's recipes, update own recipe, update another user's recipe (403), admin update any recipe, publish, unpublish, delete with ownership check and S3 image cleanup, slug generation and collision handling, slug immutability on update, validation errors for missing fields, DynamoDB StringSet to array conversion for tags.
- [ ] Lambda image handler unit tests cover: presigned URL generation with correct S3 key format.
- [ ] Lambda image resizer unit tests cover: three variants generated at correct dimensions, original deleted, no self-triggering.
- [ ] Tests follow TDD — written before implementation.


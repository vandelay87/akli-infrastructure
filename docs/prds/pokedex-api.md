# PRD: Pokedex API & Data

## Overview

Add a Pokedex API to akli.dev that serves Pokemon data (Gen 1) via API Gateway and Lambda, backed by DynamoDB. This is the first of four epics for the Pokedex app — a portfolio piece demonstrating full-stack AWS skills. The frontend (separate repo) will consume these endpoints.

## Problem Statement

The akli.dev portfolio currently showcases a single interactive app (sand-box). Adding a Pokedex app demonstrates full-stack AWS capabilities — API design, serverless compute, NoSQL data modelling, and infrastructure-as-code — which are not currently represented in the portfolio.

## Goals

- Serve Gen 1 Pokemon data (151 Pokemon) via a public REST API
- API is fast (low latency from CloudFront edge cache; cold starts may occasionally add 500ms–2s), cheap (free tier), and requires no ongoing maintenance
- Infrastructure is fully defined in CDK, including data seeding — no manual steps
- API design supports future expansion (more generations, filtering) without breaking changes

## Non-Goals

- Pokemon beyond Gen 1 — future iteration
- Filtering by type, ability, or other attributes — future iteration
- Authentication or rate limiting — public read-only API, not needed at this scale
- Frontend implementation — separate epic in the pokedex repo
- Caching layer (e.g., DAX, ElastiCache) — unnecessary at this scale
- Monitoring and alerting (CloudWatch alarms, dashboards) — follow-up if needed

## User Stories

- As a visitor to akli.dev, I want to browse a list of all Gen 1 Pokemon so I can find ones I'm interested in.
- As a visitor, I want to view detailed information about a specific Pokemon (stats, type, description) so I can learn about it.
- As the site owner, I want the API to cost nothing at low traffic so it doesn't add ongoing expense.
- As the site owner, I want the data seeding to be automated so I can tear down and redeploy the stack without manual steps.

## Design & UX

No UI in this epic — this is backend only. The API returns JSON consumed by the frontend (separate epic).

### API Endpoints

#### `GET /pokemon`

Returns a lightweight summary of all 151 Gen 1 Pokemon. Designed for the list/search view — the frontend filters client-side.

```json
{
  "pokemon": [
    {
      "id": 1,
      "name": "Bulbasaur",
      "types": ["Grass", "Poison"],
      "sprite": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/1.png"
    }
  ],
  "count": 151,
  "nextToken": null
}
```

The `count` and `nextToken` fields are included now (even though pagination is not implemented) to avoid a breaking response shape change when more generations are added later.

#### `GET /pokemon/{id}`

Returns full detail for a single Pokemon. Used when a user clicks into a Pokemon.

```json
{
  "id": 1,
  "name": "Bulbasaur",
  "types": ["Grass", "Poison"],
  "sprite": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/1.png",
  "height": 7,
  "weight": 69,
  "category": "Seed Pokemon",
  "description": "A strange seed was planted on its back at birth. The plant sprouts and grows with this Pokemon.",
  "genderRate": 1,
  "stats": {
    "hp": 45,
    "attack": 49,
    "defense": 49,
    "specialAttack": 65,
    "specialDefense": 65,
    "speed": 45
  }
}
```

#### Error responses

- `GET /pokemon/{id}` with invalid or out-of-range ID returns `404 { "error": "Pokemon not found" }`
- Any unexpected error returns `500 { "error": "Internal server error" }`

## Technical Considerations

### Stack and new resources

Pokedex-specific resources (DynamoDB, Lambda, API Gateway) live in a new `PokedexStack` in `akli-infrastructure`, deployed to `eu-west-2` (consistent with existing stacks). The CloudFront cache behaviour for `/api/pokedex/*` is added to `AkliInfrastructureStack` (which owns the CloudFront distribution), consuming the API Gateway URL via a cross-stack reference exported from `PokedexStack`.

#### DynamoDB table

- Table name: `pokedex-pokemon`
- Partition key: `id` (Number)
- No sort key needed — access patterns are get-by-ID and full scan
- Billing mode: On-demand (PAY_PER_REQUEST) — no capacity planning needed for 151 items
- No GSIs for now — a full scan of 151 items is ~30-40KB, well within a single response page. When more generations are added, GSIs for name and type can be introduced.

#### Lambda function

- Runtime: Node.js 22
- Single Lambda handling both endpoints — route parsing via the API Gateway event
- Memory: 256 MB
- Timeout: 10 seconds
- IAM: DynamoDB read-only access (`dynamodb:GetItem`, `dynamodb:Scan`) scoped to the Pokedex table
- The Lambda code lives in `lambda/pokedex-handler.ts` in the akli-infrastructure repo

#### HTTP API Gateway (v2)

- Separate from the SSR API Gateway — dedicated to the Pokedex API
- Routes:
  - `GET /pokemon` → Lambda
  - `GET /pokemon/{id}` → Lambda
- CORS enabled for `https://akli.dev`
- No custom domain for now — CloudFront will proxy to the API Gateway URL

#### CloudFront

- Add a new cache behaviour on the existing akli.dev CloudFront distribution: `/api/pokedex/*` → Pokedex API Gateway origin
- Cache policy: cache responses for 5 minutes (Pokemon data is static, but keep TTL short enough that reseeding is reflected quickly)
- The frontend calls `/api/pokedex/pokemon` and `/api/pokedex/pokemon/{id}` — a CloudFront Function on the origin-request event strips the `/api/pokedex` prefix before forwarding to the API Gateway (origin request policies cannot rewrite paths; the existing codebase already uses CloudFront Functions for URL rewriting)

### Data seeding

#### Static JSON file

- A one-time script (`scripts/fetch-pokemon-data.ts`) pulls Gen 1 data from PokeAPI (pokeapi.co) and writes a `data/pokemon.json` file
- This JSON is committed to the repo — version-controlled, reviewable, no external dependency at deploy time
- Fields pulled per Pokemon: id, name, types, sprite URL, height, weight, category (genus), description (flavor text, English), gender rate, base stats

#### CDK Custom Resource

- A Lambda-backed Custom Resource runs during `cdk deploy`
- Reads `data/pokemon.json` (bundled with the Lambda) and batch-writes all 151 items to DynamoDB
- Runs on stack create and update — idempotent (overwrites existing items). On delete, no-op (table is deleted with the stack).
- A hash of `data/pokemon.json` is included as a Custom Resource property so reseeding triggers automatically when the data file changes.
- Uses `BatchWriteItem` for efficiency (25 items per batch, 7 batches total). Must handle `UnprocessedItems` with retries in case of throttling.

### Testing

TDD is the preferred approach. Tests should be written before implementation.

- **CDK assertion tests**: verify the synthesised template contains the DynamoDB table, Lambda function, API Gateway routes, CloudFront cache behaviour, and IAM permissions
- **Lambda handler unit tests**: test route parsing, DynamoDB response mapping, error handling (404, 500), and response format
- **Seed script tests**: verify the PokeAPI response is correctly transformed to the expected JSON schema

### Cost

- **DynamoDB on-demand**: 151 items, ~40KB total storage. Free tier covers 25 read/write capacity units. $0/month.
- **Lambda**: free tier covers 1M requests. $0/month.
- **API Gateway v2**: free tier covers 1M requests (first 12 months). $0/month after: $1/million requests.
- **CloudFront caching** reduces Lambda/API Gateway invocations significantly.
- **Total: $0/month** under free tier.

### Tags

All new resources tagged with: Owner, CostCenter, Project (`pokedex`), Environment, ManagedBy (`cdk`).

## Acceptance Criteria

- [ ] `PokedexStack` is created in `eu-west-2` with all resources tagged
- [ ] DynamoDB table `pokedex-pokemon` exists with `id` (Number) as partition key and on-demand billing
- [ ] Lambda function is created with Node.js 22 runtime, 256 MB memory, 10s timeout
- [ ] Lambda has read-only DynamoDB access scoped to the Pokedex table
- [ ] HTTP API Gateway (v2) is created with `GET /pokemon` and `GET /pokemon/{id}` routes
- [ ] CORS is configured to allow `https://akli.dev`
- [ ] CloudFront cache behaviour routes `/api/pokedex/*` to the Pokedex API Gateway origin
- [ ] A CloudFront Function strips the `/api/pokedex` prefix before forwarding to the API Gateway
- [ ] Pokedex API responses are cached at CloudFront with a 5-minute TTL
- [ ] `scripts/fetch-pokemon-data.ts` fetches Gen 1 data from PokeAPI and outputs `data/pokemon.json`
- [ ] `data/pokemon.json` contains all 151 Gen 1 Pokemon with the correct schema
- [ ] CDK Custom Resource seeds DynamoDB from `data/pokemon.json` on deploy
- [ ] Seeding is idempotent — redeploying does not create duplicates
- [ ] `GET /pokemon` returns all 151 Pokemon with summary fields (id, name, types, sprite) plus `count` and `nextToken` metadata
- [ ] `GET /pokemon/{id}` returns full detail for a valid ID
- [ ] `GET /pokemon/{id}` returns 404 for an invalid or out-of-range ID
- [ ] CDK assertion tests verify all resources in the synthesised template
- [ ] Lambda handler unit tests cover happy path, 404, and 500 scenarios
- [ ] CDK Custom Resource includes a hash of `data/pokemon.json` to trigger reseeding on data changes
- [ ] Seeder Lambda handles `UnprocessedItems` from `BatchWriteItem` with retries
- [ ] CloudFront cache behaviour is added to `AkliInfrastructureStack` via cross-stack reference from `PokedexStack`
- [ ] All tests pass (`pnpm test`)
- [ ] `cdk diff` shows no unintended modifications to existing resources (only the new CloudFront cache behaviour on the existing distribution)

## Open Questions

- Should the Pokedex API Gateway have its own custom subdomain (e.g., `api.akli.dev/pokedex`) or is the CloudFront path-based routing (`akli.dev/api/pokedex/*`) sufficient?
- Should the `genderRate` field be exposed as a raw number (from PokeAPI: 0–8 scale where 0 = always male, 8 = always female) or converted to percentages?
- Should we include the shiny sprite URL as well, for potential future use?

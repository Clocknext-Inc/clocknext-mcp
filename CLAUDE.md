# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Sibling repos (one directory up, in `../`)

- `../Clocknext-Payment-Saas` → the main payments app (the `/api/v1` server this talks to).
- `../clocknext-sdk` → the TypeScript SDK.
- `../clocknext-docs` → the docs.

## What this repo is

`@clocknext/mcp` — a **stdio MCP server** that exposes ClockNext usage-based billing to AI coding tools. The repo ships two coupled artifacts:

- **The MCP server** (`src/`) — the tools an agent calls (whoami, list/add models, verify/record usage, catalogue CRUD, customers, docs search).
- **The `clocknext-onboarding` skill** (`skills/clocknext-onboarding/`) — the human-in-the-loop playbook that *drives* those tools to onboard a product end-to-end. The skill is the "policy"; the server tools are the "mechanism." Changing tool names, args, or semantics means checking whether `SKILL.md` and its `references/*.md` still describe them correctly.

## Commands

```bash
npm install
npm run build        # tsup → dist/index.js (single self-contained executable bin)
npm run dev          # run from source via tsx (needs CLOCKNEXT_API_KEY in env)
npm run typecheck    # tsc --noEmit (strict); CI runs this before build
CLOCKNEXT_API_KEY=cnk_... npm start   # run the built server
```

There is **no test suite and no linter** — `npm run typecheck` is the only static gate. To exercise the server manually, run it with a real `cnk_…` key against a **sandbox** org (see `clocknext_whoami`).

## Critical build/commit rule

`dist/` **is committed to git** and is what the Claude Code plugin runs directly (the plugin cache never runs `npm install`). tsup bundles *all* dependencies into one file (`noExternal: [/.*/]` in `tsup.config.ts`), so `node dist/index.js` runs with no `node_modules`. **After any change under `src/`, run `npm run build` and commit the regenerated `dist/` in the same change** — otherwise the plugin ships stale code.

## Architecture

- **Entry:** `src/index.ts` — builds one `ClockNext` client from env (`makeClient()`), constructs the `McpServer`, and calls each `register*` function to attach tools. `main()` connects over `StdioServerTransport`.
- **stdout is the JSON-RPC channel — never write to it.** All logging goes to **stderr** (`console.error`). A stray `console.log` corrupts the protocol.
- **The `cnk_…` API key never enters the model's context.** It's read from `process.env.CLOCKNEXT_API_KEY` inside the server and passed to the API client (`src/api.ts`); tools receive only non-secret args.
- **Every tool lives in its own `src/tools/*.ts`** and exports a `registerXxx(server, cnk)` function. To add a tool: create the file, export a register fn, and call it from `index.ts`.
- **One API client, no SDK:** every ClockNext API call goes through `src/api.ts` (`ClockNextApi`) — plain `fetch` with the `cnk_` bearer. This repo does NOT depend on `@clocknext/sdk` (a choice to keep the MCP self-contained, not a gap): since 2026-10-01 the public SDK and docs DO cover the catalogue (credits / outcomes / units / composites / plan CRUD — list, get, create, update, archive, unarchive, no delete); only `POST /api/v1/models`, `/me` and bulk import remain MCP-only. Keep `src/api.ts` in step with the documented contract (`../clocknext-docs/openapi.yaml`). `ClockNextApi` mirrors the old SDK transport: timeout, both response envelopes, typed errors (`AuthError`, `NotFoundError`, …), and retries only for GET / PUT / DELETE. Its method names (`cnk.credits.list`, `cnk.plans.update`, …) match the SDK's so tool code reads the same. Base URL from `CLOCKNEXT_BASE_URL` (default `https://payments.clocknext.com`). To call a new endpoint, add a method to `ClockNextApi` — never `fetch` directly from a tool.
  - Public docs tools (`search_docs`, `get_doc`) use `fetchJson` (`src/tools/http.ts`) against the docs origin — **no API key** (`CLOCKNEXT_DOCS_URL`, default `https://help.clocknext.com`, resolved defensively in `docs-url.ts`).

### Shared conventions (follow these when adding/editing tools)

- **Result helpers in `src/tools/util.ts`:** return `jsonResult(data)` for success and `errorResult(msg)` for failures — **catch API/network errors and turn them into `errorResult(errMsg(err))`; do not let a tool throw.** `errMsg` special-cases `ClockNextError` (from `src/api.ts`) to include the HTTP status.
- **Inputs are Zod `ZodRawShape`s** (flat objects, as MCP requires). Push validation into the schema (`.refine`, `.enum`, `.min`) where possible. Cross-field rules that can't be expressed flatly are enforced in the handler and returned as an `errorResult` (e.g. `create_composite` requiring at least one entitlement id).
- **Descriptions are load-bearing.** Tool and field `describe()` text is the agent's only guidance — it encodes rules (idempotency, "records for real", "partial update", "prefer the ClockNext product"). Keep them precise and current when behavior changes.
  **Never write "dashboard"** in a tool description, a skill file, or anything the user sees — the product is called **the ClockNext product**, and doing something there is **manually / Manually in the Clocknext**.
- **Annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are set intentionally per tool — mirror the neighbours when adding one.
- **The MCP never touches usage — not to record it, and not to preview it.** There is no record/track tool: the `/api/v1/signal/*` routes are asynchronous (`202 {queued, messageId, rawId}` — no usage log, and no validation of `agentKey` until the worker picks it up), so a tool could only ever report "accepted", never "billed". There is no dry-run/preview tool either: it was removed in 0.10.0 because the underlying `dryRun` flag is internal-only and must not be exposed through a public surface. Don't re-add either one.
- **What replaced the preview is a read-only reference check** (`SKILL.md` S27): `list_models` plus `get_credit` / `get_outcome` / `get_unit` confirm every model and `agentKey` the product will send actually resolves. That catches the two mis-wires ingest will not report — it answers `202` and the worker drops a bad reference later — but it does NOT price the signal. Say so rather than implying it is a guarantee; the real signal is the first thing that validates the whole path.
- **The MCP has no usage-read tool.** `get_customer_usage` was removed with `GET /api/v1/usage` (SE-100): that route read a table the edge does not write, so its numbers were frozen. A signal is confirmed with the SDK's `signals.usageLog()` (`GET /api/v1/signal/usage-log`). Don't re-add a read on `/api/v1/usage`.

### Domain model (needed to touch catalogue/pricing code)

- Catalogue resources: **plans** bundle **components**, each of type `WALLET | FLAT | CREDIT | OUTCOME | UNIT | COMPOSITE`. `src/tools/catalogue.ts` generates list/get/create/update/archive/unarchive for credits, outcomes, units, and plans via one `registerCrud` factory.
- **Composites live in `src/tools/composites.ts`, outside that factory** — list/get/create/update/archive/unarchive, but their inputs (three flat id lists, where an update must read the other lists back first) don't fit the factory. There is no delete on the public API. `COMPOSITE` is the plan-line type that SELLS a composite (with `compositeId`). The server stores it as `PRICING_METRIC`, but the public API takes and returns `COMPOSITE` only and refuses `PRICING_METRIC` and `pricingMetricId` (400) — never send the old names.
- **Creating a composite bills nobody.** An invoice is built from plan components, never from a catalogue entry, so `create_composite` followed by no plan component charges nothing, errors nowhere, and looks configured. Both tool descriptions and `references/composite.md` say so explicitly — keep that wording if you touch them.
- **Archive / unarchive are the only way to change active state** — `setActive(id, bool)` calls `POST <base>/:id/archive` / `…/unarchive`; the API has no DELETE and no `isActive` in any body. **Update = partial**, like the API's PATCH — only the fields sent change; a list sent (steps, tiers, entitlements) is the complete new list. Plans name their lines `entitlements` and take no `currencyCode` (the workspace's primary currency is used). The wallet-for-arrear flag is `useWalletForArrear` (the old `walletFundedArrear` is ignored without an error), and the price is set with `cost` (`priceAdjustment` is read-only). Plan line ids and unit tier ids stay the same across a PATCH, so the line / tier schemas carry an optional `id`.
- **403s:** `statusDetail.code` `FEATURE_LOCKED` → `FeatureLockedError` (with `feature`), `WORKSPACE_LOCKED` → `WorkspaceLockedError`, any other 403 → `ForbiddenError` (e.g. the 25-customer sandbox cap). Same names as the SDK.
- **Pricing is model-grounded, never hand-typed.** Credit/outcome create/update take a **model mixer** (`models`: enabled catalog model + avg tokens + input/output/cache/cacheWrite split summing to 100, + `marginPercent` ≥ -100). `computeMixerBase()` checks it against the org's live models via `cnk.workspace.models` and turns it into the `modelBundle` the SERVER prices from (the server refuses a credit / new step without one); a caller can't inject an ungrounded price.
- **Smoke test:** `test/catalogue-tools.smoke.ts` drives the catalogue + composite tools against a real server (`CN_TEST_KEY=cnk_… CN_TEST_BASE=http://localhost:3000 npx tsx test/catalogue-tools.smoke.ts`). It creates rows and deletes nothing — point it at a throwaway workspace. Wallet components debit at **raw model cost (no margin)**; units are fixed-price per event (no tokens).

## SDK authoring conventions (`@clocknext/sdk` style)

This repo no longer depends on `@clocknext/sdk`, but usage-billing work often spans both. When you write or extend the SDK (its own repo, `../clocknext-sdk`), follow the conventions it already demonstrates (its `src/` is the best reference — read it). Several are mirrored in this server's `src/api.ts`.

**Types are the API — make illegal states unrepresentable.**
- **Discriminated unions for mutually-exclusive shapes**, keyed on a literal `type` field. `Signal = CreditSignal | WalletSignal | OutcomeSignal` mirrors the server's Zod `recordSchema`, so per-variant required fields (`agentKey` on credit/outcome, not wallet) are enforced at **compile time instead of surfacing as runtime 422s**. When the server validates with a discriminated schema, mirror it as a discriminated union — don't collapse it into one interface with optional fields.
- **Derive input types from entity types**, don't hand-duplicate: `type CreditInput = Omit<CreditSignal, "type">`; `type CreateCustomerInput = CustomerProfileInput & { name: string; email: string }`. Keep `Create*Input` (required fields), `Update*Input` (all optional / patch), and the read entity as distinct types.
- **`null` vs `undefined` is semantic and must be documented.** Convention here: on write inputs `null` **clears** a column, omitting (`undefined`) **leaves it unchanged**; on read models a truly-absent value is explicit `T | null`. Don't use `?:` and `| null` interchangeably.
- **No `any`.** Use `unknown` for genuinely open values (`custom?: Record<string, unknown>`, `onError(error: unknown)`) and let callers narrow. `strict` is on.
- **JSDoc every exported type and field** with what it means, its **units** (e.g. "USD per 1,000,000 tokens"), its default, and *when* it's populated vs `null` (e.g. "balance is null on read-back"). These docs are the primary reference surface — treat them as load-bearing, like the MCP tool descriptions.
- Name wire/response DTOs with a `Serialized*` prefix; export **types** type-only (`export type Foo`) and classes as value exports.

**Client architecture — one seam, composed resources.**
- A single root `ClockNext` class holds `readonly` resource sub-clients (`signals`, `customers`, `plans`, `workspace`, …), each its own class taking a shared `Transport`.
- **All HTTP goes through one `Transport` seam**: it builds the authenticated request, enforces the timeout, unwraps the `{ ok, ... }` envelope, maps status → typed error, and retries transient failures with backoff + jitter. Resource classes never call `fetch` directly.
- **Config object with documented defaults**, plus an internal `ResolvedConfig` (= config with every default applied) so downstream code sees non-optional fields.
- **Injectable seams for testability**: `fetch?: FetchLike` and `logger?: Logger` are config options defaulting to globals.
- **Idempotency/retry safety is method-based**: reads (GET), idempotent replaces (PUT) and DELETE are replay-safe and retried; non-idempotent writes (POST/PATCH) are **not** auto-retried so a transient failure can't duplicate a write (callers opt in). This is the same reasoning behind the MCP tools' `idempotentHint` annotations.
- Consistent CRUD verbs across every resource: `list(params?)`, `get(id)`, `create(input)`, `update(id, input)`, `setActive(id, bool)`. Add lifecycle methods (`flush()`, `close()`, `pending`) where buffering exists.

**Errors — a typed hierarchy callers branch on.**
- `ClockNextError extends Error` carries `status?: number` and `retryable: boolean`; subclasses map one-to-one to HTTP status (`AuthError` 401, `ValidationError` 400, `NotFoundError` 404, `PlanError`/`AllowanceError` 422, `ConflictError` 409, `RateLimitError` 429 with `retryAfterMs`, `ServerError` 5xx, `NetworkError` for a request that never completed). Callers branch on the **kind**, never string-match messages. This server's `errMsg` (`src/tools/util.ts`) already special-cases `ClockNextError` to surface `status`.

**Packaging — dual ESM/CJS, tree-shakeable, validated.**
- `"type": "module"`, `"sideEffects": false`, and an `exports` map with distinct `import`/`require` conditions each pointing at their own types (`index.d.ts` / `index.d.cts`); `main`→CJS, `module`→ESM, `types`→DTS. Ship only `["dist", "README.md"]`, `engines: node >=18`.
- Build with tsup; gate publishes with `publint --strict && attw --pack` (are-the-types-wrong) in `prepublishOnly` so broken exports/types can't ship. Tests run on vitest, `tsc --noEmit` as the type gate.

## Releasing

Tag push (`v*`) triggers `.github/workflows/publish-mcp.yml`, which typechecks, builds, `npm publish`es with provenance, then publishes `server.json` to the MCP Registry via GitHub OIDC. The tag **must** match `package.json` `version` or CI fails. Before tagging, bump the version in **all four** places: `package.json`, `server.json` (both `version` fields), `src/index.ts` (the `McpServer` version), and `.claude-plugin/plugin.json` — then `npm run build` and commit `dist/`.

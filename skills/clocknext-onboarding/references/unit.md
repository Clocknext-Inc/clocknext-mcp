# Unit — fixed price per event (no tokens)

A **unit** is a catalogue entitlement for a **discrete, non-LLM event**: one event = one unit,
**no tokens, no model**. Seats, reports generated, exports, API actions, documents uploaded —
anything token-shaped is a [credit](credit.md), not a unit.

A unit is priced in one of **three ways**: **FLAT**, **SLAB**, or **VOLUME**. Choosing between
them is the main thing to get right, so they're worked out side-by-side below.

## When to pick it
- Billing sounds like *"$X per report / per seat / per export / per action."*
- The event has **no token cost** to meter — it's a countable thing, not an LLM call.
- **All FLAT (per-event) pricing lives here** — including simple "$0.10 per event."

## Create it — `clocknext_create_unit`

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Human label. |
| `agentKey` | yes | Durable identity `[A-Za-z0-9._-]`, matched exactly (case included), **unique org-wide**; what the product reports consumption against. |
| `pricingType` | yes | `FLAT` \| `SLAB` \| `VOLUME` (below). |
| `flatPrice` | FLAT only | Price per event (default 0). |
| `tiers` | SLAB/VOLUME only | **1–50 ordered tiers**, each `{ upTo, price }`. `upTo` is the tier's **inclusive** upper bound, rising tier by tier; **the last tier must be `upTo: null`** ("and above"), and only the last. On update, `tiers` is the complete new list; tier `id`s stay the same (a tier sent with its `id` updates that tier, one without updates the saved tier at the same position). |
| `description` | no | Optional. (Active state isn't a field — use `clocknext_archive_unit` / `_unarchive_unit`.) |

Unit prices are **set directly** (they aren't token-grounded) — there's no model mixer here.

## The three pricing types

- **FLAT** — one price per event. `cost = quantity × flatPrice`.
- **SLAB** (graduated / marginal) — each tier's rate applies **only to the units that fall in
  that tier's band**. Like income-tax brackets. `cost = Σ (units in band × band price)`.
- **VOLUME** — the **single tier the total quantity lands in** sets the rate for **all** units.
  `cost = quantity × (price of the tier the total lands in)`.

Boundaries: a tier `upTo` is inclusive; the next band starts at `upTo + 1`. The last tier is
always "and above", so every quantity lands in a band.

### FLAT worked example
`flatPrice = $4`. 7 events → `7 × 4 = $28`.

### SLAB vs VOLUME — same tiers, side by side
Tiers (stored as `upTo`): **1–10 @ $5**, **11–25 @ $10**, **26+ @ $12**
(`tiers: [{upTo:10,price:5}, {upTo:25,price:10}, {upTo:null,price:12}]`).

| Quantity | **SLAB** (per-band) | **VOLUME** (whole at landing tier) |
| --- | --- | --- |
| 10 | 10·$5 = **$50** | 10·$5 = **$50** |
| 11 | 10·$5 + 1·$10 = **$60** | 11·$10 = **$110** |
| 25 | 10·$5 + 15·$10 = **$200** | 25·$10 = **$250** |
| 30 | 10·$5 + 15·$10 + 5·$12 = **$260** | 30·$12 = **$360** |

Same tiers, very different bills once you cross a boundary. **SLAB rewards the first units at
cheap rates; VOLUME re-prices everything at the reached tier.** Pick SLAB for "gentle graduated"
pricing, VOLUME for "buy more, the whole order gets cheaper (or, above a line, pricier)."

## How it's metered at runtime — NEVER via the MCP
A unit event is recorded **in the customer's product**, one call = one unit unless it passes
`quantity`:
```ts
signals.unit({ customerId, agentKey })          // SDK — no tokens, no model
// or POST /api/v1/signal/unit  { customerId, agentKey, quantity? }   (REST)
```
The MCP builds the unit catalogue and does **not** record unit events. `signals.unit()` sends
immediately and returns a Promise; handle failures at the product's server boundary. The MCP
has no unit-event read tool, and an ARREAR Unit may have no balance decrement. Confirm
consumption through the product SDK/API's supported Unit usage/event-count endpoint, not a
balance alone. See [`code-metering.md`](code-metering.md).

## In a plan
Granted via a **UNIT component** referencing the unit id:
- **ADVANCE** — prepay a `quantity` (priced through the tiers at purchase).
- **ARREAR** — meter actual events (optionally [wallet-funded](wallet.md)).
See [`plans.md`](plans.md).

## Common mistakes
- **Confusing unit-FLAT with a plan-FLAT.** Unit-FLAT is **per event**; a plan FLAT component is a
  **single** fee. See [`plans.md`](plans.md).
- **Using a unit for token usage.** Token-shaped spend is a [credit](credit.md).
- **Mixing up SLAB and VOLUME.** Re-read the table — the difference is large past tier 1.
- **A non-last tier with `upTo: null`, or a capped last tier.** The final tier — and only it —
  is `upTo: null`.
- **Metering units through the MCP.** It's the product's job at runtime.

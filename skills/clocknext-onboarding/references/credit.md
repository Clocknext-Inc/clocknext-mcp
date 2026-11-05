# Credit — token-metered balance

A **credit** is a catalogue entitlement: a balance a customer holds that each billable LLM call
**draws down in proportion to its real token cost**, plus your margin. It's the default choice
for variable, token-shaped AI usage ("chat turns", "generations", "AI credits").

## When to pick it
- Billing sounds like *"credits"*, *"tokens"*, or *"pay for what the AI uses."*
- Usage is **token-driven** and varies per call.
- You want a **margin** over raw provider cost (unlike a wallet, which is at cost).

If instead you charge a fixed price per finished *job*, that's an [outcome](outcome.md); a fixed
price per non-LLM *event* is a [unit](unit.md); at-cost pass-through is a [wallet](wallet.md).

## Create it — `clocknext_create_credit`
Fields (see also the mixer in [`pricing-and-models.md`](pricing-and-models.md)):

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Human label. |
| `agentKey` | yes | **Durable identity** — the stable key `[A-Za-z0-9._-]` your product sends, saved and matched exactly as sent (case included), when recording usage. A rename never changes it; it must be unique across the organization. |
| `models` | yes | The **model mixer**: 1+ enabled models, each with `avgTokens` and an `inputPct`/`outputPct`/`cachePct`/`cacheWritePct` split that totals 100 (`cacheWritePct` only on a model with a cache-write price). Grounds the price. |
| `marginPercent` | yes | Markup over the computed base cost. `100` = double the base = price per credit. `0` = at cost; negative discounts (down to `-100` = free). |
| `description` | no | Optional. |

The mixer is saved as the credit's model bundle, and **Clocknext works out `basePrice` and
`pricePerCredit` from it** at the models' live prices; a disabled/unknown model, a split ≠ 100
or a cache-write share on a model without a cache-write price is rejected. You never hand-type
a price. The money draw-down is cost-based (below).

**Update is partial** (`clocknext_update_credit`): pass the id plus only the fields to change.
Send `models` to re-price; leave it out to keep the current base price.

## Pricing mechanics (verified against the billing engine)

**Base price** = the whole mixer's real provider cost, in USD (no margin):

    basePrice = Σ  (avgTokens·inputPct%·inputPrice + avgTokens·outputPct%·outputPrice
                  + avgTokens·cachePct%·cachePrice + avgTokens·cacheWritePct%·cacheWritePrice) / 1e6

(prices are USD per 1,000,000 tokens). Then:

    pricePerCredit = basePrice × (1 + marginPercent/100)

**Draw-down per call** — margin cancels cleanly, so a call always costs the same money whether
you think in credits or dollars:

    providedCost = (inputTokens·inputPrice + outputTokens·outputPrice + cacheTokens·cachePrice) / 1e6   // real cost
    creditsUsed  = providedCost / basePrice
    customerCost = creditsUsed × pricePerCredit  =  providedCost × (1 + marginPercent/100)

### Worked example
Credit bundle: **100,000 tokens** of a model priced input `$3`/M, output `$15`/M, cache `$1.5`/M,
split **60/30/10**, margin **30%**.

    basePrice      = (60,000·3 + 30,000·15 + 10,000·1.5) / 1e6 = 645,000/1e6 = $0.645
    pricePerCredit = 0.645 × 1.30 = $0.8385

One real call — input 1,500, output 750, cache 250 tokens:

    providedCost = (1,500·3 + 750·15 + 250·1.5)/1e6 = 16,125/1e6 = $0.016125
    creditsUsed  = 0.016125 / 0.645 ≈ 0.0250 credits
    customerCost = 0.0250 × 0.8385 ≈ $0.0210   ( = 0.016125 × 1.30 ✓ )

So the call draws ≈ **0.025 credits** (≈ **$0.021** to the customer, ≈ $0.0035 of it margin).

## How it's metered at runtime (in the customer's product, not the MCP)
```ts
signals.credit({ customerId, model, agentKey, tokens: { input, output, cache } })  // SDK
// or POST /api/v1/signal/credit  { customerId, agentKey, usage: { model, inputTokens, outputTokens, cacheTokens } }  (REST)
```
Fire it **on the server, after the call succeeds**, at the billable boundary. See
[`code-metering.md`](code-metering.md) for the integration recipe.

## In a plan
A plan grants a credit via a **CREDIT component** referencing the credit's id:
- **ADVANCE** — grant a `quantity` of credits up-front (prepaid allowance, billed at purchase).
- **ARREAR** — meter and bill actual consumption (optionally [wallet-funded](wallet.md)).
See [`plans.md`](plans.md).

## Common mistakes
- **Typing a price.** Never — always the model mixer.
- **Reusing / renaming the `agentKey` loosely.** It's the runtime binding; changing it re-points
  which signals land here. Pick once, keep it.
- **Pricing against a disabled model.** Enable it first (`clocknext_add_model`) — see
  [`pricing-and-models.md`](pricing-and-models.md).
- **Using a credit for a non-LLM event.** That's a [unit](unit.md).

# Entitlements & billing building blocks — the map

Clocknext bills a product out of a small set of building blocks. This file is the **decision
guide** — what each one is, and which to reach for. Each has its own deep reference (pricing
math, exact MCP tool fields, runtime signal, worked examples); open the one you're working on.

Ground anything you're unsure about in the docs first: call `clocknext_search_docs`
and then `clocknext_get_doc` for the matching result. This is a curated summary, not the
source of truth.

## The blocks

| Block | Kind | One-line | Deep reference |
| --- | --- | --- | --- |
| **Credit** | catalogue entitlement | Token-metered balance, drawn down per call by real token cost (+ your margin). | [`credit.md`](credit.md) |
| **Outcome** | catalogue entitlement | Billed once per *completed* multi-step LLM deliverable. | [`outcome.md`](outcome.md) |
| **Unit** | catalogue entitlement | Fixed price per *event*, no tokens — FLAT / SLAB / VOLUME pricing. | [`unit.md`](unit.md) |
| **Composite** | catalogue + plan component | Several credits/outcomes/units bundled and billed as **ONE** thing, per completed occurrence. | [`composite.md`](composite.md) |
| **Wallet** | plan component | Prepaid USD balance. Plain wallet signals debit at **raw** model cost (no margin); when it funds metered usage (`useWalletForArrear`) it debits the **customer price — margin included**. | [`wallet.md`](wallet.md) |
| **Flat** | plan component | A one-off fee on the plan (e.g. setup). | [`plans.md`](plans.md) |
| **Plan** | the wrapper | Bundles the above into what a customer subscribes to and pays for. | [`plans.md`](plans.md) |

**Catalogue entitlements** (credit / outcome / unit) are created and priced on their own, then
referenced by a plan. **Wallet** and **flat** aren't catalogue objects — they exist only as
components *inside* a plan. A **composite** is both: it is created in the catalogue like an
entitlement, but it wraps entitlements that already exist and only bills once a plan sells it
as a component. See [`plans.md`](plans.md) for how it all composes.

Reach for a composite only **after** the individual meters are settled — it is priced on top
of them, so there is nothing to bundle until they exist.

## Which one? — decide by how the customer's billing "sounds"

- *"credits" / "tokens" / "pay for AI usage"* → **Credit**. Variable, token-shaped spend with a
  margin. → [`credit.md`](credit.md)
- *"$X per job / per workflow / per result / per document processed"*, where the job is several
  LLM steps → **Outcome**. You charge only when the whole thing finishes. → [`outcome.md`](outcome.md)
- *"$X per report / per seat / per export / per action"* — a discrete event with **no tokens**
  → **Unit**. Flat per event, or tiered (SLAB/VOLUME). → [`unit.md`](unit.md)
- *"top up a balance and burn it down at cost"* → **Wallet** (prepaid, no margin). → [`wallet.md`](wallet.md)
- *"a setup / onboarding fee"* → a **FLAT** plan component (≠ a unit priced FLAT). → [`plans.md`](plans.md)

### The two easy-to-confuse pairs — get these right
- **Unit-FLAT vs plan-FLAT.** A **unit** priced FLAT charges **per event** (10 exports = 10×).
  A **plan FLAT component** is a **single** charge on the plan (one setup fee). Different things.
- **Outcome step vs unit.** Every **outcome step is an LLM step** (token-priced). A fixed-cost,
  non-LLM event (an upload, an export) is a **unit**, never an outcome step.

## Mixing them
A product can use several blocks, and more than one of each — e.g. a "chat" **credit** + a
"reports" **unit** + a "contract-review" **outcome**, all bundled in one plan with a prepaid
**wallet**. Create each catalogue entitlement one at a time (confirm each), then assemble the
plan. Loop until the user says the catalogue is complete.

## Pricing is always model-grounded
Credit and outcome prices are **computed from a model mixer**, never hand-typed — see
[`pricing-and-models.md`](pricing-and-models.md) for the formula and the enable-a-model step.
Unit prices are set directly (they're not token-based). Wallet carries no price of its own —
plain wallet spend is raw cost; wallet-funded metered usage debits at the funded entitlement's
customer price.

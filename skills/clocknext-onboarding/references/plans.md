# Plan — what a customer subscribes to

A **plan** bundles the building blocks into what a customer actually buys and pays. It's a list
of **entitlements** (sent as `entitlements`) plus a billing cycle; its currency is the
workspace's primary currency. A purchase (subscription) raises a real
invoice, so plans are the last thing you build before the real-money gates (Gate 1 = the
purchase, Gate 2 = the first real signal — [SKILL.md](../SKILL.md) S17 and S28, each asked
alone).

## Components
Each component is one of six types, in one of two billing modes.

| Type | References | ADVANCE means | ARREAR means |
| --- | --- | --- | --- |
| **WALLET** | — | Prepaid `amount` (USD) topped up up-front. | (Rarely used; a metered wallet. Not allowed with `useWalletForArrear`.) |
| **FLAT** | — | A one-off `amount` (USD) fee. | Same one-off fee. |
| **CREDIT** | `creditId` | Grant a `quantity` of [credits](credit.md) up-front. | Meter actual credit usage. |
| **OUTCOME** | `outcomeId` | Grant a `quantity` of [outcomes](outcome.md) up-front. | Bill each completed outcome. |
| **UNIT** | `unitId` | Prepay a `quantity` of [units](unit.md) (priced through tiers). | Meter actual unit events. |
| **COMPOSITE** | `compositeId` | Prepay a POOL of `quantity` [composite](composite.md) occurrences — slots shared across whichever wrapped items each occurrence uses. | Count completed occurrences at cycle end. |

- **ADVANCE** = billed **up-front for the cycle**; grants `amount` (WALLET/FLAT) or `quantity`
  (CREDIT/OUTCOME/UNIT/COMPOSITE). Each line is checked against its type and billing mode, and
  a field that doesn't fit is a **400 naming the line and the field** — never silently dropped:

  | Line | `quantity` | `amount` | `rollover: true` |
  | --- | --- | --- | --- |
  | CREDIT / OUTCOME / UNIT / COMPOSITE, ADVANCE | **required** (0 is allowed) | not allowed | allowed (not on UNIT) |
  | CREDIT / OUTCOME / UNIT / COMPOSITE, ARREAR | not allowed | not allowed | not allowed |
  | WALLET, ADVANCE | not allowed | **required** (0 for an empty wallet) | allowed |
  | WALLET, ARREAR | not allowed | not allowed | not allowed |
  | FLAT | not allowed | **required**, above 0 | not allowed |

  On a FREE plan, `rollover: true` is not allowed on any line. `null`, a missing field and
  `rollover: false` count as not sent, so the lines `clocknext_get_plan` returns can be sent
  back as they are.
- **`rollover: true`** carries what's left into the next cycle instead of resetting it.
- **ARREAR** = **metered**, billed for what was consumed (at cycle end, or from the wallet if
  [`useWalletForArrear`](wallet.md) is on).
- CREDIT/OUTCOME/UNIT components reference an **existing** catalogue entitlement by id, and
  COMPOSITE references an **existing** composite by `compositeId` — **create those first**.
  Every item must be **active** to be added. WALLET and FLAT exist only here, not in the
  catalogue.
- At most **one WALLET** and **one FLAT** component per plan; each credit/outcome/unit at most once.
- **A COMPOSITE line is how a [composite](composite.md) gets billed.** The composite must exist first (`clocknext_create_composite`), and
  **without this component it charges nothing at all**: the catalogue entry only defines the
  bundle and its price. This is the step people forget, and it fails silently.

## Create it — `clocknext_create_plan`

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Plan name. |
| `billingCycle` | yes | `MONTHLY` \| `QUARTERLY` \| `SEMI_ANNUAL` \| `YEARLY` \| `FREE`. |
| `entitlements` | yes | ≥1 line (table above). |
| `useWalletForArrear` | no | Pay metered usage from the prepaid wallet as it happens — see [`wallet.md`](wallet.md). Default false. |
| `cost` | no | The plan's total price per cycle (USD). Leave it out to price the plan at the sum of its ADVANCE lines; send it only for a different headline price. Must be left out (or 0) on a FREE or all-ARREAR plan. The server stores the difference as the read-only `priceAdjustment`. |
| `carryForward` | no | **Deprecated** — accepted but ignored by the billing engine. |

There is no `currencyCode`: a plan always uses the workspace's primary currency (Settings →
Organization → Currencies, USD when none is set). There is no `isActive` either — a new plan is
active, and active state only changes through archive / unarchive.

**Update is partial** (`clocknext_update_plan`) — pass the id plus only the fields to change;
everything left out keeps its stored value. `entitlements`, if sent, is the complete new list:
the easiest edit is to read it with `clocknext_get_plan`, change the list, and send it back
as-is (line `id`s, `compositeId` and `rollover` included).

- **Line ids stay the same.** A line sent with its `id` updates that line; one sent without an
  `id` updates the saved line of the same type and item. Only a new line gets a new id; a saved
  line left out is removed. An unknown `id`, the same `id` twice, or an `id` with a different
  type or item is a 400.
- **The price stays the same** unless you send `cost`, or the lines really change (a line added
  or removed, or its `billingMode`, `quantity`, `amount` or `rollover` changed) — then it resets
  to the sum of the new ADVANCE lines at today's prices. Sending the same lines back keeps it.

Nothing is ever deleted: **archive**
(`clocknext_archive_plan`) retires a plan and `clocknext_unarchive_plan` restores it.

## Due-at-purchase cost (verified) — only ADVANCE components count

    cost = Σ over ADVANCE components:
             WALLET  → amount
             FLAT    → amount
             CREDIT  → quantity × pricePerCredit
             OUTCOME → quantity × pricePerOutcome
             UNIT    → priceUnits(quantity, pricingType, flatPrice, tiers)   // see unit.md
    ARREAR components add 0 up-front (they're billed on consumption).
    FREE or all-ARREAR plans → cost is 0.
    Send `cost` to set a different total; the difference is kept as priceAdjustment.

### Worked example
Components: WALLET ADVANCE **$1,000**; CREDIT ADVANCE **100 @ $0.65**; OUTCOME ADVANCE
**50 @ $0.375**; UNIT ADVANCE **10,000** at SLAB tiers [1–1,000 @ $0.01],[1,001+ @ $0.005];
FLAT **$50**; plus a CREDIT **ARREAR** (metered).

    WALLET  = 1000
    CREDIT  = 100 × 0.65   = 65
    OUTCOME = 50 × 0.375   = 18.75
    UNIT    = 1,000·0.01 + 9,000·0.005 = 10 + 45 = 55        (SLAB — see unit.md)
    FLAT    = 50
    ARREAR credit → 0 up-front
    cost = 1000 + 65 + 18.75 + 55 + 50 = $1,188.75           ← charged at purchase

The ARREAR credit is then billed as consumed — separately at cycle end, or from the wallet if
`useWalletForArrear` is on.

## Rules & gotchas
- **FREE plans** must be **ADVANCE-only with no FLAT** component (they only grant; they raise no
  invoice).
- Cross-component rules (the wallet-funded three, one-wallet/one-flat, FREE constraints) are
  enforced by the backend with a **clean 400** — the tool surfaces the message; fix and resend.
- Changes apply **going forward**; customers already on a plan keep their terms.
- Prefer the plan builder in the Clocknext product for anything non-trivial (live preview) — the MCP is the
  fallback. See [`ui-links.md`](ui-links.md) and [the plan states in `SKILL.md`](../SKILL.md#s13s15--plan).

## See also
[`credit.md`](credit.md) · [`outcome.md`](outcome.md) · [`unit.md`](unit.md) ·
[`wallet.md`](wallet.md) · [`entitlements.md`](entitlements.md) ·
[`pricing-and-models.md`](pricing-and-models.md)

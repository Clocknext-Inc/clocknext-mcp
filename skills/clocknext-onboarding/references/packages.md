# Package — a top-up or add-on on a plan

A **package** is one or more entitlements and one price that a customer's subscription gets
**on top of its plan**: "500 extra AI credits for $4", "20 extra exports". Reach for one when
customers run out mid-cycle and need more of something the plan already gives, or when an
optional extra is sold next to the plan. It is not a second plan and it never replaces one.
Build it only after the plan is settled ([SKILL.md](../SKILL.md) S13–S15) — the proof flow
never needs one.

## What it holds

The entitlements are grouped by kind — the same shape in a request and in a response:

```json
"entitlements": {
  "credits":    [{ "id": "<creditId>",    "quantity": 1000 }],
  "outcomes":   [{ "id": "<outcomeId>",   "quantity": 2 }],
  "units":      [{ "id": "<unitId>",      "quantity": 1 }],
  "composites": [{ "id": "<compositeId>", "quantity": 4 }],
  "flatFee": 2
}
```

- `id` is the credit's / outcome's / unit's / composite's own id; `quantity` is how many the
  package grants each cycle, a whole number above 0. A response adds each item's `name`
  (a request may send it back; it is ignored).
- `flatFee` is one flat fee in USD (at most one per package); null or left out = none.
- No **wallet**: a package never holds a wallet (extra wallet money belongs in the Reserved
  wallet).
- No **billing cycle**, **billing mode** or **rollover** of its own. It renews with the
  subscription on the plan's billing cycle until it is removed, and it is always billed
  up-front. Sending any of those is a 400.
- The same entitlement can't be listed twice; each one must be active.
- `cost` is required on create: the package price the customer pays each cycle (USD, before
  tax). Ask the user for the price — never invent one.

## The rule people miss: the plan must have it, billed up-front

Every entitlement in a package (except a flat fee) must **also be on the customer's plan as
billed up-front (ADVANCE)**. The catalog accepts any active entitlement, so the mistake shows
only when the package is added to a subscription:

- `PACKAGE_ENTITLEMENT_NOT_ON_PLAN` — the plan doesn't have it as billed up-front.
- `PACKAGE_ENTITLEMENT_METERED` — the plan charges it as used (ARREAR); a package can't top
  up a metered entitlement.

So check the target plan (`clocknext_get_plan`) before you design the package.

## Catalog tools

| Tool | What it does |
| --- | --- |
| `clocknext_list_packages` | All packages; `active: true` for the ones that can still be added. |
| `clocknext_get_package` | One package, with its entitlements' ids. |
| `clocknext_create_package` | Create one. Charges nobody. A taken name is a 409. |
| `clocknext_update_package` | Partial update. Each entitlement group sent is the complete new list for that group; a group left out keeps its items (the tool reads them back first); `flatFee: null` removes the flat fee. Without `cost`, new entitlements reset the price to their list prices. |
| `clocknext_archive_package` / `clocknext_unarchive_package` | Stop / restart new sales. Customers who have it keep their copy. There is no delete. |

A catalog edit or archive changes nothing for current customers: their subscription keeps
its own copy.

## On a customer's subscription

The subscription id is the purchase id (`plan.purchaseId` from `clocknext_get_customer_plan`).

- `clocknext_get_subscription` — the subscription with its `packages` (SCHEDULED, ACTIVE and
  MARKED_FOR_CANCELLATION ones; CANCELLED ones left out). Each has its `cost`, the grouped
  `entitlements` copied when it was added, and `cancelReason`.
- `clocknext_add_subscription_packages` — **⛔ raises a real invoice**, one line per
  package, full price. The packages are SCHEDULED until it is paid, then ACTIVE;
  `recordAsPaid` records it as paid (only when the user says it really was). Pass an
  `idempotencyKey` and reuse it on a retry so it never bills twice. This is never covered by
  Gate 1: it needs its own approval (`ADD_PACKAGES_TO_SUBSCRIPTION` — named packages, named
  customer, the amount), asked alone.
  Other refusals: `SUBSCRIPTION_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `SUBSCRIPTION_NOT_ACTIVE`
  (on hold, ending, cancelled or free), `PACKAGE_ARCHIVED`, `IDEMPOTENCY_KEY_REUSED`.
- `clocknext_remove_subscription_package` — by default ends it **now**: what is left of it
  is taken back, nothing is refunded. `atPeriodEnd: true` ends it at the end of the paid
  period instead (MARKED_FOR_CANCELLATION until `endsAt`, then CANCELLED). The optional
  `reason` is kept as `cancelReason`. Ask the user which before removing.
  Refusals: `PACKAGE_NOT_FOUND`, `PACKAGE_ENDED`, `PACKAGE_AWAITING_PAYMENT` (it is SCHEDULED: void its
  invoice in the Clocknext product instead), `PACKAGE_ALREADY_ENDING`, `RENEWAL_PAID_IN_PART`,
  `CHARGE_IN_FLIGHT` and `USAGE_UNAVAILABLE` (both: retry shortly).

## Webhooks

`package.added` (it became active), `package.removal_scheduled` (removed with
`atPeriodEnd: true`) and `package.ended` (with `ended_reason`: `REMOVED`, `INVOICE_VOIDED`,
`PLAN_CHANGED` or `SUBSCRIPTION_CANCELLED`). An unpaid attach is announced by
`invoice.created`. `data.package` is snake_case: `id`, `package_id`, `name`, `status`
(SCHEDULED / ACTIVE / MARKED_FOR_CANCELLATION / CANCELLED), `cost`, the grouped
`entitlements` (`credits` / `outcomes` / `units` / `composites`: [{ id, name, quantity }],
`flat_fee`), `started_at`, `ends_at`, `ended_at`, `ended_reason`, `cancel_reason`,
`invoice_id`.

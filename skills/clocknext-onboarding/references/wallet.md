# Wallet — prepaid USD balance at raw cost

A **wallet** is **not** a catalogue entitlement — it's a **plan component**: a prepaid USD
balance the customer tops up, then burns down. Its defining property:

> **Wallet debits at the RAW model cost — NO margin.** You make no profit on wallet spend.

It's pure cost pass-through ("top up $X, spend it down at what the models actually cost"). Use it
when the customer wants a prepaid balance with no markup, or as the **funding source** for
wallet-funded metering (below).

## How a wallet signal debits (verified)
```ts
signals.wallet({ customerId, model, tokens: { input, output, cache } })  // SDK
// or POST /api/v1/signal/wallet  { customerId, usage: { model, inputTokens, outputTokens, cacheTokens } }  (REST)
```
    walletDebit = providedCost = (inputTokens·inputPrice + outputTokens·outputPrice + cacheTokens·cachePrice) / 1e6

No `agentKey` (it's not a named entitlement), no margin. Example: input 1,000 + output 500 tokens
at input `$3`/M, output `$15`/M → `(1,000·3 + 500·15)/1e6 = $0.0105` off the balance.

The balance (`walletBalanceUsd`) is a stored running total, updated atomically per call, and
**may go negative** — see below.

## Wallet-funded metered usage (`useWalletForArrear`) — the "use wallet" feature
By default a plan's **metered (ARREAR)** credit/outcome/unit usage is billed on a **separate
invoice at cycle end**. Turn on `useWalletForArrear` on the plan and that metered usage is instead
**drawn from the prepaid wallet as it happens**:

- **One invoice per cycle** — the wallet top-up. No separate arrear usage invoice.
- The wallet **may go negative** mid-cycle; the **next cycle's ADVANCE top-up absorbs the
  negative balance** (e.g. −$20 balance + $100 top-up = $80).
- Note the debit basis differs from a plain wallet signal: wallet-funded **ARREAR credit** debits
  the **customer cost (margin included)** — `creditsUsed × pricePerCredit`; a wallet-funded
  **ARREAR outcome** debits `pricePerOutcome` on completion. (A plain `type:"wallet"` signal is
  still raw cost.) So margin *is* earned on wallet-funded credit/outcome usage — it's the metering
  path that moves to the wallet, not the pricing.

### The three backend rules (a 400 if any fails)
`useWalletForArrear: true` is accepted only when the plan has:
1. **at least one ARREAR** credit/outcome/unit/composite component (something to fund), **and**
2. a **WALLET** component (the funding source), **and**
3. that wallet is **ADVANCE** (a metered/ARREAR wallet would bill the same negative balance twice).

## Set it up
- As a plain prepaid balance: add a **WALLET component** to the plan with an `amount` (USD), in
  **ADVANCE** mode. See [`plans.md`](plans.md).
- As wallet-funded metering: add that ADVANCE wallet **plus** ≥1 ARREAR credit/outcome/unit, and
  set `useWalletForArrear: true` on the plan (`clocknext_create_plan` / `_update_plan`).

## Confirming balances
`clocknext_get_customer_balances` shows the wallet balance (which can be negative on a
wallet-funded plan). There's no separate wallet-transaction read tool in the MCP.

## Common mistakes
- **Expecting margin on plain wallet spend.** There is none — it's raw cost by design.
- **`useWalletForArrear` with a metered (ARREAR) wallet, or with no wallet / no arrear meter.**
  The backend rejects all three — see the rules above.
- **Confusing the wallet with a credit.** A credit carries margin and is drawn in *credits*; a
  wallet is at-cost USD. Different blocks. See [`credit.md`](credit.md).

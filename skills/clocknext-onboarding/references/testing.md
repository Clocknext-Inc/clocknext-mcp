# Proving it works

Always preflight the wiring read-only before real traffic, then read the state back.
Prefer **sandbox**
(`clocknext_whoami` confirms sandbox vs live) — but if the user chose live in S2,
run the same sequence there without re-litigating the org choice (SKILL.md S2); the
two money gates are the guardrails.

1. **Confirm the wiring** — `clocknext_get_customer_plan` shows the customer's active plan;
   check it's the one you expect **before** firing anything. This corresponds to S27 in
   `SKILL.md`, not a separate permission to send a real signal.
2. **Preflight the references** — read-only, bills nothing: `clocknext_list_models` (the
   model is enabled) and `clocknext_get_credit` / `get_outcome` / `get_unit` (every
   `agentKey` your code sends resolves and is sold on that plan). These are the two
   mis-wires that ingest will NOT report: the route answers `202`, and the edge then keeps a
   bad reference as a Pending signal (for example `UNKNOWN_CREDIT`), so nothing surfaces at
   the call site. Fix any mismatch here.

   This confirms every reference resolves; it does **not** price your exact signal, so it
   cannot prove the cost. The MCP has no tool that prices one — the real signal in step 3
   is the first thing that validates the whole path.
3. **One real signal** — ⛔ **money gate 2: ask first, alone, and wait** (the purchase
   approval did NOT authorize this — a real signal draws down a real balance). Only after
   that yes, run **the product's own code path** so a real signal fires for the dummy
   customer. There is no MCP tool that records usage — the MCP never sends or prices a
   signal; the edge prices it — so the product's SDK call is the only way, and it is also the point: only real
   traffic through your own code proves the wiring end-to-end.
4. **Read it back** (why: a signal that "sent" isn't proof — ingest is **asynchronous**, so
   a signal your code accepted can still stay Pending downstream, e.g. an `agentKey` that
   matches nothing. You confirm it *landed and produced the expected usage record*):
   - The SDK's `signals.list({ customerId, status: "PENDING" })` → must be empty. A Pending
     signal did not bill. Its `error.message` names the cause; fix it, then send it again
     with `signals.retry([signalId])` and read back again.
   - The SDK's `signals.usageLog({ customerId })` → the log landed with the expected model,
     tokens, cost. The MCP has no usage-read tool.
   - `clocknext_get_customer_balances` → credits/outcomes drew down as expected.
   - For **Units**, read Unit usage/event counts through the product SDK/API's supported Unit
     usage endpoint. The MCP does not expose a Unit-event read tool, and an ARREAR Unit may
     have no balance to decrement, so never use balance alone as proof of a Unit event.
5. If anything is off, fix it and re-run the preflight first.

**Done** = a real signal shows up with the right cost; credit/outcome balances move where
applicable, and Unit usage counts/events show the expected event.
Only then offer to promote to live / wire real customer onboarding.

---
name: clocknext-onboarding
description: >-
  Guide a product end-to-end onto Clocknext usage-based billing using the Clocknext MCP
  tools — detect and enable the models it uses, create entitlements (credits / outcomes /
  units) and a plan, then meter every billable call in the codebase and prove it with a
  dummy customer and live signals. Runs as a strict one-state-per-turn state machine — for
  every setup step the user chooses Manually in the Clocknext or Set it up using AI,
  automatic execution never means automatic progression, and two hard money gates
  guard anything that spends real money. Use whenever the user is doing anything with
  Clocknext — setting up billing, creating or pricing credits/outcomes/units/plans, adding
  models, metering or charging for LLM/API calls, wiring agentKey or customerId into their
  app, or onboarding customers. If the request has nothing to do with Clocknext, ignore
  this skill.
---

# Onboard a product onto Clocknext usage-based billing

Take a product from "nothing metered" to "billed, tested, and live". Everything the MCP
writes is **real org state** — and a purchase raises a **real invoice** — so this flow is a
**strict state machine**: you are always in exactly ONE state, you execute only that state,
and you advance only on the user's answer. This is a one-on-one interview with a finance/ops
person, not a pipeline.

## When this runs
Any Clocknext work: setting up billing, adding models, creating/pricing entitlements or
plans, metering calls, wiring the SDK/API into a codebase, or onboarding customers. If a
request isn't about Clocknext, **ignore this skill entirely**.

## PRIME INVARIANT — AUTOMATIC EXECUTION DOES NOT MEAN AUTOMATIC PROGRESSION

> **"Automatic" means: use the MCP to execute the CURRENTLY APPROVED step instead of the
> Clocknext product. It does NOT mean: run the workflow automatically.**

When the user picks Set it up using AI — or says "auto mode", "just do it", "you handle it", "I
trust you" — that choice applies to **exactly one state**: the one the immediately
preceding question was about. After that MCP operation completes you MUST stop, report,
and ask the next single question, exactly as if they had chosen Manually in the Clocknext.

Concretely, *"use automatic"* must NEVER cascade into: enable all models → create all
entitlements → create the plan → create the customer → make the purchase → fire usage
signals. Each of those is its own state with its own question. **Automatic changes WHO
executes a step. It never changes WHEN you stop.**

## THE TURN PROTOCOL (every turn, no exceptions)

1. **ANNOUNCE** the current state and why it's needed — one plain sentence.
2. **EXECUTE** only the current state.
3. **REPORT** what you found or changed.
4. **ASK exactly ONE question** — the decision the next state needs.
5. **STOP.** Do not enter the next state. Wait.

When a setup method is needed, bring back both options in the same single question:
**Manually in the Clocknext** (give the exact page and entries) or **Set it up using AI**
(name the one MCP operation). Do not ask that method question alongside a design choice,
approval, or a second setup decision. Present the options again for the next operation;
never carry a prior choice forward.

## EXECUTION CONTRACT — THE ENFORCEMENT MODEL

Treat the conversation as a resumable run, not as permission memory. On every turn, derive
or maintain this state record before acting:

```yaml
current_state: S5_DISCOVER_CODEBASE_MODELS
state_data: {}                 # verified facts only
pending_action: null           # or one exact action awaiting approval
completed_states: []
execution_mode: manual         # manual or automatic for the current action only
```

When an action needs approval, `pending_action` must contain all of the following before the
question is asked:

```yaml
pending_action:
  id: stable-run-action-id
  operation: ENABLE_ONE_MODEL
  target: provider/model
  arguments_summary: exact non-secret arguments
  side_effect: what changes in Clocknext or the codebase
  approval_scope: this action only
```

The user's answer may approve or reject only that `pending_action.id`. “Yes,” “continue,”
“automatic,” and blanket permission are invalid if no matching pending action exists. On
approval, execute exactly that action, persist its result, clear `pending_action`, advance
to the next state, ask one new question, and stop. Never reuse an approval ID for another
target.

For every state, internally follow this contract:

```text
ANNOUNCE state and purpose
READ verified state_data
EXECUTE only the current state's read or one approved write
REPORT facts/result
CREATE at most one next pending_action/question
STOP
```

A state transition is not authorization. Only the matching pending action authorizes a write.
If the process resumes after interruption, reload this record and re-verify state with tools;
do not infer completion from chat text. This mirrors durable human-approval workflows where
approval is attached to one tool call and the run is resumed from persisted state.

Gate 1 is the one deliberate composite exception in business wording: its pending action is
`TEST_CUSTOMER_AND_SUBSCRIBE_TRANSACTION`, targeting one named throwaway customer, one named
plan, and one displayed invoice amount. It is one financial transaction approval, not two
independent decisions. Because the turn protocol still forbids two writes in one turn, S18 and
S19 execute its customer and subscription phases in separate turns; the S18 transition question
only sequences the already-approved transaction and never expands its target or creates a new
money gate. Real usage is always a separate `REAL_USAGE_SIGNAL` pending action at Gate 2.

Authorization rules (MUST):
- **An answer authorizes ONLY the state the immediately preceding question was about.**
- "yes", "ok", "continue", "go ahead", "do everything", blanket pre-approvals, and
  auto / full-permission / bypass mode authorize NOTHING beyond that one state.
  Permission modes silence tool prompts — **never decisions**. All of this applies
  identically when the harness runs you unattended.
- **Never two state-changing (write) actions in one turn.** Read-only work — codebase
  scans, `list_*` calls, docs reads, read-back verification of a write you just
  made — may happen inside ANNOUNCE/REPORT, but a write always ends the turn's EXECUTE.
- **Use the harness's native question/options tool whenever one is available.** This is
  mandatory for every decision state and setup-method choice (for example, use
  `AskUserQuestion` in a harness that provides it). Provide the complete set of
  user-facing options through that tool. If the harness has no question tool, fall back to
  one plain-language question in the response. Keep exactly one question per dialog: never
  combine independent decisions, and a money gate (S17/S28) shares its dialog with NOTHING.
- **A setup-method pick never carries forward.** It applies to the state it was asked
  for; offer the choice fresh at the next state-changing state (briefly — within a single
  state, don't re-litigate a pick). The user may choose Manually in the Clocknext on one
  step and Set it up using AI on the next.
- A setup-method question must name the single operation it controls. The user's answer
  authorizes only that named operation, even when execution is described in the next state
  row. The next turn may execute that operation and nothing else; it must not ask for a
  second approval for the same operation or infer approval for any later operation.
- A state with no decision of its own still gets its announce-before and report-after.

## THE STATE MACHINE

⚙ work state (execute + report) · ⏸ decision state (ask ONE question, wait) ·
⛔ money gate (its question is asked ALONE — nothing else in the dialog).

| # | State | What happens |
|---|-------|--------------|
| S1 | ⚙ CHECK_ENVIRONMENT | `clocknext_whoami` → org, sandbox or live, why it matters. |
| S2 | ⏸ CONFIRM_SANDBOX_OR_LIVE | One question: build here, or sandbox first? Respect the answer; never re-litigate. |
| S3 | ⚙ RECONCILE_EXISTING_STATE | Read models, entitlements, plans, customers, and existing purchases/subscriptions before creating or charging anything. |
| S4 | ⏸ CHOOSE_MODEL_SETUP_METHOD | Ask one question: How would you like to set up model support: Manually in the Clocknext (`{base}/settings/models`) or Set it up using AI? |
| S5 | ⚙ DISCOVER_CODEBASE_MODELS | Exhaustive scan; after reporting, create approval for exactly one first model. Do not enable here. |
| S6 | ⚙ ENABLE_MODELS | Enable or verify exactly one approved model per turn; loop until the complete approved model set is reconciled. |
| S7 | ⚙ ENTITLEMENT_DESIGN | Docs-grounded explanation of credit/outcome/unit/composite in the product's terms + recommendation. |
| S8 | ⏸ ENTITLEMENT_SELECTION | Which entitlement (type + what it bills) does the user want first? |
| S9 | ⚙ ENTITLEMENT_SKETCH | Sketch it BEFORE creating: mixer values, pricing assumptions, remaining decisions one per turn. |
| S10 | ⏸ CHOOSE_ENTITLEMENT_CREATION_METHOD | Ask one question: How would you like to create the named entitlement: Manually in the Clocknext or Set it up using AI? For credits and outcomes, recommend Manually in the Clocknext because it shows a live price preview. |
| S11 | ⚙ CREATE_ENTITLEMENT | Execute the chosen method, active. Report the grounded price. |
| S12 | ⏸ REPEAT_OR_MOVE_TO_PLAN | Another entitlement, or move on to the plan? (Loop to S8.) |
| S13 | ⚙ PLAN_DESIGN | Reuse/adjust an existing plan, or design new — one detail per question, one turn each. |
| S14 | ⏸ CHOOSE_PLAN_CREATION_METHOD | Ask one question: How would you like to create or update the named plan: Manually in the Clocknext (`{base}/plans` builder) or Set it up using AI? |
| S15 | ⚙ CREATE_PLAN | Execute exactly one approved plan creation/update; loop for further changes only through a new decision. |
| S16 | ⏸ CHOOSE_TEST_CUSTOMER_METHOD | Ask one question: How would you like to create this test customer: Manually in the Clocknext at `{base}/customers` or Set it up using AI? |
| S17 | ⛔ MONEY_GATE_1 | The purchase question, asked ALONE, after the customer method is chosen. |
| S18 | ⚙ CREATE_TEST_CUSTOMER | `list_customers` first (collision check); create or verify only the approved throwaway customer. Customer only — NOT the purchase. |
| S19 | ⚙ PURCHASE_OR_SUBSCRIBE | `clocknext_create_purchase` — the invoice-raising step Gate 1 approved. Say so. |
| S20 | ⚙ DISCOVER_ALL_BILLABLE_CALLS | Exhaustive billable-call scan of the whole codebase. |
| S21 | ⏸ MAP_EACH_CALL_TO_ENTITLEMENT | One call site per question; remain here until every discovered site has a confirmed entitlement mapping. |
| S22 | ⏸ CHOOSE_METERING_METHOD | Ask one question: How would you like to make this code change: Manually in the Clocknext (I’ll give you the exact files and edits to make yourself) or Set it up using AI? |
| S23 | ⚙ CODE_METERING | Implement exactly one approved call-site mapping per turn; loop until every mapped site is implemented and verified. |
| S24 | ⚙ PREPARE_ENV_FILES | After explicit approval, add only the `.env.example` placeholder and verify `.env` is gitignored. |
| S25 | ⏸ CHOOSE_SERVER_ENV_METHOD | Ask one question: How would you like to add the server key: Manually in the Clocknext by copying it into the project's `.env`, or Set it up using AI with `clocknext_write_env`? |
| S26 | ⚙ SERVER_ENV_SETUP | Execute exactly the approved key-injection method. |
| S27 | ⚙ PREFLIGHT | Read-only wiring check: plan, model enabled, every agentKey resolves, balance available. Reads only, bills nothing. |
| S28 | ⛔ MONEY_GATE_2 | The real-signal question, asked ALONE. Gate 1 did NOT cover this. |
| S29 | ⚙ REAL_SIGNAL | Fire exactly one approved real signal. |
| S30 | ⚙ VERIFY_USAGE_AND_BALANCE | Read back usage and balances where applicable; prove credit/outcome/wallet logs and Unit event counts landed. |
| S31 | ⏸ CLEANUP | Offer cleanup in the Clocknext product (no MCP tool exists — never improvise one). |
| S32 | ⏸ REAL_CUSTOMER_ONBOARDING_DECISION | "Wire real customer onboarding now?" |

**Re-entry:** on resume, do NOT trust the conversation's claims about what happened — not
even your own earlier messages. Re-enter at S1, re-derive everything (S3), and fast-forward
only past states whose results you have re-verified with tools. Reconciliation is never
skippable.

**Manually in the Clocknext always means:** the exact Clocknext product deep-link (`{base}` URLs below; the full map
is `references/ui-links.md`), exactly what to enter, then one question asking whether the
user will confirm completion — and
you verify with the list tools before advancing. **Set it up using AI always means:** state exactly
what the MCP will create or change, get the approval for that step, execute only it, stop.

## State details

### S1–S2 · Environment
`clocknext_whoami`. Report the org and whether it's **sandbox** (a disposable twin — safe)
or **live** (purchases raise real invoices). Recommend sandbox for building and testing,
then ask S2's one question. If they choose live, respect it — the money gates are the
guardrails; don't nag (and `references/testing.md` follows the same rule).

### S3 · Reconcile
List models, credits, outcomes, units, plans, and customers. For each candidate test customer,
read its current plan/subscription with `clocknext_get_customer_plan`; if purchase history
cannot be read by MCP, direct the user to the Clocknext product and ask them to report any active or
scheduled purchase. Report what exists so everything downstream
reuses instead of duplicating. If an entitlement exists but is archived/inactive, the fix
later is `clocknext_unarchive_credit`/`_unit`/`_outcome`/`_plan` — NOT an update:
**no update tool takes `isActive` — archive / unarchive are the only way to change active
state.** NEVER create a second entitlement on an occupied agentKey — agentKeys are
unique org-wide.

Do not select or reuse a customer in S3. The proof flow creates one newly named throwaway
customer later; existing customers and their plan state are reported for collision awareness.

### S4–S6 · Model setup
S4 asks one question: “How would you like to set up model support: Manually in the Clocknext
or Set it up using AI?” This method choice authorizes no
model change yet. S5 then scans the **entire** codebase and reports every provider/model
pair; do not enable models in S5. At the end of S5, create one pending action for the first
named model: Manually in the Clocknext asks the user to report when that model is enabled;
Set it up using AI asks for
approval to enable that exact model. S6 executes exactly that one pending action.

Do not batch model discovery with enabling them.
Scan the **entire** codebase for every model call: direct provider calls, wrappers, helper
functions, server actions, route handlers, background jobs, workers, queues, cron jobs,
agent/tool execution, retry paths, fallback models, secondary providers. Do not assume one
call site or one provider. Report the provider/model pairs and which are already enabled
(from S3). Discovery and enabling are **different states** — never enable in this turn.

S6 executes exactly the selected method for **one model only**:
- **Manually in the Clocknext** → tell them exactly which provider + model entry to enable, give the link,
  and ask: “Please tell me when this model is enabled.” STOP. When they report done, verify with
  `clocknext_list_models` and reconcile before advancing.
- **Set it up using AI** → call `clocknext_add_model` only after a pending action names exactly one
  approved model, read its price
  back, report it, ask whether to enable the next approved model, and STOP. Never call
  `clocknext_add_model` for two models in one turn. Stay in S6 until every approved model is
  individually enabled or explicitly rejected.

Watch for two things (say why each matters): **no catalog price** → the model meters at
**$0** — real usage, zero revenue; send them to `{base}/settings/models` to price it and
STOP until they confirm. **Not in the catalog** → it can't be metered; help pick a
supported model. Details: `references/pricing-and-models.md`.

### S7–S12 · Entitlements (loop until the user is happy)
S7: ground in the docs first (`clocknext_search_docs` → `clocknext_get_doc`),
then explain ALL FOUR types **in the product's own terms** and recommend a fit
(`references/entitlements.md` is the decision guide; open the deep reference before
pricing or explaining a type):
- **Credit** — token-metered balance drawn down by real token cost. Variable, token-shaped
  usage. Deep: `references/credit.md`.
- **Outcome** — billed once per *completed* multi-LLM-step deliverable. Every step is an
  LLM step; a non-LLM fixed-cost event is a UNIT, not an outcome step. Deep:
  `references/outcome.md`.
- **Unit** — fixed price per *event*, no tokens (upload, export, seat); FLAT or tiered
  (SLAB vs VOLUME differ a lot). Deep: `references/unit.md`.
- **Composite** — several of the above bundled and billed as ONE thing, per completed
  occurrence ("$2 per call", where a call is 2 credits + 4 units). Only offer it once the
  individual meters are settled — it is priced on top of them. Two steps, and the second is
  the one people forget: creating a composite charges nobody, a plan has to SELL it. Its
  `refId` is costly to change later (a rename silently cuts live traffic over), so confirm
  the whole definition before creating. Deep: `references/composite.md`.

S8 asks which they want (recommendation vs their own choice) — one question.
S9 **sketches before creating**: name, what it bills, the model mixer grounding (model,
avg tokens, input/output/cache/cache-write split estimated from the code) and the pricing assumptions,
in plain words. Any outstanding decision (e.g. the markup) is its own question, one per
turn. **Never create first and explain pricing afterward. Never invent a price, never
hand-type a token-metered base price — the mixer computes it** (live preview in the Clocknext product on
Manually in the Clocknext, `computeMixerBase` inside `create_credit`/`create_outcome` when
the user chooses Set it up using AI).
S10 asks one question — Manually in the Clocknext or Set it up using AI — for the **named
entitlement**. For credits and outcomes, recommend **Manually in the Clocknext** because the
Clocknext product shows a live price preview and stores the full per-model pricing bundle, which
the MCP path cannot (it stores only the final computed number) — that record makes later
re-pricing and audits far easier. Units are simpler; Set it up using AI is usually fine.
S11 carries out the selected creation method and creates the entitlement **active** (don't
stage inactive as a ritual — only build inactive if the user asks to review first). For the
manual path, give the exact entries to make in the Clocknext product and wait for the user's confirmation before
verifying. Report the grounded price.
S12 asks: another entitlement, or move to the plan? Loop to S8 until they're done.

> **Wallet** isn't one of the four — it's a plan component, not a catalogue entitlement:
> prepaid USD. Two debit rules,
> say them plainly: **plain wallet signals debit at raw model cost (no margin — no profit
> on wallet-metered spend), but wallet-funded metered usage (`useWalletForArrear`, S13)
> debits at the customer price — margin included, profit preserved.** Unit-FLAT (per
> event) ≠ plan-FLAT (one-off). Deep: `references/wallet.md`.

### S13–S15 · Plan
S13: if S3 found a plan that already fits, offer reuse or adjustment first (`get_plan`
then design the proposed full update — do not write it here). Otherwise design the new plan
**one detail per question, one turn each**: cycle,
then currency, then each component's up-front-vs-metered and quantity — asked in business
words ("billed up-front for the whole cycle, or charged as it's used?"), never as raw
fields. If the plan has both a prepaid wallet AND metered usage, offer wallet-funded
metering in plain words ("pay that metered usage straight out of the prepaid wallet as
it's used — one bill a cycle; the wallet can dip negative and the next top-up covers it —
instead of a separate end-of-cycle usage invoice?"); yes → `useWalletForArrear:true`
(needs ≥1 metered credit/outcome/unit AND an up-front wallet, else the backend rejects
it; margin is preserved — wallet-funded usage debits at customer price).
S14 asks one question — Manually in the Clocknext (`{base}/plans` builder — lean this way for
anything non-trivial) or Set it up using AI — for exactly one named `CREATE_PLAN` or
`UPDATE_PLAN` operation; this question
explicitly authorizes only that named operation in S15. S15 performs only that approved
creation or full-rewrite update, active, and reports the composition and due-at-purchase
total. A later plan change requires a new S13–S15 cycle and approval.
Details: `references/plans.md`.

### S16 · Choose test-customer method
Propose the exact throwaway customer identity first, for example name `Clocknext onboarding
test` and email `clocknext-onboarding-test+<unique-suffix>@example.invalid`. Ask one
question: Manually in the Clocknext or Set it up using AI to create this customer.
Manually in the Clocknext means those exact fields will be given
after Gate 1; Set it up using AI means approval to create only that named customer through
`clocknext_create_customer`. This choice authorizes only the named customer operation after
Gate 1; it does not authorize the purchase or any usage.

### S17 · ⛔ MONEY_GATE_1 — the purchase gate, asked ALONE
Before displaying the gate question, perform a fresh read-only reconciliation: refresh the
customer list to ensure the newly named throwaway will not collide with an existing customer,
and refresh the selected plan's details. Do not create or purchase during this refresh.
Ask exactly this, with the real amount substituted for `$X`, and nothing else in the dialog:

> *"The next step creates the customer and subscription. On a LIVE organization this raises
> a real $X invoice. Proceed?"*

STOP. This is one named financial transaction approval for the newly identified customer
creation plus subscription;
S18 and S19 are only its separate execution phases. No other customer, plan, or usage action
is included. It does NOT approve real usage — that is Gate 2.

### S16–S19 · Customer, then purchase (separate turns)
S18: `clocknext_list_customers` first and reconcile against S3. For Manually in the Clocknext,
provide the exact fields for the newly named customer and ask: “Please tell me when you can
see this customer in the Clocknext.” Do not call `clocknext_create_customer`. For Set it up
using AI, create only
the approved customer, report it, and ask: “May I move to the subscription phase of the
approved transaction?” STOP. For Manually in the Clocknext, when the user reports visibility,
verify it,
report it, and ask the same single phase-transition question. This is a sequencing question,
not a second money gate or a new financial scope. Do not purchase in S18.
S19 executes the approved subscription phase only after that transition answer: announce
that this is the invoice-raising phase already covered by Gate 1, call
`clocknext_create_purchase` — leave `autoPayment` unset/false for a test. An unpaid invoice
is never voided by its age, so say that the test invoice stays open until it is paid, or
until the user voids it manually in the Clocknext. Report the invoice id and amount,
ask one next-state question, and STOP. The transition question is not a new money gate.

### S20–S23 · Metering code
S20: **exhaustive** billable-call scan — the same completeness bar as S4 (wrappers,
helpers, server actions, routes, jobs, workers, queues, cron, agent/tool execution,
retries, fallback models, every provider). A missed call is silently un-billed revenue;
say that's why you're being thorough. Report every call site, then ask exactly one question:
“Shall I map the first listed call to an entitlement?” STOP.
S21: for **each** call site, ONE question: show the real entitlements **by name** and ask
which one this call should charge against. Never infer, never batch a mapping table. After
each answer, record only that mapping, report it, and ask whether to map the next discovered
call site. Remain in S21 until the complete inventory has an explicit user-confirmed
mapping; only then enter S22.
Internally that's its `agentKey` — the key never appears in the question, and it must come
from an existing entitlement, never invented. Outcomes map to the *step* key.
S22 asks one question — Manually in the codebase or Set it up using AI — for the specific
approved code change. The choice covers one implementation step only. Manually in the
codebase means provide exact files and edits for the user; Set it up using AI means
approval to change only that implementation step. After S23, return to S22 for each remaining
call site; never carry the method choice forward.
S23: decide SDK vs REST by the codebase (**JS/TS → `@clocknext/sdk`; anything else → the
REST API**), ground the exact call shapes in the docs (`clocknext_search_docs` →
`clocknext_get_doc` — never from memory), then write the integration **the recipe way**
(`references/code-metering.md`): one singleton client in async mode + `onError`, thin
per-meter helpers, one line for the current call site, shutdown flush. Do NOT hand-roll a
sync + try/catch wrapper. Pass a stable application-level idempotency key for retryable
logical events. Explain the choice so the user trusts the code. Implement and verify one
call site per S23 turn, then return to S22 until all mapped sites are complete. Ask whether
the user authorizes preparation of the environment files as the next separate state.

### S24 · Prepare environment files
S23 must first create a pending action named `PREPARE_ENV_FILES` whose target is the exact
project `.env.example` and `.gitignore` checks. Only after the user approves that pending
action may S24 add `CLOCKNEXT_API_KEY=` to `.env.example` and verify `.env` is gitignored.
This is a separate repository-preparation step; do not write the real key here. Report the
result and ask one question: whether to copy the key Manually in the Clocknext or Set it up
using AI in S25.

### S25–S26 · Server env
The `cnk_` key is a server-side secret: env/secret store only, never client-side, never
committed, and **never ask the user to paste it into the chat**. One question — Manually in
the Clocknext (they copy the same key they configured for this MCP server into the project's
`.env`) or Set it up using AI (`clocknext_write_env` writes it from the server's own environment; the key
never enters your context either way; the tool refuses non-gitignored files). S25's answer
authorizes only the named key-injection operation in S26. S26 performs exactly that method
and no `.env.example` or gitignore write; those were completed in S24.

### S27 · Preflight
Confirm the wiring with READ-ONLY tools before any money moves. Nothing here records or
bills:

1. `clocknext_get_customer_plan` — the customer is on the plan you expect.
2. `clocknext_list_models` — every model the code will send is enabled (an unknown
   `modelId` is the most common mis-wire).
3. `clocknext_get_credit` / `get_outcome` / `get_unit` — every `agentKey` the code will
   send actually resolves, and is sold on that plan. An `agentKey` matching nothing is
   the second most common mis-wire, and ingest will not tell you: the route answers
   `202` and the worker drops it later.
4. `clocknext_get_customer_balances` — there is allowance to draw against.

Report what you checked and what the first real signal is expected to cost, derived from
the catalogue prices you just read.

**Be honest about the limit of this check.** It confirms every *reference* resolves; it
does NOT price the exact signal, so it cannot prove the computed cost. The MCP has no
tool that prices a signal — the first thing that validates the full path is the real
signal in S29. Say so rather than implying the preflight is a guarantee.

Fix any mismatch here and re-run this state before ever reaching S28.

### S28 · ⛔ MONEY_GATE_2 — the real-signal gate, asked ALONE
Refresh the customer plan and relevant balance state read-only before displaying this gate.
Do not send a signal during the refresh.
Ask only this, nothing else in the dialog:

> *"The wiring checks out — the plan, model and agent keys all resolve. Nothing has
> been priced yet: this next signal is the real one, and it will actually draw down the
> customer's balance. Fire the real signal?"*

STOP. **The purchase yes did NOT cover this.** No earlier approval, blanket yes, or auto
mode substitutes for this question.

### S29 · Real signal
Fire exactly one approved signal **through the product's own code path** (the SDK call you
wired in). The MCP has **no record-usage tool** — it prices signals but never bills, so there
is nothing to fall back on and you must never improvise one. Report that the code ran, then
ask one question about entering verification. Do not read back usage in S29 — and do not
call the run itself proof: ingest is asynchronous, so "the code ran" is not "the signal
billed".

### S30 · Verify usage and balance
Separately read the usage log back through the product's SDK, `signals.usageLog({ customerId })`
(the log landed with expected model/tokens/cost) — the MCP has no usage-read tool — and call
`clocknext_get_customer_balances` (balance moved where applicable;
Unit event count changes are used for Units). Unit
consumption is confirmed through the product's supported Unit usage/event-count readback — the
MCP has no unit-event tool and an ARREAR Unit may have no balance decrement. “Sent” is not proof;
**the event landed and the expected count changed** is. Report proof, ask “Shall I move to
cleanup in the Clocknext product?” and STOP. Details: `references/testing.md`.

### S31 · Cleanup
Offer to clean up the test artifacts — and say plainly this happens **in the Clocknext
product, not via the MCP**: there is NO MCP tool to void an invoice or delete a customer, and you
must never improvise one. Link `{base}/customers`. If the user chooses cleanup, ask them to
report when it is complete; do not claim completion or advance until they report back. Then
reconcile the result from the Clocknext product in a new turn before entering S32.

### S32 · Real onboarding
Ask only: "Wire real customer onboarding now?" The answer authorizes only the decision to
start that process. If yes, enter a new design state in the next turn; do not add a schema
column, create customers, backfill, meter, preflight, or fire a signal in S32. Each of those
actions needs its own announced state, one question, and authorization; real usage still
requires Gate 2. A backfill creates each customer with its own `clocknext_create_customer`
call; there is no bulk import tool.

## Units are NOT LLM calls
"Meter every billable call" is about **credit / outcome / wallet** signals (token-priced).
A **unit is a per-event meter** — one event = one unit, no tokens. Units are configured in
the catalogue (S7–S11), but runtime unit signals fire **in the customer's product** via
`signals.unit()` (SDK) or `POST /api/v1/signal/unit` (REST) — **never through the MCP**, which
has no unit-usage recording or read tool.

## Writing style — talk like a human, not a schema
The user is a finance/ops person. Every question must work with zero knowledge of
Clocknext internals: "billed up-front", "charged as used", "prepaid wallet", "which
entitlement should this charge against", "which model", "which plan". Bad: *"Which
agentKey?"*, *"ADVANCE or ARREAR?"*. Good: *"Should this call charge against **AI
Credits** or **Research Outcome**?"* Terms like `agentKey`, `marginPercent`,
`billingMode`, and the input/output/cache split are for you and the MCP — keep them out
of questions, and map plain-language answers to the fields yourself. Narrate every move:
one sentence of purpose before each action; no silent state-changing tool calls.

## Worked examples (the shape to copy)

**1 — Sandbox selection (S1→S2):**
> **You:** "You're on the **SANDBOX** org 'Acme' — a disposable twin where no real money
> can move; live is where purchases raise real invoices. Build and test here on sandbox
> (my recommendation), or switch to live?" ⏸
> **User:** "Sandbox."

**2 — Model setup choices (S4→S5→S6):**
> **You:** Use the harness's native question/options tool: "How should I set up model
> support?" Options: **Manually in the Clocknext** or **Set it up using AI**. ⏸
> **User:** "Manually in the Clocknext."
> **You:** "I’ll now scan the whole codebase for every provider/model pair; I will not
enable anything in this scan." → *scan* → "I found **OpenAI / gpt-4o** and **OpenAI /
text-embedding-3-small**. Please enable **OpenAI / gpt-4o** in `{base}/settings/models`
and tell me when that one model is enabled." ⏸
> **User:** "Done."
> **You:** "I verified gpt-4o. Please enable **OpenAI / text-embedding-3-small** and tell
me when that one model is enabled." ⏸
<!-- legacy examples removed -->
<!-- no legacy workflow content -->
<!-- no legacy workflow content remains -->
<!-- no legacy example -->
<!--
-->

**3 — Set it up using AI (S4→S5→S6):**
> **User:** "Set it up using AI."
> **You:** "I’ll scan the whole codebase first, even when you choose Set it up using AI." →
*scan* → "I found **OpenAI / gpt-4o** and **OpenAI / text-embedding-3-small**. May I
enable the first approved model, **gpt-4o**?" ⏸
> **User:** "Yes."
> **You:** → `clocknext_add_model` for gpt-4o → "gpt-4o is enabled and priced. Should I
enable the next approved model, **text-embedding-3-small**, using AI?" ⏸
> *(The next answer authorizes only that next model; no entitlement or plan work occurs.)*

**4 — Entitlement selection (S7→S8):**
> **You:** "Your product's billable action is the chat answer — variable, token-shaped
> usage. That fits a **credit** (a balance each answer draws down by what it really
> cost, plus your markup). A fixed price per finished multi-step job would be an
> **outcome**; a fixed price per simple event, a **unit**. Want to go with credits for
> the chat answers, or would you like to weigh the other two?" ⏸
> **User:** "Credits."

**5 — Entitlement creation choices (S9→S10→S11):**
> **You:** "Sketch before anything is created: **'Chat Credits'**, grounded on gpt-4o at
> ~4,000 tokens per typical answer (85% input / 12% output / 3% cached, read from your
> code) — the MCP must calculate the live raw cost; never type a base price. Your markup
> goes on top. How much markup do you
> want over raw model cost?" ⏸
> **User:** "30%."
> **You:** "30% it is — the live pricing mixer will calculate the final amount. Two ways to create it: **Manually in the Clocknext**
> (`{base}/credits` — I'll spell out exactly what to enter; the live
> preview also stores the full per-model pricing bundle, which makes re-pricing and
> audits easier — that's my lean), or **Set it up using AI** (same grounded math,
> stores only the final number). Which do you prefer?" ⏸
> **User:** "Set it up using AI."
> **You:** "Your answer authorizes creation of this one named Chat Credits entitlement via
> MCP. I’ll create only that entitlement now." → `clocknext_create_credit` → "Created and active at the MCP-calculated live price,
> grounded in gpt-4o's live rates. Do you want another entitlement, or shall we move on
> to the plan?" ⏸

**6 — The two money gates, separate (S17, then S28):**
> **You (S17, alone):** "The next step creates the customer and subscription. On a LIVE
> organization this raises a real $X invoice. Proceed?" ⏸
> **User:** "Yes."
> → *customer turn, purchase turn, mapping, code, env, preflight — each its own turn* →
> **You (S28, alone):** "The wiring checks out and the catalogue price for the selected
> plan is $X. The next signal is real: it will actually draw down the customer's balance.
> Fire the real signal?" ⏸
> **User:** "Yes."
> → *fire ONE signal, read back, report proof.*

## Adversarial sequential tests

Before releasing or changing this skill, mentally execute these transcripts. A compliant
agent must reject the forbidden progression in every case:

| Test input | Required behavior |
|---|---|
| “Set it up using AI.” with no pending action | Ask which exact operation and target should be approved; perform no write. |
| AI approval for `gpt-5` followed by an attempt to enable `claude` | Reject the second write; its target has a different approval ID. |
| “Continue” after model discovery | Execute only the pending first-model action, not entitlements or plans. |
| Gate 1 approval followed by a real usage signal | Reject it; Gate 2 `REAL_USAGE_SIGNAL` is still pending. |
| Manually in the Clocknext customer choice | Give exact fields and ask the user to confirm visibility; never call `clocknext_create_customer`. |
| One mapped call site with three remaining | Stay in `MAP_EACH_CALL_TO_ENTITLEMENT`; do not enter code metering until all mappings are confirmed. |
| Retry the same credit/outcome event | Reuse the same logical idempotency key; never generate a new event key per attempt. |
| Retry a Unit event | Explain that Unit has no idempotency-key field; use the product's supported deduplication/idempotency boundary and verify via Unit usage counts, not balance alone. |
| Resume after interruption with `pending_action` present | Reconcile the action ID, target, and arguments before execution; do not trust the transcript. |
| “Do everything” or “auto mode” | Treat it as no authorization beyond the current named pending action. |

Each test has one allowed side effect at most. The expected result is a pause, a persisted
state transition, and exactly one next question.

## Self-check before you end ANY turn
- Did this turn execute **one** state, with at most one write?
- Is there exactly **one** question below, in one dialog, in business language?
- If it's a money gate: is the question **alone**, with the real amount?
- Did any write happen that the immediately preceding answer didn't authorize?
- If the user picked Set it up using AI earlier: did I treat it as execution-only, not progression?
- On resume: did I re-verify state with tools instead of trusting the conversation?

If any answer is wrong, fix the turn before sending it.

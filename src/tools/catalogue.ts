import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClockNextApi } from "../api";
import { errMsg, errorResult, jsonResult } from "./util";

/**
 * Operate-mode catalogue tools — CRUD (create / read / update / archive) over the
 * /api/v1 catalogue resources: plans, credits, outcomes, units. These MUTATE the
 * organisation's billing configuration, so they go through the MCP's own API
 * client (`src/api.ts`) rather than letting a model assemble raw API calls.
 *
 * Credit / outcome PRICING is model-grounded: the tool takes a `models` mixer
 * (enabled catalog model + avg tokens + input/output/cache/cache-write split),
 * checks it against the org's live models via list_models, and sends it as the
 * credit's / step's `modelBundle`. The SERVER works the base price out from that
 * bundle (and refuses a credit or new step without one) — an agent can never
 * hand-type an ungrounded price here. (The ClockNext product's mixer is still
 * the preferred, first-class way to price — it previews live; these tools are
 * the fallback and save the same bundle.)
 *
 * Every update tool is a PARTIAL update, like the API behind it: send the id
 * plus only the fields to change; everything left out keeps its stored value.
 *
 * "Archive" maps to `setActive(id, false)` — a reversible deactivation, NOT a hard
 * delete (hard delete exists on the API but is intentionally not exposed here).
 */

// ---------- shared field schemas ----------

/** One line of a pricing mixer: an enabled catalog model + how many tokens it
 *  uses on average, split across input/output/cache/cache-write as PERCENTAGES
 *  that total 100. The 100% rule is enforced here (refine) so a bad split is
 *  rejected at parse. */
const mixerLine = z
  .object({
    model: z
      .string()
      .min(1)
      .describe(
        "Enabled catalog model id from clocknext_list_models (e.g. 'gpt-4o'). Grounds the price in that model's live per-1M-token cost.",
      ),
    avgTokens: z
      .number()
      .positive()
      .describe("Average TOTAL tokens per credit / per step (input + output + cache combined)."),
    inputPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe("Percent of avgTokens that are input tokens (whole number)."),
    outputPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe("Percent that are output tokens (whole number)."),
    cachePct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(0)
      .describe("Percent that are cache-READ tokens (whole number). Default 0."),
    cacheWritePct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(0)
      .describe(
        "Percent that are cache-WRITE tokens (whole number). Default 0. Only for a model that has a cache-write price (cacheWritePrice in clocknext_list_models); must be 0 otherwise.",
      ),
  })
  .refine(
    (l) => l.inputPct + l.outputPct + (l.cachePct ?? 0) + (l.cacheWritePct ?? 0) === 100,
    { message: "inputPct + outputPct + cachePct + cacheWritePct must total 100." },
  );

type MixerLine = {
  model: string;
  avgTokens: number;
  inputPct: number;
  outputPct: number;
  cachePct?: number;
  cacheWritePct?: number;
};

/**
 * One saved line of the ClockNext product's pricing calculator — the same shape
 * the product stores on a credit / outcome step as `modelBundle`. The server
 * prices the credit / step from it, and it is what makes the calculator show
 * the chosen models, their average tokens and the input / output / cache /
 * cache-write split when the credit is opened in the product.
 * `modelId` names the model the same way a usage signal's `usage.model` does
 * (`modelId` from GET /api/v1/models).
 */
type BundleEntry = {
  modelId: string;
  modelName: string;
  /** The line's token count — `averageTokensPerLLMCall` on the wire. */
  averageTokensPerLLMCall: number;
  input: number;
  output: number;
  cache: number;
  cacheWrite: number;
};

/**
 * Turn a mixer into the `modelBundle` the server prices from, checking it
 * against the org's LIVE models first so the agent gets an actionable message:
 * a model that isn't enabled / is turned off, a split that doesn't total 100,
 * or a cache-write share on a model with no cache-write price are refused here.
 * Also works out the base price (USD) the server will arrive at, so a bundle
 * that would price at $0 is caught before it is sent.
 */
async function computeMixerBase(
  cnk: ClockNextApi,
  lines: readonly MixerLine[],
): Promise<
  | { ok: true; basePrice: number; bundle: BundleEntry[] }
  | { ok: false; error: string }
> {
  let models;
  try {
    models = await cnk.workspace.models({});
  } catch (err) {
    return { ok: false, error: `Could not load models to price against: ${errMsg(err)}` };
  }
  const byId = new Map(models.map((m) => [m.modelId.toLowerCase(), m]));

  let basePrice = 0;
  const bundle: BundleEntry[] = [];
  for (const line of lines) {
    const m = byId.get(line.model.toLowerCase());
    if (!m) {
      return {
        ok: false,
        error: `Model "${line.model}" isn't enabled in this workspace — enable it with clocknext_add_model, or check clocknext_list_models for the exact id.`,
      };
    }
    if (!m.isActive) {
      return {
        ok: false,
        error: `Model "${line.model}" is turned off — re-enable it before pricing against it.`,
      };
    }
    const cachePct = line.cachePct ?? 0;
    const cacheWritePct = line.cacheWritePct ?? 0;
    const total = line.inputPct + line.outputPct + cachePct + cacheWritePct;
    if (total !== 100) {
      return {
        ok: false,
        error: `For model "${line.model}", inputPct + outputPct + cachePct + cacheWritePct must total 100 (got ${total}).`,
      };
    }
    const cacheWritePrice = typeof m.cacheWritePrice === "number" ? m.cacheWritePrice : null;
    if (cacheWritePct > 0 && cacheWritePrice === null) {
      return {
        ok: false,
        error: `Model "${line.model}" has no cache-write price, so its cacheWritePct must be 0.`,
      };
    }
    // Prices are USD per 1,000,000 tokens (same basis as the pricing engine).
    const perToken =
      (line.inputPct / 100) * m.inputPrice +
      (line.outputPct / 100) * m.outputPrice +
      (cachePct / 100) * m.cachePrice +
      (cacheWritePct / 100) * (cacheWritePrice ?? 0);
    basePrice += (line.avgTokens * perToken) / 1_000_000;

    bundle.push({
      // The model's stored id, not the agent's spelling (the lookup ignores case).
      modelId: m.modelId,
      modelName: typeof m.modelName === "string" ? m.modelName : line.model,
      averageTokensPerLLMCall: line.avgTokens,
      input: line.inputPct,
      output: line.outputPct,
      cache: cachePct,
      cacheWrite: cacheWritePct,
    });
  }
  return { ok: true, basePrice, bundle };
}

// Plan component: flattened discriminated union. Every optional id / amount /
// quantity field also takes null, because that is how clocknext_get_plan reads
// them back (rollover always reads back as a boolean) — so a
// plan's entitlements can be sent straight back to clocknext_update_plan.
// The per-type rules below are
// enforced by the server, not here: a missing/duplicated field, an id that
// resolves to nothing, or an archived item newly added are all a 400
// ValidationError ("Pick a credit.", "One or more credits don't exist in this
// workspace.", "The credit … is archived …"), surfaced through errMsg with the
// status intact, so the field notes only have to guide the agent, not gate it.
const planComponent = z
  .object({
    type: z
      .enum(["WALLET", "FLAT", "CREDIT", "OUTCOME", "UNIT", "PRICING_METRIC"])
      .describe(
        "The meter type of this entitlement line. PRICING_METRIC is a COMPOSITE — the product word is 'composite' but the stored enum and the wire value are still the older name, so send PRICING_METRIC and expect it back.",
      ),
    billingMode: z
      .enum(["ADVANCE", "ARREAR"])
      .describe(
        "ADVANCE bills up-front for the cycle (grants amount/quantity); ARREAR meters and bills what was consumed.",
      ),
    amount: z
      .number()
      .nullish()
      .describe(
        "WALLET or FLAT only (USD). FLAT = one-off fee, REQUIRED and above 0. WALLET + ADVANCE = prepaid balance granted each cycle; $0 is allowed (e.g. a wallet carried only to fund metering). Plain wallet signals debit it at raw model cost — no margin; wallet-funded ARREAR usage debits it at customer price, margin included.",
      ),
    creditId: z
      .string()
      .nullish()
      .describe("CREDIT only: id of an existing, active credit (clocknext_list_credits)."),
    outcomeId: z
      .string()
      .nullish()
      .describe("OUTCOME only: id of an existing, active outcome (clocknext_list_outcomes)."),
    unitId: z
      .string()
      .nullish()
      .describe("UNIT only: id of an existing, active unit (clocknext_list_units)."),
    compositeId: z
      .string()
      .nullish()
      .describe(
        "PRICING_METRIC only: id of an existing, active COMPOSITE (clocknext_list_composites). Plans read back with this same field, so a get_plan → update_plan round-trip keeps it. This component is the ONLY thing that makes a composite bill — the catalogue entry alone charges nobody.",
      ),
    pricingMetricId: z
      .string()
      .nullish()
      .describe("Older name for compositeId, still accepted. Prefer compositeId."),
    quantity: z
      .number()
      .nullish()
      .describe(
        "CREDIT/OUTCOME/UNIT/PRICING_METRIC + ADVANCE only: the quantity granted each cycle (whole number; 0 is allowed and is the default — the entitlement exists and can be topped up by hand). Omit for ARREAR (metered). For PRICING_METRIC + ADVANCE it is a prepaid POOL of composite-occurrence slots shared across the wrapped items: each distinct tag value claims one slot on completion, repeats reuse it; running past the pool is allowed and carries as debt into the next cycle.",
      ),
    rollover: z
      .boolean()
      .optional()
      .describe(
        "ADVANCE CREDIT/OUTCOME/PRICING_METRIC/WALLET only: carry what's left this cycle into the next one instead of resetting. Default false. Ignored (stored false) for UNIT, FLAT, ARREAR lines, and on FREE plans.",
      ),
  })
  .describe("One entitlement line in the plan.");

const unitTier = z.object({
  upTo: z
    .number()
    .nullable()
    .describe(
      "Upper bound of this tier (whole number, rising tier by tier). The LAST tier must be null ('and above'), and only the last.",
    ),
  price: z.number().describe("Price for this tier."),
});

// ---------- per-resource create input shapes ----------
// The update tools take the same fields, every one optional (see
// `partialShape`), because every update is a partial update.

const planInput: z.ZodRawShape = {
  name: z.string().describe("Plan name."),
  description: z.string().nullish().describe("Optional description."),
  billingCycle: z
    .enum(["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "YEARLY", "FREE"])
    .describe(
      "Billing cadence. FREE is a one-time grant with no invoice.",
    ),
  carryForward: z
    .boolean()
    .optional()
    .describe(
      "DEPRECATED — still accepted for back-compat but no longer read by the backend; setting it has no effect (carry-forward is fixed policy now: wallet money carries, allowances reset).",
    ),
  walletFundedArrear: z
    .boolean()
    .optional()
    .describe(
      "Wallet-funded metering. Default false. When true, every metered (ARREAR) CREDIT/OUTCOME/UNIT/PRICING_METRIC component is paid FROM the customer's prepaid WALLET as usage happens — one invoice per cycle — instead of a separate arrear invoice at cycle end. The wallet may go negative mid-cycle; the next cycle's wallet top-up absorbs the overdraft. Backend rejects it (400) unless ALL THREE hold: (1) the plan has at least one ARREAR credit/outcome/unit/composite component; (2) the plan has a WALLET component; (3) that WALLET component is billingMode ADVANCE (a metered/ARREAR wallet is refused as double-billing). Margin is PRESERVED: wallet-funded ARREAR usage debits the wallet at the CUSTOMER price (margin included) — only plain type:'wallet' signals debit at raw model cost with no margin.",
    ),
  priceAdjustment: z
    .number()
    .optional()
    .describe(
      "Signed rounding nudge (USD) on the plan's computed due-at-purchase price — negative discounts, positive adds (e.g. -0.01 to land on a round number). Default 0; coerced to 0 for FREE / all-ARREAR plans that have no advance total to round. Leave unset unless you need to tidy a rounding edge.",
    ),
  entitlements: z
    .array(planComponent)
    .min(1)
    .describe(
      "At least one entitlement line. CREDIT/OUTCOME/UNIT lines reference an existing resource by id, and PRICING_METRIC references an existing composite by compositeId — create those first. The plan's currency is the workspace's primary currency; it isn't set here.",
    ),
};

const creditInput: z.ZodRawShape = {
  name: z.string().min(1).describe("Credit name."),
  agentKey: z
    .string()
    .min(1)
    .describe(
      "Stable key you report credit usage against (sent as `agentKey` when recording usage), saved and matched exactly as sent (case included). The credit's durable identity — chars [A-Za-z0-9._-]; a rename never changes it.",
    ),
  models: z
    .array(mixerLine)
    .min(1)
    .describe(
      "Model mixer that GROUNDS the price — one or more enabled catalog models with avg tokens + input/output/cache split. The tool reads live prices and computes the base cost; never type a raw price.",
    ),
  marginPercent: z
    .number()
    .min(-100)
    .describe(
      "Markup over the computed base cost, as a percent (100 = double the base = pricePerCredit; negative discounts, down to -100 = free).",
    ),
  description: z.string().nullish().describe("Optional human-readable description."),
};

const outcomeStep = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "UPDATE only: the existing step's id (from clocknext_get_outcome). Leave it out for a new step. A step sent without an id but with an existing step's agentKey is matched to that step anyway.",
    ),
  name: z.string().min(1).describe("Step name (unique within the outcome)."),
  agentKey: z
    .string()
    .min(1)
    .describe(
      "Stable key you report this outcome step against (sent as `agentKey` when recording usage), saved and matched exactly as sent (case included). Chars [A-Za-z0-9._-].",
    ),
  models: z
    .array(mixerLine)
    .min(1)
    .optional()
    .describe(
      "Model mixer grounding THIS step's price — REQUIRED for a new step. On update, leave it out to keep an existing step's current price. Every outcome step is an LLM step — a non-LLM, fixed-cost event is a UNIT, not an outcome step.",
    ),
});

const outcomeInput: z.ZodRawShape = {
  name: z.string().min(1).describe("Outcome name."),
  agentKey: z
    .string()
    .min(1)
    .describe(
      "The OUTCOME's own stable key — REQUIRED, unique org-wide, matched exactly (case included), chars [A-Za-z0-9._-]. Distinct from a step's agentKey and in a separate namespace: usage is still reported against a STEP's key, never this one. This identifies the outcome itself (mirrors a credit's agentKey); a rename never changes it.",
    ),
  description: z.string().nullish().describe("Optional human-readable description."),
  marginPercent: z
    .number()
    .min(-100)
    .describe(
      "Markup over the summed step base costs, as a percent (100 = double = pricePerOutcome; negative discounts, down to -100).",
    ),
  steps: z
    .array(outcomeStep)
    .min(1)
    .max(50)
    .describe("1–50 steps, each grounded by its own model mixer. Step names and agent keys must each be unique."),
};

const unitInput: z.ZodRawShape = {
  name: z.string().min(1).describe("Unit name."),
  agentKey: z
    .string()
    .min(1)
    .describe(
      "Stable key consumption is reported against (sent as `agentKey` when recording unit usage), saved and matched exactly as sent (case included). The unit's durable identity — unique org-wide, chars [A-Za-z0-9._-]; a rename never changes it.",
    ),
  pricingType: z
    .enum(["FLAT", "SLAB", "VOLUME"])
    .describe("FLAT = a single per-event price. SLAB/VOLUME = tiered pricing."),
  flatPrice: z.number().min(0).optional().describe("FLAT only: price per event. Default 0."),
  tiers: z
    .array(unitTier)
    .min(1)
    .max(50)
    .optional()
    .describe("SLAB/VOLUME only: 1–50 tiers, ordered by rising upTo; the last one (and only it) has upTo:null."),
  description: z.string().nullish().describe("Optional human-readable description."),
};

// ---------- the CRUD factory ----------

interface Api {
  list: (params: { active?: boolean }) => Promise<unknown>;
  get: (id: string) => Promise<unknown>;
  create: (input: unknown) => Promise<unknown>;
  update: (id: string, input: unknown) => Promise<unknown>;
  setActive: (id: string, active: boolean) => Promise<unknown>;
}

/** Transforms tool args into the API create / update payload — used by credit /
 *  outcome to turn a `models` mixer into a `modelBundle`. Returns an error
 *  string (surfaced to the caller) instead of throwing. */
type PriceInput = (
  args: Record<string, unknown>,
) => Promise<Record<string, unknown> | { error: string }>;

/** The update tools take the create fields with every one optional: an update
 *  is partial, so only the fields the agent sends change. */
function partialShape(shape: z.ZodRawShape): z.ZodRawShape {
  const partial: z.ZodRawShape = {};
  for (const [key, field] of Object.entries(shape)) {
    partial[key] = (field as z.ZodTypeAny).optional();
  }
  return partial;
}

/** The arguments the agent actually sent — `undefined` fields dropped, so a
 *  left-out field is left out of the PATCH body too. */
function definedOnly(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function registerCrud(
  server: McpServer,
  opts: {
    resource: string; // singular, e.g. "plan"
    plural: string; // e.g. "plans"
    api: Api;
    input: z.ZodRawShape;
    desc: { list: string; get: string; create: string; update: string; archive: string };
    /** Builds the create body from the tool args. */
    priceCreate?: PriceInput;
    /** Builds the (partial) update body from the tool args. */
    priceUpdate?: PriceInput;
  },
): void {
  const { resource, plural, api, input, desc, priceCreate, priceUpdate } = opts;

  server.registerTool(
    `clocknext_list_${plural}`,
    {
      title: `ClockNext: list ${plural}`,
      description: desc.list,
      inputSchema: {
        active: z
          .boolean()
          .optional()
          .describe(
            `Filter by active state: true = only active ${plural}, false = only archived ${plural}, omit = all.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ active }) => {
      try {
        const rows = await api.list(active === undefined ? {} : { active });
        // The API only special-cases `active=true`; `active=false` comes back
        // unfiltered. Filter here so the documented contract holds both ways
        // (a no-op for `true`, which the backend already narrowed).
        const filtered =
          active === undefined || !Array.isArray(rows)
            ? rows
            : (rows as { isActive?: boolean }[]).filter((r) => r.isActive === active);
        return jsonResult({
          count: Array.isArray(filtered) ? filtered.length : undefined,
          [plural]: filtered,
        });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    `clocknext_get_${resource}`,
    {
      title: `ClockNext: get ${resource}`,
      description: desc.get,
      inputSchema: { id: z.string().describe(`The ${resource} id.`) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await api.get(id));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    `clocknext_create_${resource}`,
    {
      title: `ClockNext: create ${resource}`,
      description: desc.create,
      inputSchema: input,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        let payload: Record<string, unknown> = definedOnly(args);
        if (priceCreate) {
          const priced = await priceCreate(args);
          if ("error" in priced) return errorResult(priced.error as string);
          payload = priced;
        }
        const res = await api.create(payload);
        return jsonResult(res ?? { ok: true });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    `clocknext_update_${resource}`,
    {
      title: `ClockNext: update ${resource}`,
      description: desc.update,
      inputSchema: {
        id: z.string().describe(`The ${resource} id to update.`),
        ...partialShape(input),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { id, ...rest } = args as { id: string } & Record<string, unknown>;
        let payload: Record<string, unknown> = definedOnly(rest);
        if (priceUpdate) {
          const priced = await priceUpdate(payload);
          if ("error" in priced) return errorResult(priced.error as string);
          payload = priced;
        }
        if (Object.keys(payload).length === 0) {
          return errorResult(`Nothing to update — pass the ${resource} id plus at least one field to change.`);
        }
        const res = await api.update(id, payload);
        return jsonResult(res ?? { ok: true });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    `clocknext_archive_${resource}`,
    {
      title: `ClockNext: archive ${resource}`,
      description: desc.archive,
      inputSchema: { id: z.string().describe(`The ${resource} id to deactivate (soft-archive — reversible, not a delete).`) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        const res = await api.setActive(id, false);
        return jsonResult(res ?? { ok: true, archived: id });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    `clocknext_unarchive_${resource}`,
    {
      title: `ClockNext: unarchive ${resource}`,
      description: [
        `Reactivate an archived ${resource} (sets isActive→true) — the reverse of clocknext_archive_${resource}. Same identity, same definition; nothing is re-priced or rewritten.`,
        "",
        "Rules:",
        `- This and clocknext_archive_${resource} are the only way to change active state — no update tool takes isActive.`,
        `- Prefer this over creating a replacement: agentKeys/identities are unique org-wide, so a parked ${resource} must be revived, never duplicated.`,
      ].join("\n"),
      inputSchema: { id: z.string().describe(`The ${resource} id to reactivate.`) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        const res = await api.setActive(id, true);
        return jsonResult(res ?? { ok: true, unarchived: id });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}

// ---------- credit / outcome payload builders ----------

/** The plain fields a credit body carries besides its pricing. */
const CREDIT_FIELDS = ["name", "agentKey", "marginPercent", "description"] as const;

/** Copies `keys` from `args` when present (an update leaves the rest out). */
function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

/** A credit body: its fields plus, when a mixer was given, the `modelBundle`
 *  the server prices it from. `requireModels` is true for create. */
async function creditBody(
  cnk: ClockNextApi,
  args: Record<string, unknown>,
  requireModels: boolean,
): Promise<Record<string, unknown> | { error: string }> {
  const body = pick(args, CREDIT_FIELDS);
  const models = args.models as MixerLine[] | undefined;
  if (models === undefined) {
    if (requireModels) return { error: "Pass `models` — a credit is priced from a model mixer." };
    return body;
  }
  const priced = await computeMixerBase(cnk, models);
  if (!priced.ok) return { error: priced.error };
  if (priced.basePrice <= 0) {
    return {
      error:
        "Credit priced to $0 — the mixer's model(s) have no catalog price, so usage would meter at zero revenue. Set their pricing on the Models page first, then retry.",
    };
  }
  return { ...body, modelBundle: priced.bundle };
}

/** The plain fields an outcome body carries besides its steps. */
const OUTCOME_FIELDS = ["name", "agentKey", "marginPercent", "description"] as const;

type StepArgs = { id?: string; name: string; agentKey: string; models?: MixerLine[] };

/** An outcome body: its fields plus, when `steps` was given, every step with
 *  its `modelBundle`. A step with no `models` is only allowed on update, where
 *  it keeps that existing step's price (`requireModels` is true for create). */
async function outcomeBody(
  cnk: ClockNextApi,
  args: Record<string, unknown>,
  requireModels: boolean,
): Promise<Record<string, unknown> | { error: string }> {
  const body = pick(args, OUTCOME_FIELDS);
  const steps = args.steps as StepArgs[] | undefined;
  if (steps === undefined) {
    if (requireModels) return { error: "Pass `steps` — an outcome needs at least one step." };
    return body;
  }
  const outSteps: Record<string, unknown>[] = [];
  for (const step of steps) {
    const outStep: Record<string, unknown> = { name: step.name, agentKey: step.agentKey };
    if (step.id !== undefined) outStep.id = step.id;
    if (step.models === undefined) {
      if (requireModels) {
        return { error: `Step "${step.name}": pass \`models\` — a new step is priced from a model mixer.` };
      }
      outSteps.push(outStep);
      continue;
    }
    const priced = await computeMixerBase(cnk, step.models);
    if (!priced.ok) return { error: `Step "${step.name}": ${priced.error}` };
    if (priced.basePrice <= 0) {
      return {
        error: `Step "${step.name}" priced to $0 — give it real token usage, or model a fixed-cost/non-LLM event as a UNIT instead of an outcome step.`,
      };
    }
    outStep.modelBundle = priced.bundle;
    outSteps.push(outStep);
  }
  return { ...body, steps: outSteps };
}

// ---------- shared rule text ----------

const PARTIAL_UPDATE_RULE =
  "- Partial update: pass the id plus ONLY the fields to change; everything you leave out keeps its stored value. Lists you do send (steps, tiers, entitlements) are the complete new list. Active state isn't an update field — use the archive / unarchive tools.";

// ---------- wire the four resources ----------

export function registerCatalogueTools(server: McpServer, cnk: ClockNextApi): void {
  registerCrud(server, {
    resource: "plan",
    plural: "plans",
    api: {
      list: (p) => cnk.plans.list(p),
      get: (id) => cnk.plans.get(id),
      create: (i) => cnk.plans.create(i as never),
      update: (id, i) => cnk.plans.update(id, i as never),
      setActive: (id, a) => cnk.plans.setActive(id, a),
    },
    input: planInput,
    desc: {
      list: "List the organisation's billing plans (id, name, billing cycle, cost, currency, active, entitlements). Find a plan id, or see what's on offer. Pass active=true for only sellable plans, active=false for only archived ones.",
      get: "Get one plan's configuration by id — its `entitlements` (wallet/credit/outcome/unit/flat/composite lines, each with quantity/amount and rollover), billing cycle, cost, currency and active state. A composite line reads back as type PRICING_METRIC with its compositeId, so a read→edit→update round-trip keeps it.",
      create: [
        "Create a billing plan bundling one or more `entitlements`: WALLET (prepaid USD balance, debited at raw model cost — no margin), FLAT (one-off fee), CREDIT/OUTCOME/UNIT entitlements referencing an existing resource by id, or PRICING_METRIC referencing an existing COMPOSITE by compositeId.",
        "",
        "Rules:",
        "- Create referenced credits/outcomes/units first (clocknext_create_credit / _outcome / _unit), then pass their ids. Every item referenced must be active.",
        "- To SELL a composite, add a PRICING_METRIC entitlement with the composite's id as compositeId (clocknext_list_composites). This is the only thing that makes a composite bill — the catalogue entry alone charges nobody, errors nowhere, and looks configured. For ADVANCE, its quantity is a prepaid POOL of occurrence slots shared across the wrapped items.",
        "- Each entitlement's billingMode is ADVANCE (up-front grant) or ARREAR (metered). Set rollover:true on an ADVANCE credit/outcome/composite/wallet line to carry what's left into the next cycle.",
        "- Set walletFundedArrear:true to pay metered (ARREAR) usage from the plan's prepaid WALLET as it happens (one invoice/cycle, wallet may go negative) instead of a separate cycle-end arrear invoice. Requires >=1 ARREAR credit/outcome/unit/composite AND an ADVANCE WALLET component, or the backend rejects it (400).",
        "- FREE plans must be ADVANCE-only with no FLAT component, and never roll over.",
        "- A plan name already in use is refused (409). The currency is the workspace's primary currency (Settings → Organization → Currencies); it can't be chosen here.",
        "- Creates a real, sellable plan — get pricing right first. Prefer the plan builder in the ClockNext product (https://payments.clocknext.com/plans); this is the fallback.",
      ].join("\n"),
      update: [
        "Update a plan by id.",
        "",
        "Rules:",
        PARTIAL_UPDATE_RULE,
        "- `entitlements`, if sent, replaces ALL lines: re-send every line you want to keep, PRICING_METRIC (composite) lines included — dropping one unsells that composite. Easiest: read it with clocknext_get_plan, edit the list, send it back as-is (compositeId and rollover included).",
        "- Lines get NEW ids on each entitlements update, even ones you sent back unchanged. Never store a line id as a durable handle.",
        "- An item already on the plan may stay even if since archived; a newly added one must be active.",
        "- Changes apply to new purchases; customers already on the plan keep their terms until they re-purchase. carryForward is deprecated and ignored.",
      ].join("\n"),
      archive: [
        "Archive a plan (isActive→false) — the API never deletes; this is how a plan is retired.",
        "",
        "Rules:",
        "- History is kept and customers already on it are unaffected; it just becomes unsellable and drops out of active lists.",
        "- Reversible: reactivate with clocknext_unarchive_plan.",
        "- Unrelated to cancelling a customer's purchase or ending a subscription.",
      ].join("\n"),
    },
  });

  registerCrud(server, {
    resource: "credit",
    plural: "credits",
    api: {
      list: (p) => cnk.credits.list(p),
      get: (id) => cnk.credits.get(id),
      create: (i) => cnk.credits.create(i as never),
      update: (id, i) => cnk.credits.update(id, i as never),
      setActive: (id, a) => cnk.credits.setActive(id, a),
    },
    input: creditInput,
    priceCreate: (args) => creditBody(cnk, args, true),
    priceUpdate: (args) => creditBody(cnk, args, false),
    desc: {
      list: "List the organisation's credit types (id, name, agentKey, price, model bundle, active). Find a credit id to reference from a plan's CREDIT component.",
      get: "Get one credit type's configuration by id — name, agentKey, description, pricing (base price, margin, price per credit, model bundle) and active state. Usage figures aren't returned.",
      create: [
        "Create a credit — a token-metered entitlement your product draws down against its `agentKey`.",
        "",
        "Rules:",
        "- Price is model-grounded: give the `models` mixer + `marginPercent`. The mixer is saved as the credit's model bundle and the server works out the base price and price-per-credit from the models' live prices. Never hand-typed.",
        "- Each mixer line's input/output/cache/cacheWrite shares must total 100; cacheWritePct only on a model with a cache-write price.",
        "- Enable the models you price against first (clocknext_add_model / _list_models).",
        "- Prefer the credits builder in the ClockNext product (https://payments.clocknext.com/credits) — its live preview shows the price as you build it. This tool saves the same per-model mix, so the credit opens with its calculator filled in.",
        "- A plan grants the credit via a CREDIT component referencing its id. A name or agentKey already in use is refused (409).",
      ].join("\n"),
      update: [
        "Update a credit by id.",
        "",
        "Rules:",
        PARTIAL_UPDATE_RULE,
        "- Send `models` to re-price from a new mixer; leave it out to keep the current price (a new marginPercent is applied on top of the stored base price).",
        "- Changing `agentKey` re-points which runtime signals map here — do it deliberately.",
      ].join("\n"),
      archive: [
        "Archive a credit TYPE (isActive→false) — the API never deletes; this is how it is retired.",
        "",
        "Rules:",
        "- Recorded usage and any plan already granting it keep working (update those plans with clocknext_update_plan to stop offering it); it just can't be added to new plans or composites and drops out of active lists.",
        "- Reversible: reactivate with clocknext_unarchive_credit.",
        "- Unrelated to archiving a customer, ending a purchase, or clearing a balance.",
      ].join("\n"),
    },
  });

  registerCrud(server, {
    resource: "outcome",
    plural: "outcomes",
    api: {
      list: (p) => cnk.outcomes.list(p),
      get: (id) => cnk.outcomes.get(id),
      create: (i) => cnk.outcomes.create(i as never),
      update: (id, i) => cnk.outcomes.update(id, i as never),
      setActive: (id, a) => cnk.outcomes.setActive(id, a),
    },
    input: outcomeInput,
    priceCreate: (args) => outcomeBody(cnk, args, true),
    priceUpdate: (args) => outcomeBody(cnk, args, false),
    desc: {
      list: "List the organisation's outcome types (id, name, base price, price, active). Find an outcome id to reference from a plan's OUTCOME component.",
      get: "Get one outcome type's configuration by id — name, agentKey, pricing, active state and every step (id, name, agentKey, order, base price, model bundle). Usage figures aren't returned.",
      create: [
        "Create an outcome — a multi-step LLM deliverable billed per COMPLETED outcome. Each of the 1–50 `steps` has its own `agentKey` and model mixer.",
        "",
        "Rules:",
        "- TWO kinds of agent key, both required and both unique org-wide, in separate namespaces: the outcome's own top-level `agentKey` (its identity), and each step's `agentKey` (what usage is reported against). Never reuse one as the other.",
        "- Price is model-grounded: each step's mixer is saved as its model bundle; the server works out each step's base cost from live model prices, sums them, then applies `marginPercent`. Never hand-typed.",
        "- Every step is an LLM step. A fixed-cost / non-LLM event (an upload, an export) is a UNIT, not an outcome step.",
        "- Prefer the outcomes builder in the ClockNext product (https://payments.clocknext.com/outcomes); this is the fallback.",
        "- A plan grants it via an OUTCOME component referencing its id.",
      ].join("\n"),
      update: [
        "Update an outcome by id.",
        "",
        "Rules:",
        PARTIAL_UPDATE_RULE,
        "- Leave `steps` out and the steps are untouched. If you send it, it is the complete step list: an existing step keeps its id when you pass that `id` (from clocknext_get_outcome) or the same agentKey; leave `models` out on an existing step to keep its price; stored steps you leave out are removed.",
        "- Step agent keys are the runtime binding — change them deliberately.",
      ].join("\n"),
      archive: [
        "Deactivate an outcome TYPE (sets isActive→false) — ClockNext's soft archive, NOT a delete.",
        "",
        "Rules:",
        "- Steps and any in-flight/completed history are kept; existing plans and in-progress outcomes are unaffected; it just can't be added to new plans or composites and drops out of active lists.",
        "- Reversible: reactivate with clocknext_unarchive_outcome.",
        "- Unrelated to archiving a customer or ending a purchase.",
      ].join("\n"),
    },
  });

  registerCrud(server, {
    resource: "unit",
    plural: "units",
    api: {
      list: (p) => cnk.units.list(p),
      get: (id) => cnk.units.get(id),
      create: (i) => cnk.units.create(i as never),
      update: (id, i) => cnk.units.update(id, i as never),
      setActive: (id, a) => cnk.units.setActive(id, a),
    },
    input: unitInput,
    desc: {
      list: "List the organisation's unit types (id, name, pricing type, active). Find a unit id to reference from a plan's UNIT component.",
      get: "Get one unit type's configuration by id — name, agentKey, pricing type, flat price or tiers, and active state. Usage figures aren't returned.",
      create: [
        "Create a unit — a metered usage unit for FIXED-COST / non-LLM events (an upload, an export, a seat): one event = one unit, no tokens.",
        "",
        "Rules:",
        "- Price it FLAT (single `flatPrice` per event, default 0) or tiered (pricingType SLAB or VOLUME with `tiers` — limits rising, and the last tier upTo:null).",
        "- Only a FLAT unit can go inside a composite.",
        "- Reported against a stable `agentKey`, matched exactly (case included) — its durable identity, unique org-wide (409 if taken).",
        "- Prefer the units builder in the ClockNext product (https://payments.clocknext.com/units); this is the fallback.",
        "- A plan meters it via a UNIT component referencing its id.",
      ].join("\n"),
      update: [
        "Update a unit by id.",
        "",
        "Rules:",
        PARTIAL_UPDATE_RULE,
        "- Changing `agentKey` re-points which runtime signals map here — do it deliberately.",
      ].join("\n"),
      archive: [
        "Archive a unit TYPE (isActive→false) — the API never deletes; this is how it is retired.",
        "",
        "Rules:",
        "- Recorded usage is kept and existing plans metering it keep working; it just can't be added to new plans or composites and drops out of active lists.",
        "- Reversible: reactivate with clocknext_unarchive_unit.",
        "- Unrelated to archiving a customer or ending a purchase.",
      ].join("\n"),
    },
  });
}

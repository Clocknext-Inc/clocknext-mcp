/**
 * REGRESSION — the tools follow the API contract as of 2026-11.
 *
 * The API changed after 0.13.0, and the tools still sent the old names:
 *
 *   - A composite plan line is `type: "COMPOSITE"`. `PRICING_METRIC` and the
 *     line field `pricingMetricId` are refused (400).
 *   - The wallet-for-arrear flag is `useWalletForArrear`. The old name
 *     `walletFundedArrear` is ignored without an error.
 *   - The plan price is set with `cost`. `priceAdjustment` is ignored.
 *   - A plan line and a unit tier keep their `id` across a PATCH, and a PATCH
 *     can send that `id` back (SE-190).
 *   - A 403 names a lock in `statusDetail.code` (FEATURE_LOCKED /
 *     WORKSPACE_LOCKED, SE-61).
 *   - `voidAfterMinutes` on a purchase is accepted and ignored: an unpaid
 *     invoice is never voided by its age.
 *
 * Needs no server: it registers the tools on a stand-in server, stubs
 * `fetch`, and reads back the requests the tools send.
 *
 *   npx tsx test/api-contract-2026-11.test.ts
 */
import { z } from "zod";
import { ClocknextApi } from "../src/api";
import { registerCatalogueTools } from "../src/tools/catalogue";
import { registerCompositeTools } from "../src/tools/composites";
import { registerCustomerTools } from "../src/tools/customers";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;
type Tool = { config: { description?: string; inputSchema?: z.ZodRawShape }; handler: Handler };

const tools = new Map<string, Tool>();
const fakeServer = {
  registerTool(name: string, config: Tool["config"], handler: Handler) {
    tools.set(name, { config, handler });
  },
};

// --- fetch stub: records each request, answers with the next queued reply ---
type Sent = { method: string; url: string; body: unknown };
const sent: Sent[] = [];
let reply: { status: number; json: unknown } = { status: 200, json: {} };

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  sent.push({
    method: init?.method ?? "GET",
    url: String(input),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  return new Response(JSON.stringify(reply.json), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

function success(result: unknown) {
  return { status: 200, json: { statusCode: 200, statusDetail: { status: "SUCCESS", message: "ok" }, result } };
}

const cnk = new ClocknextApi({ apiKey: "cnk_test", baseUrl: "http://localhost:0" });
registerCatalogueTools(fakeServer as never, cnk);
registerCompositeTools(fakeServer as never, cnk);
registerCustomerTools(fakeServer as never, cnk);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond ? "" : `  <-- ${detail}`}`);
}

function tool(name: string): Tool {
  const found = tools.get(name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
}

/** Parse the args the way the MCP SDK does, then run the handler. */
async function call(name: string, args: Record<string, unknown>) {
  const t = tool(name);
  const parsed = z.object(t.config.inputSchema ?? {}).safeParse(args);
  if (!parsed.success) {
    return { parseError: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  sent.length = 0;
  const result = await t.handler(parsed.data);
  return { result, request: sent[sent.length - 1] };
}

function parses(name: string, args: Record<string, unknown>): boolean {
  return z.object(tool(name).config.inputSchema ?? {}).safeParse(args).success;
}

async function main(): Promise<void> {
  console.log("plan lines");

  check(
    "create_plan accepts a COMPOSITE line",
    parses("clocknext_create_plan", {
      name: "Pro",
      billingCycle: "MONTHLY",
      entitlements: [{ type: "COMPOSITE", billingMode: "ADVANCE", compositeId: "pm_1", quantity: 5 }],
    }),
  );
  check(
    "create_plan refuses a PRICING_METRIC line (the API answers 400)",
    !parses("clocknext_create_plan", {
      name: "Pro",
      billingCycle: "MONTHLY",
      entitlements: [{ type: "PRICING_METRIC", billingMode: "ADVANCE", compositeId: "pm_1", quantity: 5 }],
    }),
  );
  check(
    "a plan line has no pricingMetricId field (the API refuses it)",
    !("pricingMetricId" in getLineShape()),
  );

  reply = success({ created: true, plan: { id: "plan_1" } });
  const created = await call("clocknext_create_plan", {
    name: "Pro",
    billingCycle: "MONTHLY",
    useWalletForArrear: true,
    cost: 300,
    entitlements: [
      { type: "WALLET", billingMode: "ADVANCE", amount: 0 },
      { type: "COMPOSITE", billingMode: "ARREAR", compositeId: "pm_1" },
    ],
  });
  const createBody = (created.request?.body ?? {}) as Record<string, unknown>;
  check("create_plan parses useWalletForArrear and cost", !("parseError" in created), String(created.parseError));
  check("create_plan sends useWalletForArrear", createBody.useWalletForArrear === true, JSON.stringify(createBody));
  check("create_plan sends cost", createBody.cost === 300, JSON.stringify(createBody));
  check(
    "create_plan sends the composite line as COMPOSITE",
    JSON.stringify(createBody.entitlements ?? []).includes('"type":"COMPOSITE"'),
    JSON.stringify(createBody.entitlements),
  );
  check("create_plan has no walletFundedArrear field", !("walletFundedArrear" in tool("clocknext_create_plan").config.inputSchema!));
  check("create_plan has no priceAdjustment field", !("priceAdjustment" in tool("clocknext_create_plan").config.inputSchema!));

  reply = success({ plan: { id: "plan_1" } });
  const updated = await call("clocknext_update_plan", {
    id: "plan_1",
    entitlements: [{ id: "pc_7", type: "CREDIT", billingMode: "ADVANCE", creditId: "cr_1", quantity: 10 }],
  });
  const updateBody = (updated.request?.body ?? {}) as { entitlements?: { id?: string }[] };
  check("update_plan parses a line id", !("parseError" in updated), String(updated.parseError));
  check("update_plan sends the line id back", updateBody.entitlements?.[0]?.id === "pc_7", JSON.stringify(updateBody));
  check(
    "update_plan no longer says lines get new ids",
    !/NEW ids/.test(tool("clocknext_update_plan").config.description ?? ""),
  );

  console.log("unit tiers");
  reply = success({ unit: { id: "un_1" } });
  const unit = await call("clocknext_update_unit", {
    id: "un_1",
    tiers: [
      { id: "tr_1", upTo: 100, price: 1 },
      { upTo: null, price: 0.5 },
    ],
  });
  const unitBody = (unit.request?.body ?? {}) as { tiers?: { id?: string }[] };
  check("update_unit parses a tier id", !("parseError" in unit), String(unit.parseError));
  check("update_unit sends the tier id back", unitBody.tiers?.[0]?.id === "tr_1", JSON.stringify(unitBody));

  console.log("descriptions");
  for (const name of ["clocknext_create_plan", "clocknext_update_plan", "clocknext_get_plan", "clocknext_create_composite", "clocknext_list_composites"]) {
    check(`${name} does not name PRICING_METRIC`, !/PRICING_METRIC/.test(tool(name).config.description ?? ""));
  }

  console.log("lock codes on 403");
  reply = {
    status: 403,
    json: {
      statusCode: 403,
      statusDetail: { status: "ERROR", message: "Composites are not on your plan.", code: "FEATURE_LOCKED" },
      result: { error: "feature_locked", feature: "COMPOSITES" },
    },
  };
  const locked = await call("clocknext_list_composites", {});
  const lockedText = "result" in locked ? locked.result?.content[0]?.text ?? "" : "";
  check("a FEATURE_LOCKED 403 is a FeatureLockedError", /FeatureLockedError \(403\)/.test(lockedText), lockedText);
  check("a FEATURE_LOCKED 403 names the feature", /COMPOSITES/.test(lockedText), lockedText);

  reply = {
    status: 403,
    json: {
      statusCode: 403,
      statusDetail: { status: "ERROR", message: "This workspace is locked.", code: "WORKSPACE_LOCKED" },
      result: {},
    },
  };
  const frozen = await call("clocknext_list_plans", {});
  const frozenText = "result" in frozen ? frozen.result?.content[0]?.text ?? "" : "";
  check("a WORKSPACE_LOCKED 403 is a WorkspaceLockedError", /WorkspaceLockedError \(403\)/.test(frozenText), frozenText);

  console.log("composites list");
  reply = success({
    composites: [
      { id: "pm_1", isActive: true },
      { id: "pm_2", isActive: false },
    ],
  });
  const archived = await call("clocknext_list_composites", { active: false });
  const archivedData = JSON.parse("result" in archived ? archived.result?.content[0]?.text ?? "{}" : "{}");
  check(
    "list_composites returns { count, composites } like the other list tools",
    archivedData.count !== undefined && Array.isArray(archivedData.composites),
    JSON.stringify(archivedData),
  );
  check(
    "list_composites active=false returns only archived ones (the API filters only active=true)",
    Array.isArray(archivedData.composites) && archivedData.composites.length === 1 && archivedData.composites[0].id === "pm_2",
    JSON.stringify(archivedData),
  );

  console.log("purchases");
  check(
    "create_purchase has no voidAfterMinutes (the API ignores it)",
    !("voidAfterMinutes" in tool("clocknext_create_purchase").config.inputSchema!),
  );

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

/** The fields of one plan line, read from create_plan's schema. */
function getLineShape(): z.ZodRawShape {
  const list = tool("clocknext_create_plan").config.inputSchema!.entitlements as z.ZodTypeAny;
  let inner: z.ZodTypeAny = list;
  while (!(inner instanceof z.ZodArray)) {
    inner = (inner as z.ZodOptional<z.ZodTypeAny>)._def.innerType;
  }
  return ((inner as z.ZodArray<z.ZodTypeAny>).element as z.ZodObject<z.ZodRawShape>).shape;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

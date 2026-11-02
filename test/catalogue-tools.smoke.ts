/**
 * SMOKE TEST — the catalogue tools against a REAL ClockNext server.
 *
 * Written BEFORE changing the tools, from the server's current rules
 * (Clocknext-Payment-Saas `scripts/itest-v1-catalog-crud-behaviour.mts`).
 * If a case fails, the tool is wrong — do not edit a case to match the tool.
 *
 *   T1 A credit / outcome step priced with a cache-write share stores it
 *      (`cacheWritePct` on the mixer → `cacheWrite` in the saved bundle).
 *   T2 A negative margin (down to -100) is accepted, like the product.
 *   T3 Update tools are PARTIAL: `{ id, <one field> }` changes that field and
 *      keeps everything else (credit, outcome steps + ids, unit, plan).
 *   T4 Plan entitlements carry `rollover` and take `compositeId`; a plan read
 *      with get_plan can be sent straight back to update_plan. Plans have no
 *      currencyCode input and no type / kind in the response.
 *   T5 Composites can be read, updated and archived / unarchived.
 *   T6 Archive / unarchive are the ONLY way to change active state: no update
 *      tool takes `isActive`.
 *
 * Needs a running server and a throwaway workspace key. Creates rows prefixed
 * `mcp-<run>`; deletes nothing.
 *
 *   CN_TEST_KEY=cnk_… CN_TEST_BASE=http://localhost:3000 npx tsx test/catalogue-tools.smoke.ts
 */
import { z } from "zod";
import { ClockNextApi } from "../src/api";
import { registerCatalogueTools } from "../src/tools/catalogue";
import { registerCompositeTools } from "../src/tools/composites";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, Handler>();
/** Stands in for the MCP SDK server: like the real one, it validates the
 *  arguments against the tool's input schema (applying defaults) before the
 *  handler runs. */
const fakeServer = {
  registerTool(name: string, meta: { inputSchema?: z.ZodRawShape }, handler: Handler) {
    const schema = z.object(meta.inputSchema ?? {});
    tools.set(name, async (args) => handler(schema.parse(args) as Record<string, unknown>));
  },
};

const apiKey = process.env.CN_TEST_KEY ?? "";
const baseUrl = process.env.CN_TEST_BASE ?? "http://localhost:3000";
if (!apiKey) throw new Error("Set CN_TEST_KEY.");
const cnk = new ClockNextApi({ apiKey, baseUrl });
registerCatalogueTools(fakeServer as never, cnk);
registerCompositeTools(fakeServer as never, cnk);

let checks = 0;
let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond ? "" : `  <-- ${detail}`}`);
}

type Json = Record<string, any>;
async function tool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Json; text: string }> {
  const handler = tools.get(name);
  if (!handler) return { ok: false, data: {}, text: `no tool ${name}` };
  let res;
  try {
    res = await handler(args);
  } catch (error) {
    return { ok: false, data: {}, text: `invalid arguments: ${(error as Error).message.slice(0, 300)}` };
  }
  const text = res.content[0]?.text ?? "";
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { ok: !res.isError, data, text };
}

const run = Date.now().toString(36);
const P = `mcp-${run}`;
const K = `mcp_${run}`;

async function main(): Promise<void> {
  const models = (await cnk.workspace.models({ active: true })) as Json[];
  const cw = models.find((m) => typeof m.cacheWritePrice === "number" && m.cacheWritePrice > 0);
  if (!cw) throw new Error("The workspace needs an active model with a cache-write price.");

  console.log("\n=== T1/T2 · credit pricing ===");
  let r = await tool("clocknext_create_credit", {
    name: `${P} credit`,
    agentKey: `${K}_credit`,
    marginPercent: -50,
    models: [{ model: cw.modelId, avgTokens: 1000, inputPct: 50, outputPct: 30, cachePct: 10, cacheWritePct: 10 }],
  });
  check("create_credit with cacheWritePct + margin -50 → ok", r.ok, r.text.slice(0, 300));
  const credit = r.data;
  check("saved bundle carries cacheWrite 10", credit.modelBundle?.[0]?.cacheWrite === 10, JSON.stringify(credit.modelBundle));
  check("margin -50 stored", credit.marginPercent === -50, String(credit.marginPercent));

  console.log("\n=== T3 · credit update is partial ===");
  r = await tool("clocknext_update_credit", { id: credit.id, description: "only this" });
  check("update_credit {id, description} → ok", r.ok, r.text.slice(0, 300));
  check("…name kept", r.data.name === `${P} credit`, r.text.slice(0, 200));
  check("…bundle kept", r.data.modelBundle?.[0]?.cacheWrite === 10, r.text.slice(0, 300));
  r = await tool("clocknext_update_credit", { id: credit.id, isActive: false });
  check("T6 update_credit does not take isActive", !r.ok, r.text.slice(0, 200));
  r = await tool("clocknext_archive_credit", { id: credit.id });
  check("archive_credit → isActive false", r.ok && r.data.isActive === false, r.text.slice(0, 200));
  r = await tool("clocknext_unarchive_credit", { id: credit.id });
  check("unarchive_credit → isActive true", r.ok && r.data.isActive === true, r.text.slice(0, 200));

  console.log("\n=== T3 · outcome update keeps step ids ===");
  r = await tool("clocknext_create_outcome", {
    name: `${P} outcome`,
    agentKey: `${K}_outcome`,
    marginPercent: 0,
    steps: [{ name: "One", agentKey: `${K}_outcome.one`, models: [{ model: cw.modelId, avgTokens: 1000, inputPct: 100, outputPct: 0 }] }],
  });
  check("create_outcome → ok", r.ok, r.text.slice(0, 300));
  const outcomeId = r.data.id;
  const before = await tool("clocknext_get_outcome", { id: outcomeId });
  const stepId = before.data.steps?.[0]?.id;
  r = await tool("clocknext_update_outcome", { id: outcomeId, name: `${P} outcome renamed` });
  check("update_outcome {id, name} → ok", r.ok, r.text.slice(0, 300));
  const after = await tool("clocknext_get_outcome", { id: outcomeId });
  check("…step id unchanged", typeof stepId === "string" && after.data.steps?.[0]?.id === stepId, `${stepId} → ${after.data.steps?.[0]?.id}`);

  console.log("\n=== T3 · unit update is partial ===");
  r = await tool("clocknext_create_unit", {
    name: `${P} unit`,
    agentKey: `${K}_unit`,
    pricingType: "SLAB",
    tiers: [{ upTo: 10, price: 1 }, { upTo: null, price: 0.5 }],
  });
  check("create_unit → ok", r.ok, r.text.slice(0, 300));
  const unitId = r.data.id;
  r = await tool("clocknext_update_unit", { id: unitId, description: "kept tiers" });
  check("update_unit {id, description} keeps tiers", r.ok && r.data.tiers?.length === 2, r.text.slice(0, 300));

  console.log("\n=== T5 · composites ===");
  const flat = await tool("clocknext_create_unit", { name: `${P} flat`, agentKey: `${K}_flat`, pricingType: "FLAT", flatPrice: 1 });
  r = await tool("clocknext_create_composite", { name: `${P} composite`, refId: `${K}_composite`, price: 2, unitIds: [flat.data.id] });
  check("create_composite → ok", r.ok, r.text.slice(0, 300));
  const compositeId = r.data.id;
  r = await tool("clocknext_get_composite", { id: compositeId });
  check("get_composite → ok", r.ok && r.data.refId === `${K}_composite`, r.text.slice(0, 300));
  r = await tool("clocknext_update_composite", { id: compositeId, price: 5 });
  check("update_composite {id, price} → price 5, entitlements kept", r.ok && r.data.price === 5 && r.data.entitlements?.units?.length === 1, r.text.slice(0, 300));
  r = await tool("clocknext_archive_composite", { id: compositeId });
  check("archive_composite → isActive false", r.ok && r.data.isActive === false, r.text.slice(0, 300));
  r = await tool("clocknext_unarchive_composite", { id: compositeId });
  check("unarchive_composite → isActive true", r.ok && r.data.isActive === true, r.text.slice(0, 300));

  console.log("\n=== T4 · plans ===");
  r = await tool("clocknext_create_plan", {
    name: `${P} plan`,
    billingCycle: "MONTHLY",
    entitlements: [
      { type: "CREDIT", billingMode: "ADVANCE", creditId: credit.id, quantity: 10, rollover: true },
      { type: "COMPOSITE", billingMode: "ADVANCE", compositeId, quantity: 3 },
    ],
  });
  check("create_plan with rollover + compositeId → ok", r.ok, r.text.slice(0, 300));
  const planId = r.data.id;
  const comps = (r.data.entitlements ?? []) as Json[];
  check("plan response has no type / kind", !("type" in r.data) && !("kind" in r.data), Object.keys(r.data).join(","));
  check("rollover stored true", comps.some((c) => c.creditId === credit.id && c.rollover === true), JSON.stringify(comps).slice(0, 300));
  check("compositeId round-trips", comps.some((c) => c.compositeId === compositeId), JSON.stringify(comps).slice(0, 300));
  check("composite line reads back as COMPOSITE", comps.some((c) => c.compositeId === compositeId && c.type === "COMPOSITE"), JSON.stringify(comps).slice(0, 300));
  r = await tool("clocknext_update_plan", { id: planId, name: `${P} plan renamed` });
  check("update_plan {id, name} → ok", r.ok, r.text.slice(0, 300));
  check("…rollover kept", ((r.data.entitlements ?? []) as Json[]).some((c) => c.creditId === credit.id && c.rollover === true), r.text.slice(0, 300));
  const read = await tool("clocknext_get_plan", { id: planId });
  r = await tool("clocknext_update_plan", { id: planId, entitlements: read.data.entitlements });
  check("update_plan with get_plan's entitlements sent back → ok", r.ok, r.text.slice(0, 300));
  const idsBefore = ((read.data.entitlements ?? []) as Json[]).map((c) => c.id).sort().join(",");
  const idsAfter = ((r.data.entitlements ?? []) as Json[]).map((c) => c.id).sort().join(",");
  check("…line ids stay the same", idsBefore !== "" && idsBefore === idsAfter, `${idsBefore} → ${idsAfter}`);
  r = await tool("clocknext_update_plan", { id: planId, isActive: false });
  check("T6 update_plan does not take isActive", !r.ok, r.text.slice(0, 200));
  r = await tool("clocknext_archive_plan", { id: planId });
  check("archive_plan → isActive false", r.ok && r.data.isActive === false, r.text.slice(0, 200));

  console.log(`\nCreated with prefix ${P} (nothing deleted).`);
  console.log(`${checks - failures}/${checks} checks passed, ${failures} failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

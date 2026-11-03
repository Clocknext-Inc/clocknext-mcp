/**
 * END-TO-END — the built server, over stdio, against a REAL Clocknext server.
 *
 * Starts `node dist/index.js` the way Claude Code / Cursor / Codex do (an MCP
 * client over stdio, the key only in the server's env) and calls EVERY tool:
 *
 *   E1  The server lists exactly the expected tools.
 *   E2  whoami, list_models, add_model (already enabled → no-op; unknown → a
 *       clear refusal).
 *   E3  search_docs + get_doc against the public docs.
 *   E4  write_env writes the key into a .env and never returns it; it refuses a
 *       wrong file name and a .env that git would commit.
 *   E5  Credits / outcomes / units / plans / composites: list (all / active /
 *       archived), get, create, update, archive, unarchive.
 *   E6  Customers: create, get, list, a wrong cursor (400), balances, plan,
 *       purchase. Balances after the purchase need a server with
 *       an edge (it reads usage from ClickHouse): set CN_TEST_EDGE=1 for it.
 *   E7  Errors: a wrong id is a NotFoundError (404); a wrong key is an
 *       AuthError (401).
 *   E8  (optional) Lock refusals: FEATURE_LOCKED → FeatureLockedError naming
 *       the feature, WORKSPACE_LOCKED → WorkspaceLockedError. Needs
 *       CN_TEST_DB_URL — the test sets and clears the lock in that database
 *       with psql, so point it at a THROWAWAY copy only.
 *   E9  (optional) A sandbox already at its 25 customers refuses a create
 *       (403 ForbiddenError). Needs CN_TEST_SANDBOX_KEY.
 *
 * Creates rows prefixed `mcp-e2e-<run>` and raises a real invoice (the
 * purchase): run it against a throwaway workspace on a local server only.
 *
 *   npm run build
 *   CN_TEST_KEY=cnk_… CN_TEST_BASE=http://localhost:3000 \
 *     [CN_TEST_DB_URL=postgresql://…] [CN_TEST_SANDBOX_KEY=cnk_…] \
 *     npx tsx test/e2e-stdio.test.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const apiKey = process.env.CN_TEST_KEY ?? "";
const baseUrl = process.env.CN_TEST_BASE ?? "http://localhost:3000";
const dbUrl = process.env.CN_TEST_DB_URL ?? "";
const sandboxKey = process.env.CN_TEST_SANDBOX_KEY ?? "";
if (!apiKey) throw new Error("Set CN_TEST_KEY.");

const EXPECTED_TOOLS = [
  "clocknext_whoami",
  "clocknext_list_models",
  "clocknext_add_model",
  "clocknext_search_docs",
  "clocknext_get_doc",
  "clocknext_write_env",
  ...["plan", "credit", "outcome", "unit"].flatMap((r) => [
    `clocknext_list_${r}s`,
    `clocknext_get_${r}`,
    `clocknext_create_${r}`,
    `clocknext_update_${r}`,
    `clocknext_archive_${r}`,
    `clocknext_unarchive_${r}`,
  ]),
  "clocknext_list_composites",
  "clocknext_get_composite",
  "clocknext_create_composite",
  "clocknext_update_composite",
  "clocknext_archive_composite",
  "clocknext_unarchive_composite",
  "clocknext_create_customer",
  "clocknext_get_customer",
  "clocknext_list_customers",
  "clocknext_get_customer_balances",
  "clocknext_get_customer_plan",
  "clocknext_create_purchase",
].sort();

// ---------- harness ----------

let checks = 0;
let failures = 0;
const called = new Set<string>();

function check(label: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond ? "" : `  <-- ${detail.slice(0, 400)}`}`);
}

type Json = Record<string, any>;
type Result = { ok: boolean; data: Json; text: string };

/** Start the built server as a stdio subprocess, with the key in its env. */
async function connect(key: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      PATH: process.env.PATH ?? "",
      CLOCKNEXT_API_KEY: key,
      CLOCKNEXT_BASE_URL: baseUrl,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "clocknext-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  called.add(name);
  const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = res.content.map((c) => c.text ?? "").join("\n");
  let data: Json = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* an error message, not JSON */
  }
  return { ok: !res.isError, data, text };
}

function psql(sql: string): void {
  execFileSync("psql", [dbUrl, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "pipe" });
}

// ---------- the run ----------

const run = Date.now().toString(36);
const P = `mcp-e2e-${run}`;
const K = `mcp_e2e_${run}`;

async function main(): Promise<void> {
  const client = await connect(apiKey);

  console.log("=== E1 · tool list ===");
  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  check(`server lists ${EXPECTED_TOOLS.length} tools`, listed.length === EXPECTED_TOOLS.length, `got ${listed.length}`);
  const missing = EXPECTED_TOOLS.filter((t) => !listed.includes(t));
  const extra = listed.filter((t) => !EXPECTED_TOOLS.includes(t));
  check("no tool missing", missing.length === 0, missing.join(", "));
  check("no unexpected tool", extra.length === 0, extra.join(", "));

  console.log("=== E2 · workspace and models ===");
  let r = await call(client, "clocknext_whoami");
  const orgId = r.data.organization?.id as string | undefined;
  check("whoami → organization id", r.ok && typeof orgId === "string", r.text);
  check("whoami → environment is live or sandbox", ["live", "sandbox"].includes(r.data.organization?.environment), r.text);
  check("whoami does not return the key", !r.text.includes(apiKey), "key in the result");

  r = await call(client, "clocknext_list_models");
  const models = (r.data.models ?? []) as Json[];
  check("list_models → models", r.ok && models.length > 0, r.text);
  r = await call(client, "clocknext_list_models", { active: true });
  const active = (r.data.models ?? []) as Json[];
  check("list_models active=true → only active", r.ok && active.length > 0 && active.every((m) => m.isActive === true), r.text);
  const priced = active.find((m) => m.inputPrice > 0 && m.outputPrice > 0);
  check("an active model with a price exists", priced !== undefined, JSON.stringify(active).slice(0, 300));
  const modelId = priced?.modelId as string;

  // A real catalog model (the catalog is models.dev): add it, then add it again.
  r = await call(client, "clocknext_add_model", { provider: "openai", model: "gpt-4o-mini" });
  check("add_model on a catalog model → ok, priced", r.ok && r.data.ok === true && r.data.priced === true, r.text);
  r = await call(client, "clocknext_add_model", { provider: "openai", model: "gpt-4o-mini" });
  check("add_model again → ok, alreadyEnabled", r.ok && r.data.alreadyEnabled === true, r.text);
  r = await call(client, "clocknext_add_model", { provider: "no-such-provider", model: "no-such-model" });
  check("add_model on an unknown model → clear refusal", !r.ok && /Couldn't add/.test(r.text), r.text);

  console.log("=== E3 · docs ===");
  r = await call(client, "clocknext_search_docs", { query: "create a plan", limit: 3 });
  const hit = (r.data.results ?? [])[0] as Json | undefined;
  check("search_docs → results", r.ok && hit !== undefined, r.text);
  r = await call(client, "clocknext_get_doc", { path: hit?.url ?? "/docs/api-reference/quickstart" });
  check("get_doc → markdown", r.ok && typeof r.data.markdown === "string" && r.data.markdown.length > 100, r.text);

  console.log("=== E4 · write_env ===");
  const dir = mkdtempSync(join(tmpdir(), "cn-e2e-"));
  try {
    const envFile = join(dir, ".env");
    r = await call(client, "clocknext_write_env", { envFilePath: envFile });
    check("write_env (new file) → created", r.ok && r.data.action === "created", r.text);
    check("…the result does not contain the key", !r.text.includes(apiKey), "key in the result");
    check("…the file holds the key", readFileSync(envFile, "utf8").includes(`CLOCKNEXT_API_KEY=${apiKey}`));
    check("…the file is owner-only (600)", (statSync(envFile).mode & 0o777) === 0o600, (statSync(envFile).mode & 0o777).toString(8));
    r = await call(client, "clocknext_write_env", { envFilePath: envFile });
    check("write_env again → replaced, one line", r.ok && r.data.action === "replaced" && readFileSync(envFile, "utf8").split("CLOCKNEXT_API_KEY=").length === 2, r.text);
    r = await call(client, "clocknext_write_env", { envFilePath: join(dir, "secrets.txt") });
    check("write_env to a wrong file name → refused", !r.ok, r.text);

    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    r = await call(client, "clocknext_write_env", { envFilePath: join(repo, ".env") });
    check("write_env to a .env git would commit → refused", !r.ok && /gitignore/.test(r.text), r.text);
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    r = await call(client, "clocknext_write_env", { envFilePath: join(repo, ".env") });
    check("write_env to a gitignored .env → created", r.ok && r.data.action === "created", r.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("=== E5 · catalogue ===");
  const mixer = [{ model: modelId, avgTokens: 2000, inputPct: 60, outputPct: 40 }];

  r = await call(client, "clocknext_create_credit", { name: `${P} credit`, agentKey: `${K}_Credit`, models: mixer, marginPercent: 50 });
  const creditId = r.data.id as string;
  check("create_credit → id", r.ok && typeof creditId === "string", r.text);
  check("…agentKey kept as sent (case included)", r.data.agentKey === `${K}_Credit`, r.text);
  r = await call(client, "clocknext_get_credit", { id: creditId });
  check("get_credit → same credit", r.ok && r.data.id === creditId, r.text);
  r = await call(client, "clocknext_update_credit", { id: creditId, description: "e2e" });
  check("update_credit → description changed", r.ok && r.data.description === "e2e", r.text);

  r = await call(client, "clocknext_create_outcome", {
    name: `${P} outcome`,
    agentKey: `${K}_outcome`,
    marginPercent: 20,
    steps: [{ name: "draft", agentKey: `${K}_draft`, models: mixer }],
  });
  const outcomeId = r.data.id as string;
  check("create_outcome → id", r.ok && typeof outcomeId === "string", r.text);
  r = await call(client, "clocknext_get_outcome", { id: outcomeId });
  check("get_outcome → one step", r.ok && (r.data.steps ?? []).length === 1, r.text);
  r = await call(client, "clocknext_update_outcome", { id: outcomeId, description: "e2e" });
  check("update_outcome → description changed", r.ok && r.data.description === "e2e", r.text);

  r = await call(client, "clocknext_create_unit", { name: `${P} unit`, agentKey: `${K}_unit`, pricingType: "FLAT", flatPrice: 0.25 });
  const unitId = r.data.id as string;
  check("create_unit → id", r.ok && typeof unitId === "string", r.text);
  r = await call(client, "clocknext_create_unit", {
    name: `${P} tiered`,
    agentKey: `${K}_tiered`,
    pricingType: "SLAB",
    tiers: [{ upTo: 100, price: 1 }, { upTo: null, price: 0.5 }],
  });
  const tieredId = r.data.id as string;
  check("create_unit SLAB → id", r.ok && typeof tieredId === "string", r.text);
  r = await call(client, "clocknext_get_unit", { id: tieredId });
  const tiers = (r.data.tiers ?? []) as Json[];
  check("get_unit → two tiers with ids", r.ok && tiers.length === 2 && tiers.every((t) => typeof t.id === "string"), r.text);
  r = await call(client, "clocknext_update_unit", {
    id: tieredId,
    tiers: [{ id: tiers[0]?.id, upTo: 200, price: 1 }, { id: tiers[1]?.id, upTo: null, price: 0.4 }],
  });
  const tiersAfter = (r.data.tiers ?? []) as Json[];
  check(
    "update_unit with tier ids → ids stay the same",
    r.ok && tiersAfter.map((t) => t.id).join() === tiers.map((t) => t.id).join() && tiersAfter[0]?.upTo === 200,
    r.text,
  );

  r = await call(client, "clocknext_create_composite", { name: `${P} composite`, refId: `${K}_Call`, price: 2, creditIds: [creditId], unitIds: [unitId] });
  const compositeId = r.data.id as string;
  check("create_composite → id", r.ok && typeof compositeId === "string", r.text);
  check("…refId kept as sent (case included)", r.data.refId === `${K}_Call`, r.text);
  r = await call(client, "clocknext_get_composite", { id: compositeId });
  check("get_composite → same composite", r.ok && r.data.id === compositeId, r.text);
  r = await call(client, "clocknext_update_composite", { id: compositeId, price: 3 });
  check("update_composite → price 3", r.ok && Number(r.data.price) === 3, r.text);

  r = await call(client, "clocknext_create_plan", {
    name: `${P} plan`,
    billingCycle: "MONTHLY",
    useWalletForArrear: true,
    cost: 99,
    entitlements: [
      { type: "WALLET", billingMode: "ADVANCE", amount: 10 },
      { type: "CREDIT", billingMode: "ADVANCE", creditId, quantity: 100, rollover: true },
      { type: "OUTCOME", billingMode: "ARREAR", outcomeId },
      { type: "UNIT", billingMode: "ARREAR", unitId },
      { type: "COMPOSITE", billingMode: "ADVANCE", compositeId, quantity: 5 },
    ],
  });
  const planId = r.data.id as string;
  check("create_plan (5 line types) → id", r.ok && typeof planId === "string", r.text);
  check("…useWalletForArrear saved", r.data.useWalletForArrear === true, r.text);
  check("…cost saved", Number(r.data.cost) === 99, r.text);
  check("…composite line is COMPOSITE", (r.data.entitlements ?? []).some((e: Json) => e.type === "COMPOSITE" && e.compositeId === compositeId), r.text);
  r = await call(client, "clocknext_create_plan", {
    name: `${P} bad`,
    billingCycle: "MONTHLY",
    entitlements: [{ type: "CREDIT", billingMode: "ADVANCE", creditId }],
  });
  check("create_plan ADVANCE line without quantity → 400 naming the field", !r.ok && /ValidationError \(400\)/.test(r.text) && /quantity/.test(r.text), r.text);

  r = await call(client, "clocknext_get_plan", { id: planId });
  const lines = (r.data.entitlements ?? []) as Json[];
  check("get_plan → 5 lines", r.ok && lines.length === 5, r.text);
  r = await call(client, "clocknext_update_plan", { id: planId, entitlements: lines });
  const linesAfter = (r.data.entitlements ?? []) as Json[];
  const ids = (l: Json[]) => l.map((e) => e.id).sort().join();
  check("update_plan with the same lines → ok, ids and cost kept", r.ok && ids(linesAfter) === ids(lines) && Number(r.data.cost) === 99, r.text);

  for (const [resource, id] of [
    ["credit", creditId],
    ["outcome", outcomeId],
    ["unit", tieredId],
    ["plan", planId],
    ["composite", compositeId],
  ] as const) {
    const plural = `${resource}s`;
    r = await call(client, `clocknext_list_${plural}`);
    check(`list_${plural} → includes the new one`, r.ok && (r.data[plural] ?? []).some((x: Json) => x.id === id), r.text);
    r = await call(client, `clocknext_archive_${resource}`, { id });
    check(`archive_${resource} → isActive false`, r.ok && r.data.isActive === false, r.text);
    r = await call(client, `clocknext_list_${plural}`, { active: false });
    check(`list_${plural} active=false → only archived, includes it`, r.ok && (r.data[plural] ?? []).every((x: Json) => x.isActive === false) && (r.data[plural] ?? []).some((x: Json) => x.id === id), r.text);
    r = await call(client, `clocknext_unarchive_${resource}`, { id });
    check(`unarchive_${resource} → isActive true`, r.ok && r.data.isActive === true, r.text);
    r = await call(client, `clocknext_list_${plural}`, { active: true });
    check(`list_${plural} active=true → only active, includes it`, r.ok && (r.data[plural] ?? []).every((x: Json) => x.isActive === true) && (r.data[plural] ?? []).some((x: Json) => x.id === id), r.text);
  }

  console.log("=== E6 · customers and purchase ===");
  r = await call(client, "clocknext_create_customer", { name: `${P} customer`, email: `${run}@e2e.example.com` });
  const customerId = r.data.id as string;
  check("create_customer → id", r.ok && typeof customerId === "string", r.text);
  r = await call(client, "clocknext_get_customer", { id: customerId });
  check("get_customer → same customer", r.ok && r.data.id === customerId, r.text);
  r = await call(client, "clocknext_list_customers", { q: `${run}@e2e`, limit: 5 });
  check("list_customers q= → finds it", r.ok && (r.data.customers ?? []).some((c: Json) => c.id === customerId), r.text);
  r = await call(client, "clocknext_list_customers", { cursor: "no-such-customer" });
  check("list_customers with a wrong cursor → 400", !r.ok && /\(400\)/.test(r.text), r.text);
  r = await call(client, "clocknext_get_customer_plan", { id: customerId });
  check("get_customer_plan before a purchase → answers", r.ok, r.text);
  r = await call(client, "clocknext_get_customer_balances", { id: customerId });
  check("get_customer_balances before a purchase → answers", r.ok, r.text);
  r = await call(client, "clocknext_create_purchase", { customerId, planId });
  check("create_purchase → purchase id", r.ok && typeof r.data.id === "string", r.text);
  r = await call(client, "clocknext_get_customer_plan", { id: customerId });
  check("get_customer_plan after the purchase → answers", r.ok, r.text);
  console.log(`      plan: ${r.text.replace(/\s+/g, " ").slice(0, 200)}`);
  if (process.env.CN_TEST_EDGE === "1") {
    r = await call(client, "clocknext_get_customer_balances", { id: customerId });
    check("get_customer_balances after the purchase → answers", r.ok, r.text);
    console.log(`      balances: ${r.text.replace(/\s+/g, " ").slice(0, 200)}`);
  } else {
    // With a plan, the server reads usage through the edge (ClickHouse).
    console.log("  [SKIP] balances after the purchase: set CN_TEST_EDGE=1 when the server has an edge");
  }

  console.log("=== E7 · errors ===");
  r = await call(client, "clocknext_get_credit", { id: "no-such-credit" });
  check("get_credit with a wrong id → NotFoundError (404)", !r.ok && /NotFoundError \(404\)/.test(r.text), r.text);
  await client.close();

  const wrongKey = await connect("cnk_wrong_key_for_e2e");
  r = await call(wrongKey, "clocknext_whoami");
  check("a wrong key → AuthError (401)", !r.ok && /AuthError \(401\)/.test(r.text), r.text);
  await wrongKey.close();

  console.log("=== E8 · lock refusals ===");
  if (!dbUrl || !orgId) {
    console.log("  [SKIP] set CN_TEST_DB_URL (a throwaway database) to run these");
  } else {
    const locked = await connect(apiKey);
    try {
      psql(`UPDATE "OrgFeatureAccess" SET "lockedFeatures" = ARRAY['COMPOSITES']::"PlatformFeature"[] WHERE "organizationId" = '${orgId}'`);
      r = await call(locked, "clocknext_list_composites");
      check("a locked feature → FeatureLockedError (403) naming COMPOSITES", !r.ok && /FeatureLockedError \(403\)/.test(r.text) && /COMPOSITES/.test(r.text), r.text);
      r = await call(locked, "clocknext_list_credits");
      check("…another feature still works", r.ok, r.text);
    } finally {
      psql(`UPDATE "OrgFeatureAccess" SET "lockedFeatures" = ARRAY[]::"PlatformFeature"[] WHERE "organizationId" = '${orgId}'`);
    }
    try {
      psql(`INSERT INTO "PlatformAccount" ("organizationId", "updatedAt", "frozenAt") VALUES ('${orgId}', now(), now())`);
      r = await call(locked, "clocknext_list_plans");
      check("a locked workspace → WorkspaceLockedError (403)", !r.ok && /WorkspaceLockedError \(403\)/.test(r.text), r.text);
    } finally {
      psql(`DELETE FROM "PlatformAccount" WHERE "organizationId" = '${orgId}'`);
    }
    r = await call(locked, "clocknext_list_plans");
    check("…unlocked again → works", r.ok, r.text);
    await locked.close();
  }

  console.log("=== E9 · sandbox customer cap ===");
  if (!sandboxKey) {
    console.log("  [SKIP] set CN_TEST_SANDBOX_KEY (a sandbox with 25+ customers) to run this");
  } else {
    const sandbox = await connect(sandboxKey);
    r = await call(sandbox, "clocknext_whoami");
    check("sandbox key → environment sandbox", r.ok && r.data.organization?.environment === "sandbox", r.text);
    r = await call(sandbox, "clocknext_create_customer", { name: `${P} over cap`, email: `${run}-cap@e2e.example.com` });
    check("create_customer past the cap → ForbiddenError (403)", !r.ok && /ForbiddenError \(403\)/.test(r.text) && /25/.test(r.text), r.text);
    await sandbox.close();
  }

  const notCalled = EXPECTED_TOOLS.filter((t) => !called.has(t));
  check("every tool was called", notCalled.length === 0, notCalled.join(", "));

  console.log(`\nCreated with prefix ${P} (nothing deleted).`);
  console.log(`${checks - failures}/${checks} checks passed, ${failures} failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

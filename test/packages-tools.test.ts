/**
 * Packages — the tools for the package catalog and for the packages on a
 * subscription (Public API v1, 2026-11-15).
 *
 *   GET    /api/v1/packages?active=true       list (archived ones listed unless active=true)
 *   GET    /api/v1/packages/:id               one package
 *   POST   /api/v1/packages                   create { name, description?, subtotalUsd?, entitlements }
 *   PATCH  /api/v1/packages/:id               partial update
 *   POST   /api/v1/packages/:id/archive       archive
 *   POST   /api/v1/packages/:id/unarchive     unarchive
 *   GET    /api/v1/subscriptions/:id          the subscription, with its `packages`
 *   POST   /api/v1/subscriptions/:id/packages { packageIds, recordAsPaid?, idempotencyKey? }
 *   POST   /api/v1/subscriptions/:id/packages/:purchasePackageId/remove { atPeriodEnd?, reason? }
 *
 * A package has no billing cycle, billing mode, rollover or wallet; it holds
 * credits, outcomes, units, composites and at most one flat fee. A refusal
 * names itself in `statusDetail.code`, and the agent must see that code.
 *
 * Needs no server: it registers the tools on a stand-in server, stubs
 * `fetch`, and reads back the requests the tools send.
 *
 *   npx tsx test/packages-tools.test.ts
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ClocknextApi } from "../src/api";
import { registerPackageTools } from "../src/tools/packages";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;
type Tool = {
  config: { description?: string; inputSchema?: z.ZodRawShape; annotations?: Record<string, boolean> };
  handler: Handler;
};

const tools = new Map<string, Tool>();
const fakeServer = {
  registerTool(name: string, config: Tool["config"], handler: Handler) {
    tools.set(name, { config, handler });
  },
};

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

function success(result: unknown, statusCode = 200) {
  return {
    status: statusCode,
    json: { statusCode, statusDetail: { status: "SUCCESS", message: "ok" }, result },
  };
}

function refusal(statusCode: number, code: string, message: string) {
  return {
    status: statusCode,
    json: { statusCode, statusDetail: { status: "ERROR", message, code }, result: null },
  };
}

const BASE = "http://localhost:0";
const cnk = new ClocknextApi({ apiKey: "cnk_test", baseUrl: BASE });
registerPackageTools(fakeServer as never, cnk);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond ? "" : `  <-- ${detail}`}`);
}

function tool(name: string): Tool | undefined {
  return tools.get(name);
}

function describeOf(name: string): string {
  return tool(name)?.config.description ?? "";
}

async function call(name: string, args: Record<string, unknown>) {
  const t = tool(name);
  if (!t) return { missing: true as const };
  const parsed = z.object(t.config.inputSchema ?? {}).safeParse(args);
  if (!parsed.success) {
    return { parseError: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  sent.length = 0;
  const result = await t.handler(parsed.data);
  return { result, requests: [...sent], request: sent[sent.length - 1] };
}

function parses(name: string, args: Record<string, unknown>): boolean {
  const t = tool(name);
  if (!t) return false;
  return z.object(t.config.inputSchema ?? {}).safeParse(args).success;
}

function textOf(r: Awaited<ReturnType<typeof call>>): string {
  return "result" in r ? r.result?.content[0]?.text ?? "" : "";
}

async function main(): Promise<void> {
  console.log("tools");
  const expected = [
    "clocknext_list_packages",
    "clocknext_get_package",
    "clocknext_create_package",
    "clocknext_update_package",
    "clocknext_archive_package",
    "clocknext_unarchive_package",
    "clocknext_get_subscription",
    "clocknext_add_subscription_packages",
    "clocknext_remove_subscription_package",
  ];
  for (const name of expected) check(`${name} is registered`, tools.has(name));

  console.log("catalog: list / get");
  reply = success({
    packages: [
      { id: "pkg_1", isActive: true },
      { id: "pkg_2", isActive: false },
    ],
  });
  const listed = await call("clocknext_list_packages", { active: true });
  check(
    "list_packages active=true sends GET /api/v1/packages?active=true",
    listed.request?.method === "GET" && listed.request?.url === `${BASE}/api/v1/packages?active=true`,
    JSON.stringify(listed.request),
  );
  const archived = await call("clocknext_list_packages", { active: false });
  const archivedData = JSON.parse(textOf(archived) || "{}");
  check(
    "list_packages returns { count, packages }",
    archivedData.count !== undefined && Array.isArray(archivedData.packages),
    JSON.stringify(archivedData),
  );
  check(
    "list_packages active=false returns only archived ones (the API filters only active=true)",
    archivedData.packages?.length === 1 && archivedData.packages[0].id === "pkg_2",
    JSON.stringify(archivedData),
  );

  reply = success({ package: { id: "pkg_1", name: "Booster" } });
  const got = await call("clocknext_get_package", { id: "pkg_1" });
  check(
    "get_package sends GET /api/v1/packages/pkg_1",
    got.request?.method === "GET" && got.request?.url === `${BASE}/api/v1/packages/pkg_1`,
    JSON.stringify(got.request),
  );
  check("get_package returns the package", /Booster/.test(textOf(got)), textOf(got));

  console.log("catalog: create");
  reply = success({ created: true, package: { id: "pkg_3" } }, 201);
  const created = await call("clocknext_create_package", {
    name: "Booster",
    description: "500 extra credits",
    subtotalUsd: 4,
    entitlements: [
      { type: "CREDIT", creditId: "cr_1", quantity: 500 },
      { type: "COMPOSITE", compositeId: "pm_1", quantity: 5 },
      { type: "FLAT", amount: 2 },
    ],
  });
  check("create_package parses", !("parseError" in created), String((created as { parseError?: string }).parseError));
  check(
    "create_package sends POST /api/v1/packages",
    created.request?.method === "POST" && created.request?.url === `${BASE}/api/v1/packages`,
    JSON.stringify(created.request),
  );
  check(
    "create_package sends the body the API takes",
    JSON.stringify(created.request?.body) ===
      JSON.stringify({
        name: "Booster",
        description: "500 extra credits",
        subtotalUsd: 4,
        entitlements: [
          { type: "CREDIT", creditId: "cr_1", quantity: 500 },
          { type: "COMPOSITE", compositeId: "pm_1", quantity: 5 },
          { type: "FLAT", amount: 2 },
        ],
      }),
    JSON.stringify(created.request?.body),
  );
  check("create_package returns the package", /pkg_3/.test(textOf(created)), textOf(created));
  check(
    "create_package refuses a WALLET entitlement",
    !parses("clocknext_create_package", { name: "W", entitlements: [{ type: "WALLET", amount: 10 }] }),
  );
  check(
    "create_package refuses PRICING_METRIC (the API takes COMPOSITE)",
    !parses("clocknext_create_package", {
      name: "P",
      entitlements: [{ type: "PRICING_METRIC", compositeId: "pm_1", quantity: 1 }],
    }),
  );
  check(
    "create_package refuses a fractional quantity",
    !parses("clocknext_create_package", {
      name: "Q",
      entitlements: [{ type: "CREDIT", creditId: "cr_1", quantity: 1.5 }],
    }),
  );
  check(
    "create_package refuses a price below $0",
    !parses("clocknext_create_package", {
      name: "N",
      subtotalUsd: -1,
      entitlements: [{ type: "CREDIT", creditId: "cr_1", quantity: 1 }],
    }),
  );
  check(
    "create_package needs at least one entitlement",
    !parses("clocknext_create_package", { name: "E", entitlements: [] }),
  );
  const createShape = tool("clocknext_create_package")?.config.inputSchema ?? {};
  for (const field of ["billingCycle", "billingMode", "rollover", "isActive", "currencyCode", "components", "priceAdjustmentUsd"]) {
    check(`create_package has no ${field} field`, !(field in createShape));
  }
  const entitlementShape = getEntitlementShape("clocknext_create_package");
  for (const field of ["billingMode", "rollover", "pricingMetricId"]) {
    check(`a package entitlement has no ${field} field`, !(field in entitlementShape));
  }

  console.log("catalog: update");
  reply = success({ updated: true, package: { id: "pkg_1" } });
  const renamed = await call("clocknext_update_package", { id: "pkg_1", name: "Booster XL" });
  check(
    "update_package sends PATCH /api/v1/packages/pkg_1",
    renamed.request?.method === "PATCH" && renamed.request?.url === `${BASE}/api/v1/packages/pkg_1`,
    JSON.stringify(renamed.request),
  );
  check(
    "update_package sends only the fields passed",
    JSON.stringify(renamed.request?.body) === JSON.stringify({ name: "Booster XL" }),
    JSON.stringify(renamed.request?.body),
  );
  const relisted = await call("clocknext_update_package", {
    id: "pkg_1",
    entitlements: [{ id: "pkc_1", type: "CREDIT", creditId: "cr_1", quantity: 800 }],
  });
  check(
    "update_package sends an entitlement's id back",
    JSON.stringify(relisted.request?.body) ===
      JSON.stringify({ entitlements: [{ id: "pkc_1", type: "CREDIT", creditId: "cr_1", quantity: 800 }] }),
    JSON.stringify(relisted.request?.body),
  );
  const cleared = await call("clocknext_update_package", { id: "pkg_1", description: null });
  check(
    "update_package description=null clears it",
    JSON.stringify(cleared.request?.body) === JSON.stringify({ description: null }),
    JSON.stringify(cleared.request?.body),
  );
  const empty = await call("clocknext_update_package", { id: "pkg_1" });
  check(
    "update_package with nothing to change is an error and sends nothing",
    "result" in empty && empty.result?.isError === true && empty.requests?.length === 0,
    JSON.stringify(empty),
  );

  console.log("catalog: archive / unarchive");
  reply = success({ archived: true, package: { id: "pkg_1", isActive: false } });
  const arch = await call("clocknext_archive_package", { id: "pkg_1" });
  check(
    "archive_package sends POST /api/v1/packages/pkg_1/archive",
    arch.request?.method === "POST" && arch.request?.url === `${BASE}/api/v1/packages/pkg_1/archive`,
    JSON.stringify(arch.request),
  );
  reply = success({ unarchived: true, package: { id: "pkg_1", isActive: true } });
  const unarch = await call("clocknext_unarchive_package", { id: "pkg_1" });
  check(
    "unarchive_package sends POST /api/v1/packages/pkg_1/unarchive",
    unarch.request?.method === "POST" && unarch.request?.url === `${BASE}/api/v1/packages/pkg_1/unarchive`,
    JSON.stringify(unarch.request),
  );

  console.log("subscription: get");
  reply = success({ subscription: { id: "pur_1", packages: [{ id: "pp_1", status: "ACTIVE" }] } });
  const sub = await call("clocknext_get_subscription", { id: "pur_1" });
  check(
    "get_subscription sends GET /api/v1/subscriptions/pur_1",
    sub.request?.method === "GET" && sub.request?.url === `${BASE}/api/v1/subscriptions/pur_1`,
    JSON.stringify(sub.request),
  );
  check("get_subscription returns its packages", /pp_1/.test(textOf(sub)), textOf(sub));

  console.log("subscription: add packages");
  reply = success(
    {
      purchasePackages: [{ id: "pp_1", status: "AWAITING_PAYMENT" }],
      invoice: { id: "inv_1", payUrl: "https://pay" },
      replayed: false,
    },
    201,
  );
  const attached = await call("clocknext_add_subscription_packages", {
    subscriptionId: "pur_1",
    packageIds: ["pkg_1", "pkg_2"],
    idempotencyKey: "attach-1",
  });
  check(
    "add_subscription_packages sends POST /api/v1/subscriptions/pur_1/packages",
    attached.request?.method === "POST" && attached.request?.url === `${BASE}/api/v1/subscriptions/pur_1/packages`,
    JSON.stringify(attached.request),
  );
  check(
    "add_subscription_packages sends { packageIds, idempotencyKey }",
    JSON.stringify(attached.request?.body) ===
      JSON.stringify({ packageIds: ["pkg_1", "pkg_2"], idempotencyKey: "attach-1" }),
    JSON.stringify(attached.request?.body),
  );
  const attachedData = JSON.parse(textOf(attached) || "{}");
  check(
    "add_subscription_packages returns the purchasePackages and the invoice",
    Array.isArray(attachedData.purchasePackages) && attachedData.invoice?.id === "inv_1",
    JSON.stringify(attachedData),
  );
  const paid = await call("clocknext_add_subscription_packages", {
    subscriptionId: "pur_1",
    packageIds: ["pkg_1"],
    recordAsPaid: { mode: "BANK_TRANSFER", reference: "TX-9" },
  });
  check(
    "add_subscription_packages sends recordAsPaid",
    JSON.stringify(paid.request?.body) ===
      JSON.stringify({ packageIds: ["pkg_1"], recordAsPaid: { mode: "BANK_TRANSFER", reference: "TX-9" } }),
    JSON.stringify(paid.request?.body),
  );
  check(
    "add_subscription_packages refuses no package ids",
    !parses("clocknext_add_subscription_packages", { subscriptionId: "pur_1", packageIds: [] }),
  );
  check(
    "add_subscription_packages refuses more than 10 package ids",
    !parses("clocknext_add_subscription_packages", {
      subscriptionId: "pur_1",
      packageIds: Array.from({ length: 11 }, (_, i) => `pkg_${i}`),
    }),
  );
  check(
    "add_subscription_packages refuses the same package twice",
    !parses("clocknext_add_subscription_packages", { subscriptionId: "pur_1", packageIds: ["pkg_1", "pkg_1"] }),
  );
  check(
    "add_subscription_packages refuses an unknown payment mode",
    !parses("clocknext_add_subscription_packages", {
      subscriptionId: "pur_1",
      packageIds: ["pkg_1"],
      recordAsPaid: { mode: "BITCOIN" },
    }),
  );

  reply = refusal(409, "PACKAGE_ENTITLEMENT_NOT_ON_PLAN", "The plan has no advance AI credits.");
  const notOnPlan = await call("clocknext_add_subscription_packages", {
    subscriptionId: "pur_1",
    packageIds: ["pkg_1"],
  });
  const notOnPlanText = textOf(notOnPlan);
  check(
    "a refusal is an error result",
    "result" in notOnPlan && notOnPlan.result?.isError === true,
    JSON.stringify(notOnPlan),
  );
  check(
    "a refusal shows its statusDetail.code to the agent",
    /PACKAGE_ENTITLEMENT_NOT_ON_PLAN/.test(notOnPlanText),
    notOnPlanText,
  );
  check(
    "an attach (a POST) is sent once, never retried on a 409",
    "requests" in notOnPlan && notOnPlan.requests?.length === 1,
    JSON.stringify("requests" in notOnPlan ? notOnPlan.requests : notOnPlan),
  );

  console.log("subscription: remove a package");
  reply = success({ purchasePackage: { id: "pp_1", status: "ENDED" }, invoice: null });
  const removedNow = await call("clocknext_remove_subscription_package", {
    subscriptionId: "pur_1",
    purchasePackageId: "pp_1",
  });
  check(
    "remove_subscription_package sends POST …/packages/pp_1/remove",
    removedNow.request?.method === "POST" &&
      removedNow.request?.url === `${BASE}/api/v1/subscriptions/pur_1/packages/pp_1/remove`,
    JSON.stringify(removedNow.request),
  );
  check(
    "remove_subscription_package without atPeriodEnd sends an empty body (remove now)",
    JSON.stringify(removedNow.request?.body) === JSON.stringify({}),
    JSON.stringify(removedNow.request?.body),
  );
  reply = success({ purchasePackage: { id: "pp_1", status: "ENDING" }, invoice: null });
  const removedLater = await call("clocknext_remove_subscription_package", {
    subscriptionId: "pur_1",
    purchasePackageId: "pp_1",
    atPeriodEnd: true,
    reason: "Not needed",
  });
  check(
    "remove_subscription_package sends atPeriodEnd and reason",
    JSON.stringify(removedLater.request?.body) === JSON.stringify({ atPeriodEnd: true, reason: "Not needed" }),
    JSON.stringify(removedLater.request?.body),
  );
  check(
    "remove_subscription_package refuses a reason over 200 characters",
    !parses("clocknext_remove_subscription_package", {
      subscriptionId: "pur_1",
      purchasePackageId: "pp_1",
      reason: "x".repeat(201),
    }),
  );
  reply = refusal(409, "PACKAGE_AWAITING_PAYMENT", "This package is not paid yet.");
  const unpaid = await call("clocknext_remove_subscription_package", {
    subscriptionId: "pur_1",
    purchasePackageId: "pp_1",
  });
  check("a remove refusal shows its code", /PACKAGE_AWAITING_PAYMENT/.test(textOf(unpaid)), textOf(unpaid));

  console.log("descriptions");
  const create = describeOf("clocknext_create_package");
  check("create_package says the entitlements must be on the plan as advance", /plan/i.test(create) && /advance/i.test(create), create);
  check("create_package says there is no billing cycle", /billing cycle/i.test(create), create);
  check("create_package says there is no wallet", /wallet/i.test(create), create);
  check("create_package says there is no rollover", /rollover/i.test(create), create);
  const add = describeOf("clocknext_add_subscription_packages");
  for (const code of [
    "SUBSCRIPTION_NOT_FOUND",
    "PACKAGE_NOT_FOUND",
    "SUBSCRIPTION_NOT_ACTIVE",
    "PACKAGE_ARCHIVED",
    "PACKAGE_ENTITLEMENT_NOT_ON_PLAN",
    "PACKAGE_ENTITLEMENT_METERED",
    "IDEMPOTENCY_KEY_REUSED",
  ]) {
    check(`add_subscription_packages names ${code}`, add.includes(code), add);
  }
  check("add_subscription_packages says it raises a real invoice", /invoice/i.test(add) && /real/i.test(add), add);
  const remove = describeOf("clocknext_remove_subscription_package");
  check("remove_subscription_package says it removes now by default", /now/i.test(remove), remove);
  check("remove_subscription_package names atPeriodEnd", /atPeriodEnd/.test(remove), remove);
  for (const code of [
    "PACKAGE_NOT_FOUND",
    "PACKAGE_ENDED",
    "PACKAGE_AWAITING_PAYMENT",
    "PACKAGE_ALREADY_ENDING",
    "RENEWAL_PAID_IN_PART",
    "CHARGE_IN_FLIGHT",
    "USAGE_UNAVAILABLE",
  ]) {
    check(`remove_subscription_package names ${code}`, remove.includes(code), remove);
  }
  for (const name of expected) {
    check(`${name} never says "dashboard"`, !/dashboard/i.test(describeOf(name)));
  }
  check(
    "add_subscription_packages is not idempotent and not read-only",
    tool("clocknext_add_subscription_packages")?.config.annotations?.readOnlyHint === false &&
      tool("clocknext_add_subscription_packages")?.config.annotations?.idempotentHint === false,
  );
  check(
    "remove_subscription_package is destructive",
    tool("clocknext_remove_subscription_package")?.config.annotations?.destructiveHint === true,
  );

  console.log("onboarding skill");
  const skill = readFileSync("skills/clocknext-onboarding/SKILL.md", "utf8");
  check("SKILL.md names packages", /package/i.test(skill));
  check("SKILL.md names clocknext_create_package", skill.includes("clocknext_create_package"));
  check("SKILL.md names clocknext_add_subscription_packages", skill.includes("clocknext_add_subscription_packages"));
  check("SKILL.md lists packages in the reconcile step", /clocknext_list_packages/.test(skill));
  let reference = "";
  try {
    reference = readFileSync("skills/clocknext-onboarding/references/packages.md", "utf8");
  } catch {
    // missing
  }
  check("references/packages.md exists", reference.length > 0);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

/** The fields of one package entitlement, read from a tool's schema. */
function getEntitlementShape(name: string): z.ZodRawShape {
  const list = tool(name)?.config.inputSchema?.entitlements as z.ZodTypeAny | undefined;
  if (!list) return {};
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

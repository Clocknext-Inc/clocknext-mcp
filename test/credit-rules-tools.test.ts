/**
 * BEHAVIOUR SPEC — credit rule tools (SE-562, 2026-11-27).
 *
 * Written BEFORE the code. If a check fails, the code is wrong.
 *
 * The Public API v1 has 4 credit rule routes, by the credit's id:
 *   GET   /api/v1/credits/:creditId/rules           → { rules }
 *   GET   /api/v1/credits/:creditId/rules/:ruleId   → { rule }
 *   POST  /api/v1/credits/:creditId/rules           → 201 { created, rule, moved }
 *   PATCH /api/v1/credits/:creditId/rules/:ruleId   → { updated, rule, moved }
 *
 * Rules:
 *   T1 4 tools: clocknext_list_credit_rules, _get_credit_rule,
 *      _create_credit_rule, _update_credit_rule. No delete tool.
 *   T2 list / get call the GET routes and return the rules / the rule.
 *   T3 create POSTs the rule; creditId goes in the path, never in the body. It
 *      returns the rule and `moved`.
 *   T4 update PATCHes only the fields sent; creditId and ruleId go in the path.
 *      `priority: null` is sent as null (keeps the place).
 *   T5 The schema refuses what the API refuses: priority 0 or a fraction, an
 *      unknown mode or operator, no conditions.
 *   T6 A refusal is an error result with the status and the API's message.
 *   T7 The texts tell the agent: a modelName condition takes the model id from
 *      clocknext_list_models; priority 1 runs first; conditions on update
 *      replace the whole list; a custom.<key> field needs valueType.
 *
 * Needs no server: it registers the tools on a stand-in server, stubs
 * `fetch`, and reads back the requests the tools send.
 *
 *   npx tsx test/credit-rules-tools.test.ts
 */
import { z } from "zod";
import { ClocknextApi } from "../src/api";
import { registerCreditRuleTools } from "../src/tools/credit-rules";

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

const success = (result: unknown, status = 200) => ({
  status,
  json: { statusCode: status, statusDetail: { status: "SUCCESS", message: "ok" }, result },
});
const refused = (status: number, code: string, message: string) => ({
  status,
  json: { statusCode: status, statusDetail: { status: "ERROR", message, code }, result: {} },
});

const BASE = "http://localhost:0";
const cnk = new ClocknextApi({ apiKey: "cnk_test", baseUrl: BASE });
registerCreditRuleTools(fakeServer as never, cnk);

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

async function call(name: string, args: Record<string, unknown>) {
  const parsed = z.object(tool(name).config.inputSchema ?? {}).safeParse(args);
  if (!parsed.success) return { parseError: parsed.error.issues.map((i) => i.message).join("; ") };
  sent.length = 0;
  const result = await tool(name).handler(parsed.data);
  return { result, request: sent[sent.length - 1] };
}

const parses = (name: string, args: Record<string, unknown>) =>
  z.object(tool(name).config.inputSchema ?? {}).safeParse(args).success;

const text = (r: Awaited<ReturnType<typeof call>>) => ("result" in r && r.result ? r.result.content[0]?.text ?? "" : "");

const rule = { id: "rule_1", creditId: "cr_1", name: "GPT-4o", priority: 1, conditions: [] };
const baseCreate = {
  creditId: "cr_1",
  name: "GPT-4o costs more",
  mode: "MARGIN",
  marginPercent: 40,
  conditions: [{ fieldPath: "modelName", operator: "EQ", value: "gpt-4o" }],
};

async function main(): Promise<void> {
  console.log("T1 tools");
  for (const name of ["list", "get", "create", "update"]) {
    check(`clocknext_${name}_credit_rule${name === "list" ? "s" : ""} is registered`, tools.has(`clocknext_${name}_credit_rule${name === "list" ? "s" : ""}`));
  }
  check("no delete tool", ![...tools.keys()].some((n) => n.includes("delete")), [...tools.keys()].join(", "));

  console.log("T2 reads");
  reply = success({ rules: [rule] });
  const listed = await call("clocknext_list_credit_rules", { creditId: "cr_1" });
  check("list sends GET /api/v1/credits/cr_1/rules", listed.request?.method === "GET" && listed.request.url === `${BASE}/api/v1/credits/cr_1/rules`, JSON.stringify(listed.request));
  check("list returns the rules", text(listed).includes('"rule_1"'), text(listed));

  reply = success({ rule });
  const got = await call("clocknext_get_credit_rule", { creditId: "cr_1", ruleId: "rule_1" });
  check("get sends GET /api/v1/credits/cr_1/rules/rule_1", got.request?.method === "GET" && got.request.url === `${BASE}/api/v1/credits/cr_1/rules/rule_1`, JSON.stringify(got.request));
  check("get returns the rule", text(got).includes('"rule_1"'), text(got));

  console.log("T3 create");
  reply = success({ created: true, rule, moved: [{ id: "rule_0", priority: 2 }] }, 201);
  const created = await call("clocknext_create_credit_rule", { ...baseCreate, priority: 1 });
  const createBody = (created.request?.body ?? {}) as Record<string, unknown>;
  check("create sends POST /api/v1/credits/cr_1/rules", created.request?.method === "POST" && created.request.url === `${BASE}/api/v1/credits/cr_1/rules`, JSON.stringify(created.request));
  check("create body has no creditId", !("creditId" in createBody), JSON.stringify(createBody));
  check(
    "create body is the rule as sent",
    JSON.stringify(createBody) ===
      JSON.stringify({ name: baseCreate.name, mode: "MARGIN", marginPercent: 40, priority: 1, conditions: baseCreate.conditions }),
    JSON.stringify(createBody),
  );
  check("create returns the rule and moved", text(created).includes('"rule_1"') && text(created).includes('"moved"') && text(created).includes('"rule_0"'), text(created));

  console.log("T4 update");
  reply = success({ updated: true, rule, moved: [] });
  const updated = await call("clocknext_update_credit_rule", { creditId: "cr_1", ruleId: "rule_1", isActive: false, priority: null });
  const updateBody = (updated.request?.body ?? {}) as Record<string, unknown>;
  check("update sends PATCH /api/v1/credits/cr_1/rules/rule_1", updated.request?.method === "PATCH" && updated.request.url === `${BASE}/api/v1/credits/cr_1/rules/rule_1`, JSON.stringify(updated.request));
  check("update body is only the fields sent, null priority kept", JSON.stringify(updateBody) === JSON.stringify({ isActive: false, priority: null }), JSON.stringify(updateBody));

  console.log("T5 schema");
  check("create refuses priority 0", !parses("clocknext_create_credit_rule", { ...baseCreate, priority: 0 }));
  check("create refuses priority 1.5", !parses("clocknext_create_credit_rule", { ...baseCreate, priority: 1.5 }));
  check("create refuses mode OTHER", !parses("clocknext_create_credit_rule", { ...baseCreate, mode: "OTHER" }));
  check("create refuses operator LIKE", !parses("clocknext_create_credit_rule", { ...baseCreate, conditions: [{ fieldPath: "status", operator: "LIKE", value: "x" }] }));
  check("create refuses no conditions", !parses("clocknext_create_credit_rule", { ...baseCreate, conditions: [] }));
  check("create accepts a custom field with valueType", parses("clocknext_create_credit_rule", { ...baseCreate, conditions: [{ fieldPath: "custom.tier", operator: "EQ", valueType: "STRING", value: "pro", joiner: "AND" }] }));

  console.log("T6 refusal");
  reply = refused(409, "CREDIT_RULE_DUPLICATE", "A rule with these conditions already exists.");
  const dup = await call("clocknext_create_credit_rule", baseCreate);
  check("a 409 is an error result", "result" in dup && dup.result?.isError === true, JSON.stringify(dup));
  check("the error names the status and the message", /409/.test(text(dup)) && text(dup).includes("already exists"), text(dup));

  console.log("T7 texts");
  const createText = [
    tool("clocknext_create_credit_rule").config.description ?? "",
    ...Object.values(tool("clocknext_create_credit_rule").config.inputSchema ?? {}).map((s) => String((s as z.ZodTypeAny).description ?? "")),
    JSON.stringify(tool("clocknext_create_credit_rule").config.inputSchema?.conditions ?? {}),
  ].join("\n");
  check("modelName takes the model id from clocknext_list_models", /modelName/.test(createText) && /clocknext_list_models/.test(createText), "");
  check("priority 1 runs first", /1 runs first|1 = first|1 is first/i.test(createText), "");
  check("custom.<key> needs valueType", /custom\.<key>/.test(createText) && /valueType/.test(createText), "");
  const updateText = tool("clocknext_update_credit_rule").config.description ?? "";
  check("update says conditions replace the whole list", /replace/i.test(updateText) && /conditions/.test(updateText), updateText);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

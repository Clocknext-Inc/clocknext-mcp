/**
 * REGRESSION — `clocknext_bulk_import_customers` is removed, and
 * `clocknext_create_customer` no longer takes `addressLine2`.
 *
 * The Payments public API v1 removes `POST /api/v1/customers/bulk` and the
 * customer `creditAllowance` field (Payments PR #142, 2026-11-03). The
 * public create never accepted `addressLine2` (the server dropped it), and
 * #142 drops the column. The other customer tools stay.
 *
 * Needs no server: it registers the tools on a stand-in server, stubs
 * `fetch`, and reads back the names, the input fields and the request body.
 *
 *   npx tsx test/bulk-import-removed.test.ts
 */
import { z } from "zod";
import { ClocknextApi } from "../src/api";
import { registerCustomerTools } from "../src/tools/customers";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type Tool = { config: { description?: string; inputSchema?: z.ZodRawShape }; handler: Handler };

const tools = new Map<string, Tool>();
const fakeServer = {
  registerTool(name: string, config: Tool["config"], handler: Handler) {
    tools.set(name, { config, handler });
  },
};

const sent: { url: string; body: unknown }[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  sent.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
  return new Response(
    JSON.stringify({
      statusCode: 200,
      statusDetail: { status: "SUCCESS", message: "ok" },
      result: { customer: { id: "cus_1" } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

const cnk = new ClocknextApi({ apiKey: "cnk_test", baseUrl: "http://localhost:0" });
registerCustomerTools(fakeServer as never, cnk);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond ? "" : `  <-- ${detail}`}`);
}

async function main(): Promise<void> {
  const names = [...tools.keys()];
  check(
    "clocknext_bulk_import_customers is not registered",
    !names.includes("clocknext_bulk_import_customers"),
    `registered: ${names.join(", ")}`,
  );
  check("the API client has no customers.bulkCreate()", !("bulkCreate" in cnk.customers), "cnk.customers.bulkCreate still exists");
  check(
    "the other customer tools are still registered",
    ["clocknext_create_customer", "clocknext_get_customer", "clocknext_list_customers", "clocknext_create_purchase"].every(
      (n) => names.includes(n),
    ),
    `registered: ${names.join(", ")}`,
  );

  const create = tools.get("clocknext_create_customer");
  const shape = create?.config.inputSchema ?? {};
  check("create_customer has no addressLine2 field", !("addressLine2" in shape), Object.keys(shape).join(", "));
  check("create_customer still has addressLine1", "addressLine1" in shape, Object.keys(shape).join(", "));

  const parsed = z.object(shape).parse({ name: "Acme", email: "a@acme.test", addressLine2: "Suite 4" });
  await create?.handler(parsed);
  const body = (sent[sent.length - 1]?.body ?? {}) as Record<string, unknown>;
  check("create_customer does not send addressLine2", !("addressLine2" in body), JSON.stringify(body));

  const text = [...tools.values()]
    .map((t) => `${t.config.description ?? ""} ${Object.values(t.config.inputSchema ?? {}).map((f) => f.description ?? "").join(" ")}`)
    .join(" ");
  check("no customer tool text says bulk", !/bulk/i.test(text), "a description still says bulk");
  check("no customer tool text says creditAllowance", !/creditAllowance/.test(text), "a description still says creditAllowance");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

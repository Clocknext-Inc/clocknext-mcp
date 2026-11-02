/**
 * REGRESSION — `clocknext_get_customer_usage` is removed (SE-100).
 *
 * The tool read `GET /api/v1/usage`, which the server no longer has: that
 * route read a table the edge does not write, so its numbers were frozen.
 * The customer tools stay; only the usage read goes.
 *
 * Needs no server: it registers the tools on a stand-in server and reads the
 * names back.
 *
 *   npx tsx test/customer-usage-removed.test.ts
 */
import { ClocknextApi } from "../src/api";
import { registerCustomerTools } from "../src/tools/customers";

const registered: string[] = [];
const fakeServer = {
  registerTool(name: string) {
    registered.push(name);
  },
};

const cnk = new ClocknextApi({ apiKey: "cnk_test", baseUrl: "http://localhost:0" });
registerCustomerTools(fakeServer as never, cnk);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond ? "" : `  <-- ${detail}`}`);
}

check(
  "clocknext_get_customer_usage is not registered",
  !registered.includes("clocknext_get_customer_usage"),
  `registered: ${registered.join(", ")}`,
);
check(
  "the API client has no customers.usage()",
  !("usage" in cnk.customers),
  "cnk.customers.usage still exists",
);
check(
  "the other customer tools are still registered",
  registered.includes("clocknext_get_customer_balances") && registered.includes("clocknext_get_customer_plan"),
  `registered: ${registered.join(", ")}`,
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

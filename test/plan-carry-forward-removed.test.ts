/**
 * REGRESSION — the plan tools no longer take `carryForward`.
 *
 * The server never read it: the wallet always carries into the next cycle,
 * and each entitlement line resets or rolls over by its own `rollover`. The
 * Payments API dropped the column, so the tools stop offering it.
 *
 * Needs no server: it registers the tools on a stand-in server and reads the
 * input shapes and descriptions back.
 *
 *   npx tsx test/plan-carry-forward-removed.test.ts
 */
import { ClocknextApi } from "../src/api";
import { registerCatalogueTools } from "../src/tools/catalogue";

type ToolConfig = { description?: string; inputSchema?: Record<string, unknown> };
const tools = new Map<string, ToolConfig>();
const fakeServer = {
  registerTool(name: string, config: ToolConfig) {
    tools.set(name, config);
  },
};

const cnk = new ClocknextApi({ apiKey: "cnk_test", baseUrl: "http://localhost:0" });
registerCatalogueTools(fakeServer as never, cnk);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond ? "" : `  <-- ${detail}`}`);
}

for (const name of ["clocknext_create_plan", "clocknext_update_plan"]) {
  const tool = tools.get(name);
  check(`${name} is registered`, tool !== undefined, `registered: ${[...tools.keys()].join(", ")}`);
  check(
    `${name} has no carryForward input`,
    tool?.inputSchema !== undefined && !("carryForward" in tool.inputSchema),
    "carryForward is still in the input schema",
  );
  check(
    `${name} does not mention carryForward`,
    !(tool?.description ?? "").includes("carryForward"),
    "the description still names carryForward",
  );
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

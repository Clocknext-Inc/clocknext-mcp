/**
 * REGRESSION — Payments entitlements cleanup (2026-11-05).
 *
 * - The public API has no hard delete for a credit, an outcome or a unit.
 *   No text says that one exists.
 * - The balances tool names every kind it returns, composites included, and
 *   the key that names each kind.
 * - A signal tags a composite with its `composite` block
 *   (`{ "<refId>": "<your id>" }`). "compositeRef" is not a field.
 * - The API no longer returns a credit's `tokensPerCredit` or a unit's
 *   `createdByName`. No tool or skill text names them.
 *
 * Needs no server: it registers the tools on a stand-in server and reads the
 * descriptions back, and it reads the tracked text files.
 *
 *   npx tsx test/entitlements-texts.test.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ClocknextApi } from "../src/api";
import { registerCustomerTools } from "../src/tools/customers";
import { registerCompositeTools } from "../src/tools/composites";

const descriptions = new Map<string, string>();
const fakeServer = {
  registerTool(name: string, config: { description?: string }) {
    descriptions.set(name, config.description ?? "");
  },
};

const cnk = new ClocknextApi({ apiKey: "cnk_test", baseUrl: "http://localhost:0" });
registerCustomerTools(fakeServer as never, cnk);
registerCompositeTools(fakeServer as never, cnk);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond ? "" : `  <-- ${detail}`}`);
}

const balances = descriptions.get("clocknext_get_customer_balances") ?? "";
check("the balances tool names composites", /composite/i.test(balances), balances);
check(
  "the balances tool names the key of a composite (refId)",
  /refId/.test(balances),
  balances,
);

const createComposite = descriptions.get("clocknext_create_composite") ?? "";
check(
  "create_composite does not name a 'compositeRef' field",
  !/compositeRef/.test(createComposite),
  createComposite,
);
check(
  "create_composite names the signal's composite block",
  /`composite`/.test(createComposite),
  createComposite,
);

// Every tracked text file: source, the built dist/, the skill, every .md.
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f !== "" && f !== "test/entitlements-texts.test.ts");

const banned: [string, RegExp][] = [
  ["a hard delete on the API", /hard delete exists/i],
  ["compositeRef", /compositeRef/],
  ["tokensPerCredit", /tokensPerCredit/],
  ["createdByName", /createdByName/],
];
for (const [label, pattern] of banned) {
  const hits: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // listed but deleted in the working tree
    }
    text.split("\n").forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${file}:${i + 1}`);
    });
  }
  check(`no tracked file names ${label}`, hits.length === 0, hits.slice(0, 10).join(", "));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

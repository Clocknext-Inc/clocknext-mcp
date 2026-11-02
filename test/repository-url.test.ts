/**
 * REGRESSION — every repository address names the real repo,
 * github.com/Clocknext-Inc/clocknext-mcp, and the MCP Registry name is
 * io.github.Clocknext-Inc/mcp.
 *
 * The repo moved to the Clocknext-Inc organisation. npm publishes with
 * provenance, and refuses (E422) a package whose `repository.url` is not the
 * repo the build ran in — the old github.com/Clocknext/… address only
 * redirects, so it no longer matches. The MCP Registry lets a run in the
 * Clocknext-Inc repo publish only io.github.Clocknext-Inc/* (it refused
 * io.github.Clocknext/mcp with a 403), and it checks the npm package's
 * `mcpName` against server.json's `name`.
 *
 * Needs no server:
 *
 *   npx tsx test/repository-url.test.ts
 */
import { readFileSync } from "node:fs";

const REPO = "https://github.com/Clocknext-Inc/clocknext-mcp";
const REGISTRY_NAME = "io.github.Clocknext-Inc/mcp";

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const pkg = json("package.json");
const server = json("server.json");
const plugin = json(".claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");

let failures = 0;
function check(label: string, actual: unknown, expected: string): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${ok ? "" : `  <-- ${String(actual)}`}`);
}

check("package.json repository.url", pkg.repository?.url, `git+${REPO}.git`);
check("server.json repository.url", server.repository?.url, REPO);
check(".claude-plugin/plugin.json homepage", plugin.homepage, REPO);
check(".claude-plugin/plugin.json repository", plugin.repository, REPO);
check("package.json mcpName", pkg.mcpName, REGISTRY_NAME);
check("server.json name", server.name, REGISTRY_NAME);
for (const entry of marketplace.plugins ?? []) {
  check(`.claude-plugin/marketplace.json ${entry.name} homepage`, entry.homepage, REPO);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

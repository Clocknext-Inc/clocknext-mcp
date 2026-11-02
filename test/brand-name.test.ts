/**
 * REGRESSION — the product name is written "Clocknext", never "ClockNext".
 *
 * Checks every file git tracks (source, the built dist/, the skill, every
 * .md) for the old spelling. The lower-case package name `clocknext` and the
 * env names `CLOCKNEXT_*` are other spellings and are not affected.
 *
 * Needs no server:
 *
 *   npx tsx test/brand-name.test.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const OLD = "Clock" + "Next"; // split so this file does not match itself

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f !== "");

const hits: string[] = [];
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // listed but deleted in the working tree
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(OLD)) hits.push(`${file}:${i + 1}`);
  }
}

if (hits.length === 0) {
  console.log(`  [PASS] no "${OLD}" in ${files.length} tracked files`);
  process.exit(0);
}
console.log(`  [FAIL] "${OLD}" found ${hits.length} times:`);
for (const hit of hits.slice(0, 20)) console.log(`    ${hit}`);
if (hits.length > 20) console.log(`    … and ${hits.length - 20} more`);
process.exit(1);

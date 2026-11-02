import { z } from "zod";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errMsg, errorResult, jsonResult } from "./util";

/**
 * clocknext_write_env — write CLOCKNEXT_API_KEY into a project's `.env` file
 * WITHOUT the key ever entering the model's context.
 *
 * The server already holds the key in its own process env; this tool copies it
 * server-side into the target file and returns only a success marker. That
 * closes the last manual step of onboarding (the user pasting the key into the
 * integrated project) while preserving the invariant that no tool result ever
 * contains the secret.
 *
 * Guard rails (the path is model-supplied, so these stop a steered agent from
 * writing the secret somewhere it leaks):
 * - only files literally named `.env`, `.env.local`, `.env.development`, or
 *   `.env.development.local` are accepted;
 * - inside a git work tree the file must be untracked AND gitignored — refuse
 *   otherwise, so the key can't be routed into something that gets committed.
 */

const ALLOWED_NAMES = new Set([".env", ".env.local", ".env.development", ".env.development.local"]);

const KEY_LINE_RE = /^\s*(?:export\s+)?CLOCKNEXT_API_KEY\s*=.*$/m;

/** Returns a human-readable refusal reason, or null when the write is safe. */
function gitGuard(fileAbs: string): string | null {
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: dirname(fileAbs), encoding: "utf8", timeout: 5_000 });

  const inRepo = run(["rev-parse", "--is-inside-work-tree"]);
  // git missing or not a repo — nothing to guard against.
  if (inRepo.error || inRepo.status !== 0) return null;

  if (run(["ls-files", "--error-unmatch", "--", fileAbs]).status === 0) {
    return "the file is tracked by git — a committed .env would publish the key. Untrack it (`git rm --cached`) and gitignore it, then retry.";
  }
  if (run(["check-ignore", "-q", "--", fileAbs]).status !== 0) {
    return "the file is not covered by .gitignore — it could be committed with the key inside. Add it to .gitignore, then retry.";
  }
  return null;
}

export function registerWriteEnv(server: McpServer): void {
  server.registerTool(
    "clocknext_write_env",
    {
      title: "Clocknext: write the API key into a project .env",
      description: [
        "Write `CLOCKNEXT_API_KEY=<the org's cnk_… key>` into a project's `.env` file, server-side. The key is copied from this MCP server's own environment directly into the file — it is NEVER returned to you and never appears in the conversation. Use this as the last integration step so the code you generated (which reads `process.env.CLOCKNEXT_API_KEY`) can run; the alternative is the user pasting the key themselves.",
        "",
        "Rules:",
        "- The target must be named exactly `.env`, `.env.local`, `.env.development`, or `.env.development.local`.",
        "- Inside a git repo the file must be untracked and gitignored, otherwise the tool refuses (a committed .env would leak the key). Fix .gitignore first, then retry.",
        "- An existing `CLOCKNEXT_API_KEY=` line is replaced in place; otherwise the line is appended. Nothing else in the file is touched.",
        "- Put only a `CLOCKNEXT_API_KEY=` placeholder in `.env.example` yourself — never ask the user to tell you the real key.",
      ].join("\n"),
      inputSchema: {
        envFilePath: z
          .string()
          .min(1)
          .refine((p) => ALLOWED_NAMES.has(basename(p)), {
            message:
              "envFilePath must point at a file named .env, .env.local, .env.development, or .env.development.local",
          })
          .describe(
            "Path to the project's env file, e.g. '/path/to/project/.env'. Prefer an absolute path; a relative one resolves against the MCP server's working directory, which may not be the project.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ envFilePath }) => {
      const apiKey = process.env.CLOCKNEXT_API_KEY;
      if (!apiKey) {
        return errorResult("CLOCKNEXT_API_KEY is not set in the MCP server's environment — nothing to write.");
      }

      const fileAbs = isAbsolute(envFilePath) ? envFilePath : resolve(envFilePath);

      try {
        const parent = await fs.stat(dirname(fileAbs)).catch(() => null);
        if (!parent?.isDirectory()) {
          return errorResult(`Directory does not exist: ${dirname(fileAbs)}`);
        }

        // A symlink named .env would pass the name/git guards while the write
        // lands on its target — the exact leak the guards exist to prevent.
        const lst = await fs.lstat(fileAbs).catch(() => null);
        if (lst?.isSymbolicLink()) {
          return errorResult(`Refusing to write the key: ${fileAbs} is a symlink — write to a regular file.`);
        }
        if (lst && !lst.isFile()) {
          return errorResult(`Refusing to write the key: ${fileAbs} is not a regular file.`);
        }

        const refusal = gitGuard(fileAbs);
        if (refusal) return errorResult(`Refusing to write the key: ${refusal}`);

        const existing = await fs.readFile(fileAbs, "utf8").catch(() => null);
        const line = `CLOCKNEXT_API_KEY=${apiKey}`;

        let action: "created" | "replaced" | "appended";
        if (existing == null) {
          // New file: owner-only permissions, since it holds a secret.
          await fs.writeFile(fileAbs, `${line}\n`, { encoding: "utf8", mode: 0o600 });
          action = "created";
        } else if (KEY_LINE_RE.test(existing)) {
          // Replacer fn (not a string) so `$` sequences in a key can't mangle
          // the output; global flag so a stale duplicate line can't win.
          const globalRe = new RegExp(KEY_LINE_RE.source, "gm");
          await fs.writeFile(fileAbs, existing.replace(globalRe, () => line), "utf8");
          action = "replaced";
        } else {
          const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
          await fs.appendFile(fileAbs, `${sep}${line}\n`, "utf8");
          action = "appended";
        }

        return jsonResult({
          ok: true,
          path: fileAbs,
          action,
          note: "CLOCKNEXT_API_KEY written server-side; the key was not returned. Remember a CLOCKNEXT_API_KEY= placeholder in .env.example.",
        });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}

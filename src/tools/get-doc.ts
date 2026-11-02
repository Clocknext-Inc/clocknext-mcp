import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errMsg, errorResult, jsonResult } from "./util";
import { fetchJson } from "./http";
import { resolveDocsUrl } from "./docs-url";

const DOCS_URL = resolveDocsUrl();

type Doc = { path: string; title: string; kind: string; markdown: string };

const DESCRIPTION = [
  "Read the FULL contents of a single Clocknext API-reference page as Markdown. Use right after clocknext_search_docs: pass a result's `url` to read the whole page — endpoints, parameters, request/response fields, and the Node.js SDK + cURL examples the search snippet leaves out. Only API-reference pages can be read.",
  "",
  "Rules:",
  "- A search snippet is enough to CHOOSE a page, never enough to implement against — read the page when you need exact field names, types, or the request body.",
  "- Use this for Clocknext docs, not an external web-fetch/browser tool: it returns the page verbatim, whereas an external fetch may silently drop details (e.g. required fields like agentKey/idempotencyKey).",
].join("\n");

export function registerGetDoc(server: McpServer): void {
  server.registerTool(
    "clocknext_get_doc",
    {
      title: "Clocknext: read a docs page",
      description: DESCRIPTION,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "The `url` (or path) of a Clocknext docs page — typically taken from a clocknext_search_docs result, e.g. 'https://help.clocknext.com/docs/api-reference/signals/recordCreditSignal' or '/docs/api-reference/quickstart'.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path }) => {
      try {
        const url = new URL("/api/doc", DOCS_URL);
        url.searchParams.set("path", path);
        const doc = await fetchJson<Doc>(url);
        return jsonResult({
          ...doc,
          url: new URL(doc.path, DOCS_URL).toString(),
        });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}

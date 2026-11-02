import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errMsg, errorResult, jsonResult } from "./util";
import { fetchJson } from "./http";
import { resolveDocsUrl } from "./docs-url";

// Public docs base URL (help.clocknext.com); no API key needed. See ./docs-url.
const DOCS_URL = resolveDocsUrl();

type SearchHit = { kind: string; title: string; url: string; snippet: string };
type SearchResponse = {
  query: string;
  count: number;
  results: SearchHit[];
};

const DESCRIPTION = [
  "Search Clocknext's API reference and get back the most relevant pages (title, URL, and a snippet). Clocknext is a usage-based billing platform: you meter product/AI usage, price it against plans and units, and bill customers for it. The API reference covers both the REST API and the Node.js SDK (`@clocknext/sdk`) — every endpoint page shows a Node.js example and a cURL example.",
  "",
  "Rules:",
  "- Prefer this over answering from memory — the docs are the source of truth and more current than training data. Search before explaining a Clocknext concept, designing an integration, or reaching for another Clocknext tool.",
  "- Typical flow: search for the task (e.g. 'record credit usage', 'subscribe a customer to a plan'), then read the matching page with clocknext_get_doc. Use its Node.js SDK example for a JS/TS codebase and its cURL/REST example for any other language.",
].join("\n");

export function registerSearchDocs(server: McpServer): void {
  server.registerTool(
    "clocknext_search_docs",
    {
      title: "Clocknext: search docs",
      description: DESCRIPTION,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "What to look for, in natural language — e.g. 'how do I record token usage', 'create a plan with tiered pricing', 'what is a unit vs an outcome'.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of pages to return (default 8)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      try {
        const url = new URL("/api/search", DOCS_URL);
        url.searchParams.set("query", query);
        if (limit) url.searchParams.set("limit", String(limit));

        const data = await fetchJson<SearchResponse>(url);
        const results = (data.results ?? []).map((r) => ({
          ...r,
          // The endpoint returns relative paths; make them clickable absolute URLs.
          url: new URL(r.url, DOCS_URL).toString(),
        }));

        return jsonResult({
          query,
          count: results.length,
          docsUrl: DOCS_URL,
          results,
        });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}

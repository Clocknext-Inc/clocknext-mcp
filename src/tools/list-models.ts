import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClocknextApi } from "../api";
import { z } from "zod";
import { errMsg, errorResult, jsonResult } from "./util";

export function registerListModels(server: McpServer, cnk: ClocknextApi): void {
  server.registerTool(
    "clocknext_list_models",
    {
      title: "Clocknext: list models",
      description:
        "List the models the organisation has enabled, with their USD prices per 1,000,000 tokens. Use a returned `modelId` as the `model` when verifying or recording usage. Pass active=true to see only models that can be metered right now.",
      inputSchema: {
        active: z
          .boolean()
          .optional()
          .describe("Only return currently-active (meterable) models."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ active }) => {
      try {
        const models = await cnk.workspace.models(
          active === undefined ? {} : { active },
        );
        return jsonResult({ count: models.length, models });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}

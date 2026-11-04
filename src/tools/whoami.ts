import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClocknextApi } from "../api";
import { errMsg, errorResult, jsonResult } from "./util";

export function registerWhoami(server: McpServer, cnk: ClocknextApi): void {
  server.registerTool(
    "clocknext_whoami",
    {
      title: "Clocknext: identify workspace",
      description: [
        "Identify the Clocknext organisation behind the configured API key, and whether it is a 'sandbox' (a disposable staging organisation) or the 'live' organisation.",
        "",
        "Rules:",
        "- Call FIRST to confirm you are pointed at the intended workspace before recording any real usage.",
      ].join("\n"),
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonResult(await cnk.workspace.me());
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}

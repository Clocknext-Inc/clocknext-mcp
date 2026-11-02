import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClocknextError, type ClocknextApi } from "../api";
import { errMsg, errorResult, jsonResult } from "./util";

/**
 * clocknext_add_model — enable a model for the org, autopriced from the catalog.
 *
 * MCP-internal on purpose: `POST /api/v1/models` is not in the public SDK or
 * docs. It goes through the MCP's own API client (`src/api.ts`), which uses the
 * org's `cnk_` key and `CLOCKNEXT_BASE_URL` (default production).
 *
 * Only catalog models are supported. AUTO copies the catalog's prices; when the
 * catalog has no price for a model it is still enabled, but at $0 — the tool
 * then tells the caller to set the price on the Models page (it reads the price
 * back to detect this).
 */

export function registerAddModel(server: McpServer, cnk: ClocknextApi): void {
  server.registerTool(
    "clocknext_add_model",
    {
      title: "Clocknext: add (enable) a model",
      description: [
        "Enable a model for the organisation so usage can be metered against it. Afterwards its `modelId` is valid in the signals your product code sends, and it appears in clocknext_list_models. Autopriced from Clocknext's catalog — you never set prices here.",
        "",
        "Rules:",
        "- Only models in Clocknext's pricing catalog can be added. clocknext_list_models shows what is ALREADY enabled; the addable catalog itself is browsable on the Models page. If the add fails, the model or provider isn't in the catalog.",
        "- Re-adding a model that is already enabled is a safe no-op: it succeeds and returns `alreadyEnabled: true` with the live prices.",
        "- If the catalog has no price for it, the model is enabled but meters at $0; the tool returns a Models-page link and a `warning` so you can set pricing.",
      ].join("\n"),
      inputSchema: {
        provider: z
          .string()
          .min(1)
          .describe(
            "Provider slug in the Clocknext catalog, e.g. 'openai', 'anthropic', 'google'.",
          ),
        model: z
          .string()
          .min(1)
          .describe(
            "Catalog model id, e.g. 'gpt-4o' or 'claude-sonnet-4-6'. Becomes the modelId you send in usage signals.",
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ provider, model }) => {
      const modelsPage = `${cnk.origin}/settings/models`;

      try {
        let alreadyEnabled = false;
        try {
          await cnk.workspace.addModel({ provider, modelId: model, pricingMode: "AUTO" });
        } catch (err) {
          // A request that never got an answer (network / timeout) is not a
          // catalog problem — report it as it is.
          const serverAnswered = err instanceof ClocknextError && err.status !== undefined;
          if (!serverAnswered) {
            throw err;
          }
          const reason = err.message;
          // Re-adding an enabled model is the idempotent no-op this tool advertises
          // (idempotentHint: true) — the backend calls it an error, but the caller's
          // goal is already satisfied, so fall through to the price read-back rather
          // than blaming a catalog that has nothing to do with it.
          alreadyEnabled = /already enabled/i.test(reason);
          if (!alreadyEnabled) {
            // Only catalog models are supported, and the server returns the same
            // error whether the MODEL or the PROVIDER is unknown — so guide the
            // caller for both without offering a manual path that won't work.
            return errorResult(
              `Couldn't add "${provider}/${model}": ${reason}. Clocknext only meters models in its pricing catalog, so a model or provider that isn't in the catalog can't be added or priced here. Browse the addable catalog on the Models page (${modelsPage}); clocknext_list_models only shows what's already enabled.`,
            );
          }
        }

        // Enabled. AUTO copies catalog prices, but the catalog may have none —
        // in which case the model is live at $0 until it's priced in the product.
        // Read the enabled model back to detect that (best-effort).
        const added = await cnk.workspace
          .models({})
          .then((list) => list.find((m) => m.modelId.toLowerCase() === model.toLowerCase()))
          .catch(() => undefined);

        const unpriced =
          added != null &&
          added.inputPrice === 0 &&
          added.outputPrice === 0 &&
          added.cachePrice === 0;

        if (unpriced) {
          return jsonResult({
            ok: true,
            provider,
            model,
            ...(alreadyEnabled ? { alreadyEnabled: true } : {}),
            priced: false,
            warning: `"${model}" is enabled but has NO price in the catalog — usage will meter at $0. Set its input/output/cache pricing on the Models page: ${modelsPage}`,
            modelsPage,
          });
        }

        return jsonResult({
          ok: true,
          provider,
          model,
          ...(alreadyEnabled ? { alreadyEnabled: true } : {}),
          priced: added != null ? true : undefined,
          ...(added
            ? {
                prices: {
                  input: added.inputPrice,
                  output: added.outputPrice,
                  cache: added.cachePrice,
                },
              }
            : {}),
        });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}

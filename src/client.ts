import { ClocknextApi } from "./api";

/**
 * Build the Clocknext API client from the environment.
 *
 * The customer supplies their per-organisation key (Settings → API Keys) as
 * `CLOCKNEXT_API_KEY`. `CLOCKNEXT_BASE_URL` optionally overrides the API origin
 * (e.g. to point at staging). The key is a secret with org-wide write access —
 * it lives only in the MCP server's env, never in the model's context.
 */
export function makeClient(): ClocknextApi {
  const apiKey = process.env.CLOCKNEXT_API_KEY;
  if (!apiKey) {
    throw new Error(
      "CLOCKNEXT_API_KEY is not set. Add your organisation's `cnk_…` key " +
        "(Settings → API Keys) to the MCP server's environment.",
    );
  }
  const baseUrl = process.env.CLOCKNEXT_BASE_URL;
  return new ClocknextApi({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

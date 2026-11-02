/**
 * Base URL of the public Clocknext docs site (help.clocknext.com). Shared by the
 * docs tools (search_docs, get_doc). Override for staging/preview via
 * CLOCKNEXT_DOCS_URL. No API key is needed — the docs are public.
 *
 * Resolved defensively: an unset, blank, non-http, or unsubstituted
 * (`${user_config.docs_url}`, when a plugin leaves the optional value empty)
 * value all fall back to production, so a tool can never be handed a broken URL.
 */
export function resolveDocsUrl(): string {
  const raw = process.env.CLOCKNEXT_DOCS_URL?.trim();
  if (raw && /^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  return "https://help.clocknext.com";
}

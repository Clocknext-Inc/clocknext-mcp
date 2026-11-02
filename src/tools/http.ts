/**
 * Minimal JSON fetch with a timeout, for the public docs tools (search / get
 * page) — no API key. Every Clocknext API call goes through `src/api.ts`.
 */
export async function fetchJson<T = unknown>(
  url: string | URL,
  timeoutMs = 10_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`request to ${String(url)} returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`request to ${String(url)} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

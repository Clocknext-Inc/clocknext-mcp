/**
 * The MCP's own Clocknext API client — plain `fetch`, no `@clocknext/sdk`.
 *
 * Why this exists: the MCP stays self-contained rather than depending on
 * `@clocknext/sdk`. The catalogue calls here (credits / outcomes / units /
 * composites / plans) ARE public — documented in the API reference and in the
 * SDK since 2026-10-01 — and must match that contract; enabling models is the
 * one thing that stays MCP-only. All `/api/v1` calls go through this client.
 *
 * It behaves the way the SDK's own transport did, so tool results and error
 * messages stay the same:
 *
 *   - sends the org's `cnk_…` key as `Authorization: Bearer …`;
 *   - enforces a timeout (10s by default);
 *   - unwraps both response envelopes the server uses —
 *       new: { statusCode, statusDetail: { status, message }, result }
 *       old: { ok: boolean, error?, ...payload };
 *   - turns a failure into a typed error (AuthError, NotFoundError, …) whose
 *     class name `errMsg` shows to the agent;
 *   - retries transient failures (network, 408, 409, 429, 5xx) with backoff,
 *     but ONLY for replay-safe requests (GET / PUT / DELETE). A POST or PATCH
 *     is never retried automatically, so a timeout can't create something twice.
 *
 * The method names below (`cnk.credits.list`, `cnk.plans.update`, …) mirror the
 * SDK's on purpose, so the tool files read the same as before.
 */

const DEFAULT_BASE_URL = "https://payments.clocknext.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 10_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for every failure this client raises. `status` is the HTTP
 *  status when the server answered, and undefined when the request never
 *  completed (network error / timeout). */
export class ClocknextError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    // Keep `instanceof` working after transpiling.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — the API key is missing, wrong, or expired. */
export class AuthError extends ClocknextError {}
/** 400 — the request body or query failed validation. */
export class ValidationError extends ClocknextError {}
/** 403 — the key may not do this. The two lock refusals below are the
 *  common cases; a plain ForbiddenError is any other 403 (for example a
 *  sandbox that already holds its 25 customers). */
export class ForbiddenError extends ClocknextError {}
/** 403 `FEATURE_LOCKED` — the organisation's Clocknext plan does not include
 *  this feature. `feature` names it (e.g. `COMPOSITES`, `PURCHASES`). */
export class FeatureLockedError extends ForbiddenError {
  readonly feature?: string;
  constructor(message: string, opts: { feature?: string } = {}) {
    super(message, { status: 403 });
    this.feature = opts.feature;
  }
}
/** 403 `WORKSPACE_LOCKED` — the whole workspace is locked (an unpaid
 *  Clocknext bill); every API call is refused until it is paid. */
export class WorkspaceLockedError extends ForbiddenError {}
/** 404 — the resource doesn't exist (or belongs to another organisation). */
export class NotFoundError extends ClocknextError {}
/** 422 — valid request, but the account state doesn't allow it. */
export class PlanError extends ClocknextError {}
/** 422 with "insufficient" — an allowance ran out. */
export class AllowanceError extends ClocknextError {}
/** 409 — conflicts with the current state. */
export class ConflictError extends ClocknextError {}
/** 429 — rate limited. `retryAfterMs` is how long the server asked us to wait. */
export class RateLimitError extends ClocknextError {
  readonly retryAfterMs?: number;
  constructor(message: string, opts: { retryAfterMs?: number } = {}) {
    super(message, { status: 429, retryable: true });
    this.retryAfterMs = opts.retryAfterMs;
  }
}
/** 5xx — something failed on the server. */
export class ServerError extends ClocknextError {}
/** The request never got an answer: network failure or timeout. */
export class NetworkError extends ClocknextError {
  constructor(message: string) {
    super(message, { retryable: true });
  }
}

/** Pick the right error class for an HTTP status. */
function errorFromResponse(
  status: number,
  message: string,
  retryAfterMs: number | undefined,
  lock: { code?: string; feature?: string } = {},
): ClocknextError {
  const text = message || `Request failed with status ${status}.`;

  if (status === 400) {
    return new ValidationError(text, { status });
  }
  if (status === 401) {
    return new AuthError(text, { status });
  }
  if (status === 403) {
    if (lock.code === "FEATURE_LOCKED") {
      return new FeatureLockedError(text, { feature: lock.feature });
    }
    if (lock.code === "WORKSPACE_LOCKED") {
      return new WorkspaceLockedError(text, { status });
    }
    return new ForbiddenError(text, { status });
  }
  if (status === 404) {
    return new NotFoundError(text, { status });
  }
  if (status === 408) {
    return new ClocknextError(text, { status, retryable: true });
  }
  if (status === 409) {
    return new ConflictError(text, { status, retryable: true });
  }
  if (status === 422) {
    if (/insufficient/i.test(text)) {
      return new AllowanceError(text, { status });
    }
    return new PlanError(text, { status });
  }
  if (status === 429) {
    return new RateLimitError(text, { retryAfterMs });
  }
  if (status >= 500) {
    return new ServerError(text, { status, retryable: true });
  }
  return new ClocknextError(text, { status });
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

/** Read `retry-after-ms` or `Retry-After` (seconds or an HTTP date). */
function parseRetryAfter(headers: Headers): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  return undefined;
}

/** Delay before retry number `attempt` (1-based): 200ms, 400ms, 800ms, …
 *  capped at 10s, with jitter between 50% and 100% of that value. A server
 *  `Retry-After` wins over the computed delay. */
function backoffDelay(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, MAX_DELAY_MS);
  }
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, MAX_DELAY_MS);
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.round(capped * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Response shapes the tools actually read
// ---------------------------------------------------------------------------

/** One enabled model (`GET /api/v1/models`). Prices are USD per 1,000,000 tokens. */
export interface Model {
  /** This workspace's own row id for the model (newer servers only). */
  id?: string;
  modelName?: string;
  modelId: string;
  isActive: boolean;
  inputPrice: number;
  outputPrice: number;
  cachePrice: number;
  /** Per-1M-token cache-WRITE price, or null when the model has none. */
  cacheWritePrice?: number | null;
  [key: string]: unknown;
}

/** Body of `POST /api/v1/composites` (and, every field optional, of
 *  `PATCH /api/v1/composites/:id`). */
export interface CreateCompositeInput {
  name: string;
  refId: string;
  price: number;
  description?: string;
  entitlements: {
    creditIds?: string[];
    outcomeIds?: string[];
    unitIds?: string[];
  };
}

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions {
  method: HttpMethod;
  /** Path under the base URL, e.g. `/api/v1/credits`. */
  path: string;
  /** Query parameters. `undefined` and `""` values are left out. */
  query?: Record<string, string | number | undefined>;
  /** JSON body. Omit for bodyless requests. */
  body?: unknown;
  /** Overrides the default 10s timeout (e.g. a slow bulk import). */
  timeoutMs?: number;
}

/** `{ active: true }` → `"true"`, omitted → not sent. */
function activeQuery(params: { active?: boolean }): Record<string, string | undefined> {
  if (params.active === undefined) {
    return { active: undefined };
  }
  return { active: String(params.active) };
}

function idPath(base: string, id: string): string {
  return `${base}/${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class ClocknextApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  /** The origin every request goes to, without a trailing slash. */
  get origin(): string {
    return this.baseUrl;
  }

  /**
   * Send one request, retrying transient failures when the method is
   * replay-safe (GET / PUT / DELETE). Returns the unwrapped `result`.
   */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query);

    const replaySafe =
      options.method === "GET" || options.method === "PUT" || options.method === "DELETE";
    const maxAttempts = replaySafe ? MAX_ATTEMPTS : 1;

    let attempt = 0;
    while (true) {
      attempt = attempt + 1;
      try {
        return await this.sendOnce<T>(url, options);
      } catch (error) {
        const isRetryable = error instanceof ClocknextError && error.retryable;
        if (attempt >= maxAttempts || !isRetryable) {
          throw error;
        }
        let retryAfterMs: number | undefined = undefined;
        if (error instanceof RateLimitError) {
          retryAfterMs = error.retryAfterMs;
        }
        await sleep(backoffDelay(attempt, retryAfterMs));
      }
    }
  }

  /** One attempt: fetch with a timeout, then unwrap the envelope. */
  private async sendOnce<T>(url: string, options: RequestOptions): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new NetworkError(`Request to ${options.path} timed out after ${timeoutMs}ms.`);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new NetworkError(`Network error calling ${options.path}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // Not JSON — only a problem if the status is also bad (handled below).
      }
    }
    const body = (json ?? {}) as Record<string, unknown>;
    const retryAfterMs = parseRetryAfter(response.headers);

    // New envelope: { statusCode, statusDetail: { status, message, code? }, result }
    if (typeof body === "object" && body !== null && "statusDetail" in body) {
      const detail = body.statusDetail as
        | { status?: string; message?: string; code?: string }
        | undefined;
      if (response.ok && detail?.status === "SUCCESS") {
        return (body.result as T | undefined) ?? ({} as T);
      }
      const message = detail?.message ?? `Request failed with status ${response.status}.`;
      // A locked feature names itself in `result.feature` and in the
      // X-Feature-Locked header (SE-61).
      const result = body.result as { feature?: unknown } | undefined;
      const feature =
        typeof result?.feature === "string"
          ? result.feature
          : (response.headers.get("x-feature-locked") ?? undefined);
      throw errorFromResponse(response.status, message, retryAfterMs, {
        code: detail?.code,
        feature,
      });
    }

    // Old envelope: { ok, error?, ...payload }
    const oldEnvelope = body as { ok?: boolean; error?: string };
    if (response.ok && oldEnvelope.ok !== false) {
      return oldEnvelope as T;
    }
    const message = oldEnvelope.error ?? (text || `Request failed with status ${response.status}.`);
    throw errorFromResponse(response.status, message, retryAfterMs);
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") {
          params.set(key, String(value));
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url = `${url}?${queryString}`;
      }
    }
    return url;
  }

  // --- Workspace -----------------------------------------------------------

  readonly workspace = {
    /** `GET /api/v1/me` — the organisation behind the key, sandbox or live. */
    me: (): Promise<unknown> => {
      return this.request({ method: "GET", path: "/api/v1/me" });
    },

    /** `GET /api/v1/models` — the organisation's enabled models with prices. */
    models: async (params: { active?: boolean } = {}): Promise<Model[]> => {
      const result = await this.request<{ models: Model[] }>({
        method: "GET",
        path: "/api/v1/models",
        query: activeQuery(params),
      });
      return result.models;
    },

    /** `POST /api/v1/models` — enable a catalog model, autopriced. */
    addModel: (input: { provider: string; modelId: string; pricingMode: "AUTO" }): Promise<unknown> => {
      return this.request({ method: "POST", path: "/api/v1/models", body: input });
    },
  };

  // --- Catalogue: credits / outcomes / units / plans / composites ----------

  readonly credits = this.catalogue("/api/v1/credits", "credits", "credit");
  readonly outcomes = this.catalogue("/api/v1/outcomes", "outcomes", "outcome");
  readonly units = this.catalogue("/api/v1/units", "units", "unit");
  readonly plans = this.catalogue("/api/v1/plans", "plans", "plan");
  /** Composites have no DELETE on the API — retire one by archiving it. */
  readonly composites = this.catalogue("/api/v1/composites", "composites", "composite");

  /**
   * The same five calls for every catalogue resource. `listKey` / `itemKey`
   * are the fields the server nests the result under, e.g. `{ credits: [...] }`
   * for a list and `{ credit: {...} }` for one item.
   */
  private catalogue(basePath: string, listKey: string, itemKey: string) {
    return {
      /** `GET <base>` — every row, or only active ones with `{ active: true }`. */
      list: async (params: { active?: boolean } = {}): Promise<unknown[]> => {
        const result = await this.request<Record<string, unknown[]>>({
          method: "GET",
          path: basePath,
          query: activeQuery(params),
        });
        return result[listKey] ?? [];
      },

      /** `GET <base>/:id`. */
      get: async (id: string): Promise<unknown> => {
        const result = await this.request<Record<string, unknown>>({
          method: "GET",
          path: idPath(basePath, id),
        });
        return result[itemKey];
      },

      /** `POST <base>`. */
      create: async (input: unknown): Promise<unknown> => {
        const result = await this.request<Record<string, unknown>>({
          method: "POST",
          path: basePath,
          body: input,
        });
        return result[itemKey];
      },

      /** `PATCH <base>/:id` — a partial update: only the fields sent change. */
      update: async (id: string, input: unknown): Promise<unknown> => {
        const result = await this.request<Record<string, unknown>>({
          method: "PATCH",
          path: idPath(basePath, id),
          body: input,
        });
        return result[itemKey];
      },

      /** `POST <base>/:id/archive` (false) or `POST <base>/:id/unarchive`
       *  (true) — the only way to change an item's active state; nothing is
       *  ever deleted through the API. */
      setActive: async (id: string, isActive: boolean): Promise<unknown> => {
        const action = isActive ? "unarchive" : "archive";
        const result = await this.request<Record<string, unknown>>({
          method: "POST",
          path: `${idPath(basePath, id)}/${action}`,
        });
        return result[itemKey];
      },
    };
  }

  // --- Customers ------------------------------------------------------------

  readonly customers = {
    /** `POST /api/v1/customers`. */
    create: async (input: Record<string, unknown>): Promise<unknown> => {
      const result = await this.request<{ customer: unknown }>({
        method: "POST",
        path: "/api/v1/customers",
        body: input,
      });
      return result.customer;
    },

    /** `GET /api/v1/customers/:id`. */
    get: async (id: string): Promise<unknown> => {
      const result = await this.request<{ customer: unknown }>({
        method: "GET",
        path: idPath("/api/v1/customers", id),
      });
      return result.customer;
    },

    /** `GET /api/v1/customers` — one cursor page. */
    list: async (
      params: { limit?: number; q?: string; cursor?: string } = {},
    ): Promise<{ customers: unknown[]; nextCursor: string | null }> => {
      const result = await this.request<{ customers: unknown[]; nextCursor: string | null }>({
        method: "GET",
        path: "/api/v1/customers",
        query: { limit: params.limit, q: params.q, cursor: params.cursor },
      });
      return { customers: result.customers, nextCursor: result.nextCursor };
    },

    /** `GET /api/v1/customers/:id/balances`. */
    balances: (id: string): Promise<unknown> => {
      return this.request({ method: "GET", path: `${idPath("/api/v1/customers", id)}/balances` });
    },

    /** `GET /api/v1/customers/:id/plan`. */
    plan: (id: string): Promise<unknown> => {
      return this.request({ method: "GET", path: `${idPath("/api/v1/customers", id)}/plan` });
    },

    /** `POST /api/v1/customers/bulk` — up to 200 customers, one result per row. */
    bulkCreate: (customers: unknown[]): Promise<unknown> => {
      return this.request({
        method: "POST",
        path: "/api/v1/customers/bulk",
        body: { customers },
        timeoutMs: 60_000, // one batch request; allow headroom
      });
    },
  };

  // --- Purchases -------------------------------------------------------------

  readonly purchases = {
    /** `POST /api/v1/purchases` — subscribe a customer to a plan. */
    create: async (input: Record<string, unknown>): Promise<unknown> => {
      const result = await this.request<{ purchase: unknown }>({
        method: "POST",
        path: "/api/v1/purchases",
        body: input,
        // Creating a purchase raises the first invoice and can take ~10s. A
        // timeout here would report failure for a purchase that DID go
        // through, inviting a retry that bills twice — so allow headroom.
        timeoutMs: 60_000,
      });
      return result.purchase;
    },
  };
}

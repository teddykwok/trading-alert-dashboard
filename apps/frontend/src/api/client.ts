import type { ApiErrorBody } from "../types/api";
import { operatorAuthHeaders } from "./operator-token";

// An explicit VITE_API_URL overrides everything (e.g. pointing at a separate
// API host). When empty/unset we use same-origin relative requests ("/api/…"),
// so remote access through Tailscale Serve + the Vite proxy just works and the
// browser never has to reach localhost:4000 directly. No localhost fallback.
const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();
const API_BASE_URL = configuredApiUrl || "";

export class ApiRequestError extends Error {
  status: number;
  body?: ApiErrorBody;

  constructor(status: number, body?: ApiErrorBody) {
    super(body?.message ?? `Request failed with status ${status}`);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      // Only claim a JSON body when one is actually sent: Fastify rejects
      // body-less requests (DELETE) whose content-type promises JSON with
      // 400 "Body cannot be empty", which broke asset deletion.
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new ApiRequestError(response.status, body as ApiErrorBody);
  }

  return body as T;
}

/**
 * Concurrent identical GETs share a single network request.
 *
 * Two things make duplicate reads easy to issue here, and this collapses both
 * without changing component code or disabling React StrictMode:
 *  - StrictMode intentionally double-invokes effects in development, so every
 *    fetch-on-mount effect runs twice in the same tick.
 *  - Independent panels legitimately need the same resource on one page (e.g.
 *    TradeOutcomePanel and FuturesRiskPlanner both read the alert's
 *    trade-review), and they mount together.
 *
 * Only GETs are deduped — mutations must always execute. The entry is dropped
 * as soon as the request settles, so this is request coalescing, not a cache:
 * a later refetch (say, after a save) still hits the network and sees fresh
 * data.
 */
const inFlightGets = new Map<string, Promise<unknown>>();

function dedupedGet<T>(path: string): Promise<T> {
  const existing = inFlightGets.get(path) as Promise<T> | undefined;
  if (existing) return existing;

  const pending = request<T>(path, { method: "GET" }).finally(() => {
    inFlightGets.delete(path);
  });

  inFlightGets.set(path, pending);
  return pending;
}

/**
 * Operator-only requests: the ONLY place the operator token is attached.
 *
 * The path prefix is checked rather than assumed. Without it, one mistyped path
 * at a future call site would send the credential that can arm a real-money
 * account to an ordinary dashboard endpoint, a third-party origin, or an
 * attacker-supplied URL. Refusing is cheap; the mistake is not.
 *
 * Deliberately not deduped like `apiClient.get`: an auth probe must always ask.
 */
const OPERATOR_PATH_PREFIX = "/api/operator/";

function assertOperatorPath(path: string): void {
  if (!path.startsWith(OPERATOR_PATH_PREFIX)) {
    throw new Error(`operatorApiClient refuses a non-operator path: ${path}`);
  }
}

export const operatorApiClient = {
  get: <T>(path: string): Promise<T> => {
    assertOperatorPath(path);
    return request<T>(path, { method: "GET", headers: operatorAuthHeaders() });
  },
  /**
   * Operator mutations. The credential travels in the Authorization header and
   * never in the body, so a request log or a proxy trace cannot capture it.
   */
  post: <T>(path: string, data?: unknown): Promise<T> => {
    assertOperatorPath(path);
    return request<T>(path, {
      method: "POST",
      body: JSON.stringify(data ?? {}),
      headers: operatorAuthHeaders(),
    });
  },
};

export const apiClient = {
  get: <T>(path: string) => dedupedGet<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

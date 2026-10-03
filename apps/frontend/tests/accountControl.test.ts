import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, apiClient, operatorApiClient } from "../src/api/client";
import * as operatorApi from "../src/api/operator";
import {
  OPERATOR_ACCOUNTS,
  accountHealthPath,
  accountOverviewState,
  accountScopedOperatorPath,
  assertOperatorAccount,
  classifyOperatorFailure,
  isCurrentAccountResponse,
} from "../src/api/operator-account";
import { clearAllOperatorTokens, hasOperatorToken, operatorAuthHeaders, setOperatorToken } from "../src/api/operator-token";
import { canOfferMutations, controlPlaneStateFromFailure, presentControlPlane } from "../src/features/operator/accountControlState";
import { getSelectedOperatorAccount, selectOperatorAccount, subscribeSelectedOperatorAccount } from "../src/features/operator/operatorAccountSelection";
import { authenticateOperator } from "../src/features/operator/operatorSession";
import { NATIVE_SCREENSHOT_NOT_APPLICABLE, screenshotPlaceholderMessage } from "../src/components/charts/ScreenshotPreview";
import { DIRECTIONAL_FILTER_LABEL, DIRECTIONAL_FILTER_TITLE } from "../src/components/alerts/AlertFilters";
import { DIRECTIONAL_SIGNALS } from "../src/hooks/useFilters";

/**
 * ONE frontend, TWO isolated accounts.
 *
 * Every operator request names exactly one account; the token of one account is
 * never sent to the other; a late response for one account can never update the
 * other's panel; an offline control plane is never shown as a bad token; and no
 * control can target both accounts. Pure functions and source checks, as the
 * rest of this suite (no DOM environment).
 */

const TOKEN_A = "token-for-account-a-0123456789";
const TOKEN_B = "token-for-account-b-9876543210";
const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function stubFetch(status = 200, body: unknown = { ok: true }) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  clearAllOperatorTokens();
  selectOperatorAccount(null);
});
afterEach(() => {
  clearAllOperatorTokens();
  selectOperatorAccount(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account routing: explicit, single, allowlisted", () => {
  it("there are exactly two accounts and no ALL target", () => {
    expect([...OPERATOR_ACCOUNTS]).toEqual(["A", "B"]);
    for (const bad of ["ALL", "all", "C", "a", "b", "", " A", "A/../B", undefined, null, 1]) {
      expect(() => assertOperatorAccount(bad)).toThrow(/exactly Account A or Account B/);
    }
  });

  it("an Account A request routes only to A's gateway path, and B only to B's", () => {
    expect(accountScopedOperatorPath("A", "/api/operator/trading-control/status")).toBe("/api/operator/accounts/A/trading-control/status");
    expect(accountScopedOperatorPath("B", "/api/operator/trading-control/status")).toBe("/api/operator/accounts/B/trading-control/status");
    expect(() => accountScopedOperatorPath("ALL" as never, "/api/operator/auth-check")).toThrow();
    // Already-scoped or non-operator paths are refused (no double scoping, no smuggling).
    for (const path of ["/api/operator/accounts/B/auth-check", "/api/alerts", "https://evil/api/operator/x"]) {
      expect(() => accountScopedOperatorPath("A", path)).toThrow();
    }
  });

  it("every operator API function issues exactly one request, to exactly the account it was given", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );
    const fns = Object.entries(operatorApi).filter(([name, value]) => typeof value === "function" && /^(fetch|post|get|check)/.test(name));
    expect(fns.length).toBeGreaterThanOrEqual(19);
    for (const account of ["A", "B"] as const) {
      for (const [name, fn] of fns) {
        calls.length = 0;
        await (fn as (...args: unknown[]) => Promise<unknown>)(account, "x", 1, undefined, false);
        expect({ name, calls: calls.length }).toEqual({ name, calls: 1 });
        expect({ name, url: calls[0].startsWith(`/api/operator/accounts/${account}/`) }).toEqual({ name, url: true });
        const other = account === "A" ? "B" : "A";
        expect(calls[0]).not.toContain(`/accounts/${other}/`);
      }
    }
  });

  it("every mutation carries its explicit account in the request path", async () => {
    const fetchMock = stubFetch();
    await operatorApi.postStopNewTrades("B");
    await operatorApi.postSafeOff("A");
    await operatorApi.postSaveAllowlist("B", "BTCUSDT");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/operator/accounts/B/trading-control/stop-new-trades",
      "/api/operator/accounts/A/trading-control/safe-off",
      "/api/operator/accounts/B/trading-control/allowlist",
    ]);
  });
});

describe("tokens: one per account, never crossed", () => {
  it("Account A's token is never sent to B, and B's never to A", async () => {
    const fetchMock = stubFetch();
    setOperatorToken("A", TOKEN_A);
    setOperatorToken("B", TOKEN_B);
    await operatorApi.fetchTradingControlStatus("B");
    await operatorApi.fetchTradingControlStatus("A");
    const [[urlB, initB], [urlA, initA]] = fetchMock.mock.calls as [string, RequestInit][];
    expect(urlB).toContain("/accounts/B/");
    expect((initB.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN_B}`);
    expect(JSON.stringify(initB)).not.toContain(TOKEN_A);
    expect(urlA).toContain("/accounts/A/");
    expect((initA.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(JSON.stringify(initA)).not.toContain(TOKEN_B);
  });

  it("signing in to A gives B nothing; a request to B without B's token carries no Authorization", async () => {
    const fetchMock = stubFetch();
    await authenticateOperator("A", TOKEN_A, async () => ({ authenticated: true }));
    expect([hasOperatorToken("A"), hasOperatorToken("B")]).toEqual([true, false]);
    expect(operatorAuthHeaders("B")).toEqual({});
    await operatorApi.checkOperatorAuth("B");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("the token-free liveness route never carries a credential, whatever is held", async () => {
    const fetchMock = stubFetch();
    setOperatorToken("A", TOKEN_A);
    await apiClient.get(accountHealthPath("A"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/operator/accounts/A/health");
    expect(JSON.stringify(init)).not.toContain(TOKEN_A);
  });

  it("tokens stay in memory only — no storage, ever", () => {
    const fake = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 };
    vi.stubGlobal("localStorage", fake);
    vi.stubGlobal("sessionStorage", fake);
    setOperatorToken("A", TOKEN_A);
    setOperatorToken("B", TOKEN_B);
    selectOperatorAccount("B");
    expect(fake.setItem).not.toHaveBeenCalled();
    for (const rel of ["api/operator-token.ts", "features/operator/operatorAccountSelection.ts", "api/operator-account.ts"]) {
      expect(code(rel)).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    }
  });
});

describe("account switching: no state, request or response crosses over", () => {
  it("the selection starts EMPTY (no default account), accepts only A or B, and notifies", () => {
    expect(getSelectedOperatorAccount()).toBeNull();
    const seen: unknown[] = [];
    const unsubscribe = subscribeSelectedOperatorAccount((a) => seen.push(a));
    selectOperatorAccount("A");
    selectOperatorAccount("B");
    selectOperatorAccount("A");
    expect(() => selectOperatorAccount("ALL" as never)).toThrow();
    unsubscribe();
    expect(seen).toEqual(["A", "B", "A"]);
  });

  it("a stale response from the previous account can never update the current one", () => {
    expect(isCurrentAccountResponse({ account: "A", generation: 3 }, { account: "A", generation: 3 })).toBe(true);
    expect(isCurrentAccountResponse({ account: "A", generation: 3 }, { account: "B", generation: 3 })).toBe(false);
    expect(isCurrentAccountResponse({ account: "B", generation: 3 }, { account: "A", generation: 3 })).toBe(false);
    expect(isCurrentAccountResponse({ account: "A", generation: 2 }, { account: "A", generation: 3 })).toBe(false);
    expect(isCurrentAccountResponse({ account: "A", generation: 3 }, { account: null, generation: 3 })).toBe(false);
  });

  it("the hook checks account AND generation after every await, and the page remounts each account's cards", () => {
    const hook = code("hooks/useTradingControl.ts");
    expect(hook).toContain("export function useTradingControl(account: OperatorAccountId");
    // No response handler may compare the bare generation any more.
    expect(hook).not.toMatch(/generation\.current !== mine|generation\.current === mine/);
    expect((hook.match(/if \(!isCurrent\(mine\)\) return;/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(hook).not.toMatch(/hasOperatorToken\(\)/);
    const page = code("pages/TradingControlPage.tsx");
    expect(page).toContain("<TradingControlCard key={`trading-control-${account}`} account={account} />");
    expect(page).toContain("<HistoricalFillOperationsCard key={`historical-fills-${account}`} account={account} />");
    // Nothing account-scoped renders until an account is chosen.
    expect(page).toContain("account === null ?");
  });
});

describe("control-plane state is truthful, and mutations are gated", () => {
  it("offline / timeout / unreachable is never reported as a bad token", () => {
    expect(controlPlaneStateFromFailure(new ApiRequestError(503))).toBe("UNREACHABLE");
    expect(controlPlaneStateFromFailure(new ApiRequestError(504))).toBe("UNREACHABLE");
    expect(controlPlaneStateFromFailure(new ApiRequestError(502))).toBe("UNREACHABLE");
    expect(controlPlaneStateFromFailure(new TypeError("Failed to fetch"))).toBe("UNREACHABLE");
    expect(controlPlaneStateFromFailure(new ApiRequestError(401))).toBe("UNAUTHORIZED");
    expect(controlPlaneStateFromFailure(new ApiRequestError(500))).toBe("ERROR");
    expect(classifyOperatorFailure(new Error("x"))).toBe("ERROR");
    expect(presentControlPlane("UNREACHABLE").label).toMatch(/offline/i);
    expect(presentControlPlane("UNREACHABLE").label).not.toMatch(/token/i);
  });

  it("signing in to an OFFLINE account says offline for that account, never 'not accepted'", async () => {
    const outcome = await authenticateOperator("B", TOKEN_B, async () => {
      throw new ApiRequestError(503, { error: "OperatorControlUnreachable", message: "Account B control plane is not reachable (offline)." });
    });
    expect(outcome).toMatchObject({ ok: false, reason: "UNREACHABLE" });
    expect(outcome.ok ? "" : outcome.message).toMatch(/Account B control plane is offline/);
    expect(outcome.ok ? "" : outcome.message).not.toMatch(/not accepted/);
    expect(hasOperatorToken("B")).toBe(false);
  });

  it("mutation controls require: one account, authenticated for it, a reachable control plane, nothing in flight", () => {
    const ok = { account: "A" as const, authState: "AUTHENTICATED" as const, controlPlane: "REACHABLE" as const, requestInFlight: false };
    expect(canOfferMutations(ok)).toBe(true);
    expect(canOfferMutations({ ...ok, account: null })).toBe(false);
    expect(canOfferMutations({ ...ok, authState: "NOT_AUTHENTICATED" })).toBe(false);
    expect(canOfferMutations({ ...ok, authState: "AUTH_FAILED" })).toBe(false);
    for (const plane of ["LOADING", "UNREACHABLE", "UNAUTHORIZED", "ERROR"] as const) expect(canOfferMutations({ ...ok, controlPlane: plane })).toBe(false);
    expect(canOfferMutations({ ...ok, requestInFlight: true })).toBe(false);
    const card = code("components/operator/TradingControlCard.tsx");
    expect(card).toContain("disabled={!eligible || !mutationsOffered}");
    expect(card).toContain("Selected account:");
  });
});

describe("read-only accounts overview and selector", () => {
  it("maps liveness and sign-in to ONLINE / AUTH NEEDED / OFFLINE / UNKNOWN", () => {
    expect(accountOverviewState("UP", true)).toBe("ONLINE");
    expect(accountOverviewState("UP", false)).toBe("AUTH_NEEDED");
    expect(accountOverviewState("DOWN", true)).toBe("OFFLINE");
    expect(accountOverviewState("UNKNOWN", false)).toBe("UNKNOWN");
  });

  it("the overview has no controls and makes no operator request; nothing anywhere targets ALL accounts", () => {
    const overview = code("components/operator/AccountsOverview.tsx");
    const hook = code("hooks/useAccountsOverview.ts");
    expect(overview).not.toMatch(/<Button|onClick|<button/);
    expect(hook).not.toMatch(/operatorApiClient|\.post\(|setOperatorToken|Authorization/);
    expect(hook).toContain("apiClient.get(accountHealthPath(account))");
    const selector = code("components/operator/OperatorAccountSelector.tsx");
    expect(selector).toContain("OPERATOR_ACCOUNTS.map(");
    expect(selector).not.toMatch(/"ALL"|'ALL'|All accounts/i);
    for (const rel of ["api/operator.ts", "api/client.ts", "hooks/useTradingControl.ts", "components/operator/TradingControlCard.tsx", "pages/TradingControlPage.tsx"]) {
      expect({ rel, all: /accounts\/ALL|"ALL"|All accounts/.test(code(rel)) }).toEqual({ rel, all: false });
    }
    // The selector lives in the persistent app shell.
    expect(code("components/layout/Topbar.tsx")).toContain("<OperatorAccountSelector />");
  });

  it("the operator client refuses a non-operator path for either account", () => {
    for (const account of ["A", "B"] as const) {
      for (const bad of ["/api/alerts", "https://example.com/api/operator/x", "api/operator/x"]) {
        expect(() => operatorApiClient.get(account, bad)).toThrow(/non-operator path/);
      }
    }
  });
});

describe("Native UI truthfulness", () => {
  it("a NATIVE alert without a screenshot is 'not applicable', never 'pending'", () => {
    for (const status of ["RECEIVED", "ANALYZING", "ANALYZED", "FAILED", undefined] as const) {
      expect(screenshotPlaceholderMessage(status, "NATIVE")).toBe(NATIVE_SCREENSHOT_NOT_APPLICABLE);
      expect(screenshotPlaceholderMessage(status, "NATIVE")).not.toMatch(/pending/i);
    }
  });

  it("TradingView screenshot placeholders are exactly unchanged", () => {
    expect(screenshotPlaceholderMessage("RECEIVED", "TRADINGVIEW")).toBe("Screenshot pending…");
    expect(screenshotPlaceholderMessage("ANALYZING", undefined)).toBe("Screenshot pending…");
    expect(screenshotPlaceholderMessage("ANALYZED", "TRADINGVIEW")).toBe("Screenshot expired");
    expect(screenshotPlaceholderMessage("FAILED", "TRADINGVIEW")).toBe("No screenshot");
    for (const rel of ["components/alerts/AlertCard.tsx", "pages/AlertDetailPage.tsx"]) expect(code(rel)).toContain("source={alert.source}");
  });

  it("the LONG+SHORT filter is labelled for what it does: a signal-direction filter, not execution eligibility", () => {
    expect([...DIRECTIONAL_SIGNALS]).toEqual(["LONG", "SHORT"]);
    expect(DIRECTIONAL_FILTER_LABEL).toBe("Long + Short only");
    expect(DIRECTIONAL_FILTER_TITLE).toMatch(/not an execution-eligibility filter/);
    expect(DIRECTIONAL_FILTER_TITLE).toMatch(/every source/);
    for (const rel of ["components/alerts/AlertFilters.tsx", "hooks/useFilters.ts", "pages/DashboardPage.tsx", "types/api.ts"]) {
      expect({ rel, misleading: /Actionable only/.test(src(rel)) }).toEqual({ rel, misleading: false });
    }
  });

  it("the Native profile UI stays account-independent", () => {
    for (const rel of ["utils/alertSource.ts", "pages/AlertDetailPage.tsx", "components/alerts/NativeBadge.tsx"]) {
      expect({ rel, coupled: /operator-account|operator-token|OperatorAccount|useSelectedOperatorAccount/.test(code(rel)) }).toEqual({ rel, coupled: false });
    }
  });
});

describe("one frontend on 127.0.0.1:5173", () => {
  const vite = readFileSync(path.join(process.cwd(), "vite.config.ts"), "utf8");
  it("binds 127.0.0.1:5173 with strictPort, and never a second port", () => {
    expect(vite).toContain('host: "127.0.0.1"');
    expect(vite).toContain("port: 5173,");
    expect(vite).toContain("strictPort: true");
    expect(vite).not.toMatch(/port:\s*5174/);
  });
  it("/api, /socket.io and /screenshots reach the generic backend; no per-account proxy, port or URL exists in browser config", () => {
    expect(vite).toContain('"/api": { target: "http://127.0.0.1:4000", changeOrigin: true }');
    expect(vite).toContain('"/socket.io": { target: "http://127.0.0.1:4000", changeOrigin: true, ws: true }');
    expect(vite).toContain('"/screenshots": { target: "http://127.0.0.1:4000", changeOrigin: true }');
    expect(vite).not.toMatch(/"\/api\/operator"\s*:/);
    expect(vite).not.toMatch(/4001|4002|VITE_ACCOUNT_CONTROL_URL|accountControlUrl/);
    for (const rel of ["api/client.ts", "api/operator.ts", "api/operator-account.ts", "hooks/useTradingControl.ts", "hooks/useAccountsOverview.ts"]) {
      expect({ rel, direct: /127\.0\.0\.1:400[12]|localhost:400[12]/.test(code(rel)) }).toEqual({ rel, direct: false });
    }
  });
});

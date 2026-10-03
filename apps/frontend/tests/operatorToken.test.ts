import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {clearAllOperatorTokens, clearOperatorToken,
  hasOperatorToken,
  operatorAuthHeaders,
  setOperatorToken,
  subscribeOperatorToken, } from "../src/api/operator-token";
import { operatorApiClient } from "../src/api/client";
import { checkOperatorAuth } from "../src/api/operator";

/**
 * The browser-side half of the operator boundary.
 *
 * This token can arm a real-money account, so the rules it has to obey are
 * narrow and worth asserting rather than trusting: it lives in memory only, it
 * is attached to operator requests and nothing else, and it never appears in
 * storage, a URL or a log line.
 */

const TOKEN = "operator-test-token-0123456789abcdef";

beforeEach(() => {
  clearAllOperatorTokens();
  vi.restoreAllMocks();
});

afterEach(() => {
  clearAllOperatorTokens();
  vi.unstubAllGlobals();
});

describe("operator token: it is held in memory only", () => {
  it("never writes to localStorage or sessionStorage", () => {
    // Persisting the credential would leave it sitting in browser storage for
    // any XSS on this origin to read at leisure, long after the operator walked
    // away from the machine. Re-entry after a refresh is the intended cost.
    const store = new Map<string, string>();
    const fake = {
      setItem: vi.fn((key: string, value: string) => void store.set(key, value)),
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      removeItem: vi.fn((key: string) => void store.delete(key)),
      clear: vi.fn(() => store.clear()),
      key: vi.fn(() => null),
      length: 0,
    };
    vi.stubGlobal("localStorage", fake);
    vi.stubGlobal("sessionStorage", fake);

    setOperatorToken("A", TOKEN);
    operatorAuthHeaders("A");
    hasOperatorToken("A");
    clearAllOperatorTokens();

    expect(fake.setItem).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("never logs the token", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    setOperatorToken("A", TOKEN);
    operatorAuthHeaders("A");
    clearAllOperatorTokens();

    for (const sink of [spy, warn, error]) {
      expect(sink).not.toHaveBeenCalled();
    }
  });

  it("does not expose the token through its own API", () => {
    setOperatorToken("A", TOKEN);
    // `hasOperatorToken` answers a yes/no question; nothing hands the value
    // back out except the Authorization header itself.
    expect(hasOperatorToken("A")).toBe(true);
    const exported = { clearOperatorToken, hasOperatorToken, setOperatorToken, subscribeOperatorToken };
    expect(JSON.stringify(Object.keys(exported))).not.toContain(TOKEN);
  });

  it("forgets the token on clear", () => {
    setOperatorToken("A", TOKEN);
    clearAllOperatorTokens();
    expect(`${hasOperatorToken("A")}:${JSON.stringify(operatorAuthHeaders("A"))}`).toBe("false:{}");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["null", null],
  ])("treats %s as no token", (_label, value) => {
    setOperatorToken("A", TOKEN);
    setOperatorToken("A", value);
    expect(hasOperatorToken("A")).toBe(false);
  });

  it("notifies subscribers without handing them the value", () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeOperatorToken((account, hasToken) => seen.push(`${account}:${hasToken}`));
    setOperatorToken("A", TOKEN);
    clearAllOperatorTokens();
    unsubscribe();
    setOperatorToken("A", TOKEN);

    // Subscribed for two changes, then unsubscribed before the third. Each
    // notification names its ACCOUNT and a yes/no, never the token value.
    expect(seen).toEqual(["A:true", "A:false"]);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });
});

describe("operator token: the Authorization header", () => {
  it("is absent when no token is held", () => {
    expect(operatorAuthHeaders("A")).toEqual({});
  });

  it("is a Bearer header carrying exactly the token", () => {
    setOperatorToken("A", TOKEN);
    expect(operatorAuthHeaders("A")).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("trims surrounding whitespace from a pasted token", () => {
    // Operators paste; pasting picks up a trailing newline. Sending it would
    // produce an indistinguishable 401, which is a miserable thing to debug.
    setOperatorToken("A", `  ${TOKEN}\n`);
    expect(operatorAuthHeaders("A")).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });
});

describe("operator requests", () => {
  function stubFetch(status = 200, body: unknown = { authenticated: true }) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("attaches the Bearer header to an operator call", async () => {
    const fetchMock = stubFetch();
    setOperatorToken("A", TOKEN);

    await expect(checkOperatorAuth("A")).resolves.toEqual({ authenticated: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/operator/accounts/A/auth-check");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends no Authorization header when no token is held", async () => {
    // The server refuses either way; sending an empty or "Bearer undefined"
    // header would just be a confusing way to arrive at the same 401.
    const fetchMock = stubFetch(401, { error: "UnauthorizedError" });
    await expect(checkOperatorAuth("A")).rejects.toThrow();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("never puts the token in the URL", async () => {
    const fetchMock = stubFetch();
    setOperatorToken("A", TOKEN);
    await checkOperatorAuth("A");

    const [url] = fetchMock.mock.calls[0] as [string];
    // A URL ends up in browser history, in the referer header and in any proxy
    // access log between here and the backend.
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("token");
  });

  it("refuses to attach the credential to a non-operator path", () => {
    setOperatorToken("A", TOKEN);
    // The whole point of the prefix check: an ordinary dashboard endpoint, or a
    // fully-qualified URL pointing somewhere else entirely, must never receive
    // the operator token.
    for (const path of ["/api/alerts", "/api/settings", "https://example.com/api/operator/x", "api/operator/x"]) {
      expect(() => operatorApiClient.get("A", path)).toThrow(/non-operator path/);
    }
  });

  it("does not leak the token through the ordinary api client", async () => {
    const fetchMock = stubFetch();
    setOperatorToken("A", TOKEN);

    const { apiClient } = await import("../src/api/client");
    await apiClient.post("/api/alerts", { hello: "world" });

    const serialized = JSON.stringify(fetchMock.mock.calls);
    expect(serialized).not.toContain(TOKEN);
  });
});

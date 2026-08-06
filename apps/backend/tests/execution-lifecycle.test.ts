import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BINANCE_CLIENT_ORDER_ID_MAX_LENGTH,
  BINANCE_CLIENT_ORDER_ID_PATTERN,
  FORBIDDEN_METADATA_KEYS,
  assertDecimalString,
  buildClientOrderId,
  containsForbiddenKey,
  sanitizeMetadata,
} from "../src/modules/execution/execution-safety";
import {
  TERMINAL_STATUSES,
  TRADE_EXECUTION_STATUSES,
  allowedTransitionsFrom,
  canTransition,
  isTerminalStatus,
  mayHaveExposure,
  type TradeExecutionStatusName,
} from "../src/modules/execution/execution-status";

/** Pure Phase 4 tests — no database, no network, entirely synthetic. */

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe("execution state machine", () => {
  const ALLOWED: Array<[TradeExecutionStatusName, TradeExecutionStatusName[]]> = [
    ["PLAN_READY", ["PREFLIGHT", "SKIPPED", "CANCELED", "FAILED"]],
    ["PREFLIGHT", ["ENTRY_SUBMITTING", "SKIPPED", "CANCELED", "FAILED"]],
    ["ENTRY_SUBMITTING", ["ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED", "FAILED", "MANUAL_INTERVENTION"]],
    ["ENTRY_PENDING", ["PARTIALLY_FILLED", "ENTRY_FILLED", "ENTRY_EXPIRED", "CANCELED", "FAILED", "MANUAL_INTERVENTION"]],
    ["PARTIALLY_FILLED", ["ENTRY_FILLED", "PLACING_PROTECTION", "ENTRY_EXPIRED", "MANUAL_INTERVENTION"]],
    ["ENTRY_FILLED", ["PLACING_PROTECTION", "MANUAL_INTERVENTION"]],
    ["PLACING_PROTECTION", ["PROTECTED", "MANUAL_INTERVENTION"]],
    ["PROTECTED", ["CLOSED_TP", "CLOSED_SL", "MANUAL_INTERVENTION"]],
  ];

  it("permits exactly the documented transitions", () => {
    for (const [from, targets] of ALLOWED) {
      expect([...allowedTransitionsFrom(from)].sort()).toEqual([...targets].sort());
      for (const to of targets) {
        expect(canTransition(from, to).allowed, `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it("forbids every transition that is not documented", () => {
    for (const [from, targets] of ALLOWED) {
      const forbidden = TRADE_EXECUTION_STATUSES.filter((s) => !targets.includes(s) && s !== from);
      for (const to of forbidden) {
        const check = canTransition(from, to);
        expect(check.allowed, `${from} -> ${to} should be forbidden`).toBe(false);
        expect(check.reason).toBeTruthy();
      }
    }
  });

  it("never allows leaving a terminal state", () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(isTerminalStatus(terminal)).toBe(true);
      expect(allowedTransitionsFrom(terminal)).toHaveLength(0);
      for (const to of TRADE_EXECUTION_STATUSES) {
        const check = canTransition(terminal, to);
        expect(check.allowed, `${terminal} -> ${to}`).toBe(false);
        expect(check.reason).toMatch(/terminal/);
      }
    }
  });

  it("guards the FAILED vs MANUAL_INTERVENTION semantics once exposure is possible", () => {
    for (const from of ["PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED"] as const) {
      expect(mayHaveExposure(from)).toBe(true);

      const failed = canTransition(from, "FAILED");
      expect(failed.allowed).toBe(false);
      expect(failed.reason).toMatch(/MANUAL_INTERVENTION/);

      // The safe alternative is always available.
      expect(canTransition(from, "MANUAL_INTERVENTION").allowed).toBe(true);
    }
  });

  it("forbids CANCELED after exposure but allows it before", () => {
    for (const from of ["PLAN_READY", "PREFLIGHT", "ENTRY_PENDING"] as const) {
      expect(canTransition(from, "CANCELED").allowed).toBe(true);
    }
    for (const from of ["ENTRY_SUBMITTING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PROTECTED"] as const) {
      const check = canTransition(from, "CANCELED");
      expect(check.allowed).toBe(false);
      expect(check.reason).toMatch(/CANCELED|not an allowed/);
    }
  });

  it("allows MANUAL_INTERVENTION to stay put for further events, but no other self-transition", () => {
    expect(canTransition("MANUAL_INTERVENTION", "MANUAL_INTERVENTION").allowed).toBe(true);
    for (const status of ["PLAN_READY", "PREFLIGHT", "ENTRY_PENDING", "PROTECTED"] as const) {
      expect(canTransition(status, status).allowed).toBe(false);
    }
  });

  it("rejects unknown statuses", () => {
    expect(canTransition("NOPE" as TradeExecutionStatusName, "PREFLIGHT").allowed).toBe(false);
    expect(canTransition("PLAN_READY", "NOPE" as TradeExecutionStatusName).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Client order IDs
// ---------------------------------------------------------------------------

describe("deterministic client order id", () => {
  it("is stable across retries for the same execution/role/generation", () => {
    const first = buildClientOrderId("exec_abc123", "ENTRY", 1);
    const second = buildClientOrderId("exec_abc123", "ENTRY", 1);
    expect(first).toBe(second);
    expect(first).toBe("tad-en-1-" + first.split("-")[3]);
  });

  it("differs per role and per generation", () => {
    const ids = new Set([
      buildClientOrderId("exec_abc123", "ENTRY", 1),
      buildClientOrderId("exec_abc123", "STOP_LOSS", 1),
      buildClientOrderId("exec_abc123", "TAKE_PROFIT", 1),
      buildClientOrderId("exec_abc123", "EMERGENCY_CLOSE", 1),
      buildClientOrderId("exec_abc123", "ENTRY", 2),
      buildClientOrderId("exec_other", "ENTRY", 1),
    ]);
    expect(ids.size).toBe(6);
  });

  it("satisfies the official Binance format and length", () => {
    for (const role of ["ENTRY", "STOP_LOSS", "TAKE_PROFIT", "EMERGENCY_CLOSE"]) {
      for (const generation of [1, 2, 99]) {
        const id = buildClientOrderId("execution-id-that-is-quite-long-abcdefghijklmnop", role, generation);
        expect(id).toMatch(BINANCE_CLIENT_ORDER_ID_PATTERN);
        expect(id.length).toBeLessThanOrEqual(BINANCE_CLIENT_ORDER_ID_MAX_LENGTH);
      }
    }
  });

  it("leaks no account alias, symbol or raw execution id", () => {
    const id = buildClientOrderId("exec_kenneth_binance_main_BTCUSDT", "ENTRY", 1);
    expect(id).not.toContain("kenneth");
    expect(id).not.toContain("BTCUSDT");
    expect(id).not.toContain("exec_");
  });

  it("rejects unknown roles and invalid generations", () => {
    expect(() => buildClientOrderId("e", "SOMETHING", 1)).toThrow(/Unknown order role/);
    for (const generation of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildClientOrderId("e", "ENTRY", generation)).toThrow(/positive integer/);
    }
  });
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

describe("metadata sanitization", () => {
  it("redacts every forbidden key, at any depth", () => {
    const dirty = {
      safe: "keep me",
      apiKey: "AAAA",
      apiSecret: "BBBB",
      signature: "cccc",
      Authorization: "Bearer x",
      signedQuery: "a=1&signature=deadbeef",
      nested: { secret: "sss", deeper: [{ token: "ttt" }] },
    };
    const clean = sanitizeMetadata(dirty) as Record<string, unknown>;

    expect(clean.safe).toBe("keep me");
    for (const value of JSON.stringify(clean).match(/AAAA|BBBB|cccc|Bearer x|sss|ttt/g) ?? []) {
      throw new Error(`secret leaked: ${value}`);
    }
    expect(JSON.stringify(clean)).toContain("***REDACTED***");
  });

  it("strips signature and API-key fragments from free text", () => {
    const clean = sanitizeMetadata("failed: signature=abc123DEF and X-MBX-APIKEY: mykey") as string;
    expect(clean).not.toContain("abc123DEF");
    expect(clean).not.toContain("mykey");
  });

  it("detects forbidden keys for callers that prefer to reject", () => {
    expect(containsForbiddenKey({ a: { b: { apiSecret: 1 } } })).toBe(true);
    expect(containsForbiddenKey({ a: { b: { quantity: 1 } } })).toBe(false);
    expect(FORBIDDEN_METADATA_KEYS.length).toBeGreaterThan(5);
  });

  it("preserves ordinary values and exact decimal strings", () => {
    const clean = sanitizeMetadata({ price: "0.038419999999999996", qty: "294" }) as Record<string, string>;
    expect(clean.price).toBe("0.038419999999999996");
    expect(clean.qty).toBe("294");
  });
});

// ---------------------------------------------------------------------------
// Decimal validation
// ---------------------------------------------------------------------------

describe("decimal validation", () => {
  it("accepts plain decimal strings and preserves them exactly", () => {
    for (const value of ["0", "0.10", "294", "0.038419999999999996"]) {
      expect(assertDecimalString(value, "x")).toBe(value);
    }
  });

  it("rejects NaN, Infinity, exponent form, numbers and empty values", () => {
    for (const bad of ["NaN", "Infinity", "-Infinity", "1e-7", "abc", "", "  ", 5, null, undefined, {}]) {
      expect(() => assertDecimalString(bad, "x"), String(bad)).toThrow();
    }
  });

  it("rejects negatives unless explicitly allowed", () => {
    expect(() => assertDecimalString("-1", "x")).toThrow(/must not be negative/);
    expect(assertDecimalString("-1.25", "pnl", { allowNegative: true })).toBe("-1.25");
  });

  it("rejects zero where a positive value is required", () => {
    expect(() => assertDecimalString("0", "qty", { allowZero: false })).toThrow(/greater than zero/);
    expect(() => assertDecimalString("0.000", "qty", { allowZero: false })).toThrow(/greater than zero/);
  });
});

// ---------------------------------------------------------------------------
// Phase-boundary / credential guards
// ---------------------------------------------------------------------------

describe("phase 4 safety boundary", () => {
  const backendRoot = process.cwd();
  const schema = readFileSync(path.join(backendRoot, "prisma", "schema.prisma"), "utf8");
  const executionDir = path.join(backendRoot, "src", "modules", "execution");
  const sources = ["execution.service.ts", "execution-status.ts", "execution-safety.ts"].map((file) => ({
    file,
    code: readFileSync(path.join(executionDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, ""),
  }));

  it("stores no credential field anywhere in the schema", () => {
    const phase4 = schema.slice(schema.indexOf("model ExecutionProfile"));
    for (const forbidden of ["apiKey", "apiSecret", "secret", "signature", "authorization", "token", "password"]) {
      expect(phase4.toLowerCase()).not.toContain(forbidden.toLowerCase() + " ");
    }
    // The profile keeps only an opaque alias.
    expect(phase4).toContain("accountIdentifier");
  });

  it("submits nothing: no fetch, HTTP client or Binance mutation endpoint", () => {
    for (const { file, code } of sources) {
      for (const forbidden of [
        "fetch(", "axios", "http.request", "/fapi/", "binance.client", "BinanceReadOnlyClient",
        "POST", "PUT", "PATCH", "DELETE",
      ]) {
        expect(code, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("exposes no order-submission or account-mutation method", () => {
    for (const { file, code } of sources) {
      for (const forbidden of [
        "submitOrder", "placeOrder", "cancelOrder", "newOrder",
        "changeLeverage", "setLeverage", "changeMarginType", "changePositionMode",
      ]) {
        expect(code, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("is not wired into the alert pipeline, queue or Telegram", () => {
    for (const { file, code } of sources) {
      for (const forbidden of [
        "webhook", "vision-analysis", "jobs/queue", "enqueue", "visionAnalysisQueue",
        "sendTelegram", "notification.service", "alerts.service",
      ]) {
        expect(code, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("uses non-destructive deletion policies for financial rows", () => {
    const phase4 = schema.slice(schema.indexOf("model TradeExecution"));
    // Alert/plan links degrade to null so retention cannot destroy history.
    expect(phase4).toContain("onDelete: SetNull");
    // Profile, orders and events are restricted.
    expect(phase4).toContain("onDelete: Restrict");
    expect(phase4).not.toContain("onDelete: Cascade");
  });

  it("seeds no real account, symbol or balance anywhere in Phase 4 sources", () => {
    const all = sources.map((s) => s.code).join("\n") + schema.slice(schema.indexOf("model ExecutionProfile"));
    for (const forbidden of ["kenneth", "EDENUSDT", "EULUSDT", "LUMIAUSDT", "ZROUSDT", "HYPEUSDT"]) {
      expect(all).not.toContain(forbidden);
    }
  });
});

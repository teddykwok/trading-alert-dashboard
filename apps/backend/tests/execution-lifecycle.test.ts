import { readFileSync } from "node:fs";
import path from "node:path";
import { TradeExecutionStatus } from "@prisma/client";
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
import {
  CAPACITY_FREE_STATUSES,
  TOTAL_ACTIVE_STATUSES,
  consumesNoCapacity,
  consumesOpenPosition,
  consumesPendingEntry,
  consumesTotalActive,
} from "../src/modules/execution/capacity-status";

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
    // Phase 7 protects the FILLED quantity while the entry may still be open,
    // so a protection exit can close directly from an exposure state.
    //
    // CLOSED_EXTERNAL belongs to all three exposure states because the
    // orchestrator routes each of them into ensureProtectionForExposure, which
    // hands a flat position to reconcileProtectionAndClosure — so each can
    // genuinely reach the proof path and observe an unattributable closure.
    [
      "PARTIALLY_FILLED",
      [
        "ENTRY_FILLED",
        "PLACING_PROTECTION",
        "ENTRY_EXPIRED",
        "CLOSED_TP",
        "CLOSED_SL",
        "CLOSED_EMERGENCY",
        "CLOSED_EXTERNAL",
        "MANUAL_INTERVENTION",
      ],
    ],
    [
      "ENTRY_FILLED",
      ["PLACING_PROTECTION", "CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "CLOSED_EXTERNAL", "MANUAL_INTERVENTION"],
    ],
    ["PLACING_PROTECTION", ["PROTECTED", "CLOSED_EMERGENCY", "CLOSED_EXTERNAL", "MANUAL_INTERVENTION"]],
    ["PROTECTED", ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "CLOSED_EXTERNAL", "MANUAL_INTERVENTION"]],
    // The two documented ways out of a parked execution, both requiring
    // exchange proof: a verified emergency close, or a position proven flat
    // whose closure cannot be attributed to one of our owned orders.
    // A parked execution still has LIVE protection on the exchange, so it can
    // close on its own. The orchestrator routes MANUAL_INTERVENTION into
    // closure reconciliation, which attributes a fill to an owned STOP or TP —
    // recording that as CLOSED_EXTERNAL would discard attribution we have.
    ["MANUAL_INTERVENTION", ["CLOSED_EMERGENCY", "CLOSED_EXTERNAL", "CLOSED_TP", "CLOSED_SL"]],
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

    // Scoped to STORED COLUMNS. A model may legitimately be NAMED for a
    // concept (Phase 11B.0's ExecutionCanaryAuthorization), and a relation
    // field back to it stores nothing; what must never exist is a column that
    // could hold a credential.
    const modelNames = new Set([...schema.matchAll(/^model (\w+)/gm)].map((match) => match[1]));
    const fieldNames = [...phase4.matchAll(/^ {2}(\w+)\s+(\w+)/gm)]
      .filter((match) => !modelNames.has(match[2]))
      .map((match) => match[1]);

    // The single deliberate exception, and why it is not a credential: it is a
    // SHA-256 digest of a one-shot, minutes-long canary authorization. The raw
    // value is shown to the operator once and never written anywhere.
    const allowed = new Set(["tokenHash"]);

    for (const forbidden of ["apiKey", "apiSecret", "secret", "signature", "authorization", "token", "password"]) {
      const offenders = fieldNames.filter(
        (name) => !allowed.has(name) && name.toLowerCase().includes(forbidden.toLowerCase())
      );
      expect(`${forbidden}:${offenders.join(",")}`).toBe(`${forbidden}:`);
    }
    // And no raw-value column beside the digest.
    expect(fieldNames).not.toContain("token");
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
    const financial = schema
      .slice(schema.indexOf("model TradeExecution"))
      // The Phase 9 materialization ledger is derived bookkeeping, not
      // financial history: it points AT lifecycle rows and must never be able
      // to restrict their deletion, so it alone uses Cascade. Everything that
      // records money or a decision is checked below.
      .replace(/model ExecutionNotificationCheckpoint \{[\s\S]*?\n\}/, "");

    // Alert/plan links degrade to null so retention cannot destroy history.
    expect(financial).toContain("onDelete: SetNull");
    // Profile, orders and events are restricted.
    expect(financial).toContain("onDelete: Restrict");
    expect(financial).not.toContain("onDelete: Cascade");
  });

  it("seeds no real account, symbol or balance anywhere in Phase 4 sources", () => {
    const all = sources.map((s) => s.code).join("\n") + schema.slice(schema.indexOf("model ExecutionProfile"));
    for (const forbidden of ["kenneth", "EDENUSDT", "EULUSDT", "LUMIAUSDT", "ZROUSDT", "HYPEUSDT"]) {
      expect(all).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Enum completeness — driven by the GENERATED Prisma enum, not a hardcoded list
// ---------------------------------------------------------------------------

describe("status classification completeness", () => {
  // Reading the generated enum means a newly added status cannot stay
  // unclassified just because a test's literal list was never updated.
  const generated = Object.values(TradeExecutionStatus) as TradeExecutionStatusName[];

  it("classifies every generated status in the pure status list", () => {
    expect([...TRADE_EXECUTION_STATUSES].sort()).toEqual([...generated].sort());
  });

  it("gives every generated status defined transition semantics", () => {
    for (const status of generated) {
      // A terminal status has no out-edges; everything else must have some.
      const targets = allowedTransitionsFrom(status);
      if (isTerminalStatus(status)) expect(targets, status).toHaveLength(0);
      else expect(targets.length, status).toBeGreaterThan(0);
    }
  });

  it("classifies every generated status exactly once as active or capacity-free", () => {
    for (const status of generated) {
      const active = consumesTotalActive(status);
      const free = consumesNoCapacity(status);
      expect(active, status).toBe(!free);
    }
    expect(TOTAL_ACTIVE_STATUSES.length + CAPACITY_FREE_STATUSES.length).toBe(generated.length);
  });

  it("gives every generated status consistent pending/open semantics", () => {
    for (const status of generated) {
      const pending = consumesPendingEntry(status);
      const open = consumesOpenPosition(status);
      // Anything that consumes a pending or open slot must be counted active.
      if (pending || open) expect(consumesTotalActive(status), status).toBe(true);
      else expect(consumesTotalActive(status), status).toBe(false);
    }
  });

  it("treats CLOSED_EMERGENCY as terminal and capacity-free", () => {
    expect(generated).toContain("CLOSED_EMERGENCY");
    expect(isTerminalStatus("CLOSED_EMERGENCY")).toBe(true);
    expect(allowedTransitionsFrom("CLOSED_EMERGENCY")).toHaveLength(0);
    expect(consumesPendingEntry("CLOSED_EMERGENCY")).toBe(false);
    expect(consumesOpenPosition("CLOSED_EMERGENCY")).toBe(false);
    expect(consumesTotalActive("CLOSED_EMERGENCY")).toBe(false);
    expect(consumesNoCapacity("CLOSED_EMERGENCY")).toBe(true);
  });

  it("permits no transition out of any closed status", () => {
    for (const closed of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY"] as const) {
      expect(isTerminalStatus(closed)).toBe(true);
      for (const target of generated) {
        expect(canTransition(closed, target).allowed, `${closed} -> ${target}`).toBe(false);
      }
    }
  });

  it("reaches every closed status only from a state that can hold exposure", () => {
    for (const closed of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY"] as const) {
      const sources = generated.filter((from) => canTransition(from, closed).allowed);
      expect(sources.length, closed).toBeGreaterThan(0);
      for (const from of sources) {
        expect(
          mayHaveExposure(from) || from === "MANUAL_INTERVENTION",
          `${from} -> ${closed} must come from a state that can hold exposure`
        ).toBe(true);
      }
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { classifyBinanceFailure } from "../src/modules/binance/binance.errors";
import { classifyMutationOutcome } from "../src/modules/execution/entry-lifecycle";
import {
  gathered,
  judgeEntryAbsence,
  unavailable,
  type EntryAbsenceEvidence,
} from "../src/modules/execution/entry-absence-evidence";
import { EntryRecoveryService } from "../src/modules/execution/entry-recovery.service";
import type { BinanceReadOnlyService } from "../src/modules/binance/binance-read-only.service";

/**
 * The stuck ENTRY_SUBMITTING defect.
 *
 * A real MAINNET execution (SOLUSDC SHORT) reserved a local ENTRY intent, sent
 * it, and got an answer the connector could not classify. `-2019` was not in the
 * deterministic table, so it fell through to MALFORMED_RESPONSE, became
 * RESULT_UNKNOWN, and the reconciler re-sent the same order 75 times over 36
 * minutes. The execution never left ENTRY_SUBMITTING, kept 1.5 USD of risk and
 * 8 USD of margin reserved, and — because ENTRY_SUBMITTING is a RECOVERY_REQUIRED
 * status — refused every later signal. Twenty-four executions queued behind it.
 *
 * Two properties are protected here, and they pull in opposite directions:
 *
 *   1. a DEFINITIVE answer must terminalize, or one bad order halts trading;
 *   2. an AMBIGUOUS answer must NOT, or a live order gets abandoned.
 *
 * Everything below is pure or uses doubles: no database, no exchange, no runtime.
 */

// ---------------------------------------------------------------------------
// A. Classification
// ---------------------------------------------------------------------------

describe("entry recovery: Binance failure classification", () => {
  it("A1. treats documented BUSINESS rejections as deterministic", () => {
    // Each is Binance evaluating a well-formed request and refusing it. The
    // matching engine created nothing, so the entry can terminalize.
    for (const [code, label] of [
      [-2018, "BALANCE_NOT_SUFFICIENT"],
      [-2019, "MARGIN_NOT_SUFFICIENT"],
      [-4131, "PERCENT_PRICE reject"],
      [-4164, "MIN_NOTIONAL"],
    ] as const) {
      expect(`${label}:${classifyBinanceFailure(400, code, "rejected")}`).toBe(`${label}:ORDER_REJECTED`);
      expect(`${label}:${classifyMutationOutcome({ kind: "ORDER_REJECTED", binanceCode: code, httpStatus: 400 }, "SUBMIT_ORDER")}`).toBe(
        `${label}:CONFIRMED_REJECTED`
      );
    }
  });

  it("A2. keeps the existing REQUEST_INVALID set deterministic", () => {
    for (const code of [-1100, -1102, -1111, -1116, -1117, -1130, -4015]) {
      expect(`${code}:${classifyBinanceFailure(400, code, "bad parameter")}`).toBe(`${code}:REQUEST_INVALID`);
    }
    expect(classifyMutationOutcome({ kind: "REQUEST_INVALID", binanceCode: -1102, httpStatus: 400 }, "SUBMIT_ORDER")).toBe(
      "CONFIRMED_REJECTED"
    );
  });

  it("A3. an UNLISTED 4xx code stays AMBIGUOUS", () => {
    // The load-bearing conservatism: guessing that an unknown code created
    // nothing is exactly how a real resting order would be abandoned.
    for (const code of [-4999, -3000, -1234]) {
      expect(`${code}:${classifyBinanceFailure(400, code, "something new")}`).toBe(`${code}:MALFORMED_RESPONSE`);
      expect(`${code}:${classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", binanceCode: code, httpStatus: 400 }, "SUBMIT_ORDER")}`).toBe(
        `${code}:RESULT_UNKNOWN`
      );
    }
  });

  it("A4. timeouts, network faults, 5xx and malformed bodies stay AMBIGUOUS", () => {
    for (const kind of ["TIMEOUT", "NETWORK", "SERVER", "MALFORMED_RESPONSE"] as const) {
      expect(`${kind}:${classifyMutationOutcome({ kind, binanceCode: null, httpStatus: null }, "SUBMIT_ORDER")}`).toBe(
        `${kind}:RESULT_UNKNOWN`
      );
    }
    expect(classifyBinanceFailure(500, null, "gateway")).toBe("SERVER");
    expect(classifyBinanceFailure(503, null, "unavailable")).toBe("SERVER");
    expect(classifyBinanceFailure(400, null, "no code at all")).toBe("MALFORMED_RESPONSE");
  });

  it("A5. does not reclassify auth, rate-limit or order-lookup codes", () => {
    // -2015 covers three situations; the MESSAGE disambiguates, and that
    // existing behaviour must not shift.
    expect(classifyBinanceFailure(400, -2015, "Invalid API-key, IP, or permissions")).toBe("IP_RESTRICTED");
    expect(classifyBinanceFailure(400, -2015, "Invalid API-key.")).toBe("AUTH");
    expect(classifyBinanceFailure(400, -1003, "too many requests")).toBe("RATE_LIMIT");
    expect(classifyBinanceFailure(400, -2013, "Order does not exist.")).toBe("ORDER_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// D/E. The absence judge
// ---------------------------------------------------------------------------

/** Every fact present and clean — the only shape that may release. */
function provenAbsent(overrides: Partial<EntryAbsenceEvidence> = {}): EntryAbsenceEvidence {
  return {
    exactQuery: gathered("NOT_FOUND_CONFIRMED" as const),
    historyContainsOrder: gathered(false),
    fillsExist: gathered(false),
    positionAmount: gathered("0"),
    openOrderExists: gathered(false),
    algoOrderExists: gathered(false),
    localExecutedQuantity: gathered("0"),
    protectionStateExists: gathered(false),
    ...overrides,
  };
}

describe("entry recovery: the absence judge", () => {
  it("D1. proves absence only when EVERY fact is gathered and clean", () => {
    const verdict = judgeEntryAbsence(provenAbsent());
    expect(verdict.proven).toBe(true);
    expect(verdict.proven && verdict.checks).toHaveLength(8);
  });

  it("E1. NEVER releases when any single fact contradicts absence", () => {
    const contradictions: Array<[string, Partial<EntryAbsenceEvidence>]> = [
      ["exchange order exists", { exactQuery: gathered("CONFIRMED_ACCEPTED" as const) }],
      ["historical order found", { historyContainsOrder: gathered(true) }],
      ["exchange fill found", { fillsExist: gathered(true) }],
      ["local executed qty > 0", { localExecutedQuantity: gathered("0.77") }],
      ["non-zero position", { positionAmount: gathered("-0.77") }],
      ["open order", { openOrderExists: gathered(true) }],
      ["open algo/protection", { algoOrderExists: gathered(true) }],
      ["protection state exists", { protectionStateExists: gathered(true) }],
    ];
    for (const [label, override] of contradictions) {
      const verdict = judgeEntryAbsence(provenAbsent(override));
      expect(`${label}:${verdict.proven}`).toBe(`${label}:false`);
      expect(verdict.proven === false && verdict.reasonCode).toBe("EXPOSURE_EVIDENCE_PRESENT");
    }
  });

  it("E2. NEVER releases when any single fact could not be gathered", () => {
    // Timeout, 5xx, malformed body and an unsupported read all arrive here as
    // UNAVAILABLE. "We could not look" must never read as "nothing is there".
    const keys: Array<keyof EntryAbsenceEvidence> = [
      "exactQuery",
      "historyContainsOrder",
      "fillsExist",
      "positionAmount",
      "openOrderExists",
      "algoOrderExists",
      "localExecutedQuantity",
      "protectionStateExists",
    ];
    for (const key of keys) {
      const verdict = judgeEntryAbsence(provenAbsent({ [key]: unavailable("query failed") } as never));
      expect(`${key}:${verdict.proven}`).toBe(`${key}:false`);
      expect(verdict.proven === false && verdict.reasonCode).toBe("EVIDENCE_INCOMPLETE");
    }
  });

  it("E3. an ambiguous or retryable query outcome is not a 'no'", () => {
    for (const outcome of ["RESULT_UNKNOWN", "QUERY_RETRYABLE", "CONFLICT", "CONFIRMED_REJECTED"] as const) {
      const verdict = judgeEntryAbsence(provenAbsent({ exactQuery: gathered(outcome) }));
      expect(`${outcome}:${verdict.proven}`).toBe(`${outcome}:false`);
    }
  });

  it("E4. an unparseable quantity is never treated as flat", () => {
    for (const bad of ["", "abc", "NaN"]) {
      expect(judgeEntryAbsence(provenAbsent({ positionAmount: gathered(bad) })).proven).toBe(false);
      expect(judgeEntryAbsence(provenAbsent({ localExecutedQuantity: gathered(bad) })).proven).toBe(false);
    }
    // But the shapes an exchange really returns for flat do count.
    for (const zero of ["0", "0.000", "-0", "0.00000000"]) {
      expect(`${zero}:${judgeEntryAbsence(provenAbsent({ positionAmount: gathered(zero) })).proven}`).toBe(`${zero}:true`);
    }
  });

  it("E5. incomplete evidence outranks contradicting evidence in the reason", () => {
    // The operator's next action differs: one means "look again", the other
    // means "there is something there".
    const verdict = judgeEntryAbsence(
      provenAbsent({ positionAmount: unavailable("timeout"), openOrderExists: gathered(true) })
    );
    expect(verdict.proven === false && verdict.reasonCode).toBe("EVIDENCE_INCOMPLETE");
  });

  it("C1. elapsed time is not an input — no clock reaches the judge", () => {
    // A rule shaped "after N minutes assume no order" is how a live order gets
    // abandoned. The judge is a total function over facts only.
    const source = judgeEntryAbsence.toString();
    expect(source).not.toMatch(/Date|now\(|elapsed|timeout.*minutes/i);
  });
});

// ---------------------------------------------------------------------------
// The recovery service
// ---------------------------------------------------------------------------

const EXECUTION = {
  id: "exec-stuck-1",
  symbol: "SOLUSDC",
  positionSide: "SHORT",
  status: "ENTRY_SUBMITTING",
  version: 3,
  createdAt: new Date("2026-08-24T14:01:06.736Z"),
};

function harness(options: {
  status?: string;
  queryThrows?: unknown;
  history?: unknown[];
  trades?: unknown[];
  position?: { positionAmt: string } | null;
  openOrders?: unknown[];
  algo?: unknown[];
  executedQuantity?: string;
  protectionRows?: number;
  updateCount?: number;
} = {}) {
  const state = { status: options.status ?? EXECUTION.status, updates: 0, events: 0, orderUpdates: 0 };

  const prisma = {
    tradeExecution: {
      findUnique: vi.fn(async () => ({ ...EXECUTION, status: state.status })),
      updateMany: vi.fn(async () => {
        const count = options.updateCount ?? 1;
        if (count > 0) {
          state.status = "FAILED";
          state.updates += 1;
        }
        return { count };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ ...EXECUTION, status: "FAILED", version: EXECUTION.version + 1 })),
    },
    binanceOrder: {
      findFirst: vi.fn(async () => ({
        clientOrderId: "tad-en-1-96a827efbf2e",
        executedQuantity: { toString: () => options.executedQuantity ?? "0" },
      })),
      updateMany: vi.fn(async () => {
        state.orderUpdates += 1;
        return { count: 1 };
      }),
    },
    executionEvent: {
      create: vi.fn(async () => {
        state.events += 1;
        return {};
      }),
    },
    executionProtectionState: { count: vi.fn(async () => options.protectionRows ?? 0) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  } as unknown as PrismaClient;

  const readOnly = {
    queryOrderByClientOrderId: vi.fn(async () => {
      throw options.queryThrows ?? Object.assign(new Error("Order does not exist."), { kind: "ORDER_NOT_FOUND", binanceCode: -2013, httpStatus: 400 });
    }),
    listRecentOrders: vi.fn(async () => options.history ?? []),
    listRecentTrades: vi.fn(async () => options.trades ?? []),
    getPositionForSide: vi.fn(async () => options.position ?? { positionAmt: "0" }),
    getOpenOrders: vi.fn(async () => options.openOrders ?? []),
    getOpenAlgoOrders: vi.fn(async () => options.algo ?? []),
  } as unknown as BinanceReadOnlyService;

  return { service: new EntryRecoveryService(prisma, readOnly), prisma, readOnly, state };
}

describe("entry recovery: the explicit recovery action", () => {
  it("D2. releases exactly once when absence is proven", async () => {
    const { service, state, prisma } = harness();
    const result = await service.recover(EXECUTION.id);

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("RECOVERED");
    expect(result.status).toBe("FAILED"); // capacity-free, so risk+margin release
    expect(result.checks).toHaveLength(8);
    expect(state.updates).toBe(1);
    expect(state.events).toBe(1);
    expect(state.orderUpdates).toBe(1);
    // The claim is never touched: claims are cumulative by design.
    expect(Object.keys(prisma as unknown as object)).not.toContain("executionCanaryAuthorization");
    expect(result.message).toContain("authorization claim remains spent");
  });

  it("E6. refuses and changes NOTHING when a fact is unavailable", async () => {
    const { service, state } = harness({ position: null as never });
    // A throwing position read becomes UNAVAILABLE.
    const throwing = harness();
    (throwing.readOnly.getPositionForSide as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("timeout"), { name: "TimeoutError" })
    );
    const result = await throwing.service.recover(EXECUTION.id);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("BLOCKED");
    expect(result.blockers.join(" ")).toContain("positionFlat");
    expect(throwing.state.updates).toBe(0);
    expect(throwing.state.events).toBe(0);
    expect(state.updates).toBe(0);
  });

  it("E7. refuses when the exchange still knows the order", async () => {
    const { service, state } = harness({ history: [{ clientOrderId: "tad-en-1-96a827efbf2e" }] });
    const result = await service.recover(EXECUTION.id);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("BLOCKED");
    expect(state.updates).toBe(0);
  });

  it("E8. refuses when a fill or a position exists", async () => {
    for (const options of [
      { trades: [{ positionSide: "SHORT", qty: "0.77" }] },
      { position: { positionAmt: "-0.77" } },
      { executedQuantity: "0.77" },
      { algo: [{ clientAlgoId: "x" }] },
      { protectionRows: 1 },
    ]) {
      const { service, state } = harness(options);
      const result = await service.recover(EXECUTION.id);
      expect(`${JSON.stringify(options)}:${result.outcome}`).toBe(`${JSON.stringify(options)}:BLOCKED`);
      expect(state.updates).toBe(0);
    }
  });

  it("F1. is idempotent — a second call finds it already resolved", async () => {
    const { service } = harness({ status: "FAILED" });
    const result = await service.recover(EXECUTION.id);
    expect(result.outcome).toBe("ALREADY_RESOLVED");
    expect(result.ok).toBe(true);
  });

  it("F2. a concurrent version change blocks the release rather than repeating it", async () => {
    // The conditional updateMany matched nothing: something else moved the row.
    const { service, state } = harness({ updateCount: 0 });
    const result = await service.recover(EXECUTION.id);
    expect(result.outcome).toBe("BLOCKED");
    expect(result.blockers.join(" ")).toContain("version or status changed");
    expect(state.updates).toBe(0);
  });

  it("only ever acts on ENTRY_SUBMITTING, and only on ONE named execution", async () => {
    for (const status of ["PLAN_READY", "PREFLIGHT"]) {
      const { service } = harness({ status });
      expect((await service.recover(EXECUTION.id)).outcome).toBe("NOT_APPLICABLE");
    }
    // The signature takes one id: there is no bulk form to misuse.
    expect(EntryRecoveryService.prototype.recover.length).toBe(1);
  });

  it("G1. works with live gates closed — it never submits or configures", async () => {
    // Every exchange call it makes is a signed GET on the read-only connector,
    // so SAFE_RECOVERY neither blocks evidence nor permits a new order.
    const { service, readOnly } = harness();
    await service.recover(EXECUTION.id);
    for (const forbidden of ["submitLimitEntry", "cancelOrder", "authorizeLiveEntry", "setLeverage", "setMarginType"]) {
      expect(`${forbidden}:${forbidden in (readOnly as unknown as object)}`).toBe(`${forbidden}:false`);
    }
    const source = EntryRecoveryService.prototype.recover.toString() + EntryRecoveryService.toString();
    expect(source).not.toMatch(/submitLimitEntry|authorizeLiveEntry|cancelEntry/);
  });
});

// ---------------------------------------------------------------------------
// C. No blind re-submission
// ---------------------------------------------------------------------------

describe("entry recovery: ambiguous submissions are not re-sent", () => {
  it("C2. an already-ambiguous submission reconciles instead of submitting again", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(
      path.join(process.cwd(), "src/modules/execution/entry-lifecycle.service.ts"),
      "utf8"
    );
    const fn = source.slice(
      source.indexOf("private async continueAfterReservation"),
      source.indexOf("private async ensureIsolatedMargin")
    );
    // The short-circuit exists, and it comes BEFORE the configuration and
    // submission half of the function.
    expect(fn).toContain("order.submissionUnknownAt !== null");
    expect(fn.indexOf("submissionUnknownAt !== null")).toBeLessThan(fn.indexOf("submitAndReconcile"));
    expect(fn.indexOf("submissionUnknownAt !== null")).toBeLessThan(fn.indexOf("ensureExactLeverage"));
  });

  it("C3. the reconciliation tick reports attempts and progress separately", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const scheduler = readFileSync(
      path.join(process.cwd(), "src/modules/jobs/execution-orchestration.scheduler.ts"),
      "utf8"
    );
    // `advanced: 1` every 30s read as healthy activity while nothing moved.
    expect(scheduler).toContain("attempted: result.advanced");
    expect(scheduler).toContain("progressed: result.progressed");
  });
});

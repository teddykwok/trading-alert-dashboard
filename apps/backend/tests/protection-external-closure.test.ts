import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyMutationOutcome, type MutationOperation } from "../src/modules/execution/entry-lifecycle";
const BACKEND = process.cwd();
import { classifyBinanceFailure } from "../src/modules/binance/binance.errors";
import {
  CAPACITY_FREE_STATUSES,
  OPEN_POSITION_STATUSES,
  PENDING_ENTRY_STATUSES,
  TOTAL_ACTIVE_STATUSES,
  consumesNoCapacity,
} from "../src/modules/execution/capacity-status";
import {
  EXTERNAL_CLOSURE_SOURCE_STATUSES,
  TERMINAL_STATUSES,
  TRADE_EXECUTION_STATUSES,
  canTransition,
  isTerminalStatus,
} from "../src/modules/execution/execution-status";

/**
 * The first real MAINNET canary, as regression tests.
 *
 * A DOGSUSDT LONG filled, protection was refused by Binance, the refusal was
 * misread as ambiguous, and the execution parked at MANUAL_INTERVENTION with
 * `STOP_SUBMISSION_RESULT_UNKNOWN`. The operator closed the position by hand
 * and the row then stayed stuck forever, holding recoveryRequiredCount at 1.
 *
 * Pure functions only — no Binance, no database.
 */

// ---------------------------------------------------------------------------
// Failure classification: definitive vs ambiguous
// ---------------------------------------------------------------------------

describe("mutation failure classification", () => {
  /** What the exchange actually returned for the malformed algo request. */
  const parameterRejection = { httpStatus: 400, code: -1102, message: "Mandatory parameter 'triggerPrice' was not sent" };

  it("treats a documented request-validation code as a definitive rejection", () => {
    const kind = classifyBinanceFailure(
      parameterRejection.httpStatus,
      parameterRejection.code,
      parameterRejection.message
    );

    expect(kind).toBe("REQUEST_INVALID");
    // Binance parsed the request and refused it, so nothing was created. This
    // is the misclassification that left a live position unprotected.
    expect(classifyMutationOutcome({ kind, httpStatus: 400, binanceCode: -1102 })).toBe("CONFIRMED_REJECTED");
  });

  it("classifies every documented parameter code the same way", () => {
    for (const code of [-1100, -1101, -1102, -1103, -1104, -1105, -1106, -1111, -1116, -1117, -1118, -1130]) {
      const kind = classifyBinanceFailure(400, code, "bad parameter");
      expect(`${code}:${kind}`).toBe(`${code}:REQUEST_INVALID`);
      expect(`${code}:${classifyMutationOutcome({ kind, httpStatus: 400, binanceCode: code })}`).toBe(
        `${code}:CONFIRMED_REJECTED`
      );
    }
  });

  it("never infers absence from an unknown 4xx", () => {
    // Deliberately NOT "any 4xx = absent": an unrecognised client error still
    // tells us nothing about whether an order exists.
    const kind = classifyBinanceFailure(400, -9999, "something new");
    expect(kind).toBe("MALFORMED_RESPONSE");
    expect(classifyMutationOutcome({ kind, httpStatus: 400, binanceCode: -9999 })).toBe("RESULT_UNKNOWN");
  });

  it("never infers absence from transport or server failures", () => {
    for (const kind of ["TIMEOUT", "NETWORK", "SERVER", "MALFORMED_RESPONSE"]) {
      const outcome = classifyMutationOutcome({ kind, httpStatus: null, binanceCode: null });
      expect(`${kind}:${outcome}`).toBe(`${kind}:RESULT_UNKNOWN`);
      expect(outcome).not.toBe("NOT_FOUND_CONFIRMED");
    }
    expect(classifyBinanceFailure(503, null, "bad gateway")).toBe("SERVER");
  });

  it("never infers absence from auth, permission, rate-limit or ban failures", () => {
    for (const kind of ["AUTH", "PERMISSION", "IP_RESTRICTED", "FUTURES_NOT_ENABLED", "MISSING_CREDENTIALS"]) {
      expect(`${kind}:${classifyMutationOutcome({ kind, httpStatus: 401, binanceCode: null })}`).toBe(
        `${kind}:CONFIRMED_REJECTED`
      );
    }
    for (const kind of ["RATE_LIMIT", "IP_BANNED"]) {
      const outcome = classifyMutationOutcome({ kind, httpStatus: 429, binanceCode: null });
      expect(`${kind}:${outcome}`).toBe(`${kind}:QUERY_RETRYABLE`);
      expect(outcome).not.toBe("NOT_FOUND_CONFIRMED");
    }
    // A rejection means "not created"; it never means "proven absent" for a
    // query, and it never authorises a replacement identity.
    expect(classifyMutationOutcome({ kind: "AUTH", httpStatus: 401, binanceCode: null })).not.toBe(
      "NOT_FOUND_CONFIRMED"
    );
  });

  it("proves QUERY absence only from -2013 (NO_SUCH_ORDER)", () => {
    const query = (code: number) =>
      classifyMutationOutcome({ kind: classifyBinanceFailure(400, code, "x"), httpStatus: 400, binanceCode: code }, "QUERY");

    expect(query(-2013)).toBe("NOT_FOUND_CONFIRMED");
    // -2011 is CANCEL_REJECTED: documented in the cancel context only, so it
    // says nothing about a GET and must not prove absence here.
    expect(query(-2011)).not.toBe("NOT_FOUND_CONFIRMED");
    for (const code of [-1102, -2010, -4015, -4046, -1021, -9999]) {
      expect(`${code}:${query(code)}`).not.toBe(`${code}:NOT_FOUND_CONFIRMED`);
    }
  });

  it("defaults to the narrowest interpretation when no operation is given", () => {
    // An un-annotated caller is treated as a QUERY: -2011 stays ambiguous.
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", httpStatus: 400, binanceCode: -2011 })).not.toBe(
      "NOT_FOUND_CONFIRMED"
    );
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", httpStatus: 400, binanceCode: -2013 })).toBe(
      "NOT_FOUND_CONFIRMED"
    );
  });

  it("lets a CANCEL treat -2011 as nothing left to cancel", () => {
    // CANCEL_REJECTED "because the open order was not found" is exactly the
    // documented cancel semantic, and only the cancel path may use it.
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", httpStatus: 400, binanceCode: -2011 }, "CANCEL")).toBe(
      "NOT_FOUND_CONFIRMED"
    );
    expect(classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", httpStatus: 400, binanceCode: -2013 }, "CANCEL")).toBe(
      "NOT_FOUND_CONFIRMED"
    );
  });

  it("never lets a SUBMIT prove absence — it was asking to create something", () => {
    for (const code of [-2011, -2013]) {
      expect(
        `${code}:${classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", httpStatus: 400, binanceCode: code }, "SUBMIT_ORDER")}`
      ).not.toBe(`${code}:NOT_FOUND_CONFIRMED`);
    }
  });

  it("never reads -4015 as a duplicate or as proof an order exists", () => {
    // -4015 is INVALID_CL_ORD_ID_LEN, a malformed-id validation error. Reading
    // it as DUPLICATED_CLIENT_ORDER_ID would claim an order exists on the
    // strength of a bad id.
    expect(classifyBinanceFailure(400, -4015, "Client order id is not valid")).toBe("REQUEST_INVALID");
    for (const op of ["SUBMIT_ORDER", "SUBMIT_ALGO", "SUBMIT_CONFIG", "CANCEL", "QUERY"] as const) {
      const outcome = classifyMutationOutcome({ kind: "REQUEST_INVALID", httpStatus: 400, binanceCode: -4015 }, op);
      expect(`${op}:${outcome}`).toBe(`${op}:CONFIRMED_REJECTED`);
    }
  });

  it("treats -4116 as a duplicate ONLY on standard-order submission", () => {
    // DUPLICATED_CLIENT_ORDER_ID proves the order EXISTS, which is why a
    // replacement identity must never be minted.
    const duplicate = (op: MutationOperation) =>
      classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", httpStatus: 400, binanceCode: -4116 }, op);

    // POST /fapi/v1/order: documented clientOrderId semantics apply.
    expect(duplicate("SUBMIT_ORDER")).toBe("CONFLICT");

    // POST /fapi/v1/algoOrder: the duplicate semantic for clientAlgoId is NOT
    // established, so an algo duplicate must not prove the order exists. It
    // stays ambiguous, which sends the caller to query the SAME deterministic
    // clientAlgoId rather than mint a replacement identity.
    expect(duplicate("SUBMIT_ALGO")).toBe("RESULT_UNKNOWN");

    for (const op of ["SUBMIT_CONFIG", "QUERY", "CANCEL"] as const) {
      expect(`${op}:${duplicate(op)}`).toBe(`${op}:RESULT_UNKNOWN`);
    }
    // And it never becomes absence anywhere.
    for (const op of ["SUBMIT_ORDER", "SUBMIT_ALGO", "SUBMIT_CONFIG", "QUERY", "CANCEL"] as const) {
      expect(`${op}:${duplicate(op)}`).not.toBe(`${op}:NOT_FOUND_CONFIRMED`);
    }
  });

  it("lets no submission family prove absence", () => {
    // A submission was asking to CREATE something; -2011/-2013 cannot describe
    // its outcome.
    for (const op of ["SUBMIT_ORDER", "SUBMIT_ALGO", "SUBMIT_CONFIG"] as const) {
      for (const code of [-2011, -2013]) {
        const outcome = classifyMutationOutcome({ kind: "MALFORMED_RESPONSE", httpStatus: 400, binanceCode: code }, op);
        expect(`${op}/${code}:${outcome}`).not.toBe(`${op}/${code}:NOT_FOUND_CONFIRMED`);
      }
    }
  });

  it("routes each production call site to the family its endpoint belongs to", () => {
    const entry = readFileSync(path.join(BACKEND, "src", "modules", "execution", "entry-lifecycle.service.ts"), "utf8");
    const protection = readFileSync(
      path.join(BACKEND, "src", "modules", "execution", "protection-lifecycle.service.ts"),
      "utf8"
    );

    // The algo submission is the one that must NOT inherit clientOrderId
    // duplicate semantics.
    const algoBlock = protection.slice(protection.indexOf("submitProtectionOrder(context)"));
    expect(algoBlock).toContain('classifyMutationOutcome(this.asFailureShape(error), "SUBMIT_ALGO")');
    expect(protection).not.toContain('classifyMutationOutcome(this.asFailureShape(error), "SUBMIT")');
    expect(entry).not.toContain('classifyMutationOutcome(this.asFailureShape(error), "SUBMIT")');

    // The standard LIMIT entry keeps the documented semantics.
    expect(entry).toContain('classifyMutationOutcome(this.asFailureShape(error), "SUBMIT_ORDER")');
  });
});

// ---------------------------------------------------------------------------
// CLOSED_EXTERNAL: a truthful terminal state
// ---------------------------------------------------------------------------

describe("external closure status", () => {
  it("exists as a terminal, capacity-free status", () => {
    expect(TRADE_EXECUTION_STATUSES).toContain("CLOSED_EXTERNAL");
    expect(TERMINAL_STATUSES).toContain("CLOSED_EXTERNAL");
    expect(isTerminalStatus("CLOSED_EXTERNAL")).toBe(true);
    expect(CAPACITY_FREE_STATUSES).toContain("CLOSED_EXTERNAL");
    expect(consumesNoCapacity("CLOSED_EXTERNAL")).toBe(true);
  });

  it("counts as no active execution, pending entry or open position", () => {
    expect(PENDING_ENTRY_STATUSES).not.toContain("CLOSED_EXTERNAL");
    expect(OPEN_POSITION_STATUSES).not.toContain("CLOSED_EXTERNAL");
    expect(TOTAL_ACTIVE_STATUSES).not.toContain("CLOSED_EXTERNAL");
  });

  it("is reachable from MANUAL_INTERVENTION, which is what unsticks the real canary", () => {
    expect(canTransition("MANUAL_INTERVENTION", "CLOSED_EXTERNAL").allowed).toBe(true);
    expect(canTransition("PROTECTED", "CLOSED_EXTERNAL").allowed).toBe(true);
  });

  it("is reachable from every status the orchestrator can route into the proof path", () => {
    // ensureProtectionForExposure hands a flat position to
    // reconcileProtectionAndClosure, so PARTIALLY_FILLED, ENTRY_FILLED and
    // PLACING_PROTECTION all reach the external-close branch for real.
    for (const from of EXTERNAL_CLOSURE_SOURCE_STATUSES) {
      expect(canTransition(from, "CLOSED_EXTERNAL").allowed, from).toBe(true);
    }
    expect(EXTERNAL_CLOSURE_SOURCE_STATUSES).toEqual([
      "PARTIALLY_FILLED",
      "ENTRY_FILLED",
      "PLACING_PROTECTION",
      "PROTECTED",
      "MANUAL_INTERVENTION",
    ]);
  });

  it("is not reachable from a state where exposure is unresolved or absent", () => {
    // Before a confirmed fill exists there is nothing external to observe, so
    // these must never gain the transition merely because it is convenient.
    for (const from of ["PLAN_READY", "PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING"] as const) {
      expect(canTransition(from, "CLOSED_EXTERNAL").allowed, from).toBe(false);
    }
  });

  it("is reachable from EXACTLY the listed source statuses and no others", () => {
    // The guard against widening the transition by accident: every status in
    // the machine is checked against the declared list, in both directions.
    const reachable = TRADE_EXECUTION_STATUSES.filter(
      (from) => canTransition(from, "CLOSED_EXTERNAL").allowed
    );
    expect([...reachable].sort()).toEqual([...EXTERNAL_CLOSURE_SOURCE_STATUSES].sort());
  });

  it("is terminal in both directions — nothing leaves it", () => {
    for (const to of TRADE_EXECUTION_STATUSES) {
      const check = canTransition("CLOSED_EXTERNAL", to);
      expect(check.allowed, `CLOSED_EXTERNAL -> ${to}`).toBe(false);
      expect(check.reason).toMatch(/terminal/);
    }
  });

  it("does not displace an attributable exit", () => {
    // The known exits keep their own terminal states; CLOSED_EXTERNAL is only
    // for a closure we genuinely cannot attribute.
    for (const known of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY"] as const) {
      expect(TERMINAL_STATUSES).toContain(known);
      expect(canTransition("PROTECTED", known).allowed).toBe(true);
    }
  });
});

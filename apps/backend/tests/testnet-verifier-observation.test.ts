import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ACTIVE_ALGO_STATUSES,
  TERMINAL_ALGO_STATUSES,
  confirmActiveProtection,
  isResolved,
  observeAlgoIdentity,
  type AlgoIdentityInput,
  type ProtectionExpectation,
} from "../src/modules/binance/testnet-verifier/testnet-algo-observation";
import { normalizeAlgoOrder } from "../src/modules/binance/binance.normalize";

/**
 * The observation model, written directly against the first real demo run.
 *
 * That run reported `productionQueryFormAccepted = true`,
 * `documentedQueryFormAccepted = true`, `status = null` for the take profit —
 * three values that a documented `-2013 NO_SUCH_ORDER` answer produces just as
 * readily as a found-but-statusless order. Telling those apart is the entire
 * purpose of this module.
 */

const ID = "tad-tp-1-abcdef012345";

/** The FULL identity the verifier submitted, as production compares it. */
const EXPECTED: ProtectionExpectation = {
  symbol: "BTCUSDT",
  positionSide: "LONG",
  orderType: "TAKE_PROFIT_MARKET",
  side: "SELL",
  quantity: "0.002",
  triggerPrice: "55000.0",
  workingType: "MARK_PRICE",
  priceProtect: false,
};

/** Exactly what a correct Binance readback of that order looks like. */
const EXCHANGE_FIELDS = {
  orderType: "TAKE_PROFIT_MARKET",
  positionSide: "LONG",
  symbol: "BTCUSDT",
  side: "SELL",
  quantity: "0.002",
  triggerPrice: "55000.0",
  workingType: "MARK_PRICE",
  priceProtect: false,
  closePosition: false,
  // The mainnet shape: Binance sets this itself on a hedge-mode closing
  // conditional order. Default it to TRUE so every test here runs against
  // reality rather than against a Binance that does not exist.
  reduceOnly: true,
} as const;

/** Both forms agree, so an override must change BOTH sides. */
const found = (over: Partial<AlgoIdentityInput["documented"]> = {}) => {
  const algoStatus = "algoStatus" in over ? (over.algoStatus ?? null) : "NEW";
  return observeAlgoIdentity({
    clientAlgoId: ID,
    production: { lookup: "FOUND", ...EXCHANGE_FIELDS, ...over, algoStatus },
    documented: { lookup: "FOUND", statusKeyPresent: true, ...EXCHANGE_FIELDS, ...over, algoStatus },
  });
};

describe("algo identity observation", () => {
  it("distinguishes a found order from a confirmed-absent one", () => {
    const absent = observeAlgoIdentity({
      clientAlgoId: ID,
      production: { lookup: "CONFIRMED_ABSENT" },
      documented: { lookup: "CONFIRMED_ABSENT" },
    });
    expect(absent.outcome).toBe("ABSENT_CONFIRMED");
    expect(absent.identityFound).toBe(false);
    expect(found().outcome).toBe("IDENTITY_FOUND_STATUS_ACTIVE");
    expect(found().identityFound).toBe(true);
  });

  it("reproduces the demo shape: identity exists but algoStatus is missing", () => {
    const observation = observeAlgoIdentity({
      clientAlgoId: ID,
      production: { lookup: "FOUND", algoStatus: null, orderType: "TAKE_PROFIT_MARKET", positionSide: "LONG", symbol: "BTCUSDT" },
      documented: { lookup: "FOUND", statusKeyPresent: false, algoStatus: null },
    });

    expect(observation.outcome).toBe("IDENTITY_FOUND_STATUS_MISSING");
    // The exact identity is PRESERVED — it is not treated as absent.
    expect(observation.identityFound).toBe(true);
    expect(observation.rawStatusPresent).toBe(false);
    expect(observation.normalizedStatus).toBeNull();
    // And it is NOT resolved, so nothing downstream may call it finished.
    expect(isResolved(observation)).toBe(false);
  });

  it("treats an unrecognised status as MISSING, never as active", () => {
    const observation = found({ algoStatus: "SOMETHING_NEW" });
    expect(observation.outcome).toBe("IDENTITY_FOUND_STATUS_MISSING");
    expect(confirmActiveProtection(observation, EXPECTED).confirmed).toBe(false);
  });

  it("recognises every documented active status", () => {
    for (const status of ACTIVE_ALGO_STATUSES) {
      expect(found({ algoStatus: status }).outcome, status).toBe("IDENTITY_FOUND_STATUS_ACTIVE");
    }
  });

  it("recognises every terminal status and never calls it active", () => {
    for (const status of TERMINAL_ALGO_STATUSES) {
      const observation = found({ algoStatus: status });
      expect(observation.outcome, status).toBe("IDENTITY_FOUND_STATUS_TERMINAL");
      expect(isResolved(observation), status).toBe(true);
      expect(confirmActiveProtection(observation, EXPECTED).confirmed, status).toBe(false);
    }
  });

  it("never turns a failed query into absence", () => {
    const observation = observeAlgoIdentity({
      clientAlgoId: ID,
      production: { lookup: "UNKNOWN" },
      documented: { lookup: "UNKNOWN" },
    });
    expect(observation.outcome).toBe("UNKNOWN");
    expect(isResolved(observation)).toBe(false);
  });

  it("lets a documented -2013 prove absence even when the production form failed", () => {
    const observation = observeAlgoIdentity({
      clientAlgoId: ID,
      production: { lookup: "UNKNOWN" },
      documented: { lookup: "CONFIRMED_ABSENT" },
    });
    expect(observation.outcome).toBe("ABSENT_CONFIRMED");
  });

  it("refuses to choose when the two forms CONTRADICT each other", () => {
    const observation = observeAlgoIdentity({
      clientAlgoId: ID,
      production: { lookup: "FOUND", algoStatus: "NEW" },
      documented: { lookup: "CONFIRMED_ABSENT" },
    });
    expect(observation.outcome).toBe("UNKNOWN");
    expect(observation.identityFound).toBe(false);
    expect(isResolved(observation)).toBe(false);
  });

  it("records which form said what, so the report can never conflate them", () => {
    const observation = observeAlgoIdentity({
      clientAlgoId: ID,
      production: { lookup: "CONFIRMED_ABSENT" },
      documented: { lookup: "UNKNOWN" },
    });
    expect(observation.productionQueryForm).toBe("CONFIRMED_ABSENT");
    expect(observation.documentedQueryForm).toBe("UNKNOWN");
  });

  it("carries no payload or credential material in its fields", () => {
    const serialized = JSON.stringify(found());
    for (const forbidden of ["signature", "apiKey", "secret", "X-MBX", "https://"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("active protection confirmation", () => {
  it("is NOT satisfied by a matching clientAlgoId alone", () => {
    // The exact defect the first demo run exposed.
    const observation = observeAlgoIdentity({
      clientAlgoId: ID,
      production: { lookup: "FOUND", algoStatus: null, symbol: "BTCUSDT", positionSide: "LONG", orderType: "TAKE_PROFIT_MARKET" },
      documented: { lookup: "FOUND", statusKeyPresent: false },
    });
    expect(observation.identityFound).toBe(true);
    expect(confirmActiveProtection(observation, EXPECTED).confirmed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The verifier delegates identity to the PRODUCTION comparator.
  //
  // Phase 20 verified demo with its own weaker copy of these rules, which is
  // exactly how Mainnet Canary #2's defect escaped: demo never exercised
  // findProtectionIdentityMismatches, so it never noticed that production
  // rejected a valid hedge-mode STOP carrying reduceOnly=true.
  // -------------------------------------------------------------------------

  it("MAINNET CANARY #2: accepts reduceOnly=true through the production comparator", () => {
    const result = confirmActiveProtection(found({ reduceOnly: true }), EXPECTED);
    expect(result.confirmed).toBe(true);
    expect(result.identityMismatches).toEqual([]);
    expect(result.reason).toMatch(/production identity comparator accepted/);
  });

  it("MAINNET CANARY #2 (negative): closePosition=true fails through the production comparator", () => {
    const result = confirmActiveProtection(found({ closePosition: true }), EXPECTED);
    expect(result.confirmed).toBe(false);
    expect(result.identityMismatches).toEqual(["closePosition"]);
    expect(result.reason).toMatch(/production identity comparator rejected: closePosition/);
  });

  it("fails whenever the production comparator reports ANY mismatch", () => {
    // Every field the production comparator judges, proven to fail the
    // verifier — including the ones the old local copy never checked at all.
    for (const [field, override] of [
      ["symbol", { symbol: "ETHUSDT" }],
      ["positionSide", { positionSide: "SHORT" }],
      ["orderType", { orderType: "STOP_MARKET" }],
      ["side", { side: "BUY" }],
      ["quantity", { quantity: "0.999" }],
      ["triggerPrice", { triggerPrice: "12345.0" }],
      ["workingType", { workingType: "CONTRACT_PRICE" }],
      ["priceProtect", { priceProtect: true }],
      ["closePosition", { closePosition: true }],
    ] as const) {
      const result = confirmActiveProtection(found(override), EXPECTED);
      expect(result.confirmed, field).toBe(false);
      expect(result.identityMismatches, field).toContain(field);
    }
  });

  it("refuses when the reply carries no symbol at all", () => {
    const result = confirmActiveProtection(found({ symbol: null }), EXPECTED);
    expect(result.confirmed).toBe(false);
    expect(result.identityMismatches).toContain("symbol");
  });

  it("uses the production comparator rather than a private copy of the rules", () => {
    // A structural guard: the module must IMPORT the production comparator and
    // must not re-implement the field checks locally.
    const source = readFileSync(
      path.join(process.cwd(), "src/modules/binance/testnet-verifier/testnet-algo-observation.ts"),
      "utf8"
    );
    expect(source).toMatch(/import\s*\{[\s\S]*findProtectionIdentityMismatches[\s\S]*\}\s*from\s*"\.\.\/\.\.\/execution\/protection-lifecycle"/);
    expect(source).toContain("findProtectionIdentityMismatches(");
    // No second implementation: the verifier must not push its own field names.
    expect(source).not.toMatch(/mismatches\.push\(/);
  });

  it("gives a sanitized reason for every refusal", () => {
    const reason = confirmActiveProtection(found({ algoStatus: "CANCELED" }), EXPECTED).reason;
    expect(reason).toMatch(/IDENTITY_FOUND_STATUS_TERMINAL/);
    expect(reason).not.toMatch(/signature|http/i);
  });
});

// ---------------------------------------------------------------------------
// The production normalizer, against the DOCUMENTED Query Algo Order response
// ---------------------------------------------------------------------------

describe("algo order normalization against the documented response", () => {
  /** Field names exactly as the Query Algo Order page documents them. */
  const documentedRow = {
    algoId: 12345,
    clientAlgoId: "tad-tp-1-abcdef012345",
    algoType: "CONDITIONAL",
    orderType: "TAKE_PROFIT_MARKET",
    symbol: "BTCUSDT",
    side: "SELL",
    positionSide: "LONG",
    quantity: "0.002",
    algoStatus: "NEW",
    actualOrderId: "998877",
    actualPrice: "50123.40",
    actualQty: "0.002",
    triggerPrice: "55000.0",
    workingType: "MARK_PRICE",
    closePosition: false,
    priceProtect: false,
    reduceOnly: false,
  };

  it("reads the documented actualOrderId / actualQty / actualPrice fields", () => {
    const dto = normalizeAlgoOrder(documentedRow);
    // These were previously read under the STANDARD-order names only, leaving
    // all three null for every algo fill — which silently blanked
    // actualExitPrice on a real CLOSED_TP / CLOSED_SL.
    expect(dto.actualOrderId).toBe("998877");
    expect(dto.executedQuantity).toBe("0.002");
    expect(dto.averagePrice).toBe("50123.40");
  });

  it("still reads the legacy standard-order names as a fallback", () => {
    const dto = normalizeAlgoOrder({
      clientAlgoId: "x",
      symbol: "BTCUSDT",
      orderId: 42,
      executedQty: "0.5",
      avgPrice: "100.25",
    });
    expect(dto.actualOrderId).toBe("42");
    expect(dto.executedQuantity).toBe("0.5");
    expect(dto.averagePrice).toBe("100.25");
  });

  it("reads every field the verifier's confirmation depends on", () => {
    const dto = normalizeAlgoOrder(documentedRow);
    expect(dto.clientAlgoId).toBe("tad-tp-1-abcdef012345");
    expect(dto.algoStatus).toBe("NEW");
    expect(dto.orderType).toBe("TAKE_PROFIT_MARKET");
    expect(dto.positionSide).toBe("LONG");
    expect(dto.symbol).toBe("BTCUSDT");
    expect(dto.triggerPrice).toBe("55000.0");
  });

  it("returns null algoStatus when the key is absent, empty or not a string", () => {
    // The three source-level ways the demo run's `status = null` can arise.
    for (const row of [
      { clientAlgoId: "x", symbol: "S" },
      { clientAlgoId: "x", symbol: "S", algoStatus: "" },
      { clientAlgoId: "x", symbol: "S", algoStatus: "   " },
      { clientAlgoId: "x", symbol: "S", algoStatus: 1 },
      { clientAlgoId: "x", symbol: "S", algoStatus: null },
    ]) {
      expect(normalizeAlgoOrder(row).algoStatus, JSON.stringify(row)).toBeNull();
      // The identity survives regardless — that is what the verifier keys on.
      expect(normalizeAlgoOrder(row).clientAlgoId).toBe("x");
    }
  });

  it("accepts `status` as a documented-adjacent fallback for algoStatus", () => {
    expect(normalizeAlgoOrder({ clientAlgoId: "x", symbol: "S", status: "NEW" }).algoStatus).toBe("NEW");
  });
});

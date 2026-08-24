import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeSymbolFilters } from "../src/modules/binance/binance.normalize";
import type { BinanceSymbolFiltersDto } from "../src/modules/binance/binance.types";
import { judgeSymbolEligibility, validateAllowlist, type SymbolMetadataIndex } from "../src/modules/operator/symbol-allowlist";
import {
  SAFETY_REASON_CODES,
  classifySafetyReasonRetryability,
  evaluateSafetyAdmission,
  type SafetyEvaluationInput,
  type SymbolStateSnapshot,
} from "../src/modules/execution/safety-engine";

/**
 * USDT-only execution eligibility.
 *
 * The rule is a POSITIVE allow rule: a contract is eligible only once
 * authoritative Binance metadata confirms it is listed, TRADING, PERPETUAL,
 * quoted in USDT and margined in USDT. Everything else is refused.
 *
 * The single most important property in this file is that the ticker's
 * SPELLING is never consulted. `USDCUSDT` is a perfectly ordinary USDT-margined
 * perpetual and must be accepted; `BNBUSDC` must not. Any implementation
 * reaching for `includes("USDC")` or `endsWith("USDT")` gets both of those
 * backwards, so both directions are asserted rather than just the convenient
 * one.
 *
 * Pure throughout: fixtures and a metadata map. No database, no network, no
 * runtime, and nothing here can reach MAINNET.
 */

const BACKEND = path.resolve(__dirname, "..");

/**
 * Source with comments stripped.
 *
 * The structural pins below assert that certain expressions do not appear in
 * the implementation. Several of those very expressions are NAMED in comments
 * explaining why they are wrong, so matching raw text would fail on the
 * documentation rather than on the code. The guarantee is about behaviour.
 */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One exchangeInfo symbol row, shaped exactly as Binance sends it. */
function exchangeInfoRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    baseAsset: "BTC",
    orderTypes: ["LIMIT", "MARKET"],
    timeInForce: ["GTC"],
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.10", minPrice: "0.10", maxPrice: "1000000" },
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
    ...overrides,
  };
}

function filters(overrides: Partial<BinanceSymbolFiltersDto> = {}): BinanceSymbolFiltersDto {
  return { ...normalizeSymbolFilters(exchangeInfoRow()), ...overrides };
}

function metadata(rows: BinanceSymbolFiltersDto[]): SymbolMetadataIndex {
  return new Map(rows.map((row) => [row.symbol.toUpperCase(), row]));
}

function symbolState(overrides: Partial<SymbolStateSnapshot> = {}): SymbolStateSnapshot {
  return {
    available: true,
    exists: true,
    status: "TRADING",
    contractType: "PERPETUAL",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    hasFiltersSnapshot: true,
    hasBracketSnapshot: true,
    ...overrides,
  };
}

const EVALUATED_AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * A synthetic admission that PASSES on every axis except the one under test,
 * so a refusal can only have come from the symbol rule.
 */
function evaluate(state: SymbolStateSnapshot, symbol = "BTCUSDT") {
  const input: SafetyEvaluationInput = {
    evaluatedAt: EVALUATED_AT,
    proposed: {
      executionId: "exec-1",
      profileId: "profile-1",
      symbol,
      positionSide: "LONG",
      signalTriggeredAt: new Date(EVALUATED_AT.getTime() - 1_000),
      sourceTimeframe: "1W",
      currentStatus: "PLAN_READY",
      riskBudgetUsd: "1.50",
      actualPlannedLoss: "1.50",
      estimatedInitialMargin: "3.75",
      maximumIsolatedMargin: "5.00",
      estimatedLiquidationPrice: "90.1",
      requiredLiquidationBoundary: "94",
      marginPlanStatus: "READY",
      selectedLeverage: 10,
      hasMarginPlanSnapshot: true,
    },
    policy: {
      killSwitchActive: false,
      globalKillSwitchActive: false,
      profileKillSwitchActive: false,
      policyPresent: true,
      profileEnabled: true,
      environmentMatchesConnector: true,
      expectedPositionMode: "HEDGE",
      expectedMarginType: "ISOLATED",
      maxOpenPositions: 5,
      maxPendingEntries: 5,
      maxTotalActiveTrades: 5,
      maxTotalPlannedRiskUsd: "100.00",
      maxTotalIsolatedMarginUsd: "500.00",
      maxActivePerSymbolSide: 1,
      maxAlertAgeSeconds: 300,
      softOpenPositionTarget: 5,
      signalFutureToleranceSeconds: 30,
      allowedSymbols: [],
      allowedSourceTimeframes: ["1W", "1M"],
    } as unknown as SafetyEvaluationInput["policy"],
    local: {
      alreadyAdmitted: false,
      openPositionCount: 0,
      pendingEntryCount: 0,
      totalActiveCount: 0,
      activeSymbolSideKeys: [],
      reservedRiskUsd: "0",
      reservedMaximumMarginUsd: "0",
    } as unknown as SafetyEvaluationInput["local"],
    binance: {
      available: true,
      positionMode: "HEDGE",
      assetMode: "SINGLE_ASSET",
      usdtAvailableBalance: "5000.00",
      symbolsWithPosition: [],
      symbolsWithOpenOrder: [],
      snapshotAt: EVALUATED_AT,
    } as unknown as SafetyEvaluationInput["binance"],
    symbolState: state,
  };
  return evaluateSafetyAdmission(input);
}

const codesOf = (result: ReturnType<typeof evaluate>) => result.failedChecks.map((check) => check.reasonCode);

// ---------------------------------------------------------------------------
// A. Metadata parsing
// ---------------------------------------------------------------------------

describe("A. authoritative metadata parsing", () => {
  it("A1. parses status, contractType, quoteAsset and marginAsset", () => {
    const parsed = normalizeSymbolFilters(exchangeInfoRow());
    expect(parsed.symbol).toBe("BTCUSDT");
    expect(parsed.status).toBe("TRADING");
    expect(parsed.contractType).toBe("PERPETUAL");
    expect(parsed.quoteAsset).toBe("USDT");
    expect(parsed.marginAsset).toBe("USDT");
  });

  it("A2. keeps quote and margin asset DISTINCT rather than assuming they agree", () => {
    // A contract can be quoted in one asset and collateralised in another;
    // conflating them is how a USDC-margined contract slips through.
    const parsed = normalizeSymbolFilters(exchangeInfoRow({ quoteAsset: "USDT", marginAsset: "USDC" }));
    expect(parsed.quoteAsset).toBe("USDT");
    expect(parsed.marginAsset).toBe("USDC");
  });

  it("A3. yields NULL — never a default — when a required field is missing", () => {
    const parsed = normalizeSymbolFilters(exchangeInfoRow({ quoteAsset: undefined, marginAsset: undefined }));
    expect(parsed.quoteAsset).toBeNull();
    expect(parsed.marginAsset).toBeNull();
  });

  it("A4. yields NULL for a malformed (non-string) field rather than coercing it", () => {
    const parsed = normalizeSymbolFilters(exchangeInfoRow({ quoteAsset: 42, marginAsset: { asset: "USDT" } }));
    expect(parsed.quoteAsset).toBeNull();
    expect(parsed.marginAsset).toBeNull();
  });

  it("A5. survives a completely malformed row without inventing eligibility", () => {
    const parsed = normalizeSymbolFilters({ nonsense: true });
    expect(parsed.quoteAsset).toBeNull();
    expect(parsed.marginAsset).toBeNull();
    expect(judgeSymbolEligibility("BTCUSDT", metadata([{ ...parsed, symbol: "BTCUSDT" }]))).toMatchObject({
      ok: false,
    });
  });
});

// ---------------------------------------------------------------------------
// B. Definitive acceptance
// ---------------------------------------------------------------------------

describe("B. definitive acceptance", () => {
  it("B1. BTCUSDT — TRADING, PERPETUAL, USDT/USDT — is eligible", () => {
    expect(evaluate(symbolState(), "BTCUSDT").decision).toBe("PASS");
    expect(judgeSymbolEligibility("BTCUSDT", metadata([filters({ symbol: "BTCUSDT" })]))).toEqual({ ok: true });
  });

  it("B2. USDCUSDT is eligible — the BASE asset is irrelevant", () => {
    // The proof that this is not `symbol.includes("USDC")`. USDCUSDT is quoted
    // and margined in USDT; the fact that it TRADES the USDC asset says
    // nothing about the collateral the account must post.
    const state = symbolState({ quoteAsset: "USDT", marginAsset: "USDT" });
    expect(evaluate(state, "USDCUSDT").decision).toBe("PASS");
    expect(
      judgeSymbolEligibility("USDCUSDT", metadata([filters({ symbol: "USDCUSDT", quoteAsset: "USDT", marginAsset: "USDT" })]))
    ).toEqual({ ok: true });
  });

  it("B3. accepts lowercase metadata — the rule compares assets, not formatting", () => {
    expect(evaluate(symbolState({ quoteAsset: "usdt", marginAsset: "usdt" })).decision).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// C. Definitive rejection
// ---------------------------------------------------------------------------

describe("C. definitive rejection on authoritative metadata", () => {
  it("C1. BNBUSDC — quoted and margined in USDC — is refused", () => {
    const result = evaluate(symbolState({ quoteAsset: "USDC", marginAsset: "USDC" }), "BNBUSDC");
    expect(result.decision).toBe("SKIP");
    expect(codesOf(result)).toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });

  it("C2. SOLUSDC — the contract that actually stranded an execution — is refused", () => {
    const result = evaluate(symbolState({ quoteAsset: "USDC", marginAsset: "USDC" }), "SOLUSDC");
    expect(result.decision).toBe("SKIP");
    expect(codesOf(result)).toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });

  it("C3. a NON-PERPETUAL contract is refused", () => {
    const result = evaluate(symbolState({ contractType: "CURRENT_QUARTER" }));
    expect(result.decision).toBe("SKIP");
    expect(codesOf(result)).toContain("UNSUPPORTED_CONTRACT");
  });

  it("C4. status other than TRADING is refused", () => {
    const result = evaluate(symbolState({ status: "BREAK" }));
    expect(result.decision).toBe("SKIP");
    expect(codesOf(result)).toContain("SYMBOL_NOT_TRADING");
  });

  it("C5. a USDT-margined contract quoted in something else is refused", () => {
    const result = evaluate(symbolState({ quoteAsset: "BTC", marginAsset: "USDT" }));
    expect(result.decision).toBe("SKIP");
    expect(codesOf(result)).toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });

  it("C6. a USDT-QUOTED contract margined in something else is refused", () => {
    // The case a quote-asset-only rule would wave through, and the one that
    // decides whether the account can actually carry the position.
    const result = evaluate(symbolState({ quoteAsset: "USDT", marginAsset: "USDC" }));
    expect(result.decision).toBe("SKIP");
    expect(codesOf(result)).toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });

  it("C7. every USDT-only refusal is TERMINAL, never retried", () => {
    // The collateral asset is a property of the LISTING. Retrying could only
    // ever produce the same answer, so a retryable classification would park
    // the execution forever.
    expect(classifySafetyReasonRetryability("USDT_ONLY_CONTRACT_REQUIRED")).toBe("TERMINAL");
    expect(SAFETY_REASON_CODES).toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });

  it("C8. reports its OWN code, not a contract-type problem", () => {
    // "This is not a perpetual" and "this is a perpetual we do not trade" send
    // an operator to two different places.
    const result = evaluate(symbolState({ quoteAsset: "USDC", marginAsset: "USDC" }));
    expect(codesOf(result)).toContain("USDT_ONLY_CONTRACT_REQUIRED");
    expect(codesOf(result)).not.toContain("UNSUPPORTED_CONTRACT");
    expect(result.message).toMatch(/USDT/);
  });
});

// ---------------------------------------------------------------------------
// D. Unsupported and odd tickers
// ---------------------------------------------------------------------------

describe("D. symbols absent from authoritative metadata", () => {
  for (const symbol of ["ETHBTC", "ETHUSD1", "BTCU"]) {
    it(`D. ${symbol} — absent from exchangeInfo — fails closed as UNSUPPORTED_SYMBOL`, () => {
      // `exists: false` means exchangeInfo answered and had no such contract.
      // That is an authoritative answer, so it is TERMINAL rather than retried.
      const result = evaluate(symbolState({ exists: false, quoteAsset: null, marginAsset: null }), symbol);
      expect(result.decision).toBe("SKIP");
      expect(codesOf(result)).toContain("UNSUPPORTED_SYMBOL");
      expect(classifySafetyReasonRetryability("UNSUPPORTED_SYMBOL")).toBe("TERMINAL");
    });

    it(`D. ${symbol} is refused by the allowlist validator too`, () => {
      const verdict = judgeSymbolEligibility(symbol, metadata([filters({ symbol: "BTCUSDT" })]));
      expect(verdict).toMatchObject({ ok: false, reasonCode: "NOT_FUTURES_ELIGIBLE" });
    });
  }

  it("D4. an absent symbol never reaches the USDT rule at all", () => {
    // Ordering matters: a symbol that does not exist has no assets to judge,
    // and reporting it as a collateral problem would be a fabrication.
    const result = evaluate(symbolState({ exists: false, quoteAsset: null, marginAsset: null }), "ETHBTC");
    expect(codesOf(result)).not.toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// E. The name is never the authority
// ---------------------------------------------------------------------------

describe("E. metadata is the authority, never the ticker", () => {
  it("E1. a symbol ENDING in USDT is refused when its margin asset is not USDT", () => {
    const result = evaluate(symbolState({ quoteAsset: "USDT", marginAsset: "BNFCR" }), "FAKEUSDT");
    expect(result.decision).toBe("SKIP");
    expect(codesOf(result)).toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });

  it("E2. a symbol ending in USDT but ABSENT from metadata is refused", () => {
    // The suffix proves nothing about whether Binance lists the contract.
    const result = evaluate(symbolState({ exists: false, quoteAsset: null, marginAsset: null }), "XYZUSDT");
    expect(result.decision).toBe("SKIP");
    expect(codesOf(result)).toContain("UNSUPPORTED_SYMBOL");
    expect(judgeSymbolEligibility("XYZUSDT", metadata([filters()]))).toMatchObject({ ok: false });
  });

  it("E3. a symbol that does NOT end in USDT is accepted when metadata confirms USDT/USDT", () => {
    // Policy follows metadata in BOTH directions. A hypothetical contract
    // spelled anything at all is eligible if the exchange says it is quoted
    // and margined in USDT.
    const result = evaluate(symbolState(), "1000SHIBUSDT");
    expect(result.decision).toBe("PASS");
    expect(
      judgeSymbolEligibility("ODDNAME", metadata([filters({ symbol: "ODDNAME", quoteAsset: "USDT", marginAsset: "USDT" })]))
    ).toEqual({ ok: true });
  });

  it("E4. a Unicode-looking ticker is never trusted on its spelling", () => {
    const result = evaluate(symbolState({ exists: false, quoteAsset: null, marginAsset: null }), "ВТСUSDT");
    expect(result.decision).toBe("SKIP");
    expect(codesOf(result)).toContain("UNSUPPORTED_SYMBOL");
  });
});

// ---------------------------------------------------------------------------
// G(pure). Metadata unavailable is UNKNOWN, never "unsupported"
// ---------------------------------------------------------------------------

describe("G. unreadable metadata is unknown, not unsupported", () => {
  it("G1. an unavailable symbol read is RETRYABLE and is never called non-USDT", () => {
    const result = evaluate(symbolState({ available: false, exists: false, quoteAsset: null, marginAsset: null }));
    expect(result.decision).toBe("UNAVAILABLE");
    expect(codesOf(result)).toContain("BINANCE_SYMBOL_STATE_UNAVAILABLE");
    expect(codesOf(result)).not.toContain("USDT_ONLY_CONTRACT_REQUIRED");
    expect(classifySafetyReasonRetryability("BINANCE_SYMBOL_STATE_UNAVAILABLE")).toBe("RETRYABLE");
  });

  it("G2. a MISSING margin asset is unknown — not an accusation of being USDC", () => {
    // Present-and-wrong is terminal; absent is retryable. Labelling an
    // unreadable field "not USDT" would permanently skip a contract nobody
    // ever established anything about.
    const result = evaluate(symbolState({ marginAsset: null }));
    expect(result.decision).toBe("UNAVAILABLE");
    expect(codesOf(result)).toContain("BINANCE_SYMBOL_STATE_UNAVAILABLE");
    expect(codesOf(result)).not.toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });

  it("G3. a MISSING quote asset behaves the same way", () => {
    const result = evaluate(symbolState({ quoteAsset: null }));
    expect(result.decision).toBe("UNAVAILABLE");
    expect(codesOf(result)).toContain("BINANCE_SYMBOL_STATE_UNAVAILABLE");
    expect(codesOf(result)).not.toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });

  it("G4. a BLANK asset string is unknown too — never silently equal to USDT", () => {
    const result = evaluate(symbolState({ quoteAsset: "   ", marginAsset: "" }));
    expect(result.decision).toBe("UNAVAILABLE");
    expect(codesOf(result)).not.toContain("USDT_ONLY_CONTRACT_REQUIRED");
  });

  it("G5. UNAVAILABLE never reads as eligible", () => {
    // The one direction that would be catastrophic: an unreadable symbol
    // being admitted.
    for (const state of [
      symbolState({ available: false }),
      symbolState({ quoteAsset: null }),
      symbolState({ marginAsset: null }),
      symbolState({ quoteAsset: "", marginAsset: "" }),
    ]) {
      expect(evaluate(state).decision).not.toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// H. The allowlist validator — the second, convenience layer
// ---------------------------------------------------------------------------

describe("H. Trading Control allowlist validation", () => {
  /** Every example the operator pasted, judged against one metadata index. */
  const index = metadata([
    filters({ symbol: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT" }),
    filters({ symbol: "USDCUSDT", quoteAsset: "USDT", marginAsset: "USDT" }),
    filters({ symbol: "BNBUSDC", quoteAsset: "USDC", marginAsset: "USDC" }),
    filters({ symbol: "SOLUSDC", quoteAsset: "USDC", marginAsset: "USDC" }),
    // ETHBTC, ETHUSD1 and BTCU are deliberately ABSENT: they are not listed
    // USDⓈ-M contracts, which is a different rejection from a listed contract
    // margined in the wrong asset.
  ]);

  it("H1. accepts BTCUSDT.P and USDCUSDT.P", () => {
    const result = validateAllowlist("BTCUSDT.P\nUSDCUSDT.P", index);
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["BTCUSDT", "USDCUSDT"]);
    expect(result.rejected).toEqual([]);
  });

  it("H2. rejects BNBUSDC.P and SOLUSDC.P as non-USDT collateral", () => {
    const result = validateAllowlist("BNBUSDC.P\nSOLUSDC.P", index);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reasonCode)).toEqual([
      "USDT_ONLY_CONTRACT_REQUIRED",
      "USDT_ONLY_CONTRACT_REQUIRED",
    ]);
    // An empty accepted list is a REFUSAL, never an empty save — `[]` means
    // "allow all" to the admission engine.
    expect(result.ok).toBe(false);
    expect(result.refusal).not.toBeNull();
  });

  it("H3. rejects ETHBTC.P, ETHUSD1.P and BTCU.P as not listed", () => {
    const result = validateAllowlist("ETHBTC.P\nETHUSD1.P\nBTCU.P", index);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reasonCode)).toEqual([
      "NOT_FUTURES_ELIGIBLE",
      "NOT_FUTURES_ELIGIBLE",
      "NOT_FUTURES_ELIGIBLE",
    ]);
  });

  it("H4. rejects a listed contract whose assets could not be confirmed", () => {
    const unconfirmed = metadata([filters({ symbol: "MYSTERYUSDT", quoteAsset: null, marginAsset: null })]);
    const verdict = judgeSymbolEligibility("MYSTERYUSDT", unconfirmed);
    expect(verdict).toMatchObject({ ok: false, reasonCode: "USDT_ONLY_CONTRACT_REQUIRED" });
    // The wording must not accuse it of being something it was never shown to
    // be — it says it could not be CONFIRMED.
    expect((verdict as { detail: string }).detail).toMatch(/did not report/);
  });

  it("H5. preserves normalization, prefixes and de-duplication", () => {
    const result = validateAllowlist("BINANCE:BTCUSDT.P, btcusdt.p\nUSDCUSDT.P;BTCUSDT", index);
    expect(result.accepted).toEqual(["BTCUSDT", "USDCUSDT"]);
    expect(result.counts.duplicates).toBe(2);
  });

  it("H6. still refuses an empty paste rather than saving a wildcard", () => {
    const result = validateAllowlist("   \n  ", index);
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.refusal).not.toBeNull();
  });

  it("H7. keeps the existing leniency for an OMITTED contract type", () => {
    // Unchanged behaviour: the execution gate requires PERPETUAL strictly, so
    // this convenience layer does not need to, and tightening it here would
    // reject rows Binance simply does not annotate.
    const lenient = metadata([filters({ symbol: "BTCUSDT", contractType: null })]);
    expect(judgeSymbolEligibility("BTCUSDT", lenient)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// The pasted examples, as one explicit table
// ---------------------------------------------------------------------------

describe("the operator's pasted examples, classified", () => {
  const index = metadata([
    filters({ symbol: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT" }),
    filters({ symbol: "USDCUSDT", quoteAsset: "USDT", marginAsset: "USDT" }),
    filters({ symbol: "BNBUSDC", quoteAsset: "USDC", marginAsset: "USDC" }),
    filters({ symbol: "SOLUSDC", quoteAsset: "USDC", marginAsset: "USDC" }),
  ]);

  const cases = [
    { paste: "BTCUSDT.P", symbol: "BTCUSDT", accepted: true, reason: null },
    { paste: "USDCUSDT.P", symbol: "USDCUSDT", accepted: true, reason: null },
    // Listed, but authoritatively margined in something else.
    { paste: "BNBUSDC.P", symbol: "BNBUSDC", accepted: false, reason: "USDT_ONLY_CONTRACT_REQUIRED" },
    { paste: "SOLUSDC.P", symbol: "SOLUSDC", accepted: false, reason: "USDT_ONLY_CONTRACT_REQUIRED" },
    // Not present in USDⓈ-M metadata at all — a different rejection entirely.
    { paste: "ETHBTC.P", symbol: "ETHBTC", accepted: false, reason: "NOT_FUTURES_ELIGIBLE" },
    { paste: "ETHUSD1.P", symbol: "ETHUSD1", accepted: false, reason: "NOT_FUTURES_ELIGIBLE" },
    { paste: "BTCU.P", symbol: "BTCU", accepted: false, reason: "NOT_FUTURES_ELIGIBLE" },
  ] as const;

  for (const example of cases) {
    it(`${example.paste} -> ${example.accepted ? "ACCEPT" : `REJECT (${example.reason})`}`, () => {
      const result = validateAllowlist(example.paste, index);
      if (example.accepted) {
        expect(result.accepted).toEqual([example.symbol]);
      } else {
        expect(result.accepted).toEqual([]);
        expect(result.rejected[0]).toMatchObject({ symbol: example.symbol, reasonCode: example.reason });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Structural guarantees
// ---------------------------------------------------------------------------

describe("structural: eligibility is decided before anything is spent", () => {
  const admission = codeOf("src/modules/execution/safety-admission.service.ts");
  const engine = codeOf("src/modules/execution/safety-engine.ts");
  const allowlist = codeOf("src/modules/operator/symbol-allowlist.ts");

  it("S1. the engine decides BEFORE the authorization claim is reached", () => {
    // The ordering this whole fix depends on: the pure engine runs first, and
    // the claim is reached only if it returned PASS. A refactor that moved the
    // claim above the evaluation would spend an authorization on a contract
    // that was never eligible.
    const evaluated = admission.indexOf("evaluateSafetyAdmission({");
    const claimed = admission.indexOf("claimNaturalWindow(");
    expect(evaluated).toBeGreaterThan(-1);
    expect(claimed).toBeGreaterThan(-1);
    expect(evaluated).toBeLessThan(claimed);
  });

  it("S2. the claim is guarded by a PASS decision", () => {
    const claimed = admission.indexOf("claimNaturalWindow(");
    const guard = admission.lastIndexOf('result.decision === "PASS"', claimed);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(claimed);
  });

  it("S3. the capacity reservation is written AFTER the decision, never before", () => {
    // PREFLIGHT is the reservation. It is chosen from the decision, so a
    // non-PASS can never reserve.
    const evaluated = admission.indexOf("evaluateSafetyAdmission({");
    const reserved = admission.indexOf('result.decision === "PASS" ? "PREFLIGHT"');
    expect(reserved).toBeGreaterThan(-1);
    expect(evaluated).toBeLessThan(reserved);
  });

  it("S4. the engine emits the USDT refusal, so a non-USDT contract cannot be PASS", () => {
    expect(engine).toContain("USDT_ONLY_CONTRACT_REQUIRED");
    expect(evaluate(symbolState({ marginAsset: "USDC" })).decision).toBe("SKIP");
  });

  it("S5. NEITHER layer decides eligibility from the ticker's spelling", () => {
    // No suffix test, no substring test, no hardcoded quote-asset list. The
    // only permitted comparison is against metadata the exchange supplied.
    for (const forbidden of ['endsWith("USDT")', 'includes("USDC")', 'endsWith("USDC")', 'includes("USDT")']) {
      expect(`engine ${forbidden}:${engine.includes(forbidden)}`).toBe(`engine ${forbidden}:false`);
      expect(`allowlist ${forbidden}:${allowlist.includes(forbidden)}`).toBe(`allowlist ${forbidden}:false`);
    }
  });

  it("S6. metadata failure has no suffix fallback anywhere in the decision", () => {
    // The dangerous shape is "we could not read it, so judge the name". Both
    // layers derive their assets ONLY from the metadata object.
    expect(engine).toContain("symbolState.quoteAsset");
    expect(engine).toContain("symbolState.marginAsset");
    expect(allowlist).toContain("filters.quoteAsset");
    expect(allowlist).toContain("filters.marginAsset");
    // And an unreadable symbol is refused rather than name-checked.
    expect(evaluate(symbolState({ available: false }), "BTCUSDT").decision).toBe("UNAVAILABLE");
  });

  it("S7. the engine reads no exchange client of its own", () => {
    // It stays pure: metadata arrives as a snapshot, so the rule cannot start
    // making its own calls and cannot be bypassed by mocking a client.
    for (const forbidden of ["BinanceReadOnlyService", "inspectSymbol", "fetch(", "axios"]) {
      expect(`${forbidden}:${engine.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

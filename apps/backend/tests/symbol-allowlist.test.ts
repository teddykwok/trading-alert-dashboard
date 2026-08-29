import { describe, expect, it } from "vitest";

import {
  ALLOWLIST_MAX_ACCEPTED,
  ALLOWLIST_MAX_ENTRIES,
  ALLOWLIST_MAX_INPUT_LENGTH,
  judgeSymbolEligibility,
  parseAllowlistInput,
  previewSymbols,
  summarizeAllowlist,
  validateAllowlist,
  type SymbolMetadataIndex,
} from "../src/modules/operator/symbol-allowlist";
import {
  START_TRADING_DURATION_CHOICES,
  resolveStartTradingDuration,
} from "../src/modules/operator/trading-control-actions.service";
import type { BinanceSymbolFiltersDto } from "../src/modules/binance/binance.types";

/**
 * The operator-managed allowlist, tested as pure logic.
 *
 * The whole point of splitting parsing and eligibility away from the service is
 * that the ~600-symbol paste, the empty-input fail-safe and every rejection
 * category can be proven without a database, an exchange or a running runtime.
 * Nothing in this file touches MAINNET.
 */

function filters(overrides: Partial<BinanceSymbolFiltersDto> = {}): BinanceSymbolFiltersDto {
  return {
    symbol: "BTCUSDT",
    status: "TRADING",
    contractType: "PERPETUAL",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    tickSize: "0.10",
    minPrice: "0.10",
    maxPrice: "1000000",
    stepSize: "0.001",
    minQty: "0.001",
    maxQty: "1000",
    minNotional: "5",
    ...overrides,
  } as BinanceSymbolFiltersDto;
}

/** A metadata index where every named symbol is a healthy perpetual. */
function index(symbols: string[], overrides: Record<string, Partial<BinanceSymbolFiltersDto>> = {}): SymbolMetadataIndex {
  const map = new Map<string, BinanceSymbolFiltersDto>();
  for (const symbol of symbols) map.set(symbol, filters({ symbol, ...(overrides[symbol] ?? {}) }));
  return map;
}

// ---------------------------------------------------------------------------
// 1. Parsing
// ---------------------------------------------------------------------------

describe("allowlist parsing", () => {
  it("accepts a comma-separated paste", () => {
    const result = parseAllowlistInput("FHEUSDT.P,COWUSDT.P,BTCUSDT.P");
    expect(result.symbols).toEqual(["FHEUSDT", "COWUSDT", "BTCUSDT"]);
    expect(result.inputCount).toBe(3);
    expect(result.rejected).toEqual([]);
  });

  it("accepts a newline-separated paste", () => {
    const result = parseAllowlistInput("FHEUSDT.P\nCOWUSDT.P\nBTCUSDT.P");
    expect(result.symbols).toEqual(["FHEUSDT", "COWUSDT", "BTCUSDT"]);
  });

  it("accepts mixed separators, blank lines and stray whitespace", () => {
    const result = parseAllowlistInput("  FHEUSDT.P ,\n\n COWUSDT.P\t;BTCUSDT.P  \n");
    expect(result.symbols).toEqual(["FHEUSDT", "COWUSDT", "BTCUSDT"]);
    expect(result.rejected).toEqual([]);
  });

  it("normalizes case and the TradingView .P suffix through the shared normalizer", () => {
    const result = parseAllowlistInput("fheusdt.p\nBINANCE:COWUSDT.P\nbtcusdt");
    expect(result.symbols).toEqual(["FHEUSDT", "COWUSDT", "BTCUSDT"]);
  });

  it("removes duplicates that differ only in spelling, keeping first-seen order", () => {
    const result = parseAllowlistInput("FHEUSDT.P, fheusdt.p, BINANCE:FHEUSDT.P, BTCUSDT");
    expect(result.symbols).toEqual(["FHEUSDT", "BTCUSDT"]);
    expect(result.duplicateCount).toBe(2);
  });

  it("rejects entries the shared symbol rules refuse", () => {
    const result = parseAllowlistInput("<SYMBOL>\nETH/BTC\nBTC_USDT\nΒΤCUSDT");
    expect(result.symbols).toEqual([]);
    expect(result.rejected.every((entry) => entry.reasonCode === "INVALID_SYNTAX")).toBe(true);
    expect(result.rejected).toHaveLength(4);
  });

  it("rejects a Unicode ticker rather than mangling it", () => {
    // Greek capital letters that render like Latin ones.
    const result = parseAllowlistInput("ΒΤCUSDT");
    expect(result.symbols).toEqual([]);
    expect(result.rejected[0]?.reasonCode).toBe("INVALID_SYNTAX");
  });

  it("handles a ~600 symbol paste in one linear pass", () => {
    const many = Array.from({ length: 600 }, (_, i) => `SYM${String(i).padStart(4, "0")}USDT.P`);
    const result = parseAllowlistInput(many.join("\n"));
    expect(result.inputCount).toBe(600);
    expect(result.symbols).toHaveLength(600);
    expect(result.duplicateCount).toBe(0);
    expect(result.symbols[0]).toBe("SYM0000USDT");
  });

  it("counts duplicates correctly inside a large paste", () => {
    const many = Array.from({ length: 500 }, (_, i) => `SYM${String(i % 250).padStart(4, "0")}USDT`);
    const result = parseAllowlistInput(many.join(","));
    expect(result.symbols).toHaveLength(250);
    expect(result.duplicateCount).toBe(250);
  });

  it("refuses input longer than the accepted body size", () => {
    const result = parseAllowlistInput("A".repeat(ALLOWLIST_MAX_INPUT_LENGTH + 1));
    expect(result.symbols).toEqual([]);
    expect(result.rejected[0]?.reasonCode).toBe("INVALID_SYNTAX");
    expect(result.rejected[0]?.detail).toContain(String(ALLOWLIST_MAX_INPUT_LENGTH));
  });

  it("refuses more entries than the accepted maximum", () => {
    const many = Array.from({ length: ALLOWLIST_MAX_ENTRIES + 1 }, (_, i) => `SYM${i}USDT`);
    const result = parseAllowlistInput(many.join(","));
    expect(result.symbols).toEqual([]);
    expect(result.rejected[0]?.detail).toContain(String(ALLOWLIST_MAX_ENTRIES));
  });
});

// ---------------------------------------------------------------------------
// 2. Eligibility
// ---------------------------------------------------------------------------

describe("allowlist eligibility", () => {
  it("accepts a listed, trading, perpetual symbol with complete filters", () => {
    expect(judgeSymbolEligibility("BTCUSDT", index(["BTCUSDT"]))).toEqual({ ok: true });
  });

  it("refuses a symbol the exchange does not list", () => {
    const verdict = judgeSymbolEligibility("NOPEUSDT", index(["BTCUSDT"]));
    expect(verdict).toMatchObject({ ok: false, reasonCode: "NOT_FUTURES_ELIGIBLE" });
  });

  it("refuses a delisted or halted symbol", () => {
    const verdict = judgeSymbolEligibility("BTCUSDT", index(["BTCUSDT"], { BTCUSDT: { status: "BREAK" } }));
    expect(verdict).toMatchObject({ ok: false, reasonCode: "NOT_TRADABLE" });
  });

  it("refuses a non-perpetual contract", () => {
    const verdict = judgeSymbolEligibility(
      "BTCUSDT",
      index(["BTCUSDT"], { BTCUSDT: { contractType: "CURRENT_QUARTER" } })
    );
    expect(verdict).toMatchObject({ ok: false, reasonCode: "UNSUPPORTED_CONTRACT" });
  });

  it("refuses a symbol the planner could not size", () => {
    for (const field of ["tickSize", "stepSize", "minQty", "minNotional"] as const) {
      const verdict = judgeSymbolEligibility(
        "BTCUSDT",
        index(["BTCUSDT"], { BTCUSDT: { [field]: null } as Partial<BinanceSymbolFiltersDto> })
      );
      expect(`${field}:${verdict.ok}`).toBe(`${field}:false`);
      expect((verdict as { reasonCode: string }).reasonCode).toBe("NOT_EXECUTION_ENGINE_SUPPORTED");
    }
  });

  it("accepts a row whose contractType the exchange omitted", () => {
    const verdict = judgeSymbolEligibility("BTCUSDT", index(["BTCUSDT"], { BTCUSDT: { contractType: null } }));
    expect(verdict).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 3. The whole verdict, including the empty fail-safe
// ---------------------------------------------------------------------------

describe("allowlist validation", () => {
  const metadata = index(["FHEUSDT", "BTCUSDT", "ETHUSDT", "COWUSDT"]);

  it("reports counts the operator can reconcile with their paste", () => {
    const result = validateAllowlist("FHEUSDT.P, fheusdt.p, BTCUSDT, NOPEUSDT, <SYMBOL>", metadata);
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["FHEUSDT", "BTCUSDT"]);
    expect(result.counts).toEqual({ input: 5, normalized: 4, valid: 2, duplicates: 1, rejected: 2 });
  });

  it("REFUSES empty input rather than saving an unrestricted allowlist", () => {
    const result = validateAllowlist("", metadata);
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.refusal).toContain("ALL symbols");
  });

  it("REFUSES whitespace-only input", () => {
    for (const raw of ["   ", "\n\n", "\t", " ,\n, ;"]) {
      const result = validateAllowlist(raw, metadata);
      expect(`${JSON.stringify(raw)}:${result.ok}`).toBe(`${JSON.stringify(raw)}:false`);
    }
  });

  it("REFUSES a paste where every entry failed", () => {
    const result = validateAllowlist("<SYMBOL>\nNOPEUSDT\nETH/BTC", metadata);
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.refusal).toContain("ALL symbols");
  });

  it("never returns ok with an empty accepted list", () => {
    for (const raw of ["", " ", "\n", "<SYMBOL>", "NOPEUSDT"]) {
      const result = validateAllowlist(raw, metadata);
      expect(`${JSON.stringify(raw)}:${result.ok && result.accepted.length === 0}`).toBe(
        `${JSON.stringify(raw)}:false`
      );
    }
  });

  it("refuses more accepted symbols than the reviewed ceiling", () => {
    const symbols = Array.from({ length: ALLOWLIST_MAX_ACCEPTED + 1 }, (_, i) => `SYM${String(i).padStart(4, "0")}USDT`);
    const result = validateAllowlist(symbols.join(","), index(symbols));
    expect(result.ok).toBe(false);
    expect(result.refusal).toContain(String(ALLOWLIST_MAX_ACCEPTED));
  });

  it("keeps rejected entries out of the accepted list entirely", () => {
    const result = validateAllowlist("FHEUSDT, NOPEUSDT, <SYMBOL>", metadata);
    expect(result.accepted).not.toContain("NOPEUSDT");
    expect(result.accepted).not.toContain("<SYMBOL>");
    expect(result.rejected.map((entry) => entry.reasonCode).sort()).toEqual([
      "INVALID_SYNTAX",
      "NOT_FUTURES_ELIGIBLE",
    ]);
  });

  it("summarizes with counts only, never per-symbol lines", () => {
    const many = Array.from({ length: 600 }, (_, i) => `SYM${String(i).padStart(4, "0")}USDT`);
    const summary = summarizeAllowlist(validateAllowlist(many.join(","), index(many)));
    expect(summary).toBe("input=600 normalized=600 valid=600 duplicates=0 rejected=0");
    expect(summary.split("\n")).toHaveLength(1);
    expect(summary).not.toContain("SYM0000USDT");
  });

  it("previews a large list concisely and a small one in full", () => {
    expect(previewSymbols(["BTCUSDT", "ETHUSDT"])).toBe("BTCUSDT, ETHUSDT");
    const many = Array.from({ length: 428 }, (_, i) => `SYM${i}`);
    const preview = previewSymbols(many);
    expect(preview).toContain("+422 more");
    expect(preview.length).toBeLessThan(120);
    expect(previewSymbols([])).toBe("(none)");
  });
});

// ---------------------------------------------------------------------------
// 4. FHE regression against the durable rule
// ---------------------------------------------------------------------------

describe("allowlist: the FHE commissioning list", () => {
  it("produces exactly ['FHEUSDT'] from a TradingView paste", () => {
    const result = validateAllowlist("FHEUSDT.P", index(["FHEUSDT"]));
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(["FHEUSDT"]);
  });

  it("does not silently widen to other symbols", () => {
    const result = validateAllowlist("FHEUSDT.P", index(["FHEUSDT", "COWUSDT", "BTCUSDT"]));
    expect(result.accepted).toEqual(["FHEUSDT"]);
    expect(result.accepted).not.toContain("COWUSDT");
    expect(result.accepted).not.toContain("BTCUSDT");
  });
});

// ---------------------------------------------------------------------------
// 5. Supervised duration
// ---------------------------------------------------------------------------

describe("start trading: supervised duration", () => {
  it("offers the session durations: 1h, 6h, 12h and 24h", () => {
    // Was 15/30/60. The presets are now session lengths, and the set is no
    // longer exhaustive — a CUSTOM duration is accepted too. What keeps that
    // safe is that presets and custom values run through the SAME validator,
    // so a preset is a convenience rather than a second code path.
    expect([...START_TRADING_DURATION_CHOICES]).toEqual([60, 360, 720, 1440]);
  });

  it("accepts each reviewed choice", () => {
    for (const minutes of START_TRADING_DURATION_CHOICES) {
      expect(resolveStartTradingDuration(minutes)).toEqual({ ok: true, minutes });
    }
  });

  it("defaults to 60 minutes when nothing is supplied", () => {
    expect(resolveStartTradingDuration(undefined)).toEqual({ ok: true, minutes: 60 });
  });

  it("ACCEPTS a custom duration inside the 24-hour ceiling", () => {
    // The deliberate change: 45 and 90 used to be refused for not being one of
    // three reviewed lengths. A custom duration is now a feature, bounded by
    // the ceiling rather than by an enumeration.
    for (const value of [1, 45, 90, 1439, 1440]) {
      expect(`${value}:${resolveStartTradingDuration(value).ok}`).toBe(`${value}:true`);
    }
  });

  it("REFUSES a duration past the 24-hour ceiling, or a malformed one", () => {
    // Beyond 24 hours is a separate policy decision, not a larger number.
    for (const value of [0, -15, 1441, 2880, 15.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = resolveStartTradingDuration(value);
      expect(`${String(value)}:${verdict.ok}`).toBe(`${String(value)}:false`);
    }
  });

  it("REFUSES a non-number, including a numeric string", () => {
    for (const value of ["60", "", null, {}, [], true, () => 60]) {
      const verdict = resolveStartTradingDuration(value);
      expect(`${typeof value}:${verdict.ok}`).toBe(`${typeof value}:false`);
    }
  });

  it("never offers a duration above the reviewed maximum", () => {
    expect(Math.max(...START_TRADING_DURATION_CHOICES)).toBe(24 * 60);
  });
});

import {
  EXTREME_RR_LOOKBACKS,
  formatDynamicPrice,
  type ExtremeRRCandidate,
  type ExtremeRRLeverage,
  type ExtremeRRPlanDto,
} from "@trading-alert-dashboard/shared";
import { env } from "../../config/env";

/**
 * Concise Extreme RR Telegram messages. Pure formatting only:
 * - built exclusively from the FROZEN plan DTO — never fetches market data,
 *   never recalculates candidates, never writes selections;
 * - plain text (the repo's Telegram convention: no parse_mode, so no dynamic
 *   value can break delivery and nothing needs escaping);
 * - execution info first (direction, leverage, entry, SL, TP, notional);
 *   deliberately NO AI summary/confidence/risk notes, no candle timestamps,
 *   no calculation details, no account balance.
 */

/** Display-only price formatting; the Number() conversion never feeds math. */
function px(value: string | null): string {
  if (value === null || value === "") return "—";
  return formatDynamicPrice(Number(value));
}

/** USD money display, always two decimals ("$8.77"). Display only. */
function usd(value: string): string {
  return `$${Number(value).toFixed(2)}`;
}

function alertUrl(alertId: string): string {
  // PUBLIC_DASHBOARD_URL (not FRONTEND_URL) so the link works from a phone.
  return `${env.PUBLIC_DASHBOARD_URL.replace(/\/$/, "")}/alerts/${alertId}`;
}

function heading(direction: "LONG" | "SHORT", symbol: string): string {
  return `${direction === "LONG" ? "🟢" : "🔴"} ${direction} — ${symbol}`;
}

/**
 * The candidate whose values headline the message: the persisted selected
 * lookback. If that specific candidate is invalid while the plan is READY
 * (some other lookback is valid), fall back to the largest valid candidate so
 * the headline never shows invented prices — the alternatives section still
 * truthfully marks the selected lookback as invalid.
 */
export function resolveMainCandidate(plan: ExtremeRRPlanDto): ExtremeRRCandidate | null {
  const selected = plan.candidates.find((c) => c.requestedCandles === plan.selectedLookback);
  if (selected?.valid && selected.money) return selected;

  const fallback = [...plan.candidates]
    .filter((c) => c.valid && c.money)
    .sort((a, b) => b.requestedCandles - a.requestedCandles)[0];
  return fallback ?? null;
}

export interface LeverageChoice {
  leverage: ExtremeRRLeverage;
  estimatedMargin: string;
  /** "selected" = persisted on the plan; "recommended" = inside the preferred
   *  band (lowest matching leverage); "suggested" = closest to the band
   *  midpoint when nothing lands inside. Presentation only — never persisted. */
  kind: "selected" | "recommended" | "suggested";
}

/**
 * Leverage line algorithm (presentation only, never written back):
 * 1. persisted valid selectedLeverage wins;
 * 2. otherwise the LOWEST preset whose estimated isolated margin falls inside
 *    the configured preferred band (largest margin while inside the band);
 * 3. otherwise the preset closest to the band midpoint, labelled SUGGESTED.
 * Leverage never changes quantity, notional, SL, TP or planned PnL — only the
 * estimated margin differs between presets.
 */
export function resolveLeverageChoice(
  plan: ExtremeRRPlanDto,
  candidate: ExtremeRRCandidate
): LeverageChoice | null {
  if (!candidate.money) return null;
  const { options, closestToPreferred } = candidate.money.leverage;

  if (plan.selectedLeverage !== null) {
    const selected = options.find((option) => option.leverage === plan.selectedLeverage);
    if (selected) {
      return { leverage: selected.leverage, estimatedMargin: selected.estimatedInitialMargin, kind: "selected" };
    }
  }

  // Options are in ascending preset order; margin shrinks as leverage grows,
  // so the first preferred option is the lowest leverage / largest margin.
  const preferred = options.find((option) => option.preferred);
  if (preferred) {
    return { leverage: preferred.leverage, estimatedMargin: preferred.estimatedInitialMargin, kind: "recommended" };
  }

  const closest = options.find((option) => option.leverage === closestToPreferred) ?? options[0];
  return closest
    ? { leverage: closest.leverage, estimatedMargin: closest.estimatedInitialMargin, kind: "suggested" }
    : null;
}

function leverageLine(choice: LeverageChoice): string {
  const margin = `Estimated isolated margin: ${usd(choice.estimatedMargin)}`;
  switch (choice.kind) {
    case "selected":
      return `LEVERAGE: ${choice.leverage}x selected · ${margin}`;
    case "recommended":
      return `LEVERAGE: ${choice.leverage}x · ${margin}`;
    case "suggested":
      return `SUGGESTED LEVERAGE: ${choice.leverage}x · ${margin}`;
  }
}

/** One truthful line per saved lookback candidate — never invented prices. */
export function lookbackLine(plan: ExtremeRRPlanDto, lookback: number): string {
  const candidate = plan.candidates.find((c) => c.requestedCandles === lookback);
  const selectedMarker = plan.selectedLookback === lookback ? " ← Selected" : "";

  if (!candidate) return `${lookback}c → Unavailable${selectedMarker}`;

  if (candidate.valid && candidate.takeProfit && candidate.stopLoss) {
    const incomplete = candidate.complete ? "" : ` (${candidate.actualCandles}/${candidate.requestedCandles})`;
    return `${lookback}c → TP ${px(candidate.takeProfit)} · SL ${px(candidate.stopLoss)}${incomplete}${selectedMarker}`;
  }

  if (candidate.actualCandles === 0) {
    return `${lookback}c → Insufficient candles (0/${candidate.requestedCandles})${selectedMarker}`;
  }
  if (!candidate.complete && candidate.invalidReason?.includes("candles")) {
    return `${lookback}c → Insufficient candles (${candidate.actualCandles}/${candidate.requestedCandles})${selectedMarker}`;
  }
  return `${lookback}c → Invalid target${selectedMarker}`;
}

/** Concise READY trade-plan message. Execution information first. */
export function buildExtremeRRReadyMessage(plan: ExtremeRRPlanDto, symbol: string): string | null {
  const candidate = resolveMainCandidate(plan);
  if (plan.status !== "READY" || !candidate || !candidate.money) return null;

  const choice = resolveLeverageChoice(plan, candidate);

  const lines = [
    heading(plan.direction, symbol),
    ...(choice ? [leverageLine(choice)] : []),
    `Entry: ${px(plan.entryPrice)}`,
    `Stop-loss: ${px(candidate.stopLoss)}`,
    `Take-profit: ${px(candidate.takeProfit)}`,
    `Position notional: ${usd(candidate.money.positionNotionalRaw)}`,
    "",
    "LOOKBACK ALTERNATIVES",
    ...EXTREME_RR_LOOKBACKS.map((lookback) => lookbackLine(plan, lookback)),
    "",
    // No verified symbol leverage-limit source exists — keep the one-line
    // reminder near the bottom, never above the execution block.
    "Verify leverage support on Binance.",
    "",
    "Open Trade Plan:",
    alertUrl(plan.alertId),
  ];

  return lines.join("\n");
}

/** Trims any internal detail out of reasons shown in Telegram. */
function safeReason(reason: string | null, fallback: string): string {
  if (!reason) return fallback;
  // One line, bounded length, no stack traces.
  return reason.split("\n")[0].slice(0, 180);
}

export function buildExtremeRRInvalidMessage(plan: ExtremeRRPlanDto, symbol: string): string {
  const selected = plan.candidates.find((c) => c.requestedCandles === plan.selectedLookback);
  const reason = safeReason(
    selected?.invalidReason ?? plan.candidates.find((c) => c.invalidReason)?.invalidReason ?? null,
    "No valid Extreme RR target in the frozen lookbacks."
  );

  return [
    `⚠️ PLAN INVALID — ${symbol}`,
    `Direction: ${plan.direction}`,
    `Reason: ${reason}`,
    "",
    "Open Alert:",
    alertUrl(plan.alertId),
  ].join("\n");
}

export function buildExtremeRRErrorMessage(plan: ExtremeRRPlanDto, symbol: string): string {
  return [
    `❌ PLAN ERROR — ${symbol}`,
    `Direction: ${plan.direction}`,
    "Reason: Unable to generate the frozen Extreme RR plan.",
    "",
    "Open Alert:",
    alertUrl(plan.alertId),
  ].join("\n");
}

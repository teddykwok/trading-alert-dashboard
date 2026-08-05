import {
  EXTREME_RR_LOOKBACKS,
  formatDynamicPrice,
  type AlertContext,
  type ExtremeRRCandidate,
  type ExtremeRRLeverage,
  type ExtremeRRPlanDto,
  type TouchDirection,
} from "@trading-alert-dashboard/shared";
import { publicAlertUrl } from "../../utils/dashboard-url";

/**
 * The alert-side context a message needs. All fields come from the
 * authoritative persisted alert (see notification.service.ts, which fills
 * `levelContext` from the shared level-context builder) — nothing here is
 * parsed a second time, derived, or guessed.
 */
export interface AlertMessageContext {
  symbol: string;
  /** Persisted Alert.exchange. Null/absent when unknown — never invented. */
  exchange?: string | null;
  /** Persisted Alert.timeframe: the CHART timeframe, never the level's sourceTf. */
  timeframe?: string | null;
  /** Frozen level context, or null for legacy alerts / other indicators. */
  levelContext?: AlertContext | null;
}

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

/**
 * Trailing link section, or nothing at all when no public dashboard URL is
 * configured (PUBLIC_DASHBOARD_URL unset/empty/loopback). Returning an empty
 * array keeps the message free of dangling blank lines.
 */
function linkSection(label: string, alertId: string): string[] {
  const url = publicAlertUrl(alertId);
  return url === null ? [] : ["", label, url];
}

function heading(direction: "LONG" | "SHORT", symbol: string): string {
  return `${direction === "LONG" ? "🟢" : "🔴"} ${direction} — ${symbol}`;
}

/** UNKNOWN maps to null: an unknown direction is omitted, never displayed. */
const TOUCH_DIRECTION_LABELS: Record<TouchDirection, string | null> = {
  FROM_ABOVE: "From above",
  FROM_BELOW: "From below",
  UNKNOWN: null,
};

/**
 * "Exchange: BINANCE · Chart: 15m" — each half is included only when the
 * stored value exists, so a missing exchange yields "Chart: 15m" rather than
 * a dangling separator or an invented venue. Values are shown exactly as
 * stored (there is no display-normalization convention in this repo, and the
 * stored value must not be altered).
 */
function exchangeChartLine(context: AlertMessageContext): string | null {
  const parts: string[] = [];
  const exchange = context.exchange?.trim();
  const timeframe = context.timeframe?.trim();

  if (exchange) parts.push(`Exchange: ${exchange}`);
  if (timeframe) parts.push(`Chart: ${timeframe}`);

  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * "Level: 1W GREEN · From above" from the FROZEN level context. The level's
 * own timeframe and colour are the minimum reliable pair; without both the
 * whole line is omitted (never "Unknown"/"N/A", never inferred from
 * LONG/SHORT). A known touch direction is appended when present.
 */
function levelLine(context: AlertMessageContext): string | null {
  const level = context.levelContext;
  if (!level || !level.sourceTimeframe || !level.levelColor) return null;

  const direction = level.touchDirection ? TOUCH_DIRECTION_LABELS[level.touchDirection] : null;
  const base = `Level: ${level.sourceTimeframe} ${level.levelColor}`;
  return direction ? `${base} · ${direction}` : base;
}

/**
 * The two context lines, preceded by a blank separator. Returns an empty
 * array when neither line has content, so the message never grows a stray
 * blank line.
 */
function contextSection(context: AlertMessageContext): string[] {
  const lines = [exchangeChartLine(context), levelLine(context)].filter(
    (line): line is string => line !== null
  );
  return lines.length > 0 ? ["", ...lines] : [];
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
export function buildExtremeRRReadyMessage(
  plan: ExtremeRRPlanDto,
  context: AlertMessageContext
): string | null {
  const candidate = resolveMainCandidate(plan);
  if (plan.status !== "READY" || !candidate || !candidate.money) return null;

  const choice = resolveLeverageChoice(plan, candidate);

  const lines = [
    heading(plan.direction, context.symbol),
    ...(choice ? [leverageLine(choice)] : []),
    `Entry: ${px(plan.entryPrice)}`,
    `Stop-loss: ${px(candidate.stopLoss)}`,
    `Take-profit: ${px(candidate.takeProfit)}`,
    `Position notional: ${usd(candidate.money.positionNotionalRaw)}`,
    "",
    "LOOKBACK ALTERNATIVES",
    ...EXTREME_RR_LOOKBACKS.map((lookback) => lookbackLine(plan, lookback)),
    // Context sits below the execution block and above the warning/link.
    ...contextSection(context),
    "",
    // No verified symbol leverage-limit source exists — keep the one-line
    // reminder near the bottom, never above the execution block.
    "Verify leverage support on Binance.",
    ...linkSection("Open Trade Plan:", plan.alertId),
  ];

  return lines.join("\n");
}

/** Trims any internal detail out of reasons shown in Telegram. */
function safeReason(reason: string | null, fallback: string): string {
  if (!reason) return fallback;
  // One line, bounded length, no stack traces.
  return reason.split("\n")[0].slice(0, 180);
}

export function buildExtremeRRInvalidMessage(
  plan: ExtremeRRPlanDto,
  context: AlertMessageContext
): string {
  const selected = plan.candidates.find((c) => c.requestedCandles === plan.selectedLookback);
  const reason = safeReason(
    selected?.invalidReason ?? plan.candidates.find((c) => c.invalidReason)?.invalidReason ?? null,
    "No valid Extreme RR target in the frozen lookbacks."
  );

  return [
    `⚠️ PLAN INVALID — ${context.symbol}`,
    `Direction: ${plan.direction}`,
    `Reason: ${reason}`,
    ...linkSection("Open Alert:", plan.alertId),
  ].join("\n");
}

export function buildExtremeRRErrorMessage(
  plan: ExtremeRRPlanDto,
  context: AlertMessageContext
): string {
  return [
    `❌ PLAN ERROR — ${context.symbol}`,
    `Direction: ${plan.direction}`,
    "Reason: Unable to generate the frozen Extreme RR plan.",
    ...linkSection("Open Alert:", plan.alertId),
  ].join("\n");
}

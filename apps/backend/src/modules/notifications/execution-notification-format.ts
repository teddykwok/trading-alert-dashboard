import { Prisma } from "@prisma/client";
import type { NotificationPayload } from "./execution-notification";

/**
 * Phase 9 — central execution-notification formatter.
 *
 * Plain text only. That is the repository-wide Telegram convention (see
 * telegram.service.ts): no parse_mode is ever sent, so Markdown/HTML control
 * characters in a symbol, a reason code or an operator message cannot break
 * the parser and cannot cause a silent delivery failure. There is therefore no
 * escaping scheme to keep correct — the safety property is achieved by not
 * enabling markup at all. Every dynamic field is still bounded and stripped of
 * control characters so a stray newline cannot forge extra message lines.
 *
 * Never rendered: bot token, chat id, API key or secret, account identifier,
 * account or wallet balance, client order id, exchange order id, raw Telegram
 * or Binance payloads, stack traces.
 */

const D = Prisma.Decimal;

export const NOT_AVAILABLE = "Not available";

/** Longest a single dynamic free-text field may be in a message. */
const MAX_TEXT_FIELD = 160;

/** ASCII control characters, including the newlines used for line structure. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/g;

/**
 * Exact value, normalized. Trailing zeros are dropped ("0.27070000" ->
 * "0.2707"), which is a lossless rewrite — no rounding and no truncation, so
 * the number a reader sees is the number that is persisted. A value that
 * cannot be parsed is shown verbatim rather than silently replaced.
 */
export function exactDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  try {
    const parsed = new D(value);
    return parsed.isFinite() ? parsed.toFixed() : String(value);
  } catch {
    return String(value);
  }
}

/**
 * USD amount. Keeps the sign — a negative realized PnL or a paid funding cost
 * stays negative, and is never rendered as a positive number or as zero.
 */
export function exactMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  const text = exactDecimal(value);
  if (text === NOT_AVAILABLE) return NOT_AVAILABLE;
  return text.startsWith("-") ? `-$${text.slice(1)}` : `$${text}`;
}

/**
 * One bounded, single-line field. Control characters (including newlines) are
 * collapsed to spaces so a reason code or operator message cannot inject extra
 * lines that look like part of the message structure, and the result is length-
 * capped so no single field can push a stack-trace-sized blob into Telegram.
 */
export function safeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const flattened = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (flattened === "") return null;
  return flattened.length > MAX_TEXT_FIELD ? `${flattened.slice(0, MAX_TEXT_FIELD - 1)}…` : flattened;
}

function headline(payload: NotificationPayload): string {
  return `${safeText(payload.symbol) ?? "?"} · ${safeText(payload.direction) ?? "?"}`;
}

/**
 * The financial block shared by every closure message. Each line is present
 * always, so an unknown value reads as an explicit "Not available" rather than
 * disappearing and leaving the reader to assume zero.
 */
function financialLines(payload: NotificationPayload): string[] {
  return [
    `Exit: ${exactDecimal(payload.exitPrice)}`,
    `Realized PnL: ${exactMoney(payload.realizedPnl)}`,
    `Fees: ${exactMoney(payload.tradingFeesUsd)}`,
    `Funding: ${exactMoney(payload.fundingPnlUsd)}`,
    // Only ever set when realized PnL, fees and funding are all known.
    `Net PnL: ${exactMoney(payload.netPnlUsd)}`,
  ];
}

/**
 * Renders one informational milestone.
 *
 * `reference` is the first bytes of the durable dedupe key. Telegram offers no
 * exactly-once guarantee, so a rare redelivery is possible; an identical
 * reference makes a duplicate message recognisable as the SAME milestone rather
 * than a second fill or a second closure.
 */
export function formatExecutionNotification(payload: NotificationPayload, reference: string): string {
  const lines: string[] = [];

  switch (payload.type) {
    case "LIMIT_PLACED":
      lines.push(
        "🟦 LIMIT PLACED",
        "",
        headline(payload),
        `Entry: ${exactDecimal(payload.plannedEntryPrice)}`,
        `Quantity: ${exactDecimal(payload.plannedQuantity)}`,
        `Leverage: ${payload.selectedLeverage ?? "?"}x`,
        `Risk: ${exactMoney(payload.riskBudgetUsd)}`
      );
      break;

    case "PARTIAL_FILL":
      lines.push(
        "🟨 PARTIAL FILL",
        "",
        headline(payload),
        `Filled: ${exactDecimal(payload.filledQuantity)} / ${exactDecimal(payload.plannedQuantity)}`,
        // Never 0 when the average is unknown.
        `Average: ${exactDecimal(payload.averageFillPrice)}`
      );
      break;

    case "POSITION_FILLED":
      lines.push(
        "🟩 POSITION FILLED",
        "",
        headline(payload),
        `Filled: ${exactDecimal(payload.filledQuantity)} / ${exactDecimal(payload.plannedQuantity)}`,
        `Average: ${exactDecimal(payload.averageFillPrice)}`,
        "",
        // Filled is not protected: protection is a separate verified milestone.
        "Protection verification in progress."
      );
      break;

    case "POSITION_PROTECTED":
      lines.push(
        "🛡 POSITION PROTECTED",
        "",
        headline(payload),
        `Protected quantity: ${exactDecimal(payload.protectedQuantity)}`,
        `SL: ${exactDecimal(payload.stopPrice)}`,
        `TP: ${exactDecimal(payload.takeProfitPrice)}`,
        "",
        "STOP and TAKE PROFIT coverage verified."
      );
      break;

    case "ENTRY_EXPIRED":
      lines.push("⌛ ENTRY EXPIRED", "", headline(payload), "No live exposure remains.");
      break;

    case "CLOSED_TP":
      lines.push("✅ CLOSED — TAKE PROFIT", "", headline(payload), ...financialLines(payload));
      break;

    case "CLOSED_SL":
      lines.push("🛑 CLOSED — STOP LOSS", "", headline(payload), ...financialLines(payload));
      break;

    case "CLOSED_EMERGENCY":
      lines.push(
        // Deliberately never presented as a take profit or a stop loss.
        "🚨 CLOSED — EMERGENCY",
        "",
        headline(payload),
        "Position closure verified.",
        `Realized PnL: ${exactMoney(payload.realizedPnl)}`,
        `Fees: ${exactMoney(payload.tradingFeesUsd)}`,
        `Funding: ${exactMoney(payload.fundingPnlUsd)}`,
        `Net PnL: ${exactMoney(payload.netPnlUsd)}`
      );
      break;

    case "TRADE_SKIPPED": {
      const explanation = safeText(payload.explanation);
      lines.push(
        "⏭ TRADE SKIPPED",
        "",
        headline(payload),
        `Reason: ${safeText(payload.reasonCode) ?? NOT_AVAILABLE}`,
        ...(explanation ? [explanation] : [])
      );
      break;
    }
  }

  lines.push("", `Ref: ${reference}`);
  return lines.join("\n");
}

/** The sanitized Phase 7 critical-alert fields a message may show. */
export interface CriticalNotificationInput {
  symbol: string | null;
  positionSide: string | null;
  confirmedOpenQuantity: string | null;
  protectedStopQuantity: string | null;
  reasonCode: string;
  requiredAction: string | null;
}

/**
 * Renders a Phase 7 CriticalAlert. The alert row itself remains authoritative
 * and unmodified — this only decides how its already-sanitized content is
 * presented.
 */
export function formatCriticalNotification(input: CriticalNotificationInput, reference: string): string {
  const symbol = safeText(input.symbol) ?? "?";
  const side = safeText(input.positionSide);
  return [
    "🚨 CRITICAL — PROTECTION FAILURE",
    "",
    side ? `${symbol} · ${side}` : symbol,
    `Exposure: ${exactDecimal(input.confirmedOpenQuantity)}`,
    `Stop protected: ${exactDecimal(input.protectedStopQuantity)}`,
    `Reason: ${safeText(input.reasonCode) ?? NOT_AVAILABLE}`,
    ...(safeText(input.requiredAction) ? [`Action: ${safeText(input.requiredAction)}`] : []),
    "",
    "Manual intervention may be required.",
    "",
    `Ref: ${reference}`,
  ].join("\n");
}

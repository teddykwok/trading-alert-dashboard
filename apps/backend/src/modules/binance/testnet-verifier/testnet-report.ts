import { sanitizeBinanceText } from "../binance.errors";
import type { ProbeReport, VerifierRunReport } from "./testnet-verifier";

/**
 * Sanitized console output.
 *
 * Every line is built from field NAMES and already-narrowed values. No signed
 * URL, query string, signature, API key or secret is ever in scope here — the
 * report types carry none — and `sanitizeBinanceText` is applied as a last
 * line of defence to any free-form text that came from an exchange message.
 */

/** Belt and braces: nothing shaped like a credential may reach stdout. */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /signature=/i,
  /X-MBX-APIKEY/i,
  /[?&]timestamp=\d+/i,
  /[?&]recvWindow=/i,
];

export function assertSanitized(lines: readonly string[]): void {
  for (const line of lines) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        throw new Error(`Refusing to print a report line that looks like signed request material: ${pattern}`);
      }
    }
  }
}

function flag(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "true" : "false";
}

/** UNREADABLE is rendered explicitly — it is never shown as 0. */
function count(value: number | null): string {
  return value === null ? "UNREADABLE" : String(value);
}

export function formatProbeReport(probe: ProbeReport, context: { host: string; symbol: string; runId: string }): string[] {
  return [
    "",
    "Binance USDⓈ-M TESTNET protection verifier — capability probe",
    `  host                            ${context.host}`,
    `  symbol                          ${context.symbol}`,
    `  runId                           ${context.runId}`,
    "",
    `  TESTNET_HOST_VERIFIED           ${flag(probe.TESTNET_HOST_VERIFIED)}`,
    `  TESTNET_CREDENTIALS_WORK        ${flag(probe.TESTNET_CREDENTIALS_WORK)}`,
    `  HEDGE_MODE                      ${flag(probe.HEDGE_MODE)}`,
    `  BASELINE_POSITION_FLAT          ${flag(probe.BASELINE_POSITION_FLAT)}`,
    `  BASELINE_LONG_POSITION          ${probe.baseline.longPosition}`,
    `  BASELINE_SHORT_POSITION         ${probe.baseline.shortPosition}`,
    `  BASELINE_STANDARD_OPEN_ORDERS   ${count(probe.BASELINE_STANDARD_OPEN_ORDERS)}`,
    `  BASELINE_ALGO_OPEN_ORDERS       ${count(probe.BASELINE_ALGO_OPEN_ORDERS)}`,
    `  BASELINE_CLEAN                  ${flag(probe.BASELINE_CLEAN)}`,
    `  MARK_PRICE_AVAILABLE            ${flag(probe.MARK_PRICE_AVAILABLE)}`,
    `  EXCHANGE_FILTERS_AVAILABLE      ${flag(probe.EXCHANGE_FILTERS_AVAILABLE)}`,
    `  ALGO_QUERY_ENDPOINT_SUPPORTED   ${flag(probe.ALGO_QUERY_ENDPOINT_SUPPORTED)}`,
    `  PRODUCTION_QUERY_FORM_ACCEPTED  ${flag(probe.PRODUCTION_QUERY_FORM_ACCEPTED)}`,
    `  DOCUMENTED_QUERY_FORM_ACCEPTED  ${flag(probe.DOCUMENTED_QUERY_FORM_ACCEPTED)}`,
    "",
    `  detail  ${sanitizeBinanceText(probe.detail)}`,
  ];
}

export function formatRunReport(report: VerifierRunReport): string[] {
  const lines: string[] = [
    ...formatProbeReport(report.probe, { host: report.origin, symbol: report.symbol, runId: report.runId }),
    "",
    `  resumed from phase              ${report.resumedFromPhase ?? "— (fresh run)"}`,
    "",
    "entry",
    `  clientOrderId                   ${report.entry?.clientOrderId ?? "—"}`,
    `  status                          ${report.entry?.status ?? "—"}`,
    `  actualQuantity                  ${report.entry?.actualQuantity ?? "—"}`,
  ];

  // Per-identity diagnostics. These exist because the first real demo run
  // reported "both query forms accepted, status null", which a reader could
  // not tell apart from "the order was confirmed absent". Every field below
  // is a field NAME or a normalized value — never a payload.
  for (const [label, observation] of [
    ["stop", report.stop],
    ["takeProfit", report.takeProfit],
  ] as const) {
    lines.push(
      "",
      label,
      `  clientAlgoId                    ${observation?.clientId ?? "—"}`,
      `  outcome                         ${observation?.outcome ?? "—"}`,
      `  identityFound                   ${flag(observation?.identityFound ?? null)}`,
      `  rawStatusPresent                ${flag(observation?.rawStatusPresent ?? null)}`,
      `  normalizedStatus                ${observation?.normalizedStatus ?? "—"}`,
      `  orderType                       ${observation?.orderType ?? "—"}`,
      `  positionSide                    ${observation?.positionSide ?? "—"}`,
      `  symbol                          ${observation?.symbol ?? "—"}`,
      `  productionQueryForm             ${observation?.productionQueryForm ?? "—"}`,
      `  documentedQueryForm             ${observation?.documentedQueryForm ?? "—"}`,
      `  confirmedActive                 ${flag(observation?.confirmedActive ?? null)}`,
      `  confirmationReason              ${sanitizeBinanceText(observation?.confirmationReason ?? "—")}`
    );
  }

  lines.push("", "cancel reconciliation");
  for (const [label, reconciliation] of [
    ["stop", report.cancel?.stop],
    ["takeProfit", report.cancel?.takeProfit],
  ] as const) {
    lines.push(
      `  ${label}`,
      `    accepted                      ${flag(reconciliation?.accepted ?? null)}`,
      `    production form result        ${reconciliation?.productionFormResult ?? "—"}`,
      `    query attempts                ${reconciliation?.queryAttempts ?? "—"}`,
      `    final outcome                 ${reconciliation?.finalOutcome ?? "—"}`,
      `    final status                  ${reconciliation?.finalStatus ?? "—"}`,
      `    resolved                      ${flag(reconciliation?.resolved ?? null)}`
    );
  }

  lines.push(
    `  documented rescue required      ${flag(report.cancel ? report.cancel.rescueUsed : null)}`,
    "",
    "cleanup",
    `  entry remainder resolved        ${flag(report.cleanup?.entryRemainderResolved ?? null)}`,
    `  stop resolved                   ${flag(report.cleanup?.stopResolved ?? null)}`,
    `  takeProfit resolved             ${flag(report.cleanup?.takeProfitResolved ?? null)}`,
    `  position flat (proven)          ${flag(report.cleanup?.positionFlat ?? null)}`,
    `  cleanup fully proven            ${flag(report.cleanup?.proven ?? null)}`,
    `  state file retained             ${flag(report.stateRetained)}`,
    ""
  );

  for (const failure of report.failures) lines.push(`  ! ${sanitizeBinanceText(failure)}`);
  lines.push("", `FINAL: ${report.verdict}`, "");

  assertSanitized(lines);
  return lines;
}

import { SIGNAL_QUALITY_HORIZONS, SIGNAL_QUALITY_POLICY, type SignalQualityRowDto, type SignalQualitySampleDto, type SignalQualityWindowDto } from "@trading-alert-dashboard/shared";

/**
 * READ-ONLY export of evaluated signal-quality rows (the currently filtered
 * set). Pure. It carries the canonical identifiers, the persisted evidence,
 * the existing selected plan and the observed outcome, and nothing else: no
 * secret, credential, account, order, token or execution capability exists in
 * a row to export.
 */

type Cell = string | number | boolean | null;

const COLUMNS: readonly [string, (row: SignalQualityRowDto) => Cell][] = [
  ["alertId", (r) => r.alertId],
  ["symbol", (r) => r.symbol],
  ["direction", (r) => r.direction],
  ["sourceTimeframe", (r) => r.sourceTimeframe],
  ["timeframeClass", (r) => r.timeframeClass],
  ["levelColor", (r) => r.levelColor],
  ["levelPrice", (r) => r.levelPrice],
  ["triggeredAt", (r) => r.triggeredAt],
  ["observedAt", (r) => r.observedAt],
  ["deliveryLagMs", (r) => r.deliveryLagMs],
  ["deliveryTiming", (r) => r.deliveryTiming],
  ["soakScope", (r) => r.soakScope],
  ["barStart", (r) => r.barStart],
  ["triggerOffsetInBarMs", (r) => r.triggerOffsetInBarMs],
  ["evidenceClass", (r) => r.evidenceClass],
  ["deliveryKey", (r) => r.deliveryKey],
  ["levelKey", (r) => r.levelKey],
  ["shadowEventId", (r) => r.shadowEventId],
  ["integrityStatus", (r) => (r.integrity.judged ? r.integrity.status : "NOT_JUDGED")],
  ["freshness", (r) => r.freshness.state],
  ["freshnessExpiresAt", (r) => r.freshness.expiresAt],
  ["referencePrice", (r) => r.reference.price],
  ["referenceSource", (r) => r.reference.source],
  ["marketData", (r) => r.marketData.status],
  ["precision", (r) => r.marketData.precision],
  ...SIGNAL_QUALITY_HORIZONS.flatMap((h): [string, (row: SignalQualityRowDto) => Cell][] => [
    [`h${h.key}State`, (r) => r.horizons.find((x) => x.key === h.key)?.state ?? null],
    [`h${h.key}MfePct`, (r) => r.horizons.find((x) => x.key === h.key)?.mfePct ?? null],
    [`h${h.key}MaePct`, (r) => r.horizons.find((x) => x.key === h.key)?.maePct ?? null],
    [`h${h.key}ReturnPct`, (r) => r.horizons.find((x) => x.key === h.key)?.returnPct ?? null],
  ]),
  ["planState", (r) => r.plan.state],
  ["planStatus", (r) => r.plan.planStatus],
  ["selectedLookback", (r) => r.plan.selectedLookback],
  ["entry", (r) => r.plan.entry],
  ["stopLoss", (r) => r.plan.stopLoss],
  ["takeProfit", (r) => r.plan.takeProfit],
  ["plannedRiskReward", (r) => r.plan.plannedRiskReward],
  ["planOutcome", (r) => r.plan.outcome],
  ["rMultiple", (r) => r.plan.rMultiple],
  ["resolvedAt", (r) => r.plan.resolvedAt],
  ["flags", (r) => r.flags.map((f) => f.code).join("|")],
];

export const SIGNAL_QUALITY_EXPORT_COLUMNS: readonly string[] = COLUMNS.map(([name]) => name);

/** One CSV cell: quoted when needed, and a text cell that a spreadsheet would run as a formula is neutralised. */
export function csvCell(value: Cell): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function signalQualityCsv(rows: readonly SignalQualityRowDto[]): string {
  const lines = [COLUMNS.map(([name]) => name).join(",")];
  for (const row of rows) lines.push(COLUMNS.map(([, get]) => csvCell(get(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export function signalQualityJson(window: SignalQualityWindowDto, sample: SignalQualitySampleDto, rows: readonly SignalQualityRowDto[]): string {
  return JSON.stringify({ policy: SIGNAL_QUALITY_POLICY, authority: "NONE", nativeExecutionEnabled: false, monitoringOnly: true, window, sample, rows }, null, 2);
}

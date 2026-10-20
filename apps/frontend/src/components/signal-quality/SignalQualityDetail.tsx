import { useEffect, useRef, useState } from "react";
import { ColorType, LineStyle, createChart, type SeriesMarker, type UTCTimestamp } from "lightweight-charts";
import type { SignalQualityChartDto, SignalQualityDetailDto } from "@trading-alert-dashboard/shared";
import { fetchSignalQualityChart, fetchSignalQualityDetail } from "../../api/signalQuality.api";
import { FLAG_TONE, MARKET_DATA_LABEL, PLAN_OUTCOME_LABEL, PLAN_OUTCOME_TONE, formatPercent, formatR, horizonCell, triggerOffsetLabel } from "../../features/signal-quality/signalQualityPresentation";
import { IDLE_LOADER_STATE, LatestOnlyLoader, type LoaderState } from "../../utils/latestRequest";
import { Badge } from "../ui/Badge";

/**
 * One alert's full canonical evidence, scanner/integrity evidence, M5
 * freshness window, existing selected plan, observed outcome, flags and a
 * chart. Two read-only GETs, made once per (alert, asOf).
 */

export const CHART_NOTICE = "Candles after the SIGNAL marker were NOT known when the alert triggered; they are shown only to review the realized outcome.";

const fetchDetail = (key: string, signal: AbortSignal) => {
  const [alertId, asOf] = JSON.parse(key) as [string, string | null];
  return fetchSignalQualityDetail(alertId, asOf, signal);
};
const fetchChart = (key: string, signal: AbortSignal) => {
  const [alertId, asOf] = JSON.parse(key) as [string, string | null];
  return fetchSignalQualityChart(alertId, asOf, signal);
};

export function SignalQualityDetail({ alertId, asOf }: { alertId: string; asOf: string | null }) {
  const [detail, setDetail] = useState<LoaderState<SignalQualityDetailDto>>(IDLE_LOADER_STATE);
  const [chart, setChart] = useState<LoaderState<SignalQualityChartDto>>(IDLE_LOADER_STATE);
  const [detailLoader] = useState(() => new LatestOnlyLoader(fetchDetail, setDetail));
  const [chartLoader] = useState(() => new LatestOnlyLoader(fetchChart, setChart));
  const key = JSON.stringify([alertId, asOf]);
  useEffect(() => {
    detailLoader.load(key);
    chartLoader.load(key);
  }, [detailLoader, chartLoader, key]);
  useEffect(
    () => () => {
      detailLoader.dispose();
      chartLoader.dispose();
    },
    [detailLoader, chartLoader]
  );
  if (detail.status === "error") return <p className="text-sm text-red-300">Detail unavailable: {detail.message}</p>;
  if (detail.data === null) return <p className="text-sm text-slate-400">Loading alert detail…</p>;
  return <SignalQualityDetailView detail={detail.data} chart={chart.data} chartError={chart.status === "error" ? chart.message : null} />;
}

const Line = ({ label, value }: { label: string; value: string | number | null }) => (
  <p>
    <span className="text-slate-500">{label}: </span>
    <span className="font-mono text-slate-200">{value === null || value === "" ? "—" : value}</span>
  </p>
);

export function SignalQualityDetailView({ detail, chart, chartError }: { detail: SignalQualityDetailDto; chart: SignalQualityChartDto | null; chartError: string | null }) {
  const row = detail.row;
  const plan = row.plan;
  return (
    <div className="grid grid-cols-1 gap-4 text-xs lg:grid-cols-3">
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-200">Engine evidence</h3>
        <Line label="Alert" value={row.alertId} />
        <Line label="Triggered (exchange event time)" value={row.triggeredAt} />
        <Line label="Persisted (delivery)" value={`${row.observedAt} (${Math.round(row.deliveryLagMs / 1000)} s later, ${row.deliveryTiming})`} />
        <Line label="Operational 15m bar start" value={row.barStart} />
        <Line label="Trigger offset (as persisted)" value={triggerOffsetLabel(row.triggerOffsetInBarMs)} />
        <Line label="Level price (reference)" value={row.levelPrice} />
        <Line label="Evidence class / basis" value={`${row.evidenceClass ?? "—"} / ${row.evidenceBasis ?? "—"}`} />
        <Line label="Delivery key" value={row.deliveryKey} />
        <Line label="Level key" value={row.levelKey} />
        <Line label="Shadow event" value={row.shadowEventId} />
        <Line label="Scanner run" value={row.runId} />
        <Line label="Soak scope" value={row.soakScope} />
        <Line label="Integrity" value={row.integrity.judged ? `${row.integrity.status}: ${row.integrity.reason ?? ""}` : "not judged in this request (bounded)"} />
        <Line label="Freshness at delivery" value={`${row.freshness.state}${row.freshness.reason ? `: ${row.freshness.reason}` : ""}`} />
        <Line label="M5 window" value={`bar close ${detail.freshnessWindow.barClose ?? "—"} · expires ${detail.freshnessWindow.expiresAt ?? "—"}`} />
        <details>
          <summary className="cursor-pointer text-slate-400">Durable payload provenance</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-raised p-2 text-[10px] text-slate-300">{JSON.stringify({ schema: detail.evidence.payloadSchema, delivery: detail.evidence.delivery, profile: detail.evidence.profile, note: detail.evidence.note }, null, 2)}</pre>
        </details>
      </section>
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-200">Existing selected plan</h3>
        {plan.available ? (
          <>
            <Line label="Lookback (candles, never money)" value={plan.selectedLookback} />
            <Line label="Entry / Stop / TP" value={`${plan.entry} / ${plan.stopLoss} / ${plan.takeProfit}`} />
            <Line label="Planned RR" value={plan.plannedRiskReward} />
            <Line label="Generated" value={plan.generatedAt} />
          </>
        ) : (
          <p className="text-slate-400">No usable plan ({plan.state}){plan.reason ? `: ${plan.reason}` : ""}</p>
        )}
        <p>
          <Badge tone={PLAN_OUTCOME_TONE[plan.outcome]}>{PLAN_OUTCOME_LABEL[plan.outcome]}</Badge>
          <span className="ml-2 font-mono">{formatR(plan.rMultiple)}</span>
        </p>
        {plan.reason ? <p className="text-slate-400">{plan.reason}</p> : null}
        <h3 className="pt-2 text-sm font-semibold text-slate-200">Signal outcome after the trigger</h3>
        <table className="w-full text-left">
          <thead className="text-slate-500">
            <tr>
              <th>Horizon</th>
              <th>State</th>
              <th>MFE</th>
              <th>MAE</th>
              <th>Return</th>
            </tr>
          </thead>
          <tbody>
            {row.horizons.map((h) => {
              const cell = horizonCell(h);
              return (
                <tr key={h.key} title={cell.title}>
                  <td className="font-mono">{h.key}</td>
                  <td>
                    <Badge tone={cell.tone}>{h.state}</Badge>
                  </td>
                  <td className="font-mono">{formatPercent(h.mfePct)}</td>
                  <td className="font-mono">{formatPercent(h.maePct)}</td>
                  <td className="font-mono">{formatPercent(h.returnPct)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-slate-500">
          Market data: {MARKET_DATA_LABEL[row.marketData.status]} · {row.marketData.precision} · as of {detail.asOf}
        </p>
        <div className="flex flex-wrap gap-1 pt-1">
          {row.flags.map((flag, i) => (
            <Badge key={`${flag.code}-${i}`} tone={FLAG_TONE[flag.category]} title={flag.detail}>
              {flag.code}: {flag.detail}
            </Badge>
          ))}
        </div>
      </section>
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-200">Chart (15m, public)</h3>
        <p className="text-[11px] text-amber-300">{CHART_NOTICE}</p>
        {chart === null ? <p className="text-slate-400">{chartError ? `Chart unavailable: ${chartError}` : "Loading chart…"}</p> : <SignalChart chart={chart} />}
      </section>
    </div>
  );
}

/** Pure: the chart's markers. Only the signal and the horizon boundaries already reached. */
export function chartMarkers(chart: SignalQualityChartDto): SeriesMarker<UTCTimestamp>[] {
  const quarter = (iso: string) => (Math.floor(Date.parse(iso) / 900_000) * 900) as UTCTimestamp;
  const signal: SeriesMarker<UTCTimestamp> = { time: quarter(chart.signalTime), position: "aboveBar", color: "#facc15", shape: "arrowDown", text: "SIGNAL" };
  const horizons: SeriesMarker<UTCTimestamp>[] = chart.horizonMarks.map((m) => ({ time: quarter(m.time), position: "belowBar", color: "#64748b", shape: "circle", text: m.key }));
  return [signal, ...horizons].sort((a, b) => a.time - b.time);
}

export function SignalChart({ chart }: { chart: SignalQualityChartDto }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current;
    if (!container || chart.bars.length === 0) return undefined;
    const api = createChart(container, {
      width: container.clientWidth,
      height: 280,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "#1e293b" }, horzLines: { color: "#1e293b" } },
      timeScale: { timeVisible: true },
    });
    const series = api.addCandlestickSeries({ upColor: "#4ade80", downColor: "#f87171", borderVisible: false, wickUpColor: "#4ade80", wickDownColor: "#f87171" });
    series.setData(chart.bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    series.setMarkers(chartMarkers(chart));
    const line = (price: number | null, color: string, title: string, style = LineStyle.Dashed) => {
      if (price !== null && Number.isFinite(price)) series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    };
    line(chart.levelPrice, "#facc15", "Teddy level", LineStyle.Solid);
    line(chart.entry, "#60a5fa", "entry");
    line(chart.stopLoss, "#f87171", "stop");
    line(chart.takeProfit, "#4ade80", "TP");
    api.timeScale().fitContent();
    const observer = new ResizeObserver(() => api.applyOptions({ width: container.clientWidth }));
    observer.observe(container);
    return () => {
      observer.disconnect();
      api.remove();
    };
  }, [chart]);
  if (chart.bars.length === 0) return <p className="text-slate-400">No chart data{chart.marketData.reason ? `: ${chart.marketData.reason}` : ""}.</p>;
  return <div ref={ref} style={{ height: 280 }} aria-label="Price around the signal; candles after the SIGNAL marker are later than the trigger" />;
}

import type { ReactNode } from "react";
import type {
  SignalQualityBreakdownRowDto,
  SignalQualityHorizonAggregateDto,
  SignalQualitySoakHealthDto,
  SignalQualitySummaryDto,
} from "@trading-alert-dashboard/shared";
import { SIGNAL_QUALITY_HORIZON_STATES, SIGNAL_QUALITY_PLAN_OUTCOMES } from "@trading-alert-dashboard/shared";
import { SCOPE_OPTIONS, checkInstant, soakWindowFrom, type SoakWindowInput } from "../../features/signal-quality/signalQualityQuery";
import { BANNER_LINES, HORIZON_STATE_TONE, PLAN_OUTCOME_LABEL, PLAN_OUTCOME_TONE, formatR, formatRate, formatStats } from "../../features/signal-quality/signalQualityPresentation";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

/**
 * The observatory's page sections. Every control here changes only WHAT IS
 * SHOWN (the window, the point in time, refresh, export links). Nothing can
 * trade, arm, enable execution or write anything: the page's requests are GETs.
 */

const CONTROL =
  "rounded border border-surface-border bg-surface px-2 py-1 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

export function ObservatoryBanner() {
  return (
    <div role="note" aria-label="Signal quality observatory: monitoring only, no execution authority" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <p className="text-sm font-bold tracking-wide text-amber-300">
        {BANNER_LINES.join(" · ")}
      </p>
      <p className="mt-1 text-xs text-amber-200/80">
        Observes persisted Native alerts, their existing selected plans and public market data after each alert. Native execution is hard-disabled in code; nothing on this page can trade, arm or enable anything.
      </p>
    </div>
  );
}

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: ReactNode; hint?: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[11px] uppercase tracking-wide text-slate-400">
        {label}
      </label>
      {children}
      {hint ? <span className="text-[11px] text-red-400">{hint}</span> : null}
    </div>
  );
}

export function SoakControls({
  window,
  onChange,
  problem,
  autoRefresh,
  onAutoRefresh,
  onRefresh,
  exportCsv,
  exportJson,
}: {
  window: SoakWindowInput;
  onChange: (next: SoakWindowInput) => void;
  problem: string | null;
  autoRefresh: boolean;
  onAutoRefresh: (on: boolean) => void;
  onRefresh: () => void;
  exportCsv: string;
  exportJson: string;
}) {
  const startHint = checkInstant(window.soakStart);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Soak start (UTC)" htmlFor="sq-soak-start" hint={startHint.ok ? null : startHint.message}>
          <input id="sq-soak-start" className={`${CONTROL} w-56`} placeholder="2026-10-21T08:00:00Z" value={window.soakStart} onChange={(e) => onChange({ ...window, soakStart: e.target.value })} />
        </Field>
        <Field label="Soak end (UTC)" htmlFor="sq-soak-end">
          <input id="sq-soak-end" className={`${CONTROL} w-56`} placeholder="2026-10-22T08:00:00Z" value={window.soakEnd} onChange={(e) => onChange({ ...window, soakEnd: e.target.value })} />
        </Field>
        <Field label="Scope" htmlFor="sq-scope">
          <select id="sq-scope" className={CONTROL} value={window.scope} onChange={(e) => onChange({ ...window, scope: SCOPE_OPTIONS.find((o) => o.value === e.target.value)?.value ?? "ALL" })}>
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="As of (UTC, empty = now)" htmlFor="sq-as-of">
          <input id="sq-as-of" className={`${CONTROL} w-56`} placeholder="now" value={window.asOf} onChange={(e) => onChange({ ...window, asOf: e.target.value })} />
        </Field>
        <Button variant="secondary" type="button" onClick={() => window.soakStart.trim() && checkInstant(window.soakStart).ok && onChange({ ...window, ...soakWindowFrom(window.soakStart.trim()) })}>
          24h from start
        </Button>
        <Button variant="ghost" type="button" onClick={() => onChange({ soakStart: "", soakEnd: "", scope: "ALL", asOf: "" })}>
          Last 24h
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button variant="secondary" type="button" onClick={onRefresh}>
          Refresh
        </Button>
        <label className="flex items-center gap-2 text-slate-300">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => onAutoRefresh(e.target.checked)} />
          Auto-refresh every 60 s (read-only)
        </label>
        <a className="text-blue-400 hover:underline" href={exportCsv} download>
          Export CSV
        </a>
        <a className="text-blue-400 hover:underline" href={exportJson} download>
          Export JSON
        </a>
        {problem ? <span className="text-xs text-red-400">{problem}</span> : null}
      </div>
    </Card>
  );
}

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-lg font-semibold text-slate-100">{value}</p>
      {note ? <p className="text-[11px] text-slate-500">{note}</p> : null}
    </div>
  );
}

const pairs = (record: Readonly<Record<string, number>>) =>
  Object.entries(record).length === 0 ? "—" : Object.entries(record).map(([k, v]) => `${k} ${v}`).join(" · ");

export function SoakHealthPanel({ health, error }: { health: SignalQualitySoakHealthDto | null; error: string | null }) {
  if (health === null) return <Card className="p-4 text-sm text-slate-400">{error ? `Soak health unavailable: ${error}` : "Loading soak health…"}</Card>;
  const u = health.scanner.universe;
  return (
    <Card className="space-y-2 p-4">
      <h2 className="text-sm font-semibold text-slate-200">Monitoring health (read-only)</h2>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Scanner" value={<Badge tone={health.scanner.state === "RUNNING" ? "green" : "yellow"}>{health.scanner.state}</Badge>} note={health.scanner.runId ?? health.scanner.reason} />
        <Stat label="Emitter" value={<Badge tone={health.emitter.state === "RUNNING" ? "green" : "yellow"}>{health.emitter.state}</Badge>} note={`queue ${health.emitter.queueDepth ?? "—"} · duplicates ${health.emitter.ledgerDuplicates ?? "—"}`} />
        <Stat label="Universe (dynamic)" value={`${u.liveEligible ?? "—"} live / ${u.selected ?? "—"} selected`} note={`exchange candidates ${u.exchangeCandidates ?? "—"} · failed ${u.failed ?? "—"} · recovering ${u.recovering ?? "—"}`} />
        <Stat label="Native alerts" value={`${health.alerts.lastHour} in 1h · ${health.alerts.last24h} in 24h`} note={`last delivered ${health.alerts.lastDeliveredAt ?? "—"} · last market data ${health.scanner.lastMarketDataAt ?? "—"}`} />
      </div>
      <p className="text-[11px] text-slate-500">Native plans: {pairs(health.plans)}</p>
    </Card>
  );
}

export function SummaryPanel({ summary }: { summary: SignalQualitySummaryDto }) {
  const c = summary.counts;
  const s = summary.sample;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-200">Summary</h2>
        <p className="text-[11px] text-slate-500">
          window {summary.window.windowStart} → {summary.window.windowEnd} · as of {summary.window.asOf}
        </p>
      </div>
      {s.truncated ? <p className="rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-xs text-yellow-300">The window holds more than {s.limit} alerts; only the newest {s.limit} are evaluated. Narrow the window.</p> : null}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Alerts" value={c.total} note={`${c.uniqueSymbols} unique symbols`} />
        <Stat label="Direction" value={pairs(c.byDirection)} />
        <Stat label="Source TF" value={pairs(c.bySourceTimeframe)} note={pairs(c.byTimeframeClass)} />
        <Stat label="Level colour" value={pairs(c.byLevelColor)} />
        <Stat label="Integrity" value={pairs(c.byIntegrity)} note={`${s.integrityJudged} judged · ${s.integrityNotJudged} not judged (bounded)`} />
        <Stat label="Freshness at delivery" value={pairs(c.byFreshness)} />
        <Stat label="Soak scope" value={pairs(c.bySoakScope)} note={pairs(c.byDeliveryTiming)} />
        <Stat label="Market data" value={`${s.marketData.LOADED} loaded`} note={`${s.marketData.NOT_LOADED} not loaded yet · ${s.marketData.UNAVAILABLE} unavailable`} />
      </div>
      <p className="text-[11px] text-slate-500">
        Evidence classes: {pairs(c.byEvidenceClass)} · plans available {c.planAvailable} / {c.total} · flags: {pairs(c.flags)}
      </p>
    </Card>
  );
}

function HorizonRow({ h }: { h: SignalQualityHorizonAggregateDto }) {
  return (
    <tr className="border-t border-surface-border">
      <td className="px-2 py-1 font-mono text-slate-200">{h.key}</td>
      <td className="px-2 py-1">
        <div className="flex flex-wrap gap-1">
          {SIGNAL_QUALITY_HORIZON_STATES.map((state) => (
            <Badge key={state} tone={HORIZON_STATE_TONE[state]}>
              {state} {h.states[state]}
            </Badge>
          ))}
        </div>
      </td>
      <td className="px-2 py-1 text-xs text-slate-300">{formatStats(h.mfePct)}</td>
      <td className="px-2 py-1 text-xs text-slate-300">{formatStats(h.maePct)}</td>
      <td className="px-2 py-1 text-xs text-slate-300">{formatStats(h.returnPct)}</td>
      <td className="px-2 py-1 text-xs text-slate-300">{formatRate(h.directional, "matured moved favourably")}</td>
    </tr>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: readonly SignalQualityBreakdownRowDto[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <p className="mb-1 text-xs font-semibold text-slate-300">{title}</p>
      <table className="w-full text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="px-2 py-1">Group</th>
            <th className="px-2 py-1">Alerts</th>
            <th className="px-2 py-1">TP before SL</th>
            <th className="px-2 py-1">Realized R</th>
            <th className="px-2 py-1">24h return</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-surface-border text-slate-300">
              <td className="px-2 py-1 font-mono">{r.key}</td>
              <td className="px-2 py-1">{r.total}</td>
              <td className="px-2 py-1">{formatRate(r.plan.tpBeforeSl, "resolved")}</td>
              <td className="px-2 py-1">{formatStats(r.plan.r, formatR)}</td>
              <td className="px-2 py-1">{formatStats(r.horizon24h.returnPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QualityPanel({ summary }: { summary: SignalQualitySummaryDto }) {
  const p = summary.plans;
  const pf = p.profitFactor.value === null ? `— (${p.profitFactor.reason === "NO_LOSSES" ? "no losses" : "no resolved plans"})` : p.profitFactor.value.toFixed(2);
  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-200">Signal quality — after triggeredAt</h2>
        <p className="text-[11px] text-slate-500">Only MATURED horizons enter the statistics. PARTIAL and PENDING are censored, never zeros, wins or losses. Precision: Binance USD-M public 1-minute OHLC.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-2 py-1">Horizon</th>
              <th className="px-2 py-1">States</th>
              <th className="px-2 py-1">MFE</th>
              <th className="px-2 py-1">MAE</th>
              <th className="px-2 py-1">Return</th>
              <th className="px-2 py-1">Directional</th>
            </tr>
          </thead>
          <tbody>
            {summary.horizons.map((h) => (
              <HorizonRow key={h.key} h={h} />
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h2 className="text-sm font-semibold text-slate-200">Plan quality — the existing selected plan</h2>
        <p className="text-[11px] text-slate-500">TP/SL resolution over 24h at 1-minute precision. Ambiguous, neither, pending, gaps and missing plans are never in the win rate or R.</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {SIGNAL_QUALITY_PLAN_OUTCOMES.map((o) => (
            <Badge key={o} tone={PLAN_OUTCOME_TONE[o]}>
              {PLAN_OUTCOME_LABEL[o]} {p.outcomes[o]}
            </Badge>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-4">
          <Stat label="TP before SL" value={formatRate(p.tpBeforeSl, "resolved non-ambiguous plans")} />
          <Stat label="Realized R" value={formatStats(p.r, formatR)} />
          <Stat label="Expectancy" value={formatR(p.expectancyR)} note={`per resolved plan (n = ${p.r.n})`} />
          <Stat label="Profit factor" value={pf} note="resolved R only" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownTable title="By source timeframe" rows={summary.breakdowns.bySourceTimeframe} />
        <BreakdownTable title="By direction" rows={summary.breakdowns.byDirection} />
        <BreakdownTable title="By level colour" rows={summary.breakdowns.byLevelColor} />
        <BreakdownTable title="By timeframe class" rows={summary.breakdowns.byTimeframeClass} />
        <BreakdownTable title="By integrity" rows={summary.breakdowns.byIntegrity} />
        <BreakdownTable title="By evidence class" rows={summary.breakdowns.byEvidenceClass} />
      </div>
      <AlertRate summary={summary} />
      <p className="text-[11px] text-slate-500">This page observes; it does not conclude that anything is profitable. Small samples are shown with their size.</p>
    </Card>
  );
}

function AlertRate({ summary }: { summary: SignalQualitySummaryDto }) {
  const r = summary.alertRate;
  const list = (items: readonly { key: string; count: number }[]) => (items.length === 0 ? "none" : items.map((i) => `${i.key} ×${i.count}`).join(" · "));
  return (
    <div className="space-y-1 text-xs text-slate-300">
      <p className="font-semibold text-slate-200">Alert rate (observation only — nothing is throttled)</p>
      <p>
        Busiest 15 minutes: {r.maxInRolling15m.count} alert(s){r.maxInRolling15m.windowStart ? ` from ${r.maxInRolling15m.windowStart}` : ""}
      </p>
      <p>Per hour: {r.perHour.length === 0 ? "—" : r.perHour.map((h) => `${h.hourStart.slice(11, 16)}Z ${h.alerts}/${h.symbols}`).join(" · ")}</p>
      <p>Repeated symbols: {list(r.topSymbols)}</p>
      <p>Repeated symbol + side: {list(r.topSymbolSides)}</p>
      <p>Repeated levels: {list(r.repeatedLevels)}</p>
    </div>
  );
}

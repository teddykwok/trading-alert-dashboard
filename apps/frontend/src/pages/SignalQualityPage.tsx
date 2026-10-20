import { fetchSignalQualityPage, fetchSignalQualitySummary, fetchSoakHealth, signalQualityExportHref } from "../api/signalQuality.api";
import { ObservatoryBanner, QualityPanel, SoakControls, SoakHealthPanel, SummaryPanel } from "../components/signal-quality/ObservatorySections";
import { SignalQualityTable } from "../components/signal-quality/SignalQualityTable";
import { useSignalQuality, type SignalQualityFetchers } from "../hooks/useSignalQuality";

/**
 * NATIVE SIGNAL QUALITY OBSERVATORY. MONITORING ONLY, NO EXECUTION AUTHORITY.
 *
 * Engine quality, signal quality and plan quality, kept apart. Every request
 * this page makes is a GET to /api/signal-quality/*; there is no control here
 * that can trade, arm, prepare LIVE_READY or enable Native execution.
 */

// Module-level and stable: the hook's loaders are created once.
const FETCHERS: SignalQualityFetchers = {
  summary: (key, signal) => fetchSignalQualitySummary(key, signal),
  page: (key, signal) => fetchSignalQualityPage(key, signal),
  soakHealth: (_key, signal) => fetchSoakHealth(signal),
};

export function SignalQualityPage() {
  const view = useSignalQuality(FETCHERS);
  const summary = view.summary.data;
  return (
    <div className="space-y-4">
      <ObservatoryBanner />
      <SoakControls
        window={view.window}
        onChange={view.setWindow}
        problem={view.problem}
        autoRefresh={view.autoRefresh}
        onAutoRefresh={view.setAutoRefresh}
        onRefresh={view.reload}
        exportCsv={signalQualityExportHref(view.summaryKey, "csv")}
        exportJson={signalQualityExportHref(view.summaryKey, "json")}
      />
      <SoakHealthPanel health={view.soakHealth.data} error={view.soakHealth.status === "error" ? view.soakHealth.message : null} />
      {view.summary.status === "error" && summary === null ? (
        <div role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          The signal-quality summary is unavailable: {view.summary.message}
        </div>
      ) : summary === null ? (
        <p className="text-sm text-slate-400">Loading summary…</p>
      ) : (
        <>
          <SummaryPanel summary={summary} />
          <QualityPanel summary={summary} />
        </>
      )}
      <SignalQualityTable view={view} />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  EXTREME_RR_LEVERAGE_PRESETS,
  EXTREME_RR_LEVERAGE_UNVERIFIED_NOTE,
  EXTREME_RR_LOOKBACKS,
  EXTREME_RR_MARGIN_DISCLAIMER,
  EXTREME_RR_PREFERRED_MARGIN_MAX,
  EXTREME_RR_PREFERRED_MARGIN_MIN,
  EXTREME_RR_UNROUNDED_NOTE,
  type ExtremeRRCandidate,
  type ExtremeRRLeverage,
  type ExtremeRRLookback,
  type ExtremeRRPlanDto,
} from "@trading-alert-dashboard/shared";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Disclosure } from "../ui/Disclosure";
import { extremeRRApi } from "../../api/extreme-rr.api";
import { formatDateTime } from "../../utils/formatDate";
import { formatPrice } from "../../utils/formatPrice";
import { isNativeAlert } from "../../utils/alertSource";
import type { Alert } from "../../types/alert";

const STATUS_TONE = { PENDING: "blue", READY: "green", INVALID: "yellow", ERROR: "red" } as const;
const PENDING_POLL_MS = 3000;

/** Display-only: exact strings stay authoritative, Number() only feeds formatting. */
function px(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return formatPrice(Number(value));
}

/** USD money display, 2 decimals (display only — never fed back anywhere). */
function usd(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return `$${Number(value).toFixed(2)}`;
}

/** Quantity display with more precision than money (small-cap quantities are large). */
function qty(value: string | null | undefined): string {
  if (!value) return "—";
  return String(parseFloat(Number(value).toFixed(6)));
}

export function ExtremeRRPlanner({ alert }: { alert: Alert }) {
  const [plan, setPlan] = useState<ExtremeRRPlanDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  // Local view selection follows the saved value but switches instantly.
  const [viewLookback, setViewLookback] = useState<ExtremeRRLookback | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const directional = alert.signal === "LONG" || alert.signal === "SHORT";
  // The same planner for both sources; a Native plan is planning only (generated automatically after delivery, or on demand).
  const native = isNativeAlert(alert);

  useEffect(() => {
    if (!directional) return;
    setLoading(true);
    setError(null);
    extremeRRApi
      .getForAlert(alert.id)
      .then((loaded) => {
        setPlan(loaded);
        setViewLookback(loaded?.selectedLookback ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load Extreme RR plan"))
      .finally(() => setLoading(false));
  }, [alert.id, directional]);

  // While the background worker is generating (PENDING), poll gently.
  useEffect(() => {
    if (plan?.status !== "PENDING") return;
    pollTimer.current = setTimeout(() => {
      extremeRRApi
        .getForAlert(alert.id)
        .then((loaded) => {
          if (loaded) {
            setPlan(loaded);
            setViewLookback((current) => current ?? loaded.selectedLookback);
          }
        })
        .catch(() => {
          // polling is best-effort; the manual Refresh button remains
        });
    }, PENDING_POLL_MS);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [plan, alert.id]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const generated = await extremeRRApi.generate(alert.id);
      setPlan(generated);
      setViewLookback(generated.selectedLookback);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plan generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function selectLookback(lookback: ExtremeRRLookback) {
    // Instant display from the SAVED candidates — no new market request.
    setViewLookback(lookback);
    try {
      setPlan(await extremeRRApi.updateSelection(alert.id, { selectedLookback: lookback }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lookback selection");
    }
  }

  async function selectLeverage(leverage: ExtremeRRLeverage) {
    try {
      setPlan(await extremeRRApi.updateSelection(alert.id, { selectedLeverage: leverage }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save leverage selection");
    }
  }

  async function copyPlan(candidate: ExtremeRRCandidate) {
    if (!plan) return;
    const leverage = plan.selectedLeverage;
    const margin =
      leverage !== null
        ? candidate.money?.leverage.options.find((option) => option.leverage === leverage)
        : undefined;

    const lines = [
      `${plan.direction} ${alert.symbol}`,
      `Entry: ${px(plan.entryPrice)}`,
      `SL: ${px(candidate.stopLoss)}`,
      `TP: ${px(candidate.takeProfit)}`,
      `Quantity: ${qty(candidate.money?.quantityRaw)}`,
      ...(leverage !== null ? [`Leverage: ${leverage}x`] : []),
      ...(margin ? [`Estimated margin: ${usd(margin.estimatedInitialMargin)}`] : []),
      ...(plan.template
        ? [`Risk: $${plan.template.riskAmount}`, `Target: $${plan.template.targetAmount}`]
        : []),
      `Lookback: ${candidate.actualCandles} closed candles`,
      `Cutoff: ${formatDateTime(plan.cutoffAt)}`,
    ];
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  // The Extreme RR plan only exists for actionable directions.
  if (!directional) return null;

  const candidate =
    plan?.candidates.find((c) => c.requestedCandles === (viewLookback ?? plan.selectedLookback)) ?? null;
  const selectedMargin =
    plan?.selectedLeverage != null
      ? candidate?.money?.leverage.options.find((o) => o.leverage === plan.selectedLeverage) ?? null
      : null;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-200">Extreme RR Plan</h2>
        {plan && <Badge tone={STATUS_TONE[plan.status]}>{plan.status}</Badge>}
        <Badge tone="blue">AUTO-CALCULATED</Badge>
        <Badge tone="gray">FROZEN AT ALERT</Badge>
        {native && <Badge tone="yellow">PLANNING ONLY</Badge>}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !plan ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-slate-500">
            {native
              ? "No plan yet. New Native alerts are planned automatically after delivery, and any Native alert can be planned on demand — always from the chart candles that closed before the alert, never newer candles. The plan is planning only: it is never executed."
              : "No plan exists for this alert (it predates the Extreme RR feature). Generation uses the alert's original trigger time as the candle cutoff — never newer candles."}
          </p>
          <div>
            <Button variant="secondary" disabled={generating} onClick={generate}>
              {generating ? "Generating…" : "Generate plan"}
            </Button>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      ) : (
        <>
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

          {plan.status === "PENDING" && (
            <p className="mb-3 text-sm text-slate-500">
              Waiting for background generation… this refreshes automatically.
            </p>
          )}

          {plan.status === "ERROR" && (
            <div className="mb-3 flex flex-col gap-2">
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                Generation failed: {plan.errorReason ?? "unknown error"}
              </p>
              <div>
                <Button variant="secondary" disabled={generating} onClick={generate}>
                  {generating ? "Retrying…" : "Retry generation"}
                </Button>
              </div>
            </div>
          )}

          {plan.candidates.length > 0 && (
            <>
              {/* Lookback selector: switching displays the SAVED candidate —
                  never a new market request, never newer candles. */}
              <div className="mb-3 flex items-center gap-1.5">
                {EXTREME_RR_LOOKBACKS.map((lookback) => {
                  const c = plan.candidates.find((x) => x.requestedCandles === lookback);
                  const active = (viewLookback ?? plan.selectedLookback) === lookback;
                  return (
                    <Button
                      key={lookback}
                      variant={active ? "primary" : "secondary"}
                      onClick={() => selectLookback(lookback)}
                      title={c && !c.complete ? `Only ${c.actualCandles} closed candles were available` : undefined}
                    >
                      {lookback} candles{c && !c.complete ? ` (${c.actualCandles})` : ""}
                    </Button>
                  );
                })}
              </div>

              {candidate && (
                <>
                  {/* Price plan — the fields needed to place the trade. Cutoff,
                      candle counts and raw distances live in Calculation
                      details below; the invalid reason is never hidden. */}
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Price plan
                  </h3>
                  <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                    <Field label="Direction" value={plan.direction} strong />
                    <Field label="Entry" value={px(plan.entryPrice)} />
                    <Field label="Lookback" value={`${candidate.actualCandles} candles`} />
                    <Field label="Stop-loss" value={px(candidate.stopLoss)} strong />
                    <Field
                      label={`Take-profit (${candidate.extremeType === "HIGHEST_HIGH" ? "Highest High" : "Lowest Low"})`}
                      value={px(candidate.takeProfit)}
                      strong
                    />
                    <Field
                      label="Risk / reward"
                      value={candidate.riskRewardRatio ? `1:${Number(candidate.riskRewardRatio).toFixed(2)}` : "—"}
                    />
                  </dl>

                  {!candidate.valid && (
                    <p className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
                      Invalid candidate — {candidate.invalidReason ?? "unknown reason"}
                    </p>
                  )}

                  {/* Money management */}
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Money management
                    </h3>
                    {plan.template && (
                      <span className="truncate text-xs text-slate-500">{plan.template.name}</span>
                    )}
                  </div>
                  {plan.template ? (
                    <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                      <Field label="Risk amount" value={`$${plan.template.riskAmount}`} strong />
                      <Field label="Target amount" value={`$${plan.template.targetAmount}`} strong />
                      <Field label="Quantity" value={qty(candidate.money?.quantityRaw)} strong />
                    </dl>
                  ) : (
                    <p className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
                      No risk template was active when this plan was generated — money management is
                      unavailable. Create/activate a template on the Risk Templates page, then use
                      Retry generation to re-snapshot.
                    </p>
                  )}

                  {/* Execution planning */}
                  {candidate.valid && candidate.money && (
                    <>
                      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Execution planning
                      </h3>
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        {EXTREME_RR_LEVERAGE_PRESETS.map((leverage) => {
                          const option = candidate.money!.leverage.options.find((o) => o.leverage === leverage)!;
                          const selected = plan.selectedLeverage === leverage;
                          return (
                            <Button
                              key={leverage}
                              variant={selected ? "primary" : "secondary"}
                              onClick={() => selectLeverage(leverage)}
                              title={`Estimated isolated margin: ${usd(option.estimatedInitialMargin)}`}
                            >
                              {leverage}x{option.preferred ? " ★" : ""}
                            </Button>
                          );
                        })}
                      </div>
                      <p className="mb-2 text-[11px] text-slate-500">
                        ★ = estimated margin inside the preferred ${EXTREME_RR_PREFERRED_MARGIN_MIN}–$
                        {EXTREME_RR_PREFERRED_MARGIN_MAX} band.
                        {candidate.money.leverage.closestToPreferred !== null &&
                          ` No preset lands in the band — ${candidate.money.leverage.closestToPreferred}x is closest (informational only).`}
                      </p>

                      {plan.selectedLeverage === null ? (
                        <p className="mb-3 text-sm text-slate-500">
                          Select a leverage preset to estimate the isolated margin — none is assumed
                          by default.
                        </p>
                      ) : (
                        <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                          <Field label="Selected leverage" value={`${plan.selectedLeverage}x`} strong />
                          <Field
                            label="Estimated margin"
                            value={usd(selectedMargin?.estimatedInitialMargin)}
                            strong
                          />
                          <Field label="Position notional" value={usd(candidate.money.positionNotionalRaw)} />
                          {selectedMargin?.preferred && (
                            <Field
                              label="Preferred band"
                              value="Yes (inside the configured range)"
                              className="col-span-2 sm:col-span-3"
                            />
                          )}
                        </dl>
                      )}

                      {selectedMargin?.marginAtOrBelowRisk && (
                        <p className="mb-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
                          Estimated margin ({usd(selectedMargin.estimatedInitialMargin)}) is at or below
                          the planned loss budget ({usd(candidate.money.plannedLossRaw)}) — liquidation
                          could occur before the stop loss.
                        </p>
                      )}

                      {/* Safety statements stay visible; the precision note is
                          in Calculation details. */}
                      <div className="mb-3 space-y-1 text-[11px] text-slate-500">
                        <p>{EXTREME_RR_MARGIN_DISCLAIMER}</p>
                        <p>{EXTREME_RR_LEVERAGE_UNVERIFIED_NOTE}</p>
                      </div>

                      <div className="mb-3 flex items-center gap-2">
                        <Button variant="secondary" onClick={() => copyPlan(candidate)}>
                          Copy Plan
                        </Button>
                        {copied && <span className="text-xs text-green-400">Copied ✓</span>}
                      </div>
                    </>
                  )}

                  {/* Everything needed to reproduce the frozen plan, kept out
                      of the way of the trading decision. */}
                  <Disclosure
                    title="Calculation details"
                    description="Cutoff, candle counts, raw distances and precision notes"
                  >
                    <dl className="space-y-1 text-sm">
                      <Row label="Entry basis" value="Alert price" />
                      <Row
                        label={candidate.extremeType === "HIGHEST_HIGH" ? "Highest high" : "Lowest low"}
                        value={px(candidate.extremePrice)}
                      />
                      <Row label="Timeframe" value={plan.timeframe} />
                      <Row label="Candle cutoff" value={formatDateTime(plan.cutoffAt)} />
                      <Row
                        label="Candles (requested / actual)"
                        value={`${candidate.requestedCandles} / ${candidate.actualCandles}${candidate.complete ? "" : " (incomplete history)"}`}
                      />
                      <Row
                        label="Oldest candle open"
                        value={candidate.oldestCandleOpenTime ? formatDateTime(candidate.oldestCandleOpenTime) : "—"}
                      />
                      <Row
                        label="Newest candle close"
                        value={candidate.newestCandleCloseTime ? formatDateTime(candidate.newestCandleCloseTime) : "—"}
                      />
                      <Row label="Reward distance" value={px(candidate.rewardDistance)} />
                      <Row label="Risk distance" value={px(candidate.riskDistance)} />
                      <Row label="Validation" value={candidate.valid ? "Valid" : "Invalid"} />
                      {plan.template && (
                        <>
                          <Row label="Reference capital" value={`$${plan.template.referenceCapital}`} />
                          <Row label="Risk %" value={`${plan.template.riskPercent}%`} />
                          <Row label="Reward ratio" value={`1:${plan.template.rewardRatio}`} />
                        </>
                      )}
                      {candidate.money && (
                        <>
                          <Row label="Planned loss" value={usd(candidate.money.plannedLossRaw)} />
                          <Row label="Planned profit" value={usd(candidate.money.plannedProfitRaw)} />
                        </>
                      )}
                      <Row
                        label="Generated at"
                        value={plan.generatedAt ? formatDateTime(plan.generatedAt) : "—"}
                      />
                    </dl>
                    <p className="mt-2 text-[11px] text-slate-500">{EXTREME_RR_UNROUNDED_NOTE}</p>
                  </Disclosure>
                </>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

/** Compact labelled value used by the primary summary grids. */
function Field({
  label,
  value,
  strong,
  className,
}: {
  label: string;
  value: string;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={strong ? "text-sm font-semibold text-slate-100" : "text-sm text-slate-200"}>
        {value}
      </dd>
    </div>
  );
}

/** Label/value row used inside the Calculation details disclosure. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-200">{value}</dd>
    </div>
  );
}

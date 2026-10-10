import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { NATIVE_PLAN_EXECUTION_STATUS, type NativeAccountPlanPreview, type NativePlanListItemDto } from "@trading-alert-dashboard/shared";
import {
  PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT,
  nativePlanStatusLabel,
  nativePlanStatusTone,
  presentNativeAccountDefault,
  type NativeAccountDefaultRow,
} from "../../features/plans/nativeAccountDefaults";
import { NATIVE_EXECUTION_INTEGRITY_HEADING, presentNativeExecutionIntegrity } from "../../features/plans/nativeExecutionIntegrity";
import { ratioText } from "../../features/plans/nativePlanTable";
import { SelectedPlanSummaryView } from "../alerts/SelectedPlanSummaryView";
import { Badge } from "../ui/Badge";
import { DecimalText } from "../ui/DecimalText";

/**
 * One Native plan in full, shown when its table row is expanded. READ ONLY:
 * every value is the API's verbatim (exact decimals in titles), long ids and
 * reasons wrap instead of being cut, and the only interactive elements are
 * links to the alert. Native plans are planning only; nothing here selects,
 * permits or starts anything.
 */

/** One account's default (policy or per-plan preview) on one line. */
export function AccountDefaultRow({ row }: { row: NativeAccountDefaultRow }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs" data-testid="native-account-default">
      <span className="text-slate-400">{row.label}</span>
      <Badge tone={row.tone}>{row.value}</Badge>
      {row.source !== null && <span className="text-[10px] uppercase tracking-wide text-slate-500">{row.source}</span>}
      {row.detail !== null && (
        <span className="min-w-0 break-words text-slate-500" title={row.detailExact ?? undefined}>
          {row.detail}
        </span>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2 rounded-lg border border-surface-border bg-surface-raised/60 p-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</h4>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-right text-slate-200">{children}</dd>
    </div>
  );
}

const shown = (value: string | number | boolean | null | undefined): string => (value === null || value === undefined ? "—" : String(value));

/** Every field of one account's preview, exact. */
function AccountPreviewFacts({ preview }: { preview: NativeAccountPlanPreview }) {
  return (
    <div className="space-y-1 border-t border-surface-border/60 pt-2 first:border-t-0 first:pt-0">
      <AccountDefaultRow row={presentNativeAccountDefault(preview)} />
      <dl className="space-y-0.5">
        <Fact label="Policy">{preview.policy}</Fact>
        <Fact label="Source">{preview.source}</Fact>
        <Fact label="Lookback">{shown(preview.lookback)}</Fact>
        <Fact label="Planning state">{preview.state}</Fact>
        <Fact label="SL">{preview.stopLoss === null ? "—" : <DecimalText value={preview.stopLoss} />}</Fact>
        <Fact label="TP">{preview.takeProfit === null ? "—" : <DecimalText value={preview.takeProfit} />}</Fact>
        <Fact label="RR">
          <span title={preview.riskRewardRatio ?? undefined}>{ratioText(preview.riskRewardRatio)}</span>
        </Fact>
        <Fact label="Actual candles">{shown(preview.actualCandles)}</Fact>
        <Fact label="Complete">{shown(preview.complete)}</Fact>
        {preview.reason !== null && <Fact label="Reason">{preview.reason}</Fact>}
      </dl>
    </div>
  );
}

export function NativePlanDetail({ item }: { item: NativePlanListItemDto }) {
  const integrity = presentNativeExecutionIntegrity(item.executionIntegrity);
  return (
    <div className="min-w-0 space-y-2 overflow-hidden rounded-lg" data-testid="native-plan-detail">
      <div className="flex flex-wrap items-baseline gap-2 text-xs text-slate-400">
        <Link to={`/alerts/${item.alertId}`} className="font-semibold text-slate-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          {item.symbol}
        </Link>
        <Badge tone={item.plan.direction === "LONG" ? "green" : "red"}>{item.plan.direction}</Badge>
        <span>source TF {item.sourceTimeframe ?? "—"}</span>
        <span>
          Entry <DecimalText value={item.plan.entryPrice} />
        </span>
        <Badge tone={nativePlanStatusTone(item.plan.planStatus)}>{nativePlanStatusLabel(item.plan.planStatus)}</Badge>
        <span className="font-semibold text-yellow-300">{NATIVE_PLAN_EXECUTION_STATUS}</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
        <Section title="Identity">
          <dl className="space-y-0.5">
            <Fact label="Alert id">
              <span className="break-all font-mono">{item.alertId}</span>
            </Fact>
            <Fact label="Symbol">{item.symbol}</Fact>
            <Fact label="Source TF">{shown(item.sourceTimeframe)}</Fact>
            <Fact label="Triggered">
              <time dateTime={item.triggeredAt}>{item.triggeredAt}</time>
            </Fact>
            <Fact label="Plan cutoff">
              <time dateTime={item.plan.cutoffAt}>{item.plan.cutoffAt}</time>
            </Fact>
          </dl>
        </Section>

        <Section title="Selected plan">
          <SelectedPlanSummaryView summary={item.plan} />
          <dl className="space-y-0.5">
            <Fact label="Planning state">{item.plan.state}</Fact>
            <Fact label="Actual candles">{shown(item.plan.actualCandles)}</Fact>
            <Fact label="Complete">{shown(item.plan.complete)}</Fact>
          </dl>
          <p className="text-xs text-slate-500">
            Available lookbacks: {item.availableLookbacks.length > 0 ? item.availableLookbacks.join(" / ") : "none yet"}
          </p>
        </Section>

        <Section title="Account planning defaults">
          <p className="text-xs text-slate-500" data-testid="plan-selection-note">
            {PLAN_SELECTION_IS_NOT_ACCOUNT_DEFAULT}
          </p>
          <div className="space-y-2">
            {item.accountDefaults.map((preview) => (
              <AccountPreviewFacts key={preview.account} preview={preview} />
            ))}
          </div>
        </Section>

        <Section title="Integrity">
          <div className="flex flex-wrap items-baseline gap-2 text-xs" data-testid="native-execution-integrity">
            <span className="text-slate-400">{NATIVE_EXECUTION_INTEGRITY_HEADING}:</span>
            <Badge tone={integrity.tone}>{integrity.label}</Badge>
          </div>
          <p className="min-w-0 break-words text-xs text-slate-300">{integrity.detail}</p>
          <dl className="space-y-0.5">
            <Fact label="Status">{shown(item.executionIntegrity?.status)}</Fact>
            <Fact label="Source bar opened">
              {item.executionIntegrity?.barOpenTime ? <time dateTime={item.executionIntegrity.barOpenTime}>{item.executionIntegrity.barOpenTime}</time> : "—"}
            </Fact>
          </dl>
        </Section>
      </div>
    </div>
  );
}

import type { PropsWithChildren } from "react";

import type {
  HistoricalFillInterpretationDto,
  HistoricalFillProfileReason,
} from "../../api/operator";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import {
  describeOperationalState,
  describeProfileReason,
  formatOptionalInstant,
  presentHistoricalFillOperations,
  presentInterpretationIssues,
  toneForOperationalState,
  type MetricSection,
} from "../../features/operator/historicalFillOperationsPresentation";
import {
  HISTORICAL_FILL_ESCALATION,
  HISTORICAL_FILL_EVIDENCE_NOTE,
  HISTORICAL_FILL_NORMAL_GUIDANCE,
  presentIssueRunbook,
  profileReasonCheck,
} from "../../features/operator/historicalFillRunbook";
import { useHistoricalFillOperations } from "../../hooks/useHistoricalFillOperations";

/**
 * Durable historical-fill ingestion state, for an operator to READ.
 *
 * Observability only. There is no control here and there cannot be one: the
 * panel's single network operation is the GET its hook performs, so nothing on
 * this surface can start, retry, claim, repair or abandon anything.
 *
 * The panel now shows an operational state, and that state is the SERVER'S.
 * Nothing here compares a count against anything: the block below renders
 * `snapshot.interpretation` verbatim, so the panel and the API can never tell
 * an operator two different stories. NEEDS_ATTENTION still produces no button
 * -- it is a reason to look, not a control. The runbook block below explains
 * the conditions and names read-only checks, and it is deliberately a native
 * `<details>` (the pattern the sibling trading-control card already uses on
 * this page) so that guidance costs the panel no button, no handler and no
 * state.
 *
 * The individual figures remain neutral. No metric is coloured or ranked by its
 * own value; the only tone on this surface belongs to the state the server set.
 */

function InterpretationBlock({
  interpretation,
}: {
  interpretation: HistoricalFillInterpretationDto;
}) {
  const issues = presentInterpretationIssues(interpretation);
  return (
    <div className="space-y-2" data-testid="historical-fill-interpretation">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={toneForOperationalState(interpretation.state)}>{interpretation.state}</Badge>
        <p className="text-sm text-slate-200">{describeOperationalState(interpretation.state)}</p>
      </div>
      {issues.length === 0 ? null : (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {issues.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-sm text-slate-400">{row.label}</dt>
              <dd className="text-sm tabular-nums text-slate-200">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Manual guidance, collapsed by default.
 *
 * `<details>` and nothing else: no button, no onClick, no state. Whatever it
 * contains, an operator can only read it.
 */
function OperatorChecks({ children }: PropsWithChildren) {
  return (
    <details className="rounded-lg border border-surface-border p-2">
      <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-400">
        Operator checks
      </summary>
      <div className="mt-2 space-y-2">
        {children}
        <p className="text-xs text-slate-500">{HISTORICAL_FILL_EVIDENCE_NOTE}</p>
        <p className="text-xs text-slate-500">{HISTORICAL_FILL_ESCALATION}</p>
      </div>
    </details>
  );
}

/** Guidance for exactly the issues the server reported, in its order. */
function IssueRunbook({ interpretation }: { interpretation: HistoricalFillInterpretationDto }) {
  const items = presentIssueRunbook(interpretation);
  return (
    <OperatorChecks>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">{HISTORICAL_FILL_NORMAL_GUIDANCE}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.code} className="text-xs text-slate-400">
              <span className="block font-semibold text-slate-300">{item.meaning}</span>
              {item.operatorCheck}
            </li>
          ))}
        </ul>
      )}
    </OperatorChecks>
  );
}

/** The check for the reason the server actually reported -- never all five. */
function ProfileRunbook({ reason }: { reason: HistoricalFillProfileReason }) {
  return (
    <OperatorChecks>
      <p className="text-xs text-slate-400">{profileReasonCheck(reason)}</p>
    </OperatorChecks>
  );
}

function Section({ section }: { section: MetricSection }) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {section.title}
      </h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        {section.rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-sm text-slate-400">{row.label}</dt>
            <dd className="text-sm tabular-nums text-slate-200" title={row.title}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function HistoricalFillOperationsCard() {
  const { snapshot, error, loading, refreshing, authenticated, refresh } =
    useHistoricalFillOperations();

  return (
    <Card className="space-y-3 p-4" data-testid="historical-fill-operations-card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          Historical fill operations
        </h2>
        <Button
          variant="ghost"
          onClick={() => void refresh()}
          disabled={!authenticated || refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {!authenticated ? (
        <p className="text-sm text-slate-400">
          Authenticate above to read historical fill operations.
        </p>
      ) : loading ? (
        // Distinct from a loaded snapshot that happens to be all zeros.
        <p className="text-sm text-slate-400">Loading historical fill operations…</p>
      ) : error !== null ? (
        // The failure is reported as itself, never as zeros and never as a
        // configuration state the server did not report.
        <p className="text-sm text-slate-400">{error}</p>
      ) : snapshot === null ? null : snapshot.outcome === "PROFILE_UNAVAILABLE" ? (
        <div className="space-y-2">
          <InterpretationBlock interpretation={snapshot.interpretation} />
          {/* The factual reason survives interpretation; it is not collapsed
              into the scoped unavailable sentence. */}
          <p className="text-sm text-slate-200">{describeProfileReason(snapshot.reasonCode)}</p>
          <p className="text-xs text-slate-500">
            Captured {formatOptionalInstant(snapshot.capturedAt)}
          </p>
          <ProfileRunbook reason={snapshot.reasonCode} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-slate-500">
            <span title={snapshot.capturedAt}>
              Captured {formatOptionalInstant(snapshot.capturedAt)}
            </span>
            {/* A compact metadata row, not a headline figure. */}
            <span className="font-mono">Profile {snapshot.executionProfileId}</span>
          </div>
          <InterpretationBlock interpretation={snapshot.interpretation} />
          <IssueRunbook interpretation={snapshot.interpretation} />
          {presentHistoricalFillOperations(snapshot).map((section) => (
            <Section key={section.title} section={section} />
          ))}
        </div>
      )}
    </Card>
  );
}

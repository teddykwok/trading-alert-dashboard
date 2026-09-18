import type {
  HistoricalFillInterpretationDto,
  HistoricalFillOperationalIssueCode,
  HistoricalFillOperationalState,
  HistoricalFillOperationsDto,
  HistoricalFillProfileReason,
} from "../../api/operator";
import { formatDateTime } from "../../utils/formatDate";

/**
 * Every display decision the historical-fill panel makes, as pure functions.
 *
 * Same shape as `tradingControlPresentation`: the component stays a thin
 * mapping over these, so what an operator is actually told is asserted
 * directly rather than inferred from JSX -- which matters more than usual here,
 * because this repository has no DOM test environment.
 *
 * ## Renders verdicts, never reaches them
 *
 * This file now carries wording and a tone for an operational state -- but it
 * does not DECIDE that state. The server classifies, and everything here is a
 * lookup keyed by what the server said. There is no threshold, no comparison
 * and no arithmetic over the counts anywhere in this module, which is what
 * keeps the panel incapable of disagreeing with the API about what an operator
 * is looking at.
 *
 * The individual metrics stay exactly as factual as they were: no figure is
 * coloured or ranked by its own value.
 */

/** What a durable instant that does not exist renders as. */
export const NOT_AVAILABLE = "—";

/**
 * Factual wording for each binder reason.
 *
 * Descriptions of configuration, not judgements about it: no "broken", no
 * "critical", no instruction to act.
 */
export const PROFILE_REASON_WORDING: Record<HistoricalFillProfileReason, string> = {
  PROFILE_NOT_CONFIGURED: "No execution profile is configured.",
  PROFILE_NOT_FOUND: "The configured execution profile was not found.",
  PROFILE_AMBIGUOUS: "More than one execution profile matches the configured environment.",
  PROFILE_POLICY_MISSING: "The configured execution profile does not have the required policy.",
  PROFILE_ENVIRONMENT_MISMATCH: "The configured execution profile does not match this environment.",
};

export function describeProfileReason(reason: HistoricalFillProfileReason): string {
  return PROFILE_REASON_WORDING[reason];
}

/** A durable instant, or the neutral placeholder. Never "Never". */
export function formatOptionalInstant(value: string | null): string {
  return value === null ? NOT_AVAILABLE : formatDateTime(value);
}

/** The exact ISO string, for a title attribute. Absent when there is no instant. */
export function exactInstant(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

export interface MetricRow {
  label: string;
  value: string;
  /** The unabbreviated instant, when the row carries one. */
  title?: string;
}

export interface MetricSection {
  title: string;
  rows: MetricRow[];
}

const count = (value: number): string => String(value);

/**
 * The whole READY panel, as labelled sections.
 *
 * Labels are nouns describing what was counted. None of them asserts a state
 * of health, and none is derived from a threshold.
 */
export function presentHistoricalFillOperations(
  snapshot: Extract<HistoricalFillOperationsDto, { outcome: "READY" }>
): MetricSection[] {
  const { windows, pending, ledger } = snapshot;
  return [
    {
      title: "Window summary",
      rows: [
        { label: "Total windows", value: count(windows.total) },
        { label: "Roots", value: count(windows.roots) },
        { label: "Split children", value: count(windows.children) },
        { label: "Distinct symbols", value: count(windows.distinctSymbolCount) },
      ],
    },
    {
      title: "Window states",
      rows: [
        { label: "Pending", value: count(windows.byStatus.PENDING) },
        { label: "Complete", value: count(windows.byStatus.COMPLETE) },
        { label: "Split", value: count(windows.byStatus.SPLIT) },
        { label: "Incomplete / skipped rows", value: count(windows.byStatus.INCOMPLETE_SKIPPED_ROWS) },
        {
          label: "Saturated single millisecond",
          value: count(windows.byStatus.SATURATED_SINGLE_MILLISECOND),
        },
        { label: "Abandoned", value: count(windows.byStatus.ABANDONED) },
      ],
    },
    {
      title: "Pending work",
      rows: [
        { label: "Total pending", value: count(pending.total) },
        { label: "Claimable now", value: count(pending.claimableNow) },
        { label: "Active leases", value: count(pending.activeLease) },
        { label: "Stale leases", value: count(pending.staleLease) },
        { label: "In backoff", value: count(pending.inBackoff) },
        { label: "Attempt exhausted", value: count(pending.attemptExhausted) },
      ],
    },
    {
      title: "Queue timing",
      rows: [
        {
          label: "Oldest pending",
          value: formatOptionalInstant(pending.oldestPendingCreatedAt),
          title: exactInstant(pending.oldestPendingCreatedAt),
        },
        {
          label: "Oldest claimable",
          value: formatOptionalInstant(pending.oldestClaimableCreatedAt),
          title: exactInstant(pending.oldestClaimableCreatedAt),
        },
        {
          label: "Next backoff eligible",
          value: formatOptionalInstant(pending.nextBackoffEligibleAt),
          title: exactInstant(pending.nextBackoffEligibleAt),
        },
      ],
    },
    {
      title: "Fill ledger",
      rows: [
        { label: "Total fills", value: count(ledger.totalFills) },
        { label: "Unattributed fills", value: count(ledger.unattributedFills) },
      ],
    },
  ];
}

/**
 * What each server-assigned state is called in front of an operator.
 *
 * Every sentence is scoped to historical fills. None of them makes a claim
 * about the account, the exchange connection, or whether trading is safe --
 * this panel has never read anything that would justify one.
 */
export const HISTORICAL_FILL_STATE_WORDING: Record<HistoricalFillOperationalState, string> = {
  NORMAL: "No historical fill conditions currently require operator attention.",
  NEEDS_ATTENTION: "Historical fill ingestion has conditions that require operator review.",
  UNAVAILABLE: "Historical fill operational state is unavailable.",
};

export function describeOperationalState(state: HistoricalFillOperationalState): string {
  return HISTORICAL_FILL_STATE_WORDING[state];
}

/** The tones this panel may use. `red` is deliberately not among them. */
export type InterpretationTone = "green" | "yellow" | "gray";

/**
 * Tone per state, deliberately understated.
 *
 * Attention is amber, never red: NEEDS_ATTENTION means a durable condition is
 * worth an operator's review, not that anything is failing right now, and a
 * critical colour would overstate every one of the five triggers.
 */
export const HISTORICAL_FILL_STATE_TONE: Record<HistoricalFillOperationalState, InterpretationTone> =
  {
    NORMAL: "green",
    NEEDS_ATTENTION: "yellow",
    UNAVAILABLE: "gray",
  };

export function toneForOperationalState(state: HistoricalFillOperationalState): InterpretationTone {
  return HISTORICAL_FILL_STATE_TONE[state];
}

/**
 * Issue labels: nouns naming what was counted.
 *
 * No verbs, because a label here is not an instruction. What an operator should
 * DO about a stale lease is the runbook slice's subject, and wording it now
 * would commit this panel to advice nobody has reviewed.
 */
export const HISTORICAL_FILL_ISSUE_WORDING: Record<HistoricalFillOperationalIssueCode, string> = {
  // A noun like the rest, naming the STATE rather than counting anything: the
  // server always sends one for this code, because a latch is open or it is not.
  HISTORICAL_FILL_SYSTEMIC_CIRCUIT_OPEN: "Systemic circuit open (ingestion stopped)",
  STALE_LEASES_PRESENT: "Stale leases",
  ATTEMPT_EXHAUSTED_PRESENT: "Pending windows at the attempt limit",
  ABANDONED_WINDOWS_PRESENT: "Abandoned windows",
  INCOMPLETE_SKIPPED_ROWS_PRESENT: "Windows completed with skipped rows",
  SATURATED_SINGLE_MILLISECOND_PRESENT: "Windows saturated at single-millisecond granularity",
};

/**
 * The issue rows, in the order the server sent them.
 *
 * Every issue is rendered. None is dropped, merged, re-ordered or promoted,
 * so a second condition can never be hidden behind the first.
 */
export function presentInterpretationIssues(
  interpretation: HistoricalFillInterpretationDto
): MetricRow[] {
  return interpretation.issues.map((issue) => ({
    label: HISTORICAL_FILL_ISSUE_WORDING[issue.code],
    value: count(issue.count),
  }));
}

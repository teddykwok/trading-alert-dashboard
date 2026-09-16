import type {
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
 * ## No verdicts
 *
 * Nothing in this file decides whether a number is good. There is no tone, no
 * severity, no threshold and no recommendation, and that is deliberate: a
 * stale lease or an abandoned window is a fact an operator reads, and deciding
 * what it MEANS is a later slice's job. Introducing a colour here would quietly
 * make this file the owner of a policy it has not been given.
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

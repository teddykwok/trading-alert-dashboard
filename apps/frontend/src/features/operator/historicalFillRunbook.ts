import type {
  HistoricalFillInterpretationDto,
  HistoricalFillOperationalIssueCode,
  HistoricalFillProfileReason,
} from "../../api/operator";

/**
 * Manual operator guidance for the historical-fill conditions the SERVER
 * reports. Pure data and two lookups -- nothing here decides anything.
 *
 * ## This file is not policy
 *
 * The backend classifier decides the state and the issue codes. This module is
 * keyed BY those codes and never reads a count, so guidance cannot disagree
 * with the verdict it explains, and a threshold cannot sneak in through the
 * back door of "advice".
 *
 * ## This file is not a control
 *
 * Every check is read-only: review, verify, compare, escalate. There is no
 * remediation step here and no button anywhere on the panel, because re-opening
 * durable ingestion state is a deliberate engineering act, not a dashboard
 * click -- and the evidence needed to do it safely is not even on this screen
 * (see `HISTORICAL_FILL_EVIDENCE_NOTE`).
 */

export interface IssueRunbookEntry {
  /** What the condition IS, in the ingestion model's own terms. */
  meaning: string;
  /** What a human may safely look at. Read-only verbs only. */
  operatorCheck: string;
}

/**
 * One entry per issue code, enforced by `Record`: a sixth code added to the
 * contract will not compile until it has guidance, so an operator can never
 * meet a condition the runbook has never heard of.
 */
export const HISTORICAL_FILL_ISSUE_RUNBOOK: Record<
  HistoricalFillOperationalIssueCode,
  IssueRunbookEntry
> = {
  HISTORICAL_FILL_SYSTEMIC_CIRCUIT_OPEN: {
    meaning:
      "Repeated failures of a single kind tripped this account's systemic circuit, so historical ingestion is stopped entirely and no further request will be admitted until a person clears it.",
    operatorCheck:
      "Review the reported failure family, last reason code and opening time to identify the external cause, and confirm it is resolved. Clearing the latch is a separate, deliberate command run outside this panel; it clears the latch only and starts or resumes nothing.",
  },
  STALE_LEASES_PRESENT: {
    meaning:
      "A pending ingestion window holds a claim whose lease is older than the configured lease boundary.",
    operatorCheck:
      "Review the recorded claim and attempt history for the affected historical-fill work, and check whether the condition clears on a later refresh, before considering any manual recovery.",
  },
  ATTEMPT_EXHAUSTED_PRESENT: {
    meaning: "One or more pending windows have reached the configured attempt limit.",
    operatorCheck:
      "Review the repeated ingestion failures that exhausted the attempt budget before planning any recovery.",
  },
  ABANDONED_WINDOWS_PRESENT: {
    meaning:
      "One or more ingest windows reached their terminal abandoned state, which the ingestion model treats as a known coverage gap.",
    operatorCheck:
      "Review the failure history that led the window to that state before deciding on a controlled recovery.",
  },
  INCOMPLETE_SKIPPED_ROWS_PRESENT: {
    meaning:
      "A window finished without accepting every row the exchange returned, so that interval carries a known coverage gap.",
    operatorCheck:
      "Review why returned rows were skipped before treating the affected historical interval as fully reconciled.",
  },
  SATURATED_SINGLE_MILLISECOND_PRESENT: {
    meaning:
      "An exchange page stayed saturated at single-millisecond granularity, so the planner had no smaller interval left to ask for.",
    operatorCheck:
      "Review the saturated one-millisecond interval before planning a targeted recovery.",
  },
};

export interface ProfileReasonRunbookEntry {
  operatorCheck: string;
}

/**
 * One entry per binder reason. These are configuration checks, not fixes, and
 * none of them names or displays a secret value.
 */
export const HISTORICAL_FILL_PROFILE_RUNBOOK: Record<
  HistoricalFillProfileReason,
  ProfileReasonRunbookEntry
> = {
  PROFILE_NOT_CONFIGURED: {
    operatorCheck:
      "Verify that the intended execution profile configuration is present for this deployment environment.",
  },
  PROFILE_NOT_FOUND: {
    operatorCheck:
      "Verify that the configured execution profile still exists in the current environment.",
  },
  PROFILE_AMBIGUOUS: {
    operatorCheck:
      "Verify that the current environment resolves to exactly one execution profile.",
  },
  PROFILE_POLICY_MISSING: {
    operatorCheck:
      "Verify that the configured execution profile has the required policy record.",
  },
  PROFILE_ENVIRONMENT_MISMATCH: {
    operatorCheck:
      "Verify that the configured environment and the execution profile binding agree.",
  },
};

/** NORMAL, scoped to this subsystem and to this snapshot. Never a global claim. */
export const HISTORICAL_FILL_NORMAL_GUIDANCE =
  "No historical-fill runbook action is indicated by the current snapshot.";

/**
 * The boundary. Preferred over handing an operator a durable-state edit: the
 * per-window evidence is not on this screen, so anyone acting from this panel
 * alone would be acting blind.
 */
export const HISTORICAL_FILL_ESCALATION =
  "If the condition cannot be explained from the available evidence, escalate for engineering review before changing durable ingestion state.";

/**
 * What this panel can and cannot show, stated plainly.
 *
 * Audited, not assumed: the historical-fill execution modules emit no runtime
 * logs at all, and no route exposes window ids, symbols, interval bounds,
 * attempt counts, claim owners or recorded failure reasons. Telling an operator
 * to "check the logs" would be an instruction to go looking for something that
 * does not exist.
 */
export const HISTORICAL_FILL_EVIDENCE_NOTE =
  "This panel reports counts only. Per-window identifiers, attempt counts, claim owners and recorded failure reasons live in durable ingestion records that are not exposed here, and the historical-fill execution path emits no runtime logs.";

export interface RunbookItem {
  code: HistoricalFillOperationalIssueCode;
  meaning: string;
  operatorCheck: string;
}

/**
 * Guidance for exactly the issues the server sent, in the order it sent them.
 *
 * Not sorted, not ranked, not filtered by count: the server's order IS the
 * order, and presenting one condition ahead of another would invent a severity
 * the contract deliberately does not have.
 */
export function presentIssueRunbook(interpretation: HistoricalFillInterpretationDto): RunbookItem[] {
  return interpretation.issues.map((issue) => ({
    code: issue.code,
    meaning: HISTORICAL_FILL_ISSUE_RUNBOOK[issue.code].meaning,
    operatorCheck: HISTORICAL_FILL_ISSUE_RUNBOOK[issue.code].operatorCheck,
  }));
}

/** The check for one binder reason -- never all five at once. */
export function profileReasonCheck(reason: HistoricalFillProfileReason): string {
  return HISTORICAL_FILL_PROFILE_RUNBOOK[reason].operatorCheck;
}

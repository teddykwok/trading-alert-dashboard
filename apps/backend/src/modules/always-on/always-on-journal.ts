import { ALWAYS_ON_INCIDENT_SCHEMA, type AlwaysOnRole } from "./always-on-contract";

/**
 * THE INCIDENT JOURNAL: an append-only JSONL file of meaningful TRANSITIONS
 * (never one line per health poll), outside the repository and outside the
 * application database.
 *
 * Every line is produced by this module from fixed reason codes, numbers, run
 * ids and pids. Nothing reads an environment value into it, and a final
 * redaction pass removes anything that looks like a credential assignment or a
 * URL carrying a user — so a line can be pasted into a chat window.
 *
 * Writing is best effort: a journal that cannot be written is reported on the
 * console and never stops supervision (observation must not become an outage).
 */

export const INCIDENT_KINDS = Object.freeze([
  "SUPERVISOR_STARTED",
  "SUPERVISOR_STOPPING",
  "SUPERVISOR_STOPPED",
  "SUPERVISOR_DETACHED",
  "SUPERVISOR_FENCED",
  "SUPERVISOR_RESUMED_AFTER_GAP",
  "SUPERVISOR_DEGRADED",
  "SUPERVISOR_RETURNED_HEALTHY",
  "SUPERVISOR_ENTERED_BACKOFF",
  "SUPERVISOR_LATCHED",
  "SUPERVISOR_TICK_FAILED",
  "OBSERVATION_FAILED",
  "OWNERSHIP_READ_FAILED",
  "OWNERSHIP_READ_RESTORED",
  "OWNERSHIP_WRITE_FAILED",
  "OWNERSHIP_WRITE_RESTORED",
  "CREDENTIALS_STRIPPED",
  "CHILD_ADOPTED",
  "CHILD_RECORD_DROPPED",
  "ROLE_STARTED",
  "ROLE_START_FAILED",
  "ROLE_EXITED",
  "ROLE_STOP_REQUESTED",
  "ROLE_STOPPED",
  "ROLE_FORCE_STOPPED",
  "ROLE_STOP_FAILED",
  "ROLE_CONFLICT",
  "ROLE_CONFLICT_CLEARED",
  "ROLE_BLOCKED",
  "ROLE_DEGRADED",
  "ROLE_HEALTHY",
  "ROLE_LATCHED",
  "LATCH_CLEARED",
  "BACKOFF_ENTERED",
  "SCANNER_DEGRADED",
  "NETWORK_UNAVAILABLE",
  "NETWORK_RESTORED",
  "SCANNER_RECOVERY_REQUESTED",
  "SCANNER_RECOVERY_SUCCEEDED",
  "SCANNER_RECOVERY_FAILED",
  "SCANNER_RUN_IDENTIFIED",
  "EMITTER_STOPPED_RUN_SUPERSEDED",
  "EMITTER_STARTED_ON_RUN",
  "LARGE_BACKLOG_DETECTED",
  "BACKLOG_DRAINED",
  "PLANNER_BASELINE_ESTABLISHED",
  "PLANNER_BASELINE_RESET",
  "PLANNER_FAILURE_DELTA_INCREASED",
  "DATA_STORE_UNAVAILABLE",
  "DATA_STORE_RESTORED",
  "EXTERNAL_MONITORING_PROCESS",
  // The operator network drill (always-on-drill.ts): every request, start, end and confirmation.
  "DRILL_REJECTED",
  "DRILL_STARTED",
  "DRILL_ACTIVATION_CONFIRMED",
  "DRILL_ACTIVATION_UNCONFIRMED",
  "DRILL_RESTORE_REQUESTED",
  "DRILL_ENDED",
  "DRILL_RESTORE_CONFIRMED",
  "DRILL_RESTORE_UNCONFIRMED",
  "DRILL_STALE_REMOVED",
] as const);
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export type IncidentFacts = Readonly<Record<string, string | number | boolean | null>>;

export interface IncidentEvent {
  readonly kind: IncidentKind;
  readonly role?: AlwaysOnRole | null;
  readonly reasonCode?: string | null;
  /** Operator-readable sentence. Built from fixed text and numbers only. */
  readonly detail?: string | null;
  readonly facts?: IncidentFacts;
}

export interface IncidentRecord {
  readonly schema: typeof ALWAYS_ON_INCIDENT_SCHEMA;
  readonly generation: number;
  readonly seq: number;
  readonly at: string;
  readonly kind: IncidentKind;
  readonly role: AlwaysOnRole | null;
  readonly reasonCode: string | null;
  readonly detail: string | null;
  readonly facts: IncidentFacts;
}

/** Defence in depth: nothing that looks like a secret assignment or a credentialed URL ever reaches the journal. */
export function redactIncidentText(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/((?:API_KEY|API_SECRET|SECRET|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL)\s*[=:]\s*)\S+/gi, "$1***");
}

export interface IncidentJournalDeps {
  readonly file: string;
  /** Appends ONE line durably (the real adapter fsyncs). */
  readonly append: (file: string, line: string) => void;
  readonly now: () => number;
  readonly generation: () => number;
  readonly log: (line: string) => void;
}

export class IncidentJournal {
  private seq = 0;
  private readonly recent: IncidentRecord[] = [];

  constructor(private readonly deps: IncidentJournalDeps) {}

  record(event: IncidentEvent): IncidentRecord {
    this.seq += 1;
    const facts: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(event.facts ?? {})) facts[key] = typeof value === "string" ? redactIncidentText(value) : value;
    const record: IncidentRecord = {
      schema: ALWAYS_ON_INCIDENT_SCHEMA,
      generation: this.deps.generation(),
      seq: this.seq,
      at: new Date(this.deps.now()).toISOString(),
      kind: event.kind,
      role: event.role ?? null,
      reasonCode: event.reasonCode ?? null,
      detail: event.detail == null ? null : redactIncidentText(event.detail),
      facts,
    };
    try {
      this.deps.append(this.deps.file, `${JSON.stringify(record)}\n`);
    } catch (error) {
      this.deps.log(`incident journal not written (${error instanceof Error ? error.name : "unknown"}); supervision continues`);
    }
    this.recent.push(record);
    if (this.recent.length > 50) this.recent.shift();
    this.deps.log(`[incident] ${record.kind}${record.role ? ` ${record.role}` : ""}${record.reasonCode ? ` ${record.reasonCode}` : ""}${record.detail ? ` — ${record.detail}` : ""}`);
    return record;
  }

  /** The most recent records this process wrote (for the status artifact). */
  latest(count: number): readonly IncidentRecord[] {
    return this.recent.slice(-count);
  }
}

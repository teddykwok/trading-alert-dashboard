/**
 * 24-HOUR SOAK CONTINUITY: was the monitoring run actually continuous?
 *
 * Judged only from the soak monitor's own snapshots. Pure: the same snapshots
 * always give the same verdict. A soak is CONTINUOUS only when the snapshots
 * cover the whole window at the expected cadence and every one of them saw a
 * reachable backend, a RUNNING scanner on ONE run and a RUNNING emitter.
 * Anything else is SOAK_INTERRUPTED, with each reason and when it was seen.
 * A recovered dataset (FAST_RECOVERY after a stop) is useful, but it is not an
 * uninterrupted real-time soak, and this never pretends otherwise.
 */

export interface SoakSnapshotFacts {
  /** Wall-clock instant the snapshot was taken. */
  readonly takenAtMs: number;
  readonly backendReachable: boolean;
  readonly scannerState: string | null;
  readonly scannerRunId: string | null;
  readonly emitterState: string | null;
}

export interface SoakPlan {
  readonly soakStartMs: number;
  readonly expectedSoakEndMs: number;
  readonly intervalMs: number;
}

export const SOAK_INTERRUPTION_KINDS = [
  "MONITOR_STARTED_LATE",
  "MONITOR_GAP",
  "MONITOR_ENDED_EARLY",
  "BACKEND_UNREACHABLE",
  "SCANNER_NOT_RUNNING",
  "SCANNER_RESTARTED",
  "EMITTER_NOT_RUNNING",
] as const;
export type SoakInterruptionKind = (typeof SOAK_INTERRUPTION_KINDS)[number];

export interface SoakInterruption {
  readonly kind: SoakInterruptionKind;
  readonly at: string;
  readonly detail: string;
}

export interface SoakContinuity {
  readonly verdict: "CONTINUOUS" | "SOAK_INTERRUPTED" | "IN_PROGRESS";
  readonly soakStart: string;
  readonly expectedSoakEnd: string;
  /** The last snapshot once the expected end has passed, or null while the soak is still running. */
  readonly actualSoakEnd: string | null;
  readonly snapshots: number;
  readonly interruptions: readonly SoakInterruption[];
}

/** A gap longer than this many intervals between snapshots means the monitor (or the machine) stopped. */
export const SOAK_GAP_TOLERANCE_INTERVALS = 2;

export function assessSoakContinuity(plan: SoakPlan, snapshots: readonly SoakSnapshotFacts[], nowMs: number): SoakContinuity {
  const ordered = [...snapshots].sort((a, b) => a.takenAtMs - b.takenAtMs);
  const iso = (ms: number) => new Date(ms).toISOString();
  const tolerance = SOAK_GAP_TOLERANCE_INTERVALS * plan.intervalMs;
  const out: SoakInterruption[] = [];
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  if (first === undefined) {
    return {
      verdict: nowMs >= plan.soakStartMs + tolerance ? "SOAK_INTERRUPTED" : "IN_PROGRESS",
      soakStart: iso(plan.soakStartMs),
      expectedSoakEnd: iso(plan.expectedSoakEndMs),
      actualSoakEnd: null,
      snapshots: 0,
      interruptions: nowMs >= plan.soakStartMs + tolerance ? [{ kind: "MONITOR_STARTED_LATE", at: iso(nowMs), detail: "no snapshot was taken after the soak started" }] : [],
    };
  }
  if (first.takenAtMs - plan.soakStartMs > tolerance) out.push({ kind: "MONITOR_STARTED_LATE", at: iso(first.takenAtMs), detail: `the first snapshot came ${Math.round((first.takenAtMs - plan.soakStartMs) / 60_000)} min after the soak started` });

  let previous: SoakSnapshotFacts | null = null;
  for (const s of ordered) {
    if (previous !== null && s.takenAtMs - previous.takenAtMs > tolerance) {
      out.push({ kind: "MONITOR_GAP", at: iso(previous.takenAtMs), detail: `no snapshot for ${Math.round((s.takenAtMs - previous.takenAtMs) / 60_000)} min (crash, stop, sleep or lid closed)` });
    }
    if (!s.backendReachable) out.push({ kind: "BACKEND_UNREACHABLE", at: iso(s.takenAtMs), detail: "the generic backend did not answer" });
    else {
      if (s.scannerState !== "RUNNING") out.push({ kind: "SCANNER_NOT_RUNNING", at: iso(s.takenAtMs), detail: `scanner state ${s.scannerState ?? "unknown"}` });
      if (s.emitterState !== "RUNNING") out.push({ kind: "EMITTER_NOT_RUNNING", at: iso(s.takenAtMs), detail: `emitter state ${s.emitterState ?? "unknown"}` });
      if (previous !== null && previous.backendReachable && previous.scannerRunId !== null && s.scannerRunId !== null && s.scannerRunId !== previous.scannerRunId) {
        out.push({ kind: "SCANNER_RESTARTED", at: iso(s.takenAtMs), detail: `scanner run changed from ${previous.scannerRunId} to ${s.scannerRunId}` });
      }
    }
    previous = s;
  }

  const finished = nowMs >= plan.expectedSoakEndMs;
  if (finished && last !== undefined && plan.expectedSoakEndMs - last.takenAtMs > tolerance) {
    out.push({ kind: "MONITOR_ENDED_EARLY", at: iso(last.takenAtMs), detail: `the last snapshot came ${Math.round((plan.expectedSoakEndMs - last.takenAtMs) / 60_000)} min before the expected end` });
  }
  if (!finished && last !== undefined && nowMs - last.takenAtMs > tolerance) {
    out.push({ kind: "MONITOR_GAP", at: iso(last.takenAtMs), detail: `no snapshot for ${Math.round((nowMs - last.takenAtMs) / 60_000)} min so far` });
  }
  return {
    verdict: out.length > 0 ? "SOAK_INTERRUPTED" : finished ? "CONTINUOUS" : "IN_PROGRESS",
    soakStart: iso(plan.soakStartMs),
    expectedSoakEnd: iso(plan.expectedSoakEndMs),
    actualSoakEnd: finished && last !== undefined ? iso(last.takenAtMs) : null,
    snapshots: ordered.length,
    interruptions: out,
  };
}

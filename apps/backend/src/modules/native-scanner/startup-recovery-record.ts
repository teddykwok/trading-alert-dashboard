import { closeSync, existsSync, linkSync, mkdirSync, openSync, unlinkSync, writeSync, fsyncSync } from "node:fs";
import path from "node:path";

import type { StartupRecoverySummary } from "./live-shadow-supervisor";

/**
 * A FAILED start-up's recovery summary, kept on disk.
 *
 * A successful start-up's summary already lives in the run's status.json
 * (`recovery`). A start-up that throws never reaches status.json, so its
 * summary existed only on the terminal. This writes ONE compact file in that
 * run's own directory.
 *
 * Observation only. It is not scanner state, checkpoint evidence, delivery
 * evidence or execution-integrity evidence, and nothing reads it: the scanner
 * reads its engine directories, the emitter reads manifest.json and
 * membership.jsonl by name, and the status page reads status.json by name.
 * Writing it can never mask the start-up failure it describes.
 */

export const STARTUP_RECOVERY_RECORD_FILE = "startup-recovery.json";
export const STARTUP_RECOVERY_RECORD_SCHEMA = "teddy.native-scanner.startup-recovery.v1";

export interface StartupRecoveryRecord {
  readonly schema: typeof STARTUP_RECOVERY_RECORD_SCHEMA;
  readonly notice: string;
  readonly actionable: false;
  readonly runId: string;
  readonly outcome: "STARTUP_FAILED";
  /** The supervisor's start-up summary, field by field (numbers, the policy label and timestamps only), or null. */
  readonly recovery: StartupRecoverySummary | null;
  /** The error's class, its code when it has one, and its message with any URL or key-like token removed. */
  readonly failure: { readonly name: string; readonly code: string | null; readonly message: string };
  readonly writtenAt: string;
}

const MAX_MESSAGE_CHARS = 500;

/** No URL (they can carry query strings) and no long key-like token survives into the record. */
export function sanitizeFailureMessage(message: string): string {
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "<redacted>")
    .slice(0, MAX_MESSAGE_CHARS);
}

/** Copies exactly the summary's own fields: nothing else on the object (or anything added to it) can leak in. */
function summaryFields(r: StartupRecoverySummary): StartupRecoverySummary {
  return {
    policy: r.policy,
    symbols: r.symbols,
    liveReady: r.liveReady,
    recovered: r.recovered,
    current: r.current,
    bootstrapped: r.bootstrapped,
    notLive: r.notLive,
    missingBarsReplayed: r.missingBarsReplayed,
    restRequests: r.restRequests,
    restWeight: r.restWeight,
    serverClockRequests: r.serverClockRequests,
    maxRequestsInFlight: r.maxRequestsInFlight,
    workerConcurrency: r.workerConcurrency,
    weightWaits: r.weightWaits,
    usedWeightPauses: r.usedWeightPauses,
    peakReportedUsedWeight: r.peakReportedUsedWeight,
    elapsedMs: r.elapsedMs,
    completedAt: r.completedAt,
  };
}

export function startupRecoveryRecordOf(input: { readonly runId: string; readonly recovery: StartupRecoverySummary | null; readonly error: unknown; readonly writtenAt: string }): StartupRecoveryRecord {
  const error = input.error;
  const name = error instanceof Error ? error.name : typeof error;
  const rawCode = error !== null && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : null;
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : null;
  const message = error instanceof Error ? error.message : String(error);
  return {
    schema: STARTUP_RECOVERY_RECORD_SCHEMA,
    notice: "Observation only: a failed scanner start-up's recovery summary. Not scanner state, checkpoint, delivery or execution evidence.",
    actionable: false,
    runId: input.runId,
    outcome: "STARTUP_FAILED",
    recovery: input.recovery === null ? null : summaryFields(input.recovery),
    failure: { name: sanitizeFailureMessage(name).slice(0, 64), code, message: sanitizeFailureMessage(message) },
    writtenAt: input.writtenAt,
  };
}

/**
 * Writes the record into `runDir` exactly once: a temp file, then an atomic
 * hard link to the final name, which fails if the name exists — so an
 * existing record is never overwritten, even by a racing writer.
 */
export function writeStartupRecoveryRecordOnce(runDir: string, record: StartupRecoveryRecord): "WRITTEN" | "ALREADY_PRESENT" {
  const file = path.join(runDir, STARTUP_RECOVERY_RECORD_FILE);
  mkdirSync(runDir, { recursive: true });
  if (existsSync(file)) return "ALREADY_PRESENT";
  const temporary = `${file}.${record.writtenAt.replace(/[^0-9]/g, "")}.tmp`;
  const fd = openSync(temporary, "wx");
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, file);
    return "WRITTEN";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "ALREADY_PRESENT";
    throw error;
  } finally {
    unlinkSync(temporary);
  }
}

/**
 * Runs the start-up; if it throws, records the failure (best effort) and then
 * rethrows the ORIGINAL error. A failure to record is reported and swallowed:
 * it never replaces or masks the start-up failure.
 */
export async function startRecordingFailure(start: () => Promise<void>, record: (error: unknown) => void, report: (line: string) => void): Promise<void> {
  try {
    await start();
  } catch (error) {
    try {
      record(error);
    } catch (recordError) {
      report(`${STARTUP_RECOVERY_RECORD_FILE} not written (${recordError instanceof Error ? recordError.name : "unknown"}); the start-up failure follows`);
    }
    throw error;
  }
}

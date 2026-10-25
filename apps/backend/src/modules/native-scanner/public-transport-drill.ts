/**
 * THE PUBLIC TRANSPORT DRILL — the scanner's half of the Always-On operator
 * network drill (Gate 4A). OPERATIONAL ONLY: it never changes what the
 * scanner computes, only whether its PUBLIC market-data transports reach the
 * network for a bounded while.
 *
 * ## Who can start one
 *
 * Nobody but the running Always-On supervisor of the current generation, and
 * only after it has validated an operator's explicit, short-lived drill
 * request (always-on-drill.ts). It writes ONE file beside the cooperative stop
 * file it handed this scanner at spawn time (`<stop file>.drill`), naming this
 * scanner's run id. A scanner started without a stop file (by hand, or by
 * anything other than Always-On) has no drill file at all. There is no flag,
 * no environment variable and no other input.
 *
 * ## What a drill does
 *
 *   REST         REFUSED: every public request fails exactly as undici fails on
 *                a refused connection (TypeError "fetch failed", ECONNREFUSED);
 *                the network is never asked
 *   open streams DROP: every connection open at activation is closed for real
 *                and reported as an abnormal close (1006); SILENT: connections
 *                stay open and deliver nothing (half-open)
 *   new streams  REFUSED: no connection is attempted; each fails asynchronously
 *                (error, then close 1006) like a refused handshake
 *
 * It can only refuse, drop or silence: no URL, host, header or redirect can be
 * expressed (the file format refuses any field it does not know), so it can
 * never send a request anywhere the scanner would not.
 *
 * ## How a drill always ends
 *
 * At its expiry — checked on every transport use, on the wall clock AND on a
 * monotonic deadline fixed at activation, so a wall clock moved backwards
 * cannot extend it — or as soon as its file is gone, unreadable or invalid
 * (fail-safe: inactive). The window is at most PUBLIC_TRANSPORT_DRILL_MAX_MS.
 * An ended drill id never reactivates, and another run's drill never
 * activates. None of this needs the supervisor or the operator's controller to
 * stay alive.
 */

export const PUBLIC_TRANSPORT_DRILL_SCHEMA = "teddy.native-monitoring.public-transport-drill.v1";
/** The longest drill window there can be (15 minutes). */
export const PUBLIC_TRANSPORT_DRILL_MAX_MS = 15 * 60_000;
/** How far a drill's start may lie ahead of this process's clock (both are the same machine's clock). */
export const PUBLIC_TRANSPORT_DRILL_SKEW_MS = 5_000;

export type DrillRestFault = "REFUSED";
export type DrillOpenStreamFault = "DROP" | "SILENT";
export type DrillNewStreamFault = "REFUSED";

/** What a drill does to each public transport (null: untouched). */
export interface PublicTransportDrillFaults {
  readonly rest: DrillRestFault | null;
  readonly openStreams: DrillOpenStreamFault | null;
  readonly newStreams: DrillNewStreamFault | null;
}

export interface PublicTransportDrill {
  /** The operator's request id (128-bit hex): one drill, one id, used once. */
  readonly drillId: string;
  /** The catalogue name the operator chose (audit only; the faults below are what applies). */
  readonly fault: string;
  /** The ONE scanner run this drill is for. */
  readonly runId: string;
  /** The Always-On generation that wrote it (audit only). */
  readonly generation: number;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly faults: PublicTransportDrillFaults;
}

const DRILL_ID = /^[0-9a-f]{32}$/;
const FAULT_NAME = /^[A-Z][A-Z_]{2,47}$/;
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const KEYS: readonly string[] = ["schema", "drillId", "fault", "runId", "generation", "startedAt", "expiresAt", "faults"];
const FAULT_KEYS: readonly string[] = ["rest", "openStreams", "newStreams"];

/** The drill file of one spawned scanner: beside its cooperative stop file. */
export function drillFileOf(stopFile: string): string {
  if (!/\.stop$/i.test(stopFile)) throw new Error("a drill file sits beside a cooperative stop file (*.stop)");
  return stopFile.replace(/\.stop$/i, ".drill");
}

const isoOf = (ms: number) => new Date(ms).toISOString();

/** The one serializer of the drill file (the supervisor writes exactly this). */
export function publicTransportDrillText(drill: PublicTransportDrill): string {
  return `${JSON.stringify(
    {
      schema: PUBLIC_TRANSPORT_DRILL_SCHEMA,
      drillId: drill.drillId,
      fault: drill.fault,
      runId: drill.runId,
      generation: drill.generation,
      startedAt: isoOf(drill.startedAtMs),
      expiresAt: isoOf(drill.expiresAtMs),
      faults: { rest: drill.faults.rest, openStreams: drill.faults.openStreams, newStreams: drill.faults.newStreams },
    },
    null,
    2
  )}\n`;
}

export type PublicTransportDrillInvalidReason = "UNREADABLE" | "SCHEMA_INVALID" | "FIELD_INVALID" | "FAULTS_INVALID" | "WINDOW_INVALID" | "RUN_MISMATCH";

export type PublicTransportDrillVerdict =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "INVALID"; readonly reason: PublicTransportDrillInvalidReason }
  | { readonly kind: "VALID"; readonly drill: PublicTransportDrill };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (record: Record<string, unknown>, keys: readonly string[]) => Object.keys(record).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));

/** A canonical ISO instant (exactly as the serializer writes it), or null. */
function instantOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && isoOf(ms) === value ? ms : null;
}

function faultsOf(value: unknown): PublicTransportDrillFaults | null {
  if (!isRecord(value) || !exactKeys(value, FAULT_KEYS)) return null;
  const { rest, openStreams, newStreams } = value;
  if (rest !== null && rest !== "REFUSED") return null;
  if (openStreams !== null && openStreams !== "DROP" && openStreams !== "SILENT") return null;
  if (newStreams !== null && newStreams !== "REFUSED") return null;
  if (rest === null && openStreams === null && newStreams === null) return null;
  return { rest, openStreams, newStreams };
}

/**
 * Reads a drill file for the scanner run `runId`. VALID only for a well-formed drill of exactly that run, with a
 * non-empty window of at most the maximum; whether it is current (started, unexpired) is the gate's decision.
 */
export function parsePublicTransportDrill(text: string | null, runId: string): PublicTransportDrillVerdict {
  if (text === null) return { kind: "ABSENT" };
  const invalid = (reason: PublicTransportDrillInvalidReason): PublicTransportDrillVerdict => ({ kind: "INVALID", reason });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid("UNREADABLE");
  }
  if (!isRecord(raw)) return invalid("UNREADABLE");
  if (raw.schema !== PUBLIC_TRANSPORT_DRILL_SCHEMA) return invalid("SCHEMA_INVALID");
  if (!exactKeys(raw, KEYS)) return invalid("FIELD_INVALID");
  const { drillId, fault, runId: drillRunId, generation, startedAt, expiresAt } = raw;
  if (typeof drillId !== "string" || !DRILL_ID.test(drillId)) return invalid("FIELD_INVALID");
  if (typeof fault !== "string" || !FAULT_NAME.test(fault)) return invalid("FIELD_INVALID");
  if (typeof drillRunId !== "string" || !RUN_ID.test(drillRunId)) return invalid("FIELD_INVALID");
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return invalid("FIELD_INVALID");
  const startedAtMs = instantOf(startedAt);
  const expiresAtMs = instantOf(expiresAt);
  if (startedAtMs === null || expiresAtMs === null) return invalid("FIELD_INVALID");
  const faults = faultsOf(raw.faults);
  if (faults === null) return invalid("FAULTS_INVALID");
  if (expiresAtMs <= startedAtMs || expiresAtMs - startedAtMs > PUBLIC_TRANSPORT_DRILL_MAX_MS) return invalid("WINDOW_INVALID");
  if (drillRunId !== runId) return invalid("RUN_MISMATCH");
  return { kind: "VALID", drill: { drillId, fault, runId: drillRunId, generation, startedAtMs, expiresAtMs, faults } };
}

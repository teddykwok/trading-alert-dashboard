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

import type { PublicHttpTransport } from "./kline-fetcher";
import type { OpenPublicStream, StreamConnection, StreamHandlers } from "./live-shadow-runner";

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

// ---------------------------------------------------------------------------
// The gate: which drill (if any) applies to this process right now
// ---------------------------------------------------------------------------

export type PublicTransportDrillEndReason = "EXPIRED" | "FILE_REMOVED" | "FILE_INVALID" | "SUPERSEDED";

/** What the scanner reports in its status (only once it has seen a drill: a status without one is unchanged). */
export interface PublicTransportDrillObservation {
  readonly drillId: string;
  readonly fault: string;
  readonly active: boolean;
  readonly activatedAt: string;
  readonly endedAt: string | null;
  readonly endReason: PublicTransportDrillEndReason | null;
}

/** The part of the gate the transports use. */
export interface PublicTransportDrillSource {
  faults(): PublicTransportDrillFaults | null;
  /** Called once per activated drill, with its faults (the streams drop their open connections on DROP). */
  onActivate(listener: (faults: PublicTransportDrillFaults) => void): void;
}

export interface PublicTransportDrillGateDeps {
  readonly file: string;
  readonly runId: string;
  /** The drill file's text, or null when it is absent or cannot be read. */
  readonly readText: (file: string) => string | null;
  readonly nowMs: () => number;
  /** A monotonic clock (never moved by a wall-clock change). */
  readonly monoMs: () => number;
  readonly log: (line: string) => void;
}

interface CurrentDrill {
  readonly drill: PublicTransportDrill;
  readonly activatedAtMs: number;
  readonly monoDeadline: number;
  endedAtMs: number | null;
  endReason: PublicTransportDrillEndReason | null;
}

/**
 * Polled once a second by the scanner CLI (and asked on every transport use). Active only between a valid drill
 * file's activation and the first of: its expiry (wall clock), its monotonic deadline, its file going away or turning
 * invalid, or a newer drill. Every drill id is applied at most once.
 */
export class PublicTransportDrillGate implements PublicTransportDrillSource {
  private current: CurrentDrill | null = null;
  private readonly finished = new Set<string>();
  private readonly listeners: ((faults: PublicTransportDrillFaults) => void)[] = [];

  constructor(private readonly deps: PublicTransportDrillGateDeps) {}

  onActivate(listener: (faults: PublicTransportDrillFaults) => void): void {
    this.listeners.push(listener);
  }

  poll(): void {
    let text: string | null;
    try {
      text = this.deps.readText(this.deps.file);
    } catch {
      text = null;
    }
    const verdict = parsePublicTransportDrill(text, this.deps.runId);
    const active = this.active();
    if (verdict.kind !== "VALID") {
      if (active !== null) this.end(active, verdict.kind === "ABSENT" ? "FILE_REMOVED" : "FILE_INVALID");
      return;
    }
    const drill = verdict.drill;
    if (active !== null && active.drill.drillId === drill.drillId) return;
    if (active !== null) this.end(active, "SUPERSEDED");
    if (this.finished.has(drill.drillId)) return;
    const now = this.deps.nowMs();
    if (now < drill.startedAtMs - PUBLIC_TRANSPORT_DRILL_SKEW_MS || now >= drill.expiresAtMs) {
      // Not current for this clock: never applied, then or later.
      this.finished.add(drill.drillId);
      this.deps.log(`public transport drill ${drill.drillId} (${drill.fault}) NOT applied: its window ${isoOf(drill.startedAtMs)}..${isoOf(drill.expiresAtMs)} is not current`);
      return;
    }
    const remaining = Math.min(drill.expiresAtMs - now, PUBLIC_TRANSPORT_DRILL_MAX_MS);
    this.current = { drill, activatedAtMs: now, monoDeadline: this.deps.monoMs() + remaining, endedAtMs: null, endReason: null };
    const f = drill.faults;
    this.deps.log(
      `public transport drill ${drill.drillId} ACTIVE: ${drill.fault} (REST ${f.rest ?? "untouched"}, open streams ${f.openStreams ?? "untouched"}, new streams ${f.newStreams ?? "untouched"}) until ${isoOf(drill.expiresAtMs)}`
    );
    for (const listener of this.listeners) listener(f);
  }

  faults(): PublicTransportDrillFaults | null {
    return this.active()?.drill.faults ?? null;
  }

  observation(): PublicTransportDrillObservation | null {
    this.active();
    const c = this.current;
    if (c === null) return null;
    return {
      drillId: c.drill.drillId,
      fault: c.drill.fault,
      active: c.endedAtMs === null,
      activatedAt: isoOf(c.activatedAtMs),
      endedAt: c.endedAtMs === null ? null : isoOf(c.endedAtMs),
      endReason: c.endReason,
    };
  }

  /** The current drill if it is still active — ending it here, exactly at its expiry, if it is not. */
  private active(): CurrentDrill | null {
    const c = this.current;
    if (c === null || c.endedAtMs !== null) return null;
    if (this.deps.nowMs() >= c.drill.expiresAtMs || this.deps.monoMs() >= c.monoDeadline) {
      this.end(c, "EXPIRED");
      return null;
    }
    return c;
  }

  private end(c: CurrentDrill, reason: PublicTransportDrillEndReason): void {
    if (c.endedAtMs !== null) return;
    c.endedAtMs = this.deps.nowMs();
    c.endReason = reason;
    this.finished.add(c.drill.drillId);
    this.deps.log(`public transport drill ${c.drill.drillId} ENDED (${reason}): the public transports are the real ones again`);
  }
}

// ---------------------------------------------------------------------------
// The transports under a drill
// ---------------------------------------------------------------------------

/** Exactly what undici's fetch throws when the connection is refused. */
export function drillRefusedError(): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED (public transport drill)"), { code: "ECONNREFUSED" }) });
}

/** The scanner's public REST transport under the gate: refused while the drill says so, otherwise the inner transport, untouched. */
export function drilledPublicTransport(inner: PublicHttpTransport, gate: Pick<PublicTransportDrillSource, "faults">): PublicHttpTransport {
  return (url, init) => (gate.faults()?.rest === "REFUSED" ? Promise.reject(drillRefusedError()) : inner(url, init));
}

export interface DrilledStreams {
  readonly openStream: OpenPublicStream;
  /** Drops every open connection now (what a DROP drill does at activation); returns how many. */
  dropOpenStreams(): number;
}

/**
 * The scanner's public WebSocket opener under the gate. New connections are refused while the drill refuses them
 * (never attempted; error then close 1006, asynchronously, like a refused handshake); a DROP drill closes every open
 * connection for real at activation and reports each as an abnormal close (the dead socket's own late events are
 * swallowed); a SILENT drill swallows messages while it lasts (half-open). `defer` runs a callback on a later turn.
 */
export function drilledOpenStream(inner: OpenPublicStream, gate: PublicTransportDrillSource, defer: (fn: () => void) => void): DrilledStreams {
  interface Live {
    readonly handlers: StreamHandlers;
    connection: StreamConnection | null;
    dropped: boolean;
  }
  const live = new Set<Live>();
  const failLater = (handlers: StreamHandlers, closedByScanner: () => boolean, what: string) =>
    defer(() => {
      if (closedByScanner()) return;
      handlers.onError(`public transport drill: ${what}`);
      handlers.onClose("code 1006 public transport drill");
    });
  const dropOpenStreams = (): number => {
    const doomed = [...live];
    for (const c of doomed) {
      live.delete(c);
      c.dropped = true;
      try {
        c.connection?.close();
      } catch {
        // Already closed: nothing to release.
      }
      failLater(c.handlers, () => false, "connection dropped");
    }
    return doomed.length;
  };
  gate.onActivate((faults) => {
    if (faults.openStreams === "DROP") dropOpenStreams();
  });
  const openStream: OpenPublicStream = (url, handlers) => {
    if (gate.faults()?.newStreams === "REFUSED") {
      let closed = false;
      failLater(handlers, () => closed, "connection refused");
      return {
        close: () => {
          closed = true;
        },
      };
    }
    const c: Live = { handlers, connection: null, dropped: false };
    live.add(c);
    try {
      c.connection = inner(url, {
        onOpen: () => {
          if (!c.dropped) handlers.onOpen();
        },
        onMessage: (text) => {
          if (!c.dropped && gate.faults()?.openStreams !== "SILENT") handlers.onMessage(text);
        },
        onError: (reason) => {
          if (!c.dropped) handlers.onError(reason);
        },
        onClose: (reason) => {
          if (c.dropped) return;
          live.delete(c);
          handlers.onClose(reason);
        },
      });
    } catch (error) {
      live.delete(c);
      throw error;
    }
    return {
      close: () => {
        live.delete(c);
        c.connection?.close();
      },
    };
  };
  return { openStream, dropOpenStreams };
}

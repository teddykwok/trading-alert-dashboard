import { PUBLIC_TRANSPORT_DRILL_MAX_MS, type PublicTransportDrillFaults } from "../native-scanner/public-transport-drill";
import { ALWAYS_ON_REQUEST_SCHEMA } from "./always-on-contract";

/**
 * THE OPERATOR NETWORK DRILL (Gate 4A) — the supervisor's pure contract.
 *
 * MONITORING ONLY. A drill fails the PUBLIC, UNSIGNED market-data transports of
 * the ONE scanner run this supervisor owns (and its own two connectivity
 * probes) for a bounded while, inside those processes, so real Windows process
 * ownership and recovery can be exercised without touching the machine's
 * network: no adapter, DNS, hosts, firewall, routing or proxy change, and no
 * other process affected. It never reaches the backend, the emitter, the
 * planner, an account or anything signed.
 *
 * ## Explicit local authorization
 *
 * A drill exists only after `monitoring:always-on drill start` — run by the
 * operator, on this machine, from this repository — writes a request naming the
 * running supervisor's generation, its scanner's run and itself (pid and OS
 * creation time), and the running supervisor accepts it. Every check below
 * must pass; anything uncertain refuses:
 *
 *   fresh         requested at most 60 s ago, not in the future, used once
 *   bound         this generation, this supervisor's owned, healthy scanner run,
 *                 no recovery or shutdown in progress, no other drill active
 *   controller    a live node process of THIS repository running exactly
 *                 `run-always-on-monitoring.ts drill start`, its creation time
 *                 matching the request (a leftover or hand-written file names
 *                 no such process)
 *   private       the Always-On, requests and stop directories grant write
 *                 access to nobody but the operator's own account, SYSTEM and
 *                 Administrators (read from the real Windows ACL every time)
 *
 * There is no environment variable, no `run` or scanner option, no route and
 * no launcher item: a normal start can never activate a drill.
 */

/** The longest drill (15 minutes): the scanner enforces the same bound on its own. */
export const ALWAYS_ON_DRILL_MAX_SECONDS = PUBLIC_TRANSPORT_DRILL_MAX_MS / 1000;
export const ALWAYS_ON_DRILL_MIN_SECONDS = 10;
/** A drill request is an authorization valid for this long after the controller wrote it. */
export const ALWAYS_ON_DRILL_REQUEST_TTL_MS = 60_000;
/** How far a request may lie ahead of the supervisor's clock (same machine). */
export const ALWAYS_ON_DRILL_CLOCK_SKEW_MS = 5_000;

/** What a drill does to the supervisor's own probes (null: the probe's transport is untouched). */
export interface DrillProbeFaults {
  readonly rest: "REFUSED" | null;
  readonly stream: "REFUSED" | "SILENT" | null;
}

export const ALWAYS_ON_DRILL_FAULT_NAMES = Object.freeze([
  "PUBLIC_REST_DOWN",
  "PUBLIC_STREAMS_DISCONNECT",
  "PUBLIC_STREAMS_NEW_REFUSED",
  "PUBLIC_STREAMS_DOWN",
  "PUBLIC_ALL_DOWN",
  "PUBLIC_STREAMS_HALF_OPEN",
  "SCANNER_LOCAL_STREAMS",
] as const);
export type AlwaysOnDrillFault = (typeof ALWAYS_ON_DRILL_FAULT_NAMES)[number];

interface DrillFaultSpec {
  readonly scanner: PublicTransportDrillFaults;
  readonly probes: DrillProbeFaults;
  readonly summary: string;
}

/**
 * The fault catalogue: each scenario is a FIXED combination of transport faults. A PUBLIC_* scenario is seen by the
 * scanner and by the supervisor's probes alike (a public outage); SCANNER_LOCAL_STREAMS only by the scanner (the
 * public network is fine, so the probes connect and the normal bounded recovery applies).
 */
export const ALWAYS_ON_DRILL_FAULTS: Readonly<Record<AlwaysOnDrillFault, DrillFaultSpec>> = Object.freeze({
  PUBLIC_REST_DOWN: {
    scanner: { rest: "REFUSED", openStreams: null, newStreams: null },
    probes: { rest: "REFUSED", stream: null },
    summary: "public REST refused (scanner and REST probe); streams untouched",
  },
  PUBLIC_STREAMS_DISCONNECT: {
    scanner: { rest: null, openStreams: "DROP", newStreams: null },
    probes: { rest: null, stream: null },
    summary: "every open stream dropped once at the start; reconnects succeed",
  },
  PUBLIC_STREAMS_NEW_REFUSED: {
    scanner: { rest: null, openStreams: null, newStreams: "REFUSED" },
    probes: { rest: null, stream: "REFUSED" },
    summary: "new stream connections refused (scanner and stream probe); open streams untouched",
  },
  PUBLIC_STREAMS_DOWN: {
    scanner: { rest: null, openStreams: "DROP", newStreams: "REFUSED" },
    probes: { rest: null, stream: "REFUSED" },
    summary: "open streams dropped and new ones refused (scanner and stream probe); REST untouched",
  },
  PUBLIC_ALL_DOWN: {
    scanner: { rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED" },
    probes: { rest: "REFUSED", stream: "REFUSED" },
    summary: "public REST and streams down together (scanner and both probes)",
  },
  PUBLIC_STREAMS_HALF_OPEN: {
    scanner: { rest: null, openStreams: "SILENT", newStreams: null },
    probes: { rest: null, stream: "SILENT" },
    summary: "streams stay open and deliver nothing (half-open); the stream probe can only answer UNKNOWN",
  },
  SCANNER_LOCAL_STREAMS: {
    scanner: { rest: null, openStreams: "DROP", newStreams: "REFUSED" },
    probes: { rest: null, stream: null },
    summary: "the scanner's own streams fail while the public network (both probes) is fine",
  },
});

export const isDrillFault = (value: unknown): value is AlwaysOnDrillFault => typeof value === "string" && (ALWAYS_ON_DRILL_FAULT_NAMES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// The request (written by the operator's controller, consumed by the supervisor)
// ---------------------------------------------------------------------------

export interface DrillController {
  readonly pid: number;
  /** The controller process's OS creation time (the pid-reuse fence). */
  readonly startedAtMs: number;
  /** The Windows account name it ran as (audit only; never a credential). */
  readonly user: string;
}

export interface DrillStartRequest {
  /** 128-bit hex, generated by the controller: the drill's id, used once. */
  readonly requestId: string;
  readonly generation: number;
  readonly runId: string;
  readonly fault: AlwaysOnDrillFault;
  readonly durationSeconds: number;
  readonly requestedAtMs: number;
  readonly controller: DrillController;
}

const REQUEST_ID = /^[0-9a-f]{32}$/;
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const USER = /^[^\u0000-\u001f\u007f|]{1,64}$/;
const REQUEST_KEYS: readonly string[] = ["schema", "kind", "requestId", "generation", "runId", "fault", "durationSeconds", "requestedAt", "controller"];
const CONTROLLER_KEYS: readonly string[] = ["pid", "startedAtMs", "user"];

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (record: Record<string, unknown>, keys: readonly string[]) => Object.keys(record).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The one serializer of a drill request (the CLI writes exactly this). */
export function drillStartRequestText(request: DrillStartRequest): string {
  return `${JSON.stringify({
    schema: ALWAYS_ON_REQUEST_SCHEMA,
    kind: "DRILL_START",
    requestId: request.requestId,
    generation: request.generation,
    runId: request.runId,
    fault: request.fault,
    durationSeconds: request.durationSeconds,
    requestedAt: new Date(request.requestedAtMs).toISOString(),
    controller: { pid: request.controller.pid, startedAtMs: request.controller.startedAtMs, user: request.controller.user },
  })}\n`;
}

/** The restore request: honoured by whichever generation runs, even unparseable, because it can only end a fault. */
export function drillRestoreRequestText(input: { readonly generation: number | null; readonly requestedAtMs: number }): string {
  return `${JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "DRILL_RESTORE", generation: input.generation, requestedAt: new Date(input.requestedAtMs).toISOString() })}\n`;
}

export type DrillRequestRefusal = "SCHEMA_INVALID" | "FIELD_INVALID" | "FAULT_UNKNOWN" | "DURATION_OUT_OF_BOUNDS";
export type DrillRequestParse = { readonly ok: true; readonly request: DrillStartRequest } | { readonly ok: false; readonly reason: DrillRequestRefusal; readonly requestId: string | null };

/** Parses a drill request strictly: exactly the known fields, each well-formed; anything else is refused. */
export function parseDrillStartRequest(text: string): DrillRequestParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "SCHEMA_INVALID", requestId: null };
  }
  if (!isRecord(raw) || raw.schema !== ALWAYS_ON_REQUEST_SCHEMA || raw.kind !== "DRILL_START") return { ok: false, reason: "SCHEMA_INVALID", requestId: null };
  const requestId = typeof raw.requestId === "string" && REQUEST_ID.test(raw.requestId) ? raw.requestId : null;
  const refuse = (reason: DrillRequestRefusal): DrillRequestParse => ({ ok: false, reason, requestId });
  if (!exactKeys(raw, REQUEST_KEYS) || requestId === null) return refuse("FIELD_INVALID");
  const { generation, runId, fault, durationSeconds, controller } = raw;
  if (!positiveInteger(generation) || typeof runId !== "string" || !RUN_ID.test(runId)) return refuse("FIELD_INVALID");
  const requestedAtMs = typeof raw.requestedAt === "string" ? Date.parse(raw.requestedAt) : Number.NaN;
  if (!Number.isFinite(requestedAtMs) || new Date(requestedAtMs).toISOString() !== raw.requestedAt) return refuse("FIELD_INVALID");
  if (!isRecord(controller) || !exactKeys(controller, CONTROLLER_KEYS)) return refuse("FIELD_INVALID");
  if (!positiveInteger(controller.pid) || !positiveInteger(controller.startedAtMs) || typeof controller.user !== "string" || !USER.test(controller.user)) return refuse("FIELD_INVALID");
  if (!isDrillFault(fault)) return refuse("FAULT_UNKNOWN");
  if (typeof durationSeconds !== "number" || !Number.isSafeInteger(durationSeconds) || durationSeconds < ALWAYS_ON_DRILL_MIN_SECONDS || durationSeconds > ALWAYS_ON_DRILL_MAX_SECONDS) return refuse("DURATION_OUT_OF_BOUNDS");
  return {
    ok: true,
    request: { requestId, generation, runId, fault, durationSeconds, requestedAtMs, controller: { pid: controller.pid, startedAtMs: controller.startedAtMs, user: controller.user } },
  };
}

export type DrillControllerCheck = "VERIFIED" | "NOT_VERIFIED" | "UNOBSERVABLE";
export type DrillDirectoryCheck = { readonly private: true } | { readonly private: false; readonly reason: string };

export interface DrillStartContext {
  readonly nowMs: number;
  readonly generation: number;
  /** The supervisor's own scanner: owned by it, the run it identified, judged healthy now. */
  readonly scanner: { readonly owned: boolean; readonly runId: string | null; readonly healthy: boolean };
  readonly recoveryActive: boolean;
  readonly shuttingDown: boolean;
  readonly drillActive: boolean;
  readonly seenRequestIds: ReadonlySet<string>;
  readonly controller: DrillControllerCheck;
  readonly directories: DrillDirectoryCheck;
}

export type DrillStartVerdict = { readonly accept: true } | { readonly accept: false; readonly reasonCode: string; readonly detail: string };

/** Judges a parsed request against the running supervisor. The first failing rule wins, always in this order. */
export function judgeDrillStart(request: DrillStartRequest, ctx: DrillStartContext): DrillStartVerdict {
  const refuse = (reasonCode: string, detail: string): DrillStartVerdict => ({ accept: false, reasonCode, detail });
  const ageMs = ctx.nowMs - request.requestedAtMs;
  if (ageMs > ALWAYS_ON_DRILL_REQUEST_TTL_MS) return refuse("REQUEST_EXPIRED", `the drill request was written ${Math.round(ageMs / 1000)}s ago; an authorization lasts ${ALWAYS_ON_DRILL_REQUEST_TTL_MS / 1000}s`);
  if (-ageMs > ALWAYS_ON_DRILL_CLOCK_SKEW_MS) return refuse("REQUEST_FROM_FUTURE", `the drill request claims to be written ${Math.round(-ageMs / 1000)}s in the future`);
  if (ctx.seenRequestIds.has(request.requestId)) return refuse("REQUEST_REPLAYED", "this drill request id was already used");
  if (request.generation !== ctx.generation) return refuse("GENERATION_MISMATCH", `the request targets generation ${request.generation}; this is generation ${ctx.generation}`);
  if (ctx.shuttingDown) return refuse("SHUTTING_DOWN", "the supervisor is stopping");
  if (ctx.drillActive) return refuse("DRILL_ALREADY_ACTIVE", "a drill is already active; one bounded drill at a time");
  if (ctx.recoveryActive) return refuse("RECOVERY_IN_PROGRESS", "a scanner recovery is in progress");
  if (!ctx.scanner.owned || ctx.scanner.runId === null) return refuse("NO_OWNED_SCANNER", "this supervisor owns no identified scanner run");
  if (request.runId !== ctx.scanner.runId) return refuse("RUN_MISMATCH", `the request targets run ${request.runId}; the owned scanner runs ${ctx.scanner.runId}`);
  if (!ctx.scanner.healthy) return refuse("SCANNER_NOT_HEALTHY", "the owned scanner is not healthy; a drill starts only from a healthy run");
  if (ctx.controller === "UNOBSERVABLE") return refuse("CONTROLLER_UNOBSERVABLE", "the requesting controller process could not be observed");
  if (ctx.controller !== "VERIFIED") return refuse("CONTROLLER_NOT_VERIFIED", "the request names no live `monitoring:always-on drill start` process of this repository");
  if (!ctx.directories.private) return refuse("DIRECTORY_NOT_PRIVATE", `the drill directories are not private to this account: ${ctx.directories.reason}`);
  return { accept: true };
}

/**
 * The controller's command line is node itself (never a shell) running this repository's Always-On entrypoint with
 * exactly `drill start`. Its repository is checked separately against the supervisor's own.
 */
export function controllerIsDrillCli(commandLine: string): boolean {
  const normalized = commandLine.replace(/\\/g, "/");
  const node = /^\s*(?:"[^"]*\/node(?:\.exe)?"|(?:\S*\/)?node(?:\.exe)?)(?:\s|$)/i;
  const entry = /(?:^|[\s/])src\/modules\/always-on\/run-always-on-monitoring\.ts\s+drill\s+start(?:\s|$)/;
  return node.test(normalized) && entry.test(normalized);
}

/** The command line runs from inside `repoRoot` itself (a path separator after it: a sibling checkout never matches). */
export function commandLineInRepository(commandLine: string, repoRoot: string): boolean {
  const root = repoRoot.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return root !== "" && commandLine.replace(/\//g, "\\").toLowerCase().includes(`${root}\\`);
}

// ---------------------------------------------------------------------------
// The Windows ACL of the drill's directories
// ---------------------------------------------------------------------------

/** SYSTEM and BUILTIN\Administrators: they can do anything on the machine anyway. */
export const TRUSTED_WRITER_SIDS: readonly string[] = Object.freeze(["S-1-5-18", "S-1-5-32-544"]);
/** WriteData, AppendData, WriteExtendedAttributes, DeleteSubdirectoriesAndFiles, WriteAttributes, Delete, ChangePermissions, TakeOwnership, GENERIC_ALL, GENERIC_WRITE. */
const WRITE_RIGHTS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
const SID = /^S-1-\d+(?:-\d+)*$/;

/**
 * Judges the access rules (one `dir|sid|Allow|rights` row each, inherited ones included) of every directory a drill
 * relies on. Private only when every directory has rules, every row parses, and no Allow rule grants any write right
 * to anyone but the owner, SYSTEM or Administrators. Anything uncertain is NOT private.
 */
export function judgeDirectoryAcl(rowsText: string, dirs: readonly string[], ownerSid: string): DrillDirectoryCheck {
  if (!SID.test(ownerSid)) return { private: false, reason: "the current account's SID is unknown" };
  const trusted = new Set([ownerSid, ...TRUSTED_WRITER_SIDS]);
  const wanted = new Map(dirs.map((d) => [d.toLowerCase(), d]));
  const seen = new Set<string>();
  for (const line of rowsText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")) {
    const [dir, sid, type, rights, ...rest] = line.split("|");
    if (rest.length > 0 || dir === undefined || !wanted.has(dir.toLowerCase()) || sid === undefined || !SID.test(sid) || (type !== "Allow" && type !== "Deny") || rights === undefined || !/^-?\d+$/.test(rights)) {
      return { private: false, reason: "an access rule could not be read" };
    }
    seen.add(dir.toLowerCase());
    if (type === "Allow" && (Number(rights) >>> 0) & WRITE_RIGHTS && !trusted.has(sid)) return { private: false, reason: `${sid} may write ${wanted.get(dir.toLowerCase())}` };
  }
  for (const [key, dir] of wanted) if (!seen.has(key)) return { private: false, reason: `no access rules were read for ${dir}` };
  return { private: true };
}

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import { SERVER_TIME_PATH, buildPublicFuturesUrl, parseServerTimePayload } from "../native-scanner/binance-public-futures";
import { klineStreamNameOf } from "../native-scanner/exchange-symbol";
import { buildPublicCombinedKlineStreamUrl, parseCombinedStreamEnvelope, parseKlineStreamPayload } from "../native-scanner/live-kline-stream";
import { buildProcessProbeQuery, parseEnvFileStrict } from "../operator/dual-account-topology";
import { assessNonWatchBuild, type BuildVerdict } from "../operator/generic-backend-nonwatch-launcher";
import { listenerAuthority, withMutationLock, type ListenerHandle, type MutationAction, type WithAuthorityResult } from "../operator/mutation-lock";
import { classifySpawnResult, parseProcessRows, parseProcessTreeRows, type Observation, type ObservedProcessNode } from "../operator/runtime-launcher";
import { OWNERSHIP_PROOF_ATTEMPTS, type ProbeOutcome } from "../operator/worker-supervision";
import type { AlwaysOnRole, PublicStreamProbeOutcome } from "./always-on-contract";
import { drilledProbeFetch, drilledProbeOpen, judgeDirectoryAcl, type DrillDirectoryCheck, type DrillProbeFaults } from "./always-on-drill";
import { listenerInstanceLock, type InstanceLock } from "./always-on-ownership";
import { alwaysOnRoleLog, type AlwaysOnPaths } from "./always-on-paths";
import { genericEnvFilePath, type MonitoringSpawnPlan } from "./always-on-roles";
import type { AlwaysOnFileSystem, AlwaysOnHttp } from "./always-on-supervisor";

/**
 * The REAL machine behind the Always-On supervisor: the only module that runs
 * PowerShell, spawns, terminates, opens sockets or makes HTTP requests. Every
 * decision is made elsewhere (always-on-supervisor.ts, tested with fakes);
 * these are thin, reviewed adapters, built on the launcher's own pure parsers
 * and primitives:
 *
 *  - the process TREE (node.exe + cmd.exe, with parents) and targeted PID
 *    probes — the launcher's CIM queries and all-or-nothing parsers;
 *  - spawn: detached, hidden console, stdout+stderr to the role's durable log
 *    (rotated at 32 MB when a role starts), environment from the plan only;
 *  - terminate: `taskkill /PID <root> /T /F` — reachable only through the
 *    fenced stop, which re-proves ownership first;
 *  - HTTP: GETs to the LOCAL backend only (loopback, refused otherwise), and
 *    one unsigned public Binance server-time request as the connectivity
 *    probe. No header of ours, no credential, no signed endpoint.
 */

const LOG_ROTATE_BYTES = 32 * 1024 * 1024;

function powershell(script: string): Observation<string> {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  return classifySpawnResult(result);
}

/**
 * One output line per process: pid|parent pid|name|creation ms|command line.
 * '|' AND line breaks in a command line become spaces: Windows allows CR/LF
 * in any process's command line (node -e "<multi-line script>"), and one row
 * split across lines would make the all-or-nothing parser refuse the whole
 * table — stalling every start, stop and recovery while that process lives.
 */
export const PROCESS_ROW_FORMAT =
  "ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, " +
  "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), ($_.CommandLine -replace '[|\\r\\n]',' ') }";

/** Formats a PowerShell pipeline of process objects into rows and parses them (all or nothing). */
export function observeProcessRows(source: string): Observation<ObservedProcessNode[]> {
  const out = powershell(`${source} | ${PROCESS_ROW_FORMAT}`);
  if (!out.ok) return out;
  return parseProcessTreeRows(out.value);
}

export function observeProcessTree(): Observation<ObservedProcessNode[]> {
  return observeProcessRows("Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\"");
}

export function probeProcess(pid: number): ProbeOutcome {
  const script = buildProcessProbeQuery([pid]);
  if (script === null) return { observed: true, process: null };
  const out = powershell(script);
  if (!out.ok) return { observed: false };
  const rows = parseProcessRows(out.value);
  if (!rows.ok) return { observed: false };
  return { observed: true, process: rows.value.find((row) => row.pid === pid) ?? null };
}

/** taskkill /T /F on ONE root. Called only from inside the fenced stop. */
export function terminateTree(pid: number): boolean {
  return spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true }).status === 0;
}

function openRoleLog(paths: AlwaysOnPaths, role: AlwaysOnRole): number | null {
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    const file = alwaysOnRoleLog(paths, role);
    try {
      if (statSync(file).size >= LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // No file yet: appending is still correct.
    }
    return openSync(file, "a");
  } catch {
    return null;
  }
}

/** Spawns with durable output, or not at all (a role whose output goes nowhere is never started). */
export function createSpawner(paths: AlwaysOnPaths, log: (line: string) => void): { spawn: (plan: MonitoringSpawnPlan) => number | null; exitCodeOf: (pid: number) => number | null } {
  const exitCodes = new Map<number, number | null>();
  return {
    spawn: (plan) => {
      const fd = openRoleLog(paths, plan.role);
      if (fd === null) {
        log(`  ${plan.role}: its log file could not be opened, so it was NOT started`);
        return null;
      }
      try {
        const child = spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: plan.env, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
        // A spawn that fails at run time (ENOENT, EACCES, EMFILE …) has no pid and reports through 'error' on the
        // NEXT tick: listened for before anything else, or that event is an uncaught exception ending this process.
        child.on("error", () => {
          if (child.pid !== undefined) exitCodes.set(child.pid, null);
        });
        if (child.pid === undefined) return null;
        const pid = child.pid;
        child.on("exit", (code) => exitCodes.set(pid, code));
        child.unref();
        return pid;
      } catch {
        return null;
      } finally {
        try {
          closeSync(fd);
        } catch {
          // The child holds its own copy.
        }
      }
    },
    exitCodeOf: (pid) => exitCodes.get(pid) ?? null,
  };
}

/** The codes Windows returns while another process briefly holds a file (a reader, an editor, an indexer, antivirus). */
const TRANSIENT_FS_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Runs one synchronous file operation, retrying ONLY a transient sharing
 * failure, on a short bounded backoff (at most ~1.8 s in all) — the graceful-fs
 * approach, synchronous because every caller is. Any other error, or the last
 * transient one, is thrown.
 */
export function retryTransientFs<T>(operation: () => T, options: { readonly attempts?: number; readonly sleep?: (ms: number) => void } = {}): T {
  const attempts = options.attempts ?? 8;
  const sleep = options.sleep ?? sleepSync;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (attempt >= attempts || code === undefined || !TRANSIENT_FS_CODES.has(code)) throw error;
      sleep(Math.min(25 * 2 ** (attempt - 1), 500));
    }
  }
}

export const realFileSystem: AlwaysOnFileSystem = {
  readText(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  readTextStrict(file) {
    try {
      return retryTransientFs(() => readFileSync(file, "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  },
  writeTextAtomic(file, text) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    const fd = retryTransientFs(() => openSync(temporary, "w"));
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // MoveFileEx cannot replace a file another process holds open: retried, bounded, then thrown.
    retryTransientFs(() => renameSync(temporary, file));
  },
  appendLine(file, line) {
    mkdirSync(path.dirname(file), { recursive: true });
    const fd = openSync(file, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  exists: (file) => existsSync(file),
  remove(file) {
    try {
      retryTransientFs(() => unlinkSync(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  },
  ensureDir: (dir) => void mkdirSync(dir, { recursive: true }),
  listDir(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

/** The local backend only: a non-loopback URL is refused before any request is made. */
export function assertLoopbackBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--backend-url is not a URL");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("--backend-url must be a plain http://127.0.0.1:<port> (or localhost) origin: Always-On reads only the local backend");
  }
  return url.origin;
}

export const realHttp: AlwaysOnHttp = {
  async getJson(url, timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    } catch {
      return { ok: false, status: null, body: null };
    }
  },
};

/**
 * One unsigned public request (server time, weight 1). True only for a well-formed answer.
 * `fetchImpl` is the transport: the real fetch in production; tests inject a simulated network, never a switch.
 */
export async function publicBinanceReachable(timeoutMs = 5_000, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(buildPublicFuturesUrl("https://fapi.binance.com", SERVER_TIME_PATH), { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    parseServerTimePayload(await response.json());
    return true;
  } catch {
    return false;
  }
}

/** The one public stream the stream probe subscribes to: always trading, so a healthy stream speaks within seconds. */
export const PUBLIC_STREAM_PROBE_SYMBOL = "BTCUSDT";
/** Bounds the whole probe: the handshake and the first valid message. */
export const PUBLIC_STREAM_PROBE_TIMEOUT_MS = 10_000;

export type { PublicStreamProbeOutcome };

/** The part of a WebSocket the probe uses. */
export interface StreamProbeSocket {
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { readonly data?: unknown }) => void): void;
  removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: { readonly data?: unknown }) => void): void;
  close(): void;
}

export interface StreamProbeTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: StreamProbeTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as NodeJS.Timeout) };

/**
 * One unsigned public stream subscription (BTCUSDT 15m klines, the production-validated combined stream URL, no
 * protocols, no headers). REACHABLE only on a valid kline message of that stream. UNREACHABLE only on positive
 * evidence of failure: an error or a close before such a message, or no handshake at all within the timeout.
 * UNKNOWN for anything else — a socket that cannot be constructed, one that opens but proves nothing in time, or a
 * message it cannot read — and UNKNOWN never suppresses a recovery. Every path removes the listeners, clears the
 * timer and closes the socket. `open` and `timers` are the transport: real in production; tests inject a simulated
 * network, never a switch.
 */
export function publicStreamReachable(options: { readonly timeoutMs?: number; readonly open?: (url: string) => StreamProbeSocket; readonly timers?: StreamProbeTimers } = {}): Promise<PublicStreamProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? PUBLIC_STREAM_PROBE_TIMEOUT_MS;
  const timers = options.timers ?? realTimers;
  const url = buildPublicCombinedKlineStreamUrl([PUBLIC_STREAM_PROBE_SYMBOL], "15m");
  const stream = klineStreamNameOf(PUBLIC_STREAM_PROBE_SYMBOL, "15m");
  let socket: StreamProbeSocket;
  try {
    socket = (options.open ?? ((url: string) => new WebSocket(url)))(url);
  } catch {
    return Promise.resolve("UNKNOWN");
  }
  return new Promise<PublicStreamProbeOutcome>((resolve) => {
    let opened = false;
    let unreadable = false;
    let settled = false;
    const onOpen = () => {
      opened = true;
    };
    const onMessage = (event: { readonly data?: unknown }) => {
      try {
        const envelope = parseCombinedStreamEnvelope(typeof event.data === "string" ? event.data : "");
        if (envelope.stream !== stream) throw new Error("another stream");
        parseKlineStreamPayload(envelope.data, PUBLIC_STREAM_PROBE_SYMBOL, "15m");
        finish("REACHABLE");
      } catch {
        unreadable = true;
      }
    };
    // Something answered that could not be read: indeterminate, whatever happens next.
    const onFailure = () => finish(unreadable ? "UNKNOWN" : "UNREACHABLE");
    const listeners = [
      ["open", onOpen],
      ["message", onMessage],
      ["error", onFailure],
      ["close", onFailure],
    ] as const;
    const timer = timers.set(() => finish(opened || unreadable ? "UNKNOWN" : "UNREACHABLE"), timeoutMs);
    function finish(outcome: PublicStreamProbeOutcome): void {
      if (settled) return;
      settled = true;
      timers.clear(timer);
      for (const [type, listener] of listeners) socket.removeEventListener(type, listener);
      try {
        socket.close();
      } catch {
        // Already closed or never connected: nothing to release.
      }
      resolve(outcome);
    }
    for (const [type, listener] of listeners) socket.addEventListener(type, listener);
  });
}

/**
 * The REAL Windows access rules of the directories an operator drill relies on (Get-Acl, inherited rules included,
 * identities as SIDs) and this account's SID, judged by judgeDirectoryAcl: private only when nobody but this account,
 * SYSTEM and Administrators can write them. A query that fails, or a path that cannot be quoted, is NOT private.
 */
export function verifyPrivateDirectories(dirs: readonly string[]): DrillDirectoryCheck {
  if (dirs.length === 0 || dirs.some((d) => /[\r\n]/.test(d))) return { private: false, reason: "the directory list cannot be passed to the ACL query" };
  const quoted = dirs.map((d) => `'${d.replace(/'/g, "''")}'`).join(",");
  const out = powershell(
    "$ErrorActionPreference = 'Stop'; " +
      "'SID|' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
      `foreach ($d in @(${quoted})) { foreach ($r in (Get-Acl -LiteralPath $d).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { ` +
      "'{0}|{1}|{2}|{3}' -f $d, $r.IdentityReference.Value, $r.AccessControlType, [int]$r.FileSystemRights } }"
  );
  if (!out.ok) return { private: false, reason: `the access rules could not be read (${out.reason})` };
  const lines = out.value.split(/\r?\n/);
  const owner = (lines.find((line) => line.startsWith("SID|")) ?? "").slice(4).trim();
  return judgeDirectoryAcl(lines.filter((line) => !line.startsWith("SID|")).join("\n"), dirs, owner);
}

/**
 * The supervisor's REST connectivity probe exactly as production runs it: the real fetch, which an ACTIVE operator
 * drill (and nothing else) replaces by a refusal. With no drill this is `publicBinanceReachable()` itself.
 */
export function publicConnectivityProbe(drill: DrillProbeFaults | null): Promise<boolean> {
  return publicBinanceReachable(undefined, drilledProbeFetch(fetch, drill));
}

/**
 * The supervisor's public stream probe exactly as production runs it: the real WebSocket, which an ACTIVE operator
 * drill (and nothing else) replaces by a refused or silent socket. With no drill this is `publicStreamReachable()` itself.
 */
export function publicStreamProbe(drill: DrillProbeFaults | null): Promise<PublicStreamProbeOutcome> {
  return publicStreamReachable({ open: drilledProbeOpen(undefined, drill) });
}

export function genericEnvKeyNames(env: NodeJS.ProcessEnv): { readonly ok: true; readonly keys: string[] } | { readonly ok: false; readonly reason: string } {
  const parsed = parseEnvFileStrict(genericEnvFilePath(env));
  return parsed.ok ? { ok: true, keys: parsed.keys } : { ok: false, reason: parsed.reasonCode };
}

export const buildVerdictFor =
  (repoRoot: string): (() => BuildVerdict) =>
  () =>
    assessNonWatchBuild(repoRoot);

/** An exclusive loopback listener (a mutex, not a service: connections are dropped at once). */
export function openLoopbackListener(): ListenerHandle {
  const server = createServer();
  server.on("connection", (socket) => socket.destroy());
  return {
    listen: (host, port) =>
      new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
          server.removeListener("listening", bound);
          reject(error);
        };
        const bound = (): void => {
          server.removeListener("error", failed);
          server.unref();
          resolve();
        };
        server.once("error", failed);
        server.once("listening", bound);
        server.listen({ host, port, exclusive: true });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          server.close();
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function realInstanceLock(): InstanceLock {
  return listenerInstanceLock(openLoopbackListener);
}

/** The launcher's machine-wide mutation authority (127.0.0.1:4009), taken around each start / stop. */
export function realMutation(log: (line: string) => void): <T>(action: MutationAction, run: () => Promise<T>) => Promise<WithAuthorityResult<T>> {
  return (action, run) => withMutationLock(action, { authority: listenerAuthority(openLoopbackListener), log: (line) => log(`  ${line}`) }, run);
}

/**
 * This process's own OS creation time — the PID-reuse fence in its ownership
 * record — probed as often as the fenced start probes a fresh child. Null when
 * it still cannot be read: "now" would be seconds late, and no later
 * verification (±1 s of the real time) could ever match it, so `stop`, `status`
 * and the launcher would never see this supervisor again.
 */
export function selfStartedAtMs(probe: (pid: number) => ProbeOutcome = probeProcess, pid: number = process.pid): number | null {
  for (let attempt = 0; attempt < OWNERSHIP_PROOF_ATTEMPTS; attempt += 1) {
    const probed = probe(pid);
    const startedAtMs = probed.observed ? probed.process?.startedAtMs : undefined;
    if (startedAtMs !== undefined) return startedAtMs;
  }
  return null;
}

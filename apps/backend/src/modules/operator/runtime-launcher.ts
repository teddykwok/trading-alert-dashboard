import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Type-only: erased at compile time, so this module pulls in no dotenv-backed
// configuration and stays testable without touching a real environment.
import type { RuntimeGateSnapshot } from "../runtime/runtime-attestation";

/**
 * The local Windows runtime launcher — pure core.
 *
 * Everything in this file is a function of its inputs: no process is started,
 * no process is killed and no real `.env` is touched. The CLI in
 * `run-runtime-launcher.ts` supplies the adapters that do those things, which
 * is what makes the safety-sensitive parts testable without a machine.
 *
 * ## What this tool is, and is not
 *
 * It owns exactly THREE non-secret deployment gates and the lifecycle of the
 * repo's own dev processes. It is a deployment tool, not a trading control.
 * It cannot arm, cannot create an authorization window, cannot reach Binance
 * and cannot touch the execution profile. LIVE-READY only loads the process
 * prerequisites that let the authenticated Trading Control page arm later —
 * the durable ARM remains a separate, confirmed, audited action there.
 */

// ---------------------------------------------------------------------------
// The three gates this tool owns. Nothing else in .env is ever written.
// ---------------------------------------------------------------------------

export const RUNTIME_GATE_KEYS = [
  "EXECUTION_GLOBAL_KILL_SWITCH",
  "EXECUTION_LIVE_ENTRY_ENABLED",
  "EXECUTION_PROTECTION_READY",
] as const;

export type RuntimeGateKey = (typeof RUNTIME_GATE_KEYS)[number];
export type GateValues = Record<RuntimeGateKey, string>;

export const SAFE_GATES: GateValues = {
  EXECUTION_GLOBAL_KILL_SWITCH: "true",
  EXECUTION_LIVE_ENTRY_ENABLED: "false",
  EXECUTION_PROTECTION_READY: "false",
};

export const LIVE_READY_GATES: GateValues = {
  EXECUTION_GLOBAL_KILL_SWITCH: "false",
  EXECUTION_LIVE_ENTRY_ENABLED: "true",
  EXECUTION_PROTECTION_READY: "true",
};

/**
 * The take-profit modality switch.
 *
 * Deliberately NOT a member of `RUNTIME_GATE_KEYS`: those are the three gates
 * this tool WRITES to .env, and this one is never written there. It is a launch
 * choice, pinned into the child environment for the life of that runtime and
 * nowhere else, so an operator does not have to edit or clean a file to change
 * it — and so a stale file value can never contradict the running processes.
 */
export const STANDARD_LIMIT_TAKE_PROFIT_KEY = "EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED";

/**
 * The child's value for the take-profit modality switch, ALWAYS explicit.
 *
 * Omitting the key would let an exported shell value decide it: `dotenv` does
 * not overwrite a variable that is already present, so an ambient `true` would
 * silently win over both the file and the operator's intent, and place real
 * take profits as resting LIMIT orders nobody chose. Pinning "false" is what
 * makes "I did not ask for it" mean it is off.
 */
export function standardLimitTakeProfitEnv(enabled: boolean): Record<string, string> {
  return { [STANDARD_LIMIT_TAKE_PROFIT_KEY]: enabled ? "true" : "false" };
}

export type DiskMode = "SAFE" | "LIVE_READY" | "INVALID";

/**
 * Which posture the three gates spell out.
 *
 * Anything that is neither posture is INVALID and is reported as such. It is
 * never normalized: a half-open combination means someone edited the file by
 * hand or a write failed partway, and quietly "fixing" it would hide that.
 */
export function classifyDiskMode(values: Partial<GateValues>): DiskMode {
  const matches = (target: GateValues) =>
    RUNTIME_GATE_KEYS.every((key) => values[key] === target[key]);
  if (matches(SAFE_GATES)) return "SAFE";
  if (matches(LIVE_READY_GATES)) return "LIVE_READY";
  return "INVALID";
}

export function gatesFor(mode: Exclude<DiskMode, "INVALID">): GateValues {
  return mode === "SAFE" ? SAFE_GATES : LIVE_READY_GATES;
}

// ---------------------------------------------------------------------------
// Reading and rewriting .env
// ---------------------------------------------------------------------------

export type GateReadResult =
  | { ok: true; values: GateValues }
  | { ok: false; reason: string };

const GATE_LINE = /^([A-Z0-9_]+)=(.*)$/;

/**
 * Reads the three gates out of a raw `.env`.
 *
 * Refuses ambiguity rather than guessing. A key that appears twice has no
 * single answer — dotenv would take one of them and this tool would rewrite the
 * other, leaving the file saying one thing and the runtime believing another.
 * A missing key is equally refused: writing it in would mean inventing
 * configuration for a real-money deployment.
 *
 * Only the three gate lines are ever inspected. No other line is parsed, so no
 * secret is read into memory here.
 */
export function readGates(envText: string): GateReadResult {
  const seen = new Map<RuntimeGateKey, string[]>();
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = GATE_LINE.exec(line);
    if (!match) continue;
    const key = match[1] as RuntimeGateKey;
    if (!(RUNTIME_GATE_KEYS as readonly string[]).includes(key)) continue;
    seen.set(key, [...(seen.get(key) ?? []), match[2].trim()]);
  }

  const missing = RUNTIME_GATE_KEYS.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    return { ok: false, reason: `missing gate key(s): ${missing.join(", ")}` };
  }
  const duplicated = RUNTIME_GATE_KEYS.filter((key) => (seen.get(key)?.length ?? 0) > 1);
  if (duplicated.length > 0) {
    return { ok: false, reason: `duplicate gate key(s): ${duplicated.join(", ")}` };
  }

  const values = Object.fromEntries(
    RUNTIME_GATE_KEYS.map((key) => [key, seen.get(key)![0]])
  ) as GateValues;

  // A gate that is neither "true" nor "false" is not something to overwrite
  // silently: the operator needs to see it.
  const invalid = RUNTIME_GATE_KEYS.filter((key) => values[key] !== "true" && values[key] !== "false");
  if (invalid.length > 0) {
    return { ok: false, reason: `gate key(s) hold a non-boolean value: ${invalid.join(", ")}` };
  }

  return { ok: true, values };
}

export type GateWriteResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Produces the rewritten `.env` text with ONLY the three gate lines changed.
 *
 * Every other byte survives: line endings, comments, blank lines, ordering and
 * every unrelated value. The file is rebuilt by replacing three lines in place,
 * never by re-serializing a parsed model — a round-trip through a parser is
 * exactly how comments and formatting get silently destroyed, and this file
 * holds credentials nobody wants reformatted.
 */
export function applyGates(envText: string, target: GateValues): GateWriteResult {
  const current = readGates(envText);
  if (!current.ok) return current;

  const lines = envText.split("\n");
  const written = new Set<RuntimeGateKey>();

  const next = lines.map((raw) => {
    // Preserve a trailing \r so a CRLF file stays CRLF, byte for byte.
    const hasCr = raw.endsWith("\r");
    const body = hasCr ? raw.slice(0, -1) : raw;
    const trimmed = body.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return raw;
    const match = GATE_LINE.exec(trimmed);
    if (!match) return raw;
    const key = match[1] as RuntimeGateKey;
    if (!(RUNTIME_GATE_KEYS as readonly string[]).includes(key)) return raw;
    written.add(key);
    return `${key}=${target[key]}${hasCr ? "\r" : ""}`;
  });

  if (written.size !== RUNTIME_GATE_KEYS.length) {
    return { ok: false, reason: "gate lines could not all be located for rewrite" };
  }
  return { ok: true, text: next.join("\n") };
}

/** Whether the operator credential is present, WITHOUT reading its value. */
export function operatorTokenState(envText: string): "CONFIGURED" | "NOT CONFIGURED" {
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("OPERATOR_API_TOKEN=")) continue;
    // Length only. The value itself is never captured, returned or logged.
    return line.slice("OPERATOR_API_TOKEN=".length).trim().length > 0 ? "CONFIGURED" : "NOT CONFIGURED";
  }
  return "NOT CONFIGURED";
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export const LIVE_READY_CONFIRMATION = "ENABLE LIVE RUNTIME";

/**
 * The typed phrase that turns the take-profit modality switch on for ONE
 * runtime.
 *
 * A typed phrase rather than a y/n, for the same reason LIVE-READY uses one:
 * this decides how real take profits are placed, and it should not be reachable
 * by an absent-minded keystroke. Anything else — including empty input, which
 * is what an operator who just wants to start the runtime will press — is off.
 */
export const STANDARD_LIMIT_TAKE_PROFIT_CONFIRMATION = "ENABLE LIMIT TAKE PROFIT";

export function isStandardLimitTakeProfitConfirmed(typed: unknown): boolean {
  return typeof typed === "string" && typed.trim().toUpperCase() === STANDARD_LIMIT_TAKE_PROFIT_CONFIRMATION;
}

/** Exact match, for the same reason the ARM confirmation is exact. */
export function isLiveReadyConfirmed(typed: unknown): boolean {
  return typed === LIVE_READY_CONFIRMATION;
}

// ---------------------------------------------------------------------------
// Process ownership
// ---------------------------------------------------------------------------

export type LauncherRole = "backend" | "worker" | "frontend";
export const LAUNCHER_ROLES: readonly LauncherRole[] = ["backend", "worker", "frontend"];

export interface OwnedProcess {
  role: LauncherRole;
  pid: number;
  /** Milliseconds since epoch. Defeats PID reuse: a recycled PID starts later. */
  startedAtMs: number;
}

export interface RuntimeState {
  repoRoot: string;
  mode: Exclude<DiskMode, "INVALID">;
  startedAtMs: number;
  processes: OwnedProcess[];
  /**
   * The take-profit modality this runtime was started with. Recorded because a
   * supervised worker restart must reproduce the RUNTIME it is replacing, not
   * re-derive the choice; absent in state written before this existed, which
   * `standardLimitTakeProfitOf` reads as off.
   */
  standardLimitTakeProfit?: boolean;
}

/** The recorded choice, with a missing or malformed value read as OFF. */
export function standardLimitTakeProfitOf(state: Pick<RuntimeState, "standardLimitTakeProfit">): boolean {
  return state.standardLimitTakeProfit === true;
}

/** What the OS reports about a live PID. Supplied by the CLI, faked in tests. */
export interface ProcessProbe {
  pid: number;
  commandLine: string;
  startedAtMs: number;
}

export type OwnershipVerdict =
  | { owned: true }
  | { owned: false; reason: "GONE" | "PID_REUSED" | "NOT_THIS_REPO" };

/**
 * Whether a recorded PID may be terminated.
 *
 * Three independent conditions, because killing the wrong process on someone's
 * development machine is unacceptable and a PID alone proves nothing:
 *
 *  - the process still exists,
 *  - it started when we recorded it starting (a reused PID will not),
 *  - and its command line still points at THIS repository.
 *
 * Any doubt returns not-owned, and a not-owned process is reported, never
 * killed. Failing to stop something is recoverable; killing an unrelated
 * program is not.
 */
export function verifyOwnership(
  record: OwnedProcess,
  probe: ProcessProbe | null,
  repoRoot: string
): OwnershipVerdict {
  if (!probe) return { owned: false, reason: "GONE" };
  // A one-second tolerance: creation timestamps are reported at coarse
  // resolution, and an exact-equality check would reject our own processes.
  if (Math.abs(probe.startedAtMs - record.startedAtMs) > 1000) {
    return { owned: false, reason: "PID_REUSED" };
  }
  const normalized = probe.commandLine.replace(/\//g, "\\").toLowerCase();
  if (!normalized.includes(resolve(repoRoot).replace(/\//g, "\\").toLowerCase())) {
    return { owned: false, reason: "NOT_THIS_REPO" };
  }
  return { owned: true };
}

// ---------------------------------------------------------------------------
// How each role is launched
// ---------------------------------------------------------------------------

/**
 * The repo's OWN commands. Fixed, repo-controlled values: nothing an operator
 * types can reach this table, and there is no path by which a role name becomes
 * an arbitrary command.
 */
export const ROLE_COMMANDS: Readonly<Record<LauncherRole, { filter: string; script: string }>> = Object.freeze({
  backend: { filter: "@trading-alert-dashboard/backend", script: "dev" },
  worker: { filter: "@trading-alert-dashboard/backend", script: "worker" },
  frontend: { filter: "@trading-alert-dashboard/frontend", script: "dev" },
});

export interface SpawnPlan {
  command: string;
  args: string[];
  options: {
    cwd: string;
    detached: true;
    stdio: "ignore";
    windowsHide: boolean;
    /** The child's environment, with the REQUESTED gates pinned explicitly. */
    env: NodeJS.ProcessEnv;
  };
}

/**
 * How a role is started on Windows.
 *
 * ## Why the command processor, and not `pnpm.cmd` directly
 *
 * Since the CVE-2024-27980 fix (Node 18.20.2 / 20.12.2 and later) `spawn`
 * refuses to execute `.cmd` and `.bat` files unless a shell is involved, and
 * returns EINVAL. The first real SAFE rehearsal hit exactly that: no role could
 * start at all.
 *
 * ## Why not `shell: true`
 *
 * `shell: true` makes Node flatten the arguments into ONE command string and
 * hand it to cmd with verbatim-argument semantics, so every value becomes
 * subject to cmd's metacharacter parsing. Invoking the command processor
 * explicitly keeps Node's own argument quoting and confines cmd to `/c` plus a
 * fixed argument vector. For a tool whose job is starting a real-money runtime,
 * "exactly these arguments" beats "a string cmd will re-parse".
 *
 *  - `/d` skips any machine-local AutoRun registry command, which would
 *    otherwise execute before ours.
 *  - `/s` gives deterministic quote handling.
 *  - `/c` runs the command and exits with it, which is what keeps the cmd
 *    process alive for the role's whole lifetime.
 *
 * ## Why `-C <repoRoot>` is present even though `cwd` is already set
 *
 * It is redundant to pnpm and load-bearing for SAFETY. The recorded root PID is
 * the cmd process, and `verifyOwnership` will only terminate a PID whose
 * command line contains this repository's absolute path. Without `-C` the cmd
 * command line reads `pnpm --filter @trading-alert-dashboard/backend dev`,
 * which names the package but not the path — so the launcher could start a
 * process it would later refuse to recognise as its own, and could never stop
 * it.
 */
export function windowsSpawnPlan(
  role: LauncherRole,
  repoRoot: string,
  mode: Exclude<DiskMode, "INVALID">,
  env: NodeJS.ProcessEnv = process.env,
  /**
   * The operator's EXPLICIT take-profit modality choice for this runtime.
   *
   * Defaulted to false on purpose: every existing caller, and every future one
   * that forgets, pins the feature off rather than inheriting whatever the
   * launching shell happened to carry.
   */
  standardLimitTakeProfit = false
): SpawnPlan {
  const { filter, script } = ROLE_COMMANDS[role];
  return {
    command: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", "pnpm", "-C", repoRoot, "--filter", filter, script],
    options: {
      cwd: repoRoot,
      // detached so the whole tree can be terminated by root PID later, and so
      // the launcher's own console is not the parent of a long-lived dev server.
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      // The REQUESTED gates, pinned on top of the inherited environment.
      // Spread, never mutated: `process.env` itself is left alone.
      //
      // This is the fix for the defect the first LIVE-READY rehearsal exposed.
      // The launcher loads dotenv-backed configuration while checking the
      // durable state, which happens BEFORE the gates are rewritten. Its own
      // environment therefore holds the OLD values, children inherit them, and
      // dotenv in the child will not overwrite a variable that is already
      // present -- so the runtime came up in the previous mode while both the
      // file and the launcher reported the new one.
      //
      // Inheriting everything else is deliberate: credentials, DATABASE_URL and
      // the rest must reach the child untouched.
      // The take-profit modality switch is pinned the same way and for the same
      // reason, but it is a launch choice rather than a gate: it is never
      // written to .env, so the running processes are its only record.
      env: { ...env, ...gatesFor(mode), ...standardLimitTakeProfitEnv(standardLimitTakeProfit) },
    },
  };
}

// ---------------------------------------------------------------------------
// Post-start runtime mode verification
// ---------------------------------------------------------------------------

/**
 * The gate snapshot the running processes must attest for a requested mode.
 *
 * The three activation gates come from the canonical tables; the four mutation
 * flags are pinned to their conservative values because this tool only ever
 * supports the reviewed posture. A runtime attesting anything else is refused
 * rather than accommodated.
 */
export function expectedGateSnapshotFor(mode: Exclude<DiskMode, "INVALID">): RuntimeGateSnapshot {
  const gates = gatesFor(mode);
  return {
    globalKillSwitch: gates.EXECUTION_GLOBAL_KILL_SWITCH === "true",
    liveEntryEnabled: gates.EXECUTION_LIVE_ENTRY_ENABLED === "true",
    protectionReady: gates.EXECUTION_PROTECTION_READY === "true",
    accountSetupMutationsEnabled: false,
    testOrderEnabled: false,
    autoAddMarginEnabled: false,
    emergencyCloseMode: "DISABLED",
  };
}

/** Just enough of the attestation status to judge it, with no runtime import. */
export interface AttestationRoleView {
  freshCount: number;
  gates: RuntimeGateSnapshot | null;
}

export interface AttestationStatusView {
  ok: boolean;
  reasonCode: string | null;
  message: string | null;
  backend: AttestationRoleView;
  worker: AttestationRoleView;
}

export type RuntimeModeVerdict = { ok: true } | { ok: false; reason: string };

function gatesEqual(a: RuntimeGateSnapshot, b: RuntimeGateSnapshot): boolean {
  return (
    a.globalKillSwitch === b.globalKillSwitch &&
    a.liveEntryEnabled === b.liveEntryEnabled &&
    a.protectionReady === b.protectionReady &&
    a.accountSetupMutationsEnabled === b.accountSetupMutationsEnabled &&
    a.testOrderEnabled === b.testOrderEnabled &&
    a.autoAddMarginEnabled === b.autoAddMarginEnabled &&
    a.emergencyCloseMode === b.emergencyCloseMode
  );
}

/** The three non-secret activation gates only. Nothing else is ever printed. */
function describeGates(g: RuntimeGateSnapshot): string {
  return "killSwitch=" + g.globalKillSwitch + " liveEntry=" + g.liveEntryEnabled + " protectionReady=" + g.protectionReady;
}

/**
 * Whether the RUNNING processes actually loaded the requested mode.
 *
 * Open ports and a rewritten file prove only that the launcher did its own
 * part. The first LIVE-READY rehearsal came up with LIVE-READY on disk and SAFE
 * in both processes, and nothing in the tool noticed -- so this asks the
 * runtime itself, through the attestation both roles already publish.
 *
 * Everything is refused except the exact expected shape: one fresh BACKEND, one
 * fresh WORKER, both attesting the requested gates. Missing, duplicated, stale,
 * malformed and unreadable all fail closed, because "we could not tell" is not
 * the same as "it is correct".
 */
export function verifyRuntimeMode(
  status: AttestationStatusView | null,
  mode: Exclude<DiskMode, "INVALID">
): RuntimeModeVerdict {
  if (!status) return { ok: false, reason: "runtime attestation could not be read" };
  if (!status.ok) return { ok: false, reason: status.reasonCode ?? "runtime attestation is not valid" };

  const expected = expectedGateSnapshotFor(mode);
  const roles: Array<[string, AttestationRoleView]> = [
    ["BACKEND", status.backend],
    ["WORKER", status.worker],
  ];
  for (const [role, view] of roles) {
    // Exactly one fresh instance per role: zero means it never started or has
    // gone stale, more than one means two stacks are competing.
    if (view.freshCount !== 1) {
      return { ok: false, reason: "expected exactly 1 fresh " + role + " attestation, found " + view.freshCount };
    }
    if (!view.gates) {
      return { ok: false, reason: role + " attestation carried no gate snapshot" };
    }
    if (!gatesEqual(view.gates, expected)) {
      return {
        ok: false,
        reason: role + " attested " + describeGates(view.gates) + ", expected " + describeGates(expected),
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Fail-closed cleanup after a runtime mode mismatch
// ---------------------------------------------------------------------------

export type CleanupRootOutcome = "TERMINATED" | "ALREADY_GONE" | "NOT_OWNED" | "TERMINATION_FAILED";

export interface CleanupRootResult {
  role: LauncherRole;
  pid: number;
  outcome: CleanupRootOutcome;
}

export interface CleanupResult {
  results: CleanupRootResult[];
  /** Roots that are NOT provably gone. Any entry means operator recovery. */
  unresolved: CleanupRootResult[];
  safeGatesRestored: boolean;
  stateCleared: boolean;
}

/** The side effects cleanup needs. Injected so this stays testable with fakes. */
export interface CleanupAdapters {
  probe(pid: number): ProcessProbe | null;
  terminate(pid: number): boolean;
  /** Rewrites the three gates to canonical SAFE. Returns false on any failure. */
  restoreSafeGates(): boolean;
  clearState(): void;
  log(line: string): void;
}

/**
 * Shuts down a runtime that did NOT attest the requested mode.
 *
 * ## Why refusing to print success is not enough
 *
 * A mismatch means the running configuration is not the one that was asked
 * for, and it may be the MORE permissive one: a requested SAFE start whose
 * processes came up LIVE-READY leaves an armable runtime alive while the
 * operator has been told the start failed. Start SAFE deliberately does not
 * require a durably SAFE_OFF profile, so nothing downstream can be assumed to
 * make that harmless. The only safe response is to take the untrusted runtime
 * back down and put the deployment gates back to SAFE.
 *
 * ## What it will not do
 *
 * Every root is re-verified through the same ownership rules used everywhere
 * else — exists, creation time matches, command line belongs to this
 * repository. Anything that fails those checks is REPORTED and left alone;
 * there is no name-based sweep and no force applied to a process this tool
 * cannot prove it started.
 *
 * Ownership state is cleared only when every root is provably gone. If even
 * one is unresolved the record is kept, because throwing it away would strip
 * the operator of the one path that can still find and stop those processes —
 * making the launcher look clean at the cost of making the machine unsafe.
 *
 * SAFE gate restoration is attempted either way: a file that still says
 * LIVE-READY would hand the next start a posture nobody asked for.
 *
 * It mutates no durable trading state, calls no operator action and never
 * reaches the exchange.
 */
export function cleanupAfterModeMismatch(state: RuntimeState, adapters: CleanupAdapters): CleanupResult {
  const results: CleanupRootResult[] = [];

  for (const record of state.processes) {
    const verdict = verifyOwnership(record, adapters.probe(record.pid), state.repoRoot);

    if (!verdict.owned) {
      if (verdict.reason === "GONE") {
        results.push({ role: record.role, pid: record.pid, outcome: "ALREADY_GONE" });
        adapters.log(`  ${record.role} pid ${record.pid}: already gone`);
      } else {
        // PID reused, or the process no longer looks like ours. Reported, never
        // terminated: killing an unrelated program is not recoverable.
        results.push({ role: record.role, pid: record.pid, outcome: "NOT_OWNED" });
        adapters.log(`  ${record.role} pid ${record.pid}: ${verdict.reason} — NOT terminated`);
      }
      continue;
    }

    adapters.terminate(record.pid);
    // Trust the re-probe, not the exit code: what matters is whether the
    // process is actually gone.
    const stillThere = verifyOwnership(record, adapters.probe(record.pid), state.repoRoot).owned;
    if (stillThere) {
      results.push({ role: record.role, pid: record.pid, outcome: "TERMINATION_FAILED" });
      adapters.log(`  ${record.role} pid ${record.pid}: could NOT be stopped`);
    } else {
      results.push({ role: record.role, pid: record.pid, outcome: "TERMINATED" });
      adapters.log(`  ${record.role} pid ${record.pid}: stopped`);
    }
  }

  const unresolved = results.filter(
    (entry) => entry.outcome === "NOT_OWNED" || entry.outcome === "TERMINATION_FAILED"
  );

  // Attempted regardless: the disk must not be left claiming a mode nobody
  // asked for, even when a process could not be stopped.
  const safeGatesRestored = adapters.restoreSafeGates();

  let stateCleared = false;
  if (unresolved.length === 0) {
    adapters.clearState();
    stateCleared = true;
  }

  return { results, unresolved, safeGatesRestored, stateCleared };
}

// ---------------------------------------------------------------------------
// Runtime state file — machine-local, never in source control
// ---------------------------------------------------------------------------

/**
 * Where the launcher remembers what it started.
 *
 * `%LOCALAPPDATA%` rather than the repository: this is machine state, not
 * source, and a PID file inside a git worktree is one `git add -A` away from
 * being committed.
 */
export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA ?? env.TEMP ?? ".";
  return join(base, "trading-alert-dashboard", "runtime-launcher-state.json");
}

export interface StateStore {
  read(): RuntimeState | null;
  write(state: RuntimeState): void;
  clear(): void;
}

export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  read(): RuntimeState | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as RuntimeState;
      if (typeof parsed?.repoRoot !== "string" || !Array.isArray(parsed?.processes)) return null;
      return parsed;
    } catch {
      // An unreadable file means "we do not know what is running", which is
      // treated exactly like no file: nothing is eligible for termination.
      return null;
    }
  }

  /** Atomic replace: a crash mid-write can never leave a half-parsed PID list. */
  write(state: RuntimeState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

/** In-memory store for tests — no filesystem, same semantics. */
export class MemoryStateStore implements StateStore {
  private state: RuntimeState | null = null;
  read(): RuntimeState | null {
    return this.state;
  }
  write(state: RuntimeState): void {
    this.state = state;
  }
  clear(): void {
    this.state = null;
  }
}

// ---------------------------------------------------------------------------
// Outstanding trading work
// ---------------------------------------------------------------------------

/**
 * The DURABLE trading state, exactly as the read-only Trading Control status
 * already reports it. Every field is `null` when it could not be read.
 *
 * Nothing here is a second state model: `systemState`, the authorization state
 * and the warning codes are all produced by `TradingControlService`, and the
 * launcher only reads them.
 */
export interface DurableTradingState {
  /** SAFE_OFF | ARMED | SAFE_RECOVERY | INVALID | UNKNOWN, or null if unread. */
  systemState: string | null;
  activeExecutions: number | null;
  manualIntervention: number | null;
  /** The newest natural window's state, or null when no window exists. */
  authorizationState: string | null;
  /** Warning codes from the status contract, or null if unread. */
  warnings: string[] | null;
}

export type DurableVerdict = { safe: true } | { safe: false; reason: string };

/**
 * Warnings that mean trading work still needs attention.
 *
 * Deliberately a subset. `RUNTIME_ATTESTATION_BLOCKED` is expected whenever the
 * runtime is down — which is precisely when the launcher runs — and
 * `NATURAL_AUTHORIZATION_EXPIRED` describes a window that is already closed.
 * Treating either as a blocker would make the tool unusable without making it
 * safer. `FILLED_WITHOUT_VERIFIED_PROTECTION` is the recovery-required signal.
 */
const RECOVERY_WARNINGS = ["MANUAL_INTERVENTION_REQUIRED", "FILLED_WITHOUT_VERIFIED_PROTECTION"];

/**
 * Whether the DURABLE trading state is safe for the launcher to act on.
 *
 * ## Why this exists
 *
 * Process gates and durable state are different things, and the launcher used
 * to reason only about the first. That was a real hole: a profile left
 * `isEnabled=true, killSwitchActive=false` — or holding an AVAILABLE natural
 * window — is still ARMED in the database while the runtime is off. Loading
 * LIVE-READY gates and starting the worker would make that pre-existing
 * authorization executable again with no fresh Start Trading action on the
 * dashboard, which is exactly the boundary the operator controls exist to keep.
 *
 * The same reasoning applies to shutting down: "zero active executions" is NOT
 * "durably disarmed". The worker protects and reconciles open positions, and an
 * armed profile with an open window can admit one at any moment.
 *
 * So both transitions require the same thing — the durable state the dashboard
 * reports must be SAFE OFF and clean. An unreadable state refuses: "we could
 * not reach the database" and "there is nothing outstanding" are different
 * facts, and only one of them is safe to act on.
 *
 * This NEVER mutates anything. Reaching a safe state is the dashboard's job,
 * through Safe Off, and the launcher deliberately cannot do it.
 */
export function evaluateDurableSafety(state: DurableTradingState, action: "LIVE_READY" | "SHUTDOWN"): DurableVerdict {
  const next =
    action === "LIVE_READY"
      ? "Use Trading Control -> Safe Off before starting LIVE-READY."
      : "Use Trading Control -> Safe Off and wait until the system reports SAFE OFF before stopping the runtime.";

  if (
    state.systemState === null ||
    state.activeExecutions === null ||
    state.manualIntervention === null ||
    state.warnings === null
  ) {
    return {
      safe: false,
      reason: `The durable Trading Control state could not be read. It is not assumed to be safe. ${next}`,
    };
  }

  if (state.systemState !== "SAFE_OFF") {
    return {
      safe: false,
      reason: `Trading Control is not durably SAFE OFF (currently ${state.systemState}). ${next}`,
    };
  }

  // An open window can admit a trade the moment a runtime is live, regardless
  // of what the profile flags say right now.
  if (state.authorizationState === "AVAILABLE") {
    return {
      safe: false,
      reason: `A natural authorization window is still AVAILABLE and could admit a new trade. The durable trading state must be cleared through Trading Control first. ${next}`,
    };
  }

  if (state.activeExecutions > 0) {
    return {
      safe: false,
      reason:
        `${state.activeExecutions} execution(s) are still active. ${next}` +
        (action === "SHUTDOWN"
          ? " If those are pending ENTRY orders resting at the exchange, run" +
            " `pnpm --filter @trading-alert-dashboard/backend execution:prepare-shutdown evaluate`" +
            " to see what a drain would cancel."
          : ""),
    };
  }

  if (state.manualIntervention > 0) {
    return {
      safe: false,
      reason: `${state.manualIntervention} execution(s) require manual intervention. Resolve them in Trading Control first.`,
    };
  }

  const recovery = state.warnings.filter((code) => RECOVERY_WARNINGS.includes(code));
  if (recovery.length > 0) {
    return {
      safe: false,
      reason: `Trading Control reports outstanding recovery work (${recovery.join(", ")}). ${next}`,
    };
  }

  return { safe: true };
}

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

/**
 * What a role's own heartbeat says about it, as opposed to what the
 * operating system says about its process.
 *
 *   HEALTHY   — exactly one fresh attestation for the role.
 *   STALE     — the process is owned and alive, and nothing is attesting.
 *               This is the incident state: ON without OK.
 *   DUPLICATE — more than one fresh instance is claiming the role.
 *   UNKNOWN   — attestation could not be read at all.
 *   OFF       — no owned process, so there is nothing to be healthy.
 */
export type RoleHealth = "HEALTHY" | "STALE" | "DUPLICATE" | "UNKNOWN" | "OFF";

export interface StatusView {
  diskMode: DiskMode;
  diskModeWarning: string | null;
  backend: "ON" | "OFF";
  worker: "ON" | "OFF";
  frontend: "ON" | "OFF";
  /** Per-role heartbeat verdict. Frontend publishes none, so it has none. */
  health: { backend: RoleHealth; worker: RoleHealth };
  ports: { backend: number; frontend: number; backendOpen: boolean; frontendOpen: boolean };
  operatorToken: "CONFIGURED" | "NOT CONFIGURED";
  attestation: string | null;
}

/**
 * Turns process ownership plus one attestation reading into a health verdict.
 *
 * The two inputs are deliberately independent. Ownership answers 'is a process
 * of mine still there?', which is all `verifyOwnership` can ever prove: a PID
 * that exists, created when we created it, running from this repository. The
 * attestation answers 'is that process still doing its job?'. During the first
 * MAINNET commissioning those two answers diverged for the worker — process
 * present, heartbeat gone, reconciliation stopped — and the tool showed only
 * the first, which read as reassurance.
 */
export function judgeRoleHealth(running: boolean, view: AttestationRoleView | null): RoleHealth {
  if (!running) return "OFF";
  if (!view) return "UNKNOWN";
  if (view.freshCount === 1) return "HEALTHY";
  return view.freshCount > 1 ? "DUPLICATE" : "STALE";
}

export const BACKEND_PORT = 4000;
export const FRONTEND_PORT = 5173;

export const INVALID_MODE_WARNING =
  "The three execution gates are in an unrecognised combination. This tool will not normalize it silently — inspect the deployment configuration before starting anything.";

export function presentStatus(input: {
  diskMode: DiskMode;
  running: Record<LauncherRole, boolean>;
  backendPortOpen: boolean;
  frontendPortOpen: boolean;
  operatorToken: "CONFIGURED" | "NOT CONFIGURED";
  attestation?: string | null;
  /** One attestation reading, or null when it could not be read. */
  attestationRoles?: { backend: AttestationRoleView; worker: AttestationRoleView } | null;
}): StatusView {
  const roles = input.attestationRoles ?? null;
  return {
    diskMode: input.diskMode,
    diskModeWarning: input.diskMode === "INVALID" ? INVALID_MODE_WARNING : null,
    backend: input.running.backend ? "ON" : "OFF",
    worker: input.running.worker ? "ON" : "OFF",
    frontend: input.running.frontend ? "ON" : "OFF",
    health: {
      backend: judgeRoleHealth(input.running.backend, roles?.backend ?? null),
      worker: judgeRoleHealth(input.running.worker, roles?.worker ?? null),
    },
    ports: {
      backend: BACKEND_PORT,
      frontend: FRONTEND_PORT,
      backendOpen: input.backendPortOpen,
      frontendOpen: input.frontendPortOpen,
    },
    operatorToken: input.operatorToken,
    attestation: input.attestation ?? null,
  };
}

/**
 * What to tell an operator when a role is ON but is not attesting.
 *
 * The first version of this ended "Restart the runtime.", which is wrong under
 * the launcher's own semantics. In precisely the state it fires — a role owned
 * and alive, an execution still active — BOTH controls refuse:
 *
 *   Stop Runtime & Return SAFE    `evaluateDurableSafety(..., "SHUTDOWN")` refuses
 *                                 while an execution is active, and stops nothing.
 *   Start SAFE / Start LIVE-READY `evaluateStartPreconditions` refuses while a
 *                                 launcher-owned process is alive or an expected
 *                                 port is open.
 *
 * So the old line named a generic restart this tool does not offer, by way of two
 * controls that both decline. Worse, an operator who read it as an instruction
 * could try to force the one that is genuinely dangerous: a second Start would
 * mean a second stack competing for the ports and publishing a duplicate
 * attestation. The guard holds — but guidance should never lean on a guard to
 * stop the operator doing what the guidance just told them to do.
 *
 * It now states the consequence, names what must not be forced, and leaves the
 * recovery decision with the operator. This patch deliberately adds no restart
 * mechanism and changes no guard.
 *
 * Role-aware on purpose: a stale BACKEND does not stop reconciliation, and the
 * old single sentence claimed it did.
 */
export function describeStaleHealth(view: StatusView): string[] {
  const stale = (["worker", "backend"] as const).filter((role) => view.health[role] === "STALE");
  if (stale.length === 0) return [];

  const names = stale.map((role) => role.toUpperCase()).join(" and ");
  const subject = stale.length > 1 ? "processes are" : "process is";

  return [
    `  WARNING: the ${names} ${subject} running but not attesting.`,
    ...(view.health.worker === "STALE"
      ? [
          "    Execution reconciliation may be impaired: open positions and their",
          "    protection orders may not be maintained while this persists.",
        ]
      : []),
    ...(view.health.backend === "STALE"
      ? ["    Activation readiness cannot be confirmed while the backend is silent."]
      : []),
    "    Do NOT Start SAFE or Start LIVE-READY while this runtime is still owned:",
    "    that would be a SECOND stack, and the launcher refuses it for that reason.",
    "    Stop Runtime & Return SAFE is refused while an execution is active, by",
    "    design, so neither control recovers this state on its own.",
    "    If an execution is active, keep new trading blocked - do not arm - and",
    "    carry out controlled worker recovery under supervision.",
  ];
}

/** The rendered status block. Contains counts and states only, never a value. */
export function renderStatus(view: StatusView): string[] {
  const staleWarning = describeStaleHealth(view);
  // Process and health are printed as SEPARATE columns on purpose. 'Worker ON'
  // alone once meant nothing more than 'a PID we started is still there'.
  return [
    "Runtime:",
    `  Backend     process ${view.backend}   health ${view.health.backend}`,
    `  Worker      process ${view.worker}   health ${view.health.worker}`,
    `  Frontend    process ${view.frontend}`,
    "",
    ...(staleWarning.length > 0 ? [...staleWarning, ""] : []),
    `Expected ports: ${view.ports.backend} ${view.ports.backendOpen ? "open" : "closed"}, ` +
      `${view.ports.frontend} ${view.ports.frontendOpen ? "open" : "closed"}`,
    "",
    "Disk mode:",
    `  ${view.diskMode}`,
    ...(view.diskModeWarning ? ["", `  WARNING: ${view.diskModeWarning}`] : []),
    "",
    `Operator token: ${view.operatorToken}`,
    ...(view.attestation ? [`Runtime attestation: ${view.attestation}`] : []),
  ];
}

// ---------------------------------------------------------------------------
// Start guards
// ---------------------------------------------------------------------------

export type StartVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether a new stack may be started.
 *
 * A second stack would fight the first for ports 4000 and 5173 and — far worse
 * — would publish a second runtime attestation, which the ARM interlock treats
 * as a duplicate and refuses. Refusing here is both kinder and safer than
 * letting two half-working stacks coexist.
 */
export function evaluateStartPreconditions(input: {
  recordedProcessesAlive: number;
  backendPortOpen: boolean;
  frontendPortOpen: boolean;
}): StartVerdict {
  if (input.recordedProcessesAlive > 0) {
    return {
      ok: false,
      reason: "A launcher-owned runtime is already running. Stop it first, then start the mode you want.",
    };
  }
  if (input.backendPortOpen || input.frontendPortOpen) {
    return {
      ok: false,
      reason:
        "An expected port is already in use by a process this launcher does not own. Investigate before starting a second stack.",
    };
  }
  return { ok: true };
}

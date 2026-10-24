import path from "node:path";

import { ACCOUNT_SENSITIVE_KEYS, runtimeEnvDir } from "../operator/dual-account-topology";
import { descendsFrom } from "../operator/generic-backend-nonwatch-launcher";
import type { ObservedProcessNode } from "../operator/runtime-launcher";
import { STRIPPED_CREDENTIAL_KEYS, type AlwaysOnRole } from "./always-on-contract";

/**
 * HOW the Always-On supervisor starts each role, and how it RECOGNISES one.
 *
 * Every command is repo-controlled: the same entrypoints the operator's
 * package scripts run (`tsx <entry>`, or the built backend), started as node
 * itself with the repository's own tsx CLI, so the owned root's command line
 * carries this repository's path, which is what later proves ownership.
 * Nothing an operator types reaches a command except the profile name, the
 * scanner run id and the engine fingerprint, each validated before it is used.
 *
 * Every child is started with the GENERIC environment file authoritative and
 * with every account / credential variable removed — case-insensitively,
 * because Windows environment names are — so no monitoring process can hold a
 * Binance key, an account identifier or any API secret.
 */

/** The entrypoints that do monitoring work, wherever they run (any checkout counts: they share LocalAppData state). */
export const MONITORING_ENTRYPOINTS = Object.freeze({
  backend: "dist/src/server.js",
  backendWatch: "src/server.ts",
  scanner: "src/modules/native-scanner/run-live-shadow-supervisor.ts",
  scannerSingle: "src/modules/native-scanner/run-live-shadow.ts",
  emitter: "src/modules/native-alerts/run-native-multi-emitter.ts",
  emitterSingle: "src/modules/native-alerts/run-native-alert-emitter.ts",
  planner: "src/modules/native-planning/native-plan.worker.ts",
  soakMonitor: "src/modules/signal-quality/run-signal-quality-soak-monitor.ts",
  supervisor: "src/modules/always-on/run-always-on-monitoring.ts",
} as const);
export type MonitoringEntrypointKind = keyof typeof MONITORING_ENTRYPOINTS;

/** Which role's job each runtime kind does (null: observed and reported, never a role conflict). */
const ROLE_OF_KIND: Readonly<Record<MonitoringEntrypointKind, AlwaysOnRole | null>> = Object.freeze({
  backend: "backend",
  backendWatch: "backend",
  scanner: "scanner",
  scannerSingle: "scanner",
  emitter: "emitter",
  emitterSingle: "emitter",
  planner: "planner",
  soakMonitor: null,
  supervisor: null,
});

// ---------------------------------------------------------------------------
// Child environment
// ---------------------------------------------------------------------------

export const genericEnvFilePath = (env: NodeJS.ProcessEnv) => path.join(runtimeEnvDir(env), "generic.env");

/** Every name that must never reach a monitoring child (upper-cased for a case-insensitive match). */
const NEVER_INHERITED = new Set([...ACCOUNT_SENSITIVE_KEYS, ...STRIPPED_CREDENTIAL_KEYS].map((key) => key.toUpperCase()));

/**
 * The environment one monitoring child starts with.
 *
 *  - every name the generic env file declares is removed, so the FILE wins
 *    (dotenv and Prisma never override an inherited value);
 *  - every account identity / credential name is removed unconditionally;
 *  - DOTENV_CONFIG_PATH is pinned to the generic file LAST.
 *
 * Matching is case-insensitive: on Windows `binance_api_key` IS
 * `BINANCE_API_KEY` to the child. The parent's environment is never modified.
 */
export function monitoringChildEnv(env: NodeJS.ProcessEnv, genericKeyNames: readonly string[]): NodeJS.ProcessEnv {
  const drop = new Set([...genericKeyNames.map((key) => key.toUpperCase()), ...NEVER_INHERITED, "DOTENV_CONFIG_PATH"]);
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!drop.has(key.toUpperCase())) child[key] = value;
  }
  child.DOTENV_CONFIG_PATH = genericEnvFilePath(env);
  return child;
}

/** The credential names present in an environment (names only — a value is never read here). */
export function credentialNamesPresent(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((key) => NEVER_INHERITED.has(key.toUpperCase()) && (env[key] ?? "") !== "")
    .sort();
}

// ---------------------------------------------------------------------------
// Spawn plans
// ---------------------------------------------------------------------------

export interface MonitoringSpawnPlan {
  readonly role: AlwaysOnRole;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** What it runs, for operators and the ownership record (repo-controlled; no environment value). */
  readonly commandIdentity: string;
}

/** Characters a shell could split or interpret: such a path is refused, never quoted around (defence in depth). */
const UNSAFE_ARGUMENT = /[\s"&|<>^%!]/;

export class MonitoringPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitoringPlanError";
  }
}

function assertPlainArgument(value: string, what: string): string {
  if (value === "" || UNSAFE_ARGUMENT.test(value)) {
    throw new MonitoringPlanError(`${what} contains a space or a shell character; refusing (${what} must be a plain path)`);
  }
  return value;
}

const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The node executable every role is started with (the supervisor's own). */
export const MONITORING_NODE = process.execPath;

/** The repository's own tsx CLI: exactly what each role's package script (`tsx <entry>`) runs. */
export const tsxCliOf = (repoRoot: string) => path.join(assertPlainArgument(repoRoot, "the repository path"), "apps", "backend", "node_modules", "tsx", "dist", "cli.mjs");

/**
 * A role started as NODE itself — never through cmd.exe. A DETACHED cmd.exe has no console, so every console
 * program it starts (pnpm, tsx, node) gets a new, hidden one and writes there: on the real machine
 * (2026-10-24) every role's log stayed empty. Node started detached writes to the log handle it is given,
 * and tsx hands that handle to the runtime it starts.
 */
function tsxPlan(role: AlwaysOnRole, repoRoot: string, env: NodeJS.ProcessEnv, genericKeyNames: readonly string[], script: string, entry: string, scriptArgs: readonly string[]): MonitoringSpawnPlan {
  return {
    role,
    command: MONITORING_NODE,
    args: [tsxCliOf(repoRoot), entry, ...scriptArgs],
    cwd: path.join(repoRoot, "apps", "backend"),
    env: monitoringChildEnv(env, genericKeyNames),
    commandIdentity: `${script}: tsx ${entry}${scriptArgs.length > 0 ? ` ${scriptArgs.join(" ")}` : ""}`,
  };
}

/** The BUILT generic backend, exactly as the launcher's non-watch mode runs it: no watcher, no build. */
export function backendSpawnPlan(repoRoot: string, env: NodeJS.ProcessEnv, genericKeyNames: readonly string[]): MonitoringSpawnPlan {
  const server = path.join(assertPlainArgument(repoRoot, "the repository path"), "apps", "backend", "dist", "src", "server.js");
  return {
    role: "backend",
    command: MONITORING_NODE,
    args: [server],
    cwd: path.join(repoRoot, "apps", "backend"),
    env: monitoringChildEnv(env, genericKeyNames),
    commandIdentity: "node apps/backend/dist/src/server.js",
  };
}

export interface ScannerPlanInput {
  readonly profileName: string;
  readonly stopFile: string;
  /** Validated scanner tuning flags (e.g. --max-total-requests N); never engine, universe or lineage flags. */
  readonly extraArgs: readonly string[];
}

/** The Native live-shadow supervisor on the profile (FAST_RECOVERY_V1 is its default), with a cooperative stop file. */
export function scannerSpawnPlan(repoRoot: string, env: NodeJS.ProcessEnv, genericKeyNames: readonly string[], input: ScannerPlanInput): MonitoringSpawnPlan {
  if (!PROFILE_NAME.test(input.profileName)) throw new MonitoringPlanError("the scanner profile name is not a plain profile identifier");
  for (const arg of input.extraArgs) assertPlainArgument(arg, "a scanner tuning argument");
  return tsxPlan("scanner", repoRoot, env, genericKeyNames, "scanner:live-shadow-supervisor", MONITORING_ENTRYPOINTS.scanner, [
    "--profile",
    input.profileName,
    "--stop-file",
    assertPlainArgument(input.stopFile, "the scanner stop-file path"),
    ...input.extraArgs,
  ]);
}

export interface EmitterPlanInput {
  readonly profileName: string;
  readonly runId: string;
  readonly engineFingerprint: string;
  readonly queueCapacity: number;
  readonly activateAtEof: boolean;
  readonly stopFile: string;
}

/** The multi-symbol emitter in COMMIT + follow, pinned to ONE scanner run and engine. DASHBOARD WRITES ONLY. */
export function emitterSpawnPlan(repoRoot: string, env: NodeJS.ProcessEnv, genericKeyNames: readonly string[], input: EmitterPlanInput): MonitoringSpawnPlan {
  if (!PROFILE_NAME.test(input.profileName)) throw new MonitoringPlanError("the emitter profile name is not a plain profile identifier");
  if (!RUN_ID.test(input.runId)) throw new MonitoringPlanError("the pinned scanner run id is not a supervisor run id");
  if (!SHA256.test(input.engineFingerprint)) throw new MonitoringPlanError("the expected engine fingerprint is not a SHA-256 hex digest");
  if (!Number.isSafeInteger(input.queueCapacity) || input.queueCapacity < 10 || input.queueCapacity > 100_000) throw new MonitoringPlanError("the emitter queue capacity is out of bounds");
  return tsxPlan("emitter", repoRoot, env, genericKeyNames, "native-alerts:multi-emitter", MONITORING_ENTRYPOINTS.emitter, [
    "--profile",
    input.profileName,
    "--run-id",
    input.runId,
    "--expect-engine-fingerprint",
    input.engineFingerprint,
    "--commit-dashboard-alerts",
    ...(input.activateAtEof ? ["--activate-at-eof"] : []),
    "--follow",
    "--queue-capacity",
    String(input.queueCapacity),
    "--stop-file",
    assertPlainArgument(input.stopFile, "the emitter stop-file path"),
  ]);
}

/** The planning-only Native planner worker, exactly as the launcher's optional planner role runs it. */
export function plannerSpawnPlan(repoRoot: string, env: NodeJS.ProcessEnv, genericKeyNames: readonly string[]): MonitoringSpawnPlan {
  return tsxPlan("planner", repoRoot, env, genericKeyNames, "native-alerts:plan-worker", MONITORING_ENTRYPOINTS.planner, []);
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

/**
 * Which monitoring entrypoint a process RUNS, or null. Only node.exe can be a
 * runtime: the cmd.exe wrappers, pnpm and the tsx CLI all carry the entrypoint
 * on their command line and are not it.
 */
export function classifyMonitoringRuntime(node: Pick<ObservedProcessNode, "executable" | "commandLine">): MonitoringEntrypointKind | null {
  if (node.executable.toLowerCase() !== "node.exe") return null;
  const normalized = node.commandLine.replace(/\\/g, "/");
  if (/pnpm\.cjs|pnpm\/bin/.test(normalized)) return null;
  if (/tsx\/dist\/cli\.mjs/.test(normalized)) return null;
  for (const [kind, entrypoint] of Object.entries(MONITORING_ENTRYPOINTS) as [MonitoringEntrypointKind, string][]) {
    if (normalized.includes(entrypoint)) return kind;
  }
  return null;
}

export interface MonitoringCensus {
  /** Each role's runtime pids inside its OWNED tree. */
  readonly owned: Readonly<Record<AlwaysOnRole, readonly number[]>>;
  /** Each role's runtime pids OUTSIDE every owned tree: conflicts, reported and never killed. */
  readonly external: Readonly<Record<AlwaysOnRole, readonly number[]>>;
  /** signal-quality soak monitors this supervisor does not own (reported, never killed). */
  readonly soakMonitors: readonly number[];
  /** Other Always-On supervisor runtimes than this one. */
  readonly otherSupervisors: readonly number[];
}

const emptyRoles = (): Record<AlwaysOnRole, number[]> => ({ backend: [], scanner: [], emitter: [], planner: [] });

/** Sorts every monitoring runtime by whose tree it hangs in. Ownership is ANCESTRY to an owned root, never a command-line match alone. */
export function monitoringCensus(tree: readonly ObservedProcessNode[], ownedRoots: Readonly<Partial<Record<AlwaysOnRole, number>>>, selfPid: number): MonitoringCensus {
  const owned = emptyRoles();
  const external = emptyRoles();
  const soakMonitors: number[] = [];
  const otherSupervisors: number[] = [];
  for (const node of tree) {
    const kind = classifyMonitoringRuntime(node);
    if (kind === null) continue;
    if (kind === "soakMonitor") {
      soakMonitors.push(node.pid);
      continue;
    }
    if (kind === "supervisor") {
      if (node.pid !== selfPid && !descendsFrom(tree, selfPid, node.pid)) otherSupervisors.push(node.pid);
      continue;
    }
    const role = ROLE_OF_KIND[kind] as AlwaysOnRole;
    const root = ownedRoots[role];
    if (root !== undefined && descendsFrom(tree, node.pid, root)) owned[role].push(node.pid);
    else external[role].push(node.pid);
  }
  return { owned, external, soakMonitors, otherSupervisors };
}

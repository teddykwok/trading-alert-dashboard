import { SupervisorCliUsageError, parseSupervisorCliArgs } from "../native-scanner/live-shadow-supervisor-cli-args";
import { ScannerProfileError, engineFingerprintOf, resolveScannerProfile } from "../native-scanner/scanner-profile";
import { ALWAYS_ON_DEFAULT_PROFILE, ALWAYS_ON_DEFAULTS, ALWAYS_ON_ROLES, type AlwaysOnRole } from "./always-on-contract";
import { ALWAYS_ON_DRILL_FAULT_NAMES, ALWAYS_ON_DRILL_MAX_SECONDS, ALWAYS_ON_DRILL_MIN_SECONDS, isDrillFault, type AlwaysOnDrillFault } from "./always-on-drill";

/**
 * Arguments for `monitoring:always-on`. MONITORING ONLY: there is no account,
 * order, risk, arming or execution option, and none can be expressed —
 * anything unlisted is refused.
 *
 *   run           own and supervise the monitoring stack (foreground; the startup task runs this)
 *   status        print the status artifact (read-only)
 *   stop          ask the running supervisor to stop the stack gracefully, and wait
 *   clear-latch   ask the running supervisor to clear a latched role
 *   startup-task  PRINT the Windows Task Scheduler command for a logon start (never registers anything)
 *   drill         the operator network drill (always-on-drill.ts): start one against the running supervisor's
 *                 generation and scanner run, restore, or show it — the ONLY way a drill can ever be requested
 */

export class AlwaysOnCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlwaysOnCliUsageError";
  }
}

export const ALWAYS_ON_CLI_USAGE = [
  "Usage (MONITORING ONLY · NO ACCOUNT EXECUTION · NATIVE EXECUTION HARD-DISABLED):",
  "  monitoring:always-on run [--profile teddy-7-all-active] [--roles backend,scanner,emitter,planner] [--backend-url http://127.0.0.1:4000]",
  "      [--poll-seconds 15] [--degraded-grace-seconds 90] [--max-recovery-attempts 6]",
  "      [--emitter-queue-capacity 10000] [--emitter-activate-at-eof] [--scanner-max-total-requests N] [--scanner-status-every-s N]",
  "  monitoring:always-on status [--json]",
  "  monitoring:always-on stop [--wait-seconds 600]",
  "  monitoring:always-on clear-latch [--role backend|scanner|emitter|planner]",
  "  monitoring:always-on startup-task [--task-name TeddyAlwaysOnMonitoring] [--emitter-activate-at-eof] [--write]",
  "      (prints the Task Scheduler XML and commands; --write saves the XML outside the repository; it NEVER registers a task)",
  `  monitoring:always-on drill start --fault <${ALWAYS_ON_DRILL_FAULT_NAMES.join("|")}>`,
  `      --duration-seconds <${ALWAYS_ON_DRILL_MIN_SECONDS}-${ALWAYS_ON_DRILL_MAX_SECONDS}> --generation <running generation> --run-id <its scanner run id>`,
  "      (operator network drill: public market-data transport faults inside the owned scanner and the supervisor's probes only; restored automatically at expiry)",
  "  monitoring:always-on drill restore   (ends any drill now; also removes a drill file a stopped supervisor left behind)",
  "  monitoring:always-on drill status",
].join("\n");

export interface AlwaysOnRunRequest {
  readonly command: "run";
  readonly profileName: string;
  readonly engineFingerprint: string;
  readonly roles: readonly AlwaysOnRole[];
  readonly backendUrl: string;
  readonly pollMs: number;
  readonly degradedGraceMs: number;
  readonly maxRecoveryAttempts: number;
  readonly emitterQueueCapacity: number;
  readonly emitterActivateAtEof: boolean;
  /** Validated scanner tuning flags only (never an engine, universe or lineage flag). */
  readonly scannerExtraArgs: readonly string[];
}

export type AlwaysOnCliRequest =
  | AlwaysOnRunRequest
  | { readonly command: "status"; readonly json: boolean }
  | { readonly command: "stop"; readonly waitSeconds: number }
  | { readonly command: "clear-latch"; readonly role: AlwaysOnRole | null }
  | { readonly command: "startup-task"; readonly taskName: string; readonly emitterActivateAtEof: boolean; readonly write: boolean }
  | { readonly command: "drill-start"; readonly fault: AlwaysOnDrillFault; readonly durationSeconds: number; readonly generation: number; readonly runId: string }
  | { readonly command: "drill-restore" }
  | { readonly command: "drill-status" };

const usage = (message: string): never => {
  throw new AlwaysOnCliUsageError(message);
};

function bounded(value: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) usage(`${name} must be an integer ${min}..${max}`);
  return Number(value);
}

function parseFlags(argv: readonly string[], valueNames: readonly string[], flagNames: readonly string[]): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (flagNames.includes(token)) {
      if (flags.has(token)) usage(`${token} given twice`);
      flags.add(token);
      continue;
    }
    if (!valueNames.includes(token)) usage(`unexpected argument: ${token}`);
    if (values.has(token)) usage(`${token} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`${token} needs a value`);
    values.set(token, value);
    i += 1;
  }
  return { values, flags };
}

export function parseAlwaysOnCliArgs(argv: readonly string[]): AlwaysOnCliRequest {
  const [command, ...rest] = argv;
  if (command === "status") {
    const { flags } = parseFlags(rest, [], ["--json"]);
    return { command: "status", json: flags.has("--json") };
  }
  if (command === "stop") {
    const { values } = parseFlags(rest, ["--wait-seconds"], []);
    return { command: "stop", waitSeconds: bounded(values.get("--wait-seconds"), "--wait-seconds", 0, 3_600, 600) };
  }
  if (command === "clear-latch") {
    const { values } = parseFlags(rest, ["--role"], []);
    const role = values.get("--role");
    if (role !== undefined && !(ALWAYS_ON_ROLES as readonly string[]).includes(role)) usage(`--role must be one of ${ALWAYS_ON_ROLES.join(", ")}`);
    return { command: "clear-latch", role: (role ?? null) as AlwaysOnRole | null };
  }
  if (command === "startup-task") {
    const { values, flags } = parseFlags(rest, ["--task-name"], ["--emitter-activate-at-eof", "--write"]);
    const taskName = values.get("--task-name") ?? "TeddyAlwaysOnMonitoring";
    if (!/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(taskName)) usage("--task-name must be letters, digits, - or _ (3-64 characters, starting with a letter)");
    return { command: "startup-task", taskName, emitterActivateAtEof: flags.has("--emitter-activate-at-eof"), write: flags.has("--write") };
  }
  if (command === "drill") {
    const [sub, ...drillArgs] = rest;
    if (sub === "restore" || sub === "status") {
      parseFlags(drillArgs, [], []);
      return { command: sub === "restore" ? "drill-restore" : "drill-status" };
    }
    if (sub !== "start") return usage(sub === undefined ? "drill needs start, restore or status" : `unknown drill command: ${sub}`);
    const { values } = parseFlags(drillArgs, ["--fault", "--duration-seconds", "--generation", "--run-id"], []);
    const required = (name: string): string => values.get(name) ?? usage(`drill start needs ${name}`);
    const fault = required("--fault");
    if (!isDrillFault(fault)) usage(`--fault must be one of ${ALWAYS_ON_DRILL_FAULT_NAMES.join(", ")}`);
    const durationSeconds = bounded(required("--duration-seconds"), "--duration-seconds", ALWAYS_ON_DRILL_MIN_SECONDS, ALWAYS_ON_DRILL_MAX_SECONDS, 0);
    const generation = bounded(required("--generation"), "--generation", 1, 1_000_000_000, 0);
    const runId = required("--run-id");
    if (!/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(runId)) usage("--run-id must be the scanner run id the status shows (yyyymmddThhmmssZ-xxxxxxxx)");
    return { command: "drill-start", fault: fault as AlwaysOnDrillFault, durationSeconds, generation, runId };
  }
  if (command !== "run") return usage(command === undefined ? "a command is required" : `unknown command: ${command}`);

  const { values, flags } = parseFlags(
    rest,
    ["--profile", "--roles", "--backend-url", "--poll-seconds", "--degraded-grace-seconds", "--max-recovery-attempts", "--emitter-queue-capacity", "--scanner-max-total-requests", "--scanner-status-every-s"],
    ["--emitter-activate-at-eof"]
  );
  const profileName = values.get("--profile") ?? ALWAYS_ON_DEFAULT_PROFILE;
  let engineFingerprint: string;
  try {
    engineFingerprint = engineFingerprintOf(resolveScannerProfile(profileName));
  } catch (error) {
    if (error instanceof ScannerProfileError) return usage(error.message);
    throw error;
  }
  const rolesRaw = values.get("--roles");
  let roles: AlwaysOnRole[] = [...ALWAYS_ON_ROLES];
  if (rolesRaw !== undefined) {
    const listed = rolesRaw.split(",").map((r) => r.trim());
    for (const role of listed) if (!(ALWAYS_ON_ROLES as readonly string[]).includes(role)) usage(`--roles: ${role} is not one of ${ALWAYS_ON_ROLES.join(", ")}`);
    if (new Set(listed).size !== listed.length) usage("--roles lists a role twice");
    roles = ALWAYS_ON_ROLES.filter((role) => listed.includes(role));
    if (roles.includes("emitter") && !roles.includes("scanner")) usage("--roles: the emitter is pinned to the scanner run this supervisor owns, so it needs the scanner role too");
    if (roles.length === 0) usage("--roles names no role");
  }
  const scannerExtraArgs: string[] = [];
  if (values.has("--scanner-max-total-requests")) scannerExtraArgs.push("--max-total-requests", values.get("--scanner-max-total-requests") as string);
  if (values.has("--scanner-status-every-s")) scannerExtraArgs.push("--status-every-s", values.get("--scanner-status-every-s") as string);
  try {
    // The scanner's own parser is the judge of its flags: a value it would refuse is refused here, before anything starts.
    parseSupervisorCliArgs(["--profile", profileName, ...scannerExtraArgs]);
  } catch (error) {
    if (error instanceof SupervisorCliUsageError) return usage(`scanner tuning: ${error.message}`);
    throw error;
  }
  const pollMs = bounded(values.get("--poll-seconds"), "--poll-seconds", 5, 300, ALWAYS_ON_DEFAULTS.pollMs / 1000) * 1000;
  return {
    command: "run",
    profileName,
    engineFingerprint,
    roles,
    backendUrl: values.get("--backend-url") ?? "http://127.0.0.1:4000",
    pollMs,
    degradedGraceMs: bounded(values.get("--degraded-grace-seconds"), "--degraded-grace-seconds", 30, 1_800, ALWAYS_ON_DEFAULTS.degradedGraceMs / 1000) * 1000,
    maxRecoveryAttempts: bounded(values.get("--max-recovery-attempts"), "--max-recovery-attempts", 1, 20, ALWAYS_ON_DEFAULTS.maxRecoveryAttempts),
    emitterQueueCapacity: bounded(values.get("--emitter-queue-capacity"), "--emitter-queue-capacity", 10, 100_000, ALWAYS_ON_DEFAULTS.emitterQueueCapacity),
    emitterActivateAtEof: flags.has("--emitter-activate-at-eof"),
    scannerExtraArgs,
  };
}

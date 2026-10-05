import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ACCOUNT_IDENTITY_KEYS } from "../../config/account-env";

/**
 * Phase 11I -- the launcher's model of the DUAL-ACCOUNT runtime.
 *
 * ## Why this module exists rather than an edit to `runtime-launcher.ts`
 *
 * That module describes a single stack: one backend, one analysis worker, one
 * account worker, one frontend, and one `.env` whose three gate lines describe
 * the whole deployment. Every one of those assumptions stopped being true:
 *
 *   11E  split the account execution worker out of the generic analysis worker
 *   11F  split the account control plane out of the generic backend
 *   11F.1 made each process take its identity from its OWN env file, selected
 *         by DOTENV_CONFIG_PATH, so there is no longer one file to read or write
 *   11H  proved six roles across two accounts running at once
 *
 * The old model does not merely under-report that topology, it mis-describes
 * it: `worker` names a role that now exists once PER ACCOUNT, and the `.env`
 * the old tool reads and rewrites is read by NONE of the six processes.
 *
 * So the dual-account contract lives here, whole, and the legacy module keeps
 * the primitives that survived the splits -- ownership, the state file, gate
 * parsing, the durable-safety rule -- which this module reuses rather than
 * restates.
 *
 * ## What this module will not do
 *
 * It does not parse credentials, and it holds no account identifier. Roles are
 * named by ALIAS (`account-a`, `account-b`); the identifier lives only in the
 * env file and in the attestation key the runtime itself writes. Nothing here
 * can print a secret because nothing here reads one.
 */

/** Which environment file a role takes its identity from. */
export type RuntimeAccount = "GENERIC" | "ACCOUNT_A" | "ACCOUNT_B";

/** The env-file alias. Deliberately not the account identifier. */
export type EnvAlias = "generic" | "account-a" | "account-b";

export type DualRole =
  | "generic-backend"
  | "generic-analysis"
  | "account-a-control"
  | "account-a-worker"
  | "account-b-control"
  | "account-b-worker"
  | "native-planner"
  | "generic-backend-nonwatch";

/**
 * Start order, and the reverse of it is stop order.
 *
 * Generic first because the analysis worker produces the plans an account
 * adopts; control before its worker because control is inert -- it binds no
 * orchestration -- so it proves the account's env file, port and attestation
 * identity before the process with execution authority joins.
 */
export const DUAL_ROLES: readonly DualRole[] = [
  "generic-backend",
  "generic-analysis",
  "account-a-control",
  "account-a-worker",
  "account-b-control",
  "account-b-worker",
] as const;

/**
 * OPTIONAL generic roles: known to the launcher (recognised in the process
 * census, startable, supervisable and stoppable by their own menu actions) but
 * deliberately NOT part of the six-role SAFE topology above.
 *
 * The Native planner is planning only and holds no account. Keeping it out of
 * DUAL_ROLES means Start SAFE never starts it, topology verification never
 * requires it, and a Native planner problem can never block, fail or roll back
 * the TradingView runtime. Its ownership record lives in its own state file for
 * the same reason (see run-runtime-launcher.ts).
 */
export const OPTIONAL_GENERIC_ROLES: readonly DualRole[] = ["native-planner"] as const;

/**
 * The generic backend's OFFICIAL NON-WATCH mode: the built `node
 * dist/src/server.js` (the package `start` script), started and stopped only by
 * its own explicit launcher actions (generic-backend-nonwatch-launcher.ts).
 *
 * Not one of the six SAFE roles (Start SAFE keeps starting the watch backend,
 * `generic-backend`) and not an optional SUPERVISED role: it is never restarted
 * automatically. Its contract exists so the census can tell a non-watch
 * runtime from a watch runtime by entrypoint, and so it gets the generic env
 * file and its own durable log.
 */
export const GENERIC_BACKEND_NONWATCH_ROLE = "generic-backend-nonwatch" as const satisfies DualRole;

export interface RoleContract {
  readonly role: DualRole;
  readonly label: string;
  readonly account: RuntimeAccount;
  readonly envAlias: EnvAlias;
  /** pnpm filter and script. Repo-controlled: no operator input reaches these. */
  readonly filter: string;
  readonly script: string;
  /** The entrypoint this role runs, used to RECOGNISE a process, not to start it. */
  readonly entrypoint: string;
  /** The port it listens on, or null for a role that listens on nothing. */
  readonly port: number | null;
  /** Whether that port must be bound to loopback only. */
  readonly loopbackOnly: boolean;
  /** Whether this role publishes a runtime attestation, and as which role. */
  readonly attests: "BACKEND" | "WORKER" | null;
}

const BACKEND_FILTER = "@trading-alert-dashboard/backend";

export const ROLE_CONTRACTS: Readonly<Record<DualRole, RoleContract>> = Object.freeze({
  "generic-backend": {
    role: "generic-backend",
    label: "Generic Backend",
    account: "GENERIC",
    envAlias: "generic",
    filter: BACKEND_FILTER,
    script: "dev",
    entrypoint: "src/server.ts",
    port: 4000,
    // Bound to 0.0.0.0 by `server.ts`. Stated, not asserted: this is the
    // ingress the dashboard and the webhook use.
    loopbackOnly: false,
    // Since 11F the BACKEND attestation belongs to the account control plane,
    // not to the generic server.
    attests: null,
  },
  "generic-analysis": {
    role: "generic-analysis",
    label: "Generic Analysis Worker",
    account: "GENERIC",
    envAlias: "generic",
    filter: BACKEND_FILTER,
    script: "worker",
    entrypoint: "src/modules/jobs/vision-analysis.worker.ts",
    port: null,
    loopbackOnly: false,
    attests: null,
  },
  "account-a-control": {
    role: "account-a-control",
    label: "Account A Control",
    account: "ACCOUNT_A",
    envAlias: "account-a",
    filter: BACKEND_FILTER,
    script: "account-control",
    entrypoint: "src/account-control.server.ts",
    port: 4001,
    loopbackOnly: true,
    attests: "BACKEND",
  },
  "account-a-worker": {
    role: "account-a-worker",
    label: "Account A Execution Worker",
    account: "ACCOUNT_A",
    envAlias: "account-a",
    filter: BACKEND_FILTER,
    script: "execution-worker",
    entrypoint: "src/modules/jobs/execution.worker.ts",
    port: null,
    loopbackOnly: false,
    attests: "WORKER",
  },
  "account-b-control": {
    role: "account-b-control",
    label: "Account B Control",
    account: "ACCOUNT_B",
    envAlias: "account-b",
    filter: BACKEND_FILTER,
    script: "account-control",
    entrypoint: "src/account-control.server.ts",
    port: 4002,
    loopbackOnly: true,
    attests: "BACKEND",
  },
  "account-b-worker": {
    role: "account-b-worker",
    label: "Account B Execution Worker",
    account: "ACCOUNT_B",
    envAlias: "account-b",
    filter: BACKEND_FILTER,
    script: "execution-worker",
    entrypoint: "src/modules/jobs/execution.worker.ts",
    port: null,
    loopbackOnly: false,
    attests: "WORKER",
  },
  // NON-WATCH MODE of the generic backend (see GENERIC_BACKEND_NONWATCH_ROLE):
  // never started by Start SAFE, never supervised. Recognised by its BUILT
  // entrypoint, which no watch runtime (src/server.ts) carries.
  "generic-backend-nonwatch": {
    role: "generic-backend-nonwatch",
    label: "Generic Backend (non-watch)",
    account: "GENERIC",
    envAlias: "generic",
    filter: BACKEND_FILTER,
    // What the package `start` script runs; spawned directly as `node <repo>/apps/backend/dist/src/server.js`.
    script: "start",
    entrypoint: "dist/src/server.js",
    port: 4000,
    loopbackOnly: false,
    attests: null,
  },
  // OPTIONAL (see OPTIONAL_GENERIC_ROLES): never started by Start SAFE.
  "native-planner": {
    role: "native-planner",
    label: "Native Planner Worker",
    account: "GENERIC",
    envAlias: "generic",
    filter: BACKEND_FILTER,
    // Plain `tsx`, not `tsx watch`: a watcher respawns on a file change, not on
    // a crash, and would hide an exit from supervision.
    script: "native-alerts:plan-worker",
    entrypoint: "src/modules/native-planning/native-plan.worker.ts",
    port: null,
    loopbackOnly: false,
    // Generic and planning only: it publishes no account attestation. Its
    // liveness is the process census (launcher) and its own Redis heartbeat
    // (read-only backend status).
    attests: null,
  },
});

/** The accounts that own an execution runtime. GENERIC owns none. */
export const RUNTIME_ACCOUNTS: readonly Exclude<RuntimeAccount, "GENERIC">[] = [
  "ACCOUNT_A",
  "ACCOUNT_B",
] as const;

// ---------------------------------------------------------------------------
// Environment files
// ---------------------------------------------------------------------------

/**
 * Where the per-role environment files live.
 *
 * OUTSIDE the repository, deliberately: an account file inside a checkout is
 * one `git add -A` away from being committed, and one `tsx watch` away from
 * restarting a runtime because a secret was edited.
 */
export function runtimeEnvDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.LOCALAPPDATA ?? "", "trading-alert-dashboard", "env");
}

/**
 * Where a launcher-managed role's stdout and stderr are kept.
 *
 * ## Why this exists
 *
 * Every role was spawned with `stdio: "ignore"`. When Account A's execution
 * runtime died, everything it said on the way out -- the stack, the reason,
 * the last log line -- went to a null device, and the cause was unrecoverable
 * afterwards by construction.
 *
 * The file is named after the ROLE, which is a fixed identifier from this
 * module. No account identifier, token, port or environment value appears in
 * the path: a log filename is something an operator reads aloud and pastes
 * into a chat window.
 *
 * Lives beside the launcher's own state and env, outside the repository, so a
 * checkout never carries a production log and `git clean` never deletes one.
 */
export function roleLogDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.LOCALAPPDATA ?? env.TEMP ?? ".", "trading-alert-dashboard", "logs");
}

/** One file per ROLE, so two accounts can never share or rotate each other's. */
export function roleLogPath(role: DualRole, env: NodeJS.ProcessEnv = process.env): string {
  return join(roleLogDirectory(env), `${role}.log`);
}

/** The single previous generation. Rotation renames onto exactly this name. */
export function rotatedRoleLogPath(role: DualRole, env: NodeJS.ProcessEnv = process.env): string {
  return `${roleLogPath(role, env)}.1`;
}

/**
 * How large one role's log may grow before a start rotates it.
 *
 * Checked when a role is STARTED, not while it runs, which is the whole of the
 * bound: a single long-lived process can exceed this and keep going. That
 * residual is accepted deliberately -- a size check on a hot path, or a second
 * process watching the file, would both be worse than a file that can grow
 * between restarts.
 */
export const ROLE_LOG_ROTATE_BYTES = 32 * 1024 * 1024;

export function envFilePathFor(role: DualRole, env: NodeJS.ProcessEnv = process.env): string {
  return join(runtimeEnvDir(env), `${ROLE_CONTRACTS[role].envAlias}.env`);
}

/**
 * The keys that decide WHICH ACCOUNT a process is.
 *
 * Imported from the runtime-env bootstrap contract rather than restated: one
 * list, and a launcher that strips a different set from the one the bootstrap
 * checks would be a launcher that reintroduces the 11F.1 defect from outside.
 */
export const ACCOUNT_SENSITIVE_KEYS = ACCOUNT_IDENTITY_KEYS;

export const ENV_ALIASES: readonly EnvAlias[] = ["generic", "account-a", "account-b"] as const;

export type EnvFileReasonCode =
  | "ENV_FILE_MISSING"
  | "ENV_FILE_UNREADABLE"
  | "ENV_FILE_MALFORMED"
  | "ENV_FILE_DUPLICATE_KEY";

export type EnvFileParse =
  | { ok: true; values: ReadonlyMap<string, string>; keys: string[] }
  | {
      ok: false;
      reasonCode: EnvFileReasonCode;
      /** A line NUMBER or a key NAME. Never a value, never a fragment of one. */
      detail: string;
    };

/** `KEY=` with a conventional shell-safe name. Anything else is malformed. */
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * The ONE parser. Validation, declared key names and value lookup all go
 * through it, so there is no way for them to disagree about what a file says.
 *
 * ## Why strict, and why it refuses rather than skipping
 *
 * Sanitation works by deleting every name the selected file declares from the
 * child environment. A parser that silently skips a line it cannot read
 * therefore UNDER-REPORTS the key set, and an under-reported key set is a key
 * the stale shell value survives into -- which is the precise failure this
 * whole mechanism exists to prevent. A file we cannot read completely is a
 * file we cannot sanitise against, so it is refused before anything spawns.
 *
 * A duplicate key is refused for the same reason in the other direction: two
 * lines naming one variable make the effective value a question of parser
 * order, and a launcher should not be the thing that decides it.
 *
 * ## What never escapes
 *
 * Values are held in the returned map and nowhere else. A failure carries a
 * reason code plus either a LINE NUMBER or a KEY NAME -- never a value, never a
 * prefix of one, never a length.
 */
export function parseEnvFileStrict(
  path: string,
  readFile: (path: string) => string = (target) => readFileSync(target, "utf8")
): EnvFileParse {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT"
      ? { ok: false, reasonCode: "ENV_FILE_MISSING", detail: "" }
      : { ok: false, reasonCode: "ENV_FILE_UNREADABLE", detail: "" };
  }

  // A byte-order mark would otherwise become part of the first key name.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const values = new Map<string, string>();

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = ENV_LINE.exec(line);
    if (match === null) {
      // Covers an empty key (`=value`), a name with a space or a dot, an
      // `export` prefix, and any line that is not an assignment at all.
      return { ok: false, reasonCode: "ENV_FILE_MALFORMED", detail: `line ${index + 1}` };
    }

    const key = match[1];
    if (values.has(key)) {
      return { ok: false, reasonCode: "ENV_FILE_DUPLICATE_KEY", detail: key };
    }

    let value = match[2].trim();
    const quote = value.charAt(0);
    if (quote === '"' || quote === "'") {
      // An unterminated quote is the multi-line value case, which a
      // line-oriented parser cannot represent honestly.
      if (value.length < 2 || value.charAt(value.length - 1) !== quote) {
        return { ok: false, reasonCode: "ENV_FILE_MALFORMED", detail: `line ${index + 1}` };
      }
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  return { ok: true, values, keys: [...values.keys()] };
}

export interface EnvFileVerdict {
  readonly ok: boolean;
  /** Per-file reason codes. Aliases and codes only. */
  readonly failures: readonly { alias: EnvAlias; reasonCode: EnvFileReasonCode; detail: string }[];
  /** The parsed files, keyed by alias, when every one of them parsed. */
  readonly parsed: ReadonlyMap<EnvAlias, EnvFileParse & { ok: true }>;
}

/**
 * Validates ALL THREE files before a caller is allowed to act on any of them.
 *
 * Every file is parsed even after the first failure, so an operator fixing a
 * broken deployment sees the whole list rather than discovering it one start
 * attempt at a time.
 */
export function validateEnvFiles(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (target) => readFileSync(target, "utf8")
): EnvFileVerdict {
  const failures: { alias: EnvAlias; reasonCode: EnvFileReasonCode; detail: string }[] = [];
  const parsed = new Map<EnvAlias, EnvFileParse & { ok: true }>();
  for (const alias of ENV_ALIASES) {
    const result = parseEnvFileStrict(join(runtimeEnvDir(env), `${alias}.env`), readFile);
    if (result.ok) parsed.set(alias, result);
    else failures.push({ alias, reasonCode: result.reasonCode, detail: result.detail });
  }
  return { ok: failures.length === 0, failures, parsed };
}

/** Human-readable, and still free of values. */
export function describeEnvFileFailure(failure: {
  alias: EnvAlias;
  reasonCode: EnvFileReasonCode;
  detail: string;
}): string {
  const where = failure.detail === "" ? "" : ` (${failure.detail})`;
  return `${failure.alias}.env: ${failure.reasonCode}${where}`;
}

/**
 * Whether the two account files name DIFFERENT accounts.
 *
 * The attestation key is
 * `runtime:attestation:<accountIdentifier>:<environment>:<ROLE>:<instanceId>`,
 * so two accounts configured with the same identifier and environment would
 * write into the SAME key space: each would see the other's heartbeat, both
 * would read BACKEND fresh 2, and the interlock would report a duplicate
 * runtime for an account that has exactly one. Worse, either could be counted
 * as the other's live runtime.
 *
 * The identifiers are COMPARED and never returned, so a caller cannot print
 * one by way of this check.
 */
export function accountIdentitiesAreDistinct(
  readIdentity: (role: DualRole) => { accountIdentifier: string | null; environment: string | null }
): DualVerdict {
  const a = readIdentity("account-a-control");
  const b = readIdentity("account-b-control");
  const reasons: string[] = [];
  if (a.accountIdentifier === null || a.environment === null) {
    reasons.push("account-a identity could not be read from its environment file.");
  }
  if (b.accountIdentifier === null || b.environment === null) {
    reasons.push("account-b identity could not be read from its environment file.");
  }
  if (
    reasons.length === 0 &&
    a.accountIdentifier === b.accountIdentifier &&
    a.environment === b.environment
  ) {
    reasons.push(
      "account-a and account-b name the SAME account and environment. Their runtime " +
        "attestation keys would collide, so neither account's liveness could be " +
        "told from the other's."
    );
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export interface DualSpawnPlan {
  readonly command: string;
  readonly args: string[];
  readonly options: {
    readonly cwd: string;
    readonly detached: true;
    readonly stdio: "ignore";
    readonly windowsHide: false;
    readonly env: NodeJS.ProcessEnv;
  };
}

/**
 * How one role is started, with its account pinned and no other account's
 * values able to follow it in.
 *
 * The environment comes from `sanitizedChildEnv`, which makes the selected
 * file authoritative over every name it declares and clears the account
 * identity keys unconditionally on top.
 *
 * The bootstrap does the rest and is the thing that actually enforces it: a
 * generic role that somehow still holds a credential refuses to start, and an
 * account role whose inherited values contradict its file refuses too. This
 * function removes the conflict; it does not rely on being the only guard.
 *
 * The cmd invocation mirrors the proven single-stack plan -- `/d` to skip
 * AutoRun, `/s` for deterministic quoting, `/c` so the process lives for the
 * role's lifetime, and `-C <repoRoot>` so the recorded root PID carries this
 * repository's path and can later be proved ours.
 */
/**
 * The KEY NAMES a role's environment file declares.
 *
 * Names only: the file is parsed and the values are dropped on the next line,
 * so this cannot hand a secret to anything. Deciding whether the file owns a
 * variable needs the name and nothing else.
 *
 * An unreadable file yields no names, which is the fail-closed direction --
 * the account identity keys below are cleared regardless of what it says.
 */
export function declaredEnvKeyNames(
  role: DualRole,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const parsed = parseEnvFileStrict(envFilePathFor(role, env));
  return parsed.ok ? parsed.keys : [];
}

export type EnvKeyNameReader = (role: DualRole, env: NodeJS.ProcessEnv) => string[];

/**
 * The environment a role is started with: THE SELECTED FILE WINS.
 *
 * ## Why the file's whole key set is cleared, not just the identity keys
 *
 * Runtime env application is NON-OVERRIDING at every layer. dotenv skips a
 * key already present in `process.env`, and so does the generated Prisma
 * client's loader. So for ANY variable the selected file declares, a value
 * left in the launching shell silently outranks it -- and that is not limited
 * to credentials. A stale `EXECUTION_GLOBAL_KILL_SWITCH=false` would beat a
 * file that says `true`, and the process would come up with the kill switch
 * open while every file on disk said it was shut. The same goes for
 * OPERATOR_API_TOKEN (one account's token reaching the other's process),
 * ACCOUNT_CONTROL_PORT (Control B trying to bind Control A's port),
 * DATABASE_URL, REDIS_URL and every execution limit.
 *
 * Clearing exactly the names the file declares leaves it free to supply them
 * and leaves everything else -- PATH, ComSpec, SystemRoot -- inherited, because
 * a child that inherits nothing cannot run.
 *
 * The account identity keys are then cleared UNCONDITIONALLY. A malformed or
 * truncated file that omits one must not become a way to smuggle an inherited
 * account in; the bootstrap's integrity contract is fail-closed and this keeps
 * it that way.
 *
 * DOTENV_CONFIG_PATH is pinned LAST, so a file that somehow declares that name
 * cannot clear its own selector.
 *
 * The parent environment is never modified: a fresh object is built here and
 * handed to the child.
 */
export function sanitizedChildEnv(
  role: DualRole,
  env: NodeJS.ProcessEnv = process.env,
  readKeyNames: EnvKeyNameReader = declaredEnvKeyNames
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of readKeyNames(role, env)) delete childEnv[key];
  for (const key of ACCOUNT_SENSITIVE_KEYS) delete childEnv[key];
  childEnv.DOTENV_CONFIG_PATH = envFilePathFor(role, env);
  return childEnv;
}

export function dualSpawnPlan(
  role: DualRole,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  readKeyNames: EnvKeyNameReader = declaredEnvKeyNames
): DualSpawnPlan {
  const contract = ROLE_CONTRACTS[role];
  const childEnv = sanitizedChildEnv(role, env, readKeyNames);

  return {
    command: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", "pnpm", "-C", repoRoot, "--filter", contract.filter, contract.script],
    options: {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: childEnv,
    },
  };
}

// ---------------------------------------------------------------------------
// The SAFE deployment posture
// ---------------------------------------------------------------------------

/**
 * The SAFE gate contract, taken from source rather than invented.
 *
 * `expectedGateSnapshotFor("SAFE")` pins seven values, and the runtime
 * attestation compares all seven against what each process actually loaded
 * (`currentProcessGateSnapshot`). These are the env keys behind them.
 *
 * `required: true` means the file must DECLARE the value. Those three are the
 * gates an operator toggles, and a SAFE start should not depend on nobody
 * having written the opposite. The other four may be absent, because their
 * schema defaults ARE the SAFE values -- and since the child no longer
 * inherits any key the file declares, an absent key now genuinely resolves to
 * its default instead of to whatever the launching shell was carrying.
 *
 * Deliberately NOT included: BINANCE_READ_ONLY_ENABLED and
 * EXECUTION_FILL_RUNTIME_ENABLED. Neither appears in the gate snapshot the
 * attestation verifies, so requiring them here would be new policy invented
 * by a launcher rather than the established SAFE contract.
 */
export const SAFE_GATE_CONTRACT: readonly {
  key: string;
  safeValue: string;
  required: boolean;
}[] = [
  { key: "EXECUTION_GLOBAL_KILL_SWITCH", safeValue: "true", required: true },
  { key: "EXECUTION_LIVE_ENTRY_ENABLED", safeValue: "false", required: true },
  { key: "EXECUTION_PROTECTION_READY", safeValue: "false", required: true },
  { key: "BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED", safeValue: "false", required: false },
  { key: "BINANCE_TEST_ORDER_ENABLED", safeValue: "false", required: false },
  { key: "EXECUTION_AUTO_ADD_MARGIN_ENABLED", safeValue: "false", required: false },
  { key: "EXECUTION_EMERGENCY_CLOSE_MODE", safeValue: "DISABLED", required: false },
] as const;

/**
 * Whether ONE account file declares the SAFE deployment posture.
 *
 * "Start SAFE" must mean SAFE, not "start whatever the files currently say".
 * The values compared here are booleans and one enum -- safe to read, safe to
 * name in a refusal, and never a credential.
 */
export function evaluateSafeGatePosture(
  alias: EnvAlias,
  declared: Readonly<Record<string, string | undefined>>
): DualVerdict {
  const reasons: string[] = [];
  for (const gate of SAFE_GATE_CONTRACT) {
    const value = declared[gate.key];
    if (value === undefined) {
      if (gate.required) {
        reasons.push(
          `${alias}.env does not declare ${gate.key}. A SAFE start requires it to say ` +
            `${gate.safeValue}.`
        );
      }
      continue;
    }
    if (value !== gate.safeValue) {
      reasons.push(`${alias}.env declares ${gate.key}=${value}; SAFE requires ${gate.safeValue}.`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * What an account's own control plane says about its execution profile.
 *
 * Read from that account's loopback operator status, which returns the
 * ENVIRONMENT and two booleans and deliberately never the account identifier
 * (`TradingControlProfileDto`). Null means the answer could not be obtained,
 * and null refuses.
 */
export interface AccountProfileProof {
  readonly account: Exclude<RuntimeAccount, "GENERIC">;
  readonly healthOk: boolean;
  readonly surface: string | null;
  readonly isEnabled: boolean | null;
  readonly killSwitchActive: boolean | null;
}

/**
 * Whether an account's execution worker may be started.
 *
 * The control plane comes up first precisely so this can be asked: it binds
 * no orchestration and adopts no plan, so asking it costs nothing, while its
 * worker is the process that would begin adopting within seconds. Proving the
 * profile is disabled and kill-switched BEFORE that worker exists is the
 * difference between a dry runtime and a live one.
 *
 * Every unknown refuses. An unreachable control plane is not evidence of a
 * disabled profile.
 */
export function evaluateAccountProfileProof(proof: AccountProfileProof): DualVerdict {
  const reasons: string[] = [];
  if (!proof.healthOk) {
    reasons.push(`${proof.account}: its control plane did not answer /health.`);
  }
  if (proof.surface !== "ACCOUNT_CONTROL") {
    reasons.push(
      `${proof.account}: /health did not identify itself as ACCOUNT_CONTROL` +
        `${proof.surface === null ? "" : ` (got ${proof.surface})`}.`
    );
  }
  if (proof.isEnabled === null) {
    reasons.push(`${proof.account}: profile isEnabled could not be proved; it is not assumed false.`);
  } else if (proof.isEnabled) {
    reasons.push(`${proof.account}: execution profile is ENABLED. A SAFE start will not add its worker.`);
  }
  if (proof.killSwitchActive === null) {
    reasons.push(
      `${proof.account}: profile killSwitchActive could not be proved; it is not assumed true.`
    );
  } else if (!proof.killSwitchActive) {
    reasons.push(`${proof.account}: profile kill switch is NOT active. A SAFE start will not add its worker.`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** One observed OS process, as the CLI reports it. */
export interface ObservedProcess {
  readonly pid: number;
  readonly commandLine: string;
  readonly startedAtMs: number;
}

/** One observed listening socket. */
export interface ObservedListener {
  readonly port: number;
  readonly address: string;
  readonly pid: number;
}

/**
 * The CIM query that asks about SPECIFIC PIDs, whatever they are running.
 *
 * ## Why this is not the census query
 *
 * `observeProcesses` enumerates `Name='node.exe'`, which is right for asking
 * WHICH RUNTIME ROLES exist: the roles are node processes, and a machine-wide
 * scan of everything would be wasteful and noisy.
 *
 * Ownership asks a different question -- IS THIS PARTICULAR PID STILL MINE --
 * and the PID it asks about is the `cmd.exe` that `spawn` returned. Reusing
 * the node-only census to answer it meant every ownership probe came back
 * empty, `verifyOwnership` saw no process and returned GONE, and six
 * launcher-started roles reported themselves as external. So this query names
 * the PIDs and constrains nothing else.
 *
 * Returns null for an empty set, so a caller never issues a query with an
 * empty filter -- which in CIM would match EVERY process on the machine.
 *
 * Only integral, non-negative PIDs reach the filter. They are formatted, never
 * interpolated from unvalidated text, so nothing an operator types can reach
 * the query.
 */
export function buildProcessProbeQuery(pids: readonly number[]): string | null {
  const wanted = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid >= 0);
  if (wanted.length === 0) return null;
  const filter = wanted.map((pid) => `ProcessId=${pid}`).join(" OR ");
  return (
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    "ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, " +
    "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), ($_.CommandLine -replace '\\|',' ') }"
  );
}

/**
 * Parses the probe rows. Shape only -- nothing is logged from here, and the
 * command line it carries exists solely so `verifyOwnership` can confirm the
 * process belongs to this repository.
 */
export function parseProcessProbeRows(stdout: string): ObservedProcess[] {
  const rows: ObservedProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, startedAtMs, commandLine] = line.trim().split("|");
    if (!pid || !startedAtMs) continue;
    const parsedPid = Number(pid);
    const parsedStartedAt = Number(startedAtMs);
    if (!Number.isFinite(parsedPid) || !Number.isFinite(parsedStartedAt)) continue;
    rows.push({ pid: parsedPid, startedAtMs: parsedStartedAt, commandLine: commandLine ?? "" });
  }
  return rows;
}

export function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

/**
 * Which ENTRYPOINT a command line runs, or null.
 *
 * Deliberately not "which role": the two control planes run the SAME
 * entrypoint and differ only by an environment variable, which a command line
 * does not carry. Pretending otherwise would attribute a process to an account
 * on no evidence, and attribution is what a stop decision is built on.
 */
export function classifyEntrypoint(commandLine: string): string | null {
  const normalized = commandLine.replace(/\\/g, "/");
  // The supervisors that wrap a role are not the role. `pnpm` and the tsx
  // watcher both carry the entrypoint on their command line, and counting them
  // would report three of everything.
  if (/pnpm\.cjs|pnpm\/bin/.test(normalized)) return null;
  if (/tsx\/dist\/cli\.mjs/.test(normalized)) return null;
  for (const entrypoint of new Set(Object.values(ROLE_CONTRACTS).map((c) => c.entrypoint))) {
    if (normalized.includes(entrypoint)) return entrypoint;
  }
  return null;
}

export interface EntrypointCensus {
  /** entrypoint -> how many RUNTIME processes are running it. */
  readonly counts: Readonly<Record<string, number>>;
  /** port -> the listener observed on it, when there is exactly one. */
  readonly listeners: Readonly<Record<number, ObservedListener | null>>;
}

export function censusOf(
  processes: readonly ObservedProcess[],
  listeners: readonly ObservedListener[]
): EntrypointCensus {
  const counts: Record<string, number> = {};
  for (const process of processes) {
    const entrypoint = classifyEntrypoint(process.commandLine);
    if (entrypoint === null) continue;
    counts[entrypoint] = (counts[entrypoint] ?? 0) + 1;
  }
  const byPort: Record<number, ObservedListener | null> = {};
  for (const port of [4000, 4001, 4002]) {
    const found = listeners.filter((listener) => listener.port === port);
    byPort[port] = found.length === 1 ? found[0] : null;
  }
  return { counts, listeners: byPort };
}

// ---------------------------------------------------------------------------
// Status projection
// ---------------------------------------------------------------------------

export type Presence = "OWNED" | "DETECTED" | "OFF";

/** The three operator-facing gates, as some source reports them. */
export interface GateTriple {
  readonly globalKillSwitch: boolean;
  readonly liveEntryEnabled: boolean;
  readonly protectionReady: boolean;
}

export interface AccountAttestationView {
  /** Null when the reading itself failed. Never assumed healthy. */
  readonly backendFresh: number | null;
  readonly backendStale: number | null;
  readonly workerFresh: number | null;
  readonly workerStale: number | null;
  /**
   * The gates the RUNNING processes actually loaded, as they attest them.
   *
   * Separate from anything read off disk, and reported separately, because a
   * file is what the next start would use and this is what the current
   * runtime is using. Presenting one as the other is how an operator reads a
   * SAFE file and believes a running process is SAFE.
   */
  readonly effectiveGates: GateTriple | null;
}

export interface RoleStatus {
  readonly role: DualRole;
  readonly label: string;
  readonly presence: Presence;
  readonly port: number | null;
  readonly portOpen: boolean | null;
  readonly portLoopbackOk: boolean | null;
  /**
   * What this ACCOUNT's attestation says about this role.
   *
   * ABSENT and STALE are deliberately different answers. Absent means no
   * record exists at all -- the ordinary state of a drained machine, and the
   * state every first start begins from. Stale means a record exists and has
   * gone quiet, which is a fault. Collapsing them made a clean machine report
   * four stale runtimes and refuse to start.
   */
  readonly attestation:
    | "HEALTHY"
    | "STALE"
    | "DUPLICATE"
    | "ABSENT"
    | "UNKNOWN"
    | "NOT_APPLICABLE";
}

export interface TopologyStatus {
  readonly roles: readonly RoleStatus[];
  /** Raw process counts per entrypoint, which is all a command line can prove. */
  readonly entrypointCounts: Readonly<Record<string, number>>;
  readonly anyExternal: boolean;
}

/**
 * What one account's attestation says about one role.
 *
 * Both counts are read, because `freshCount` alone cannot tell the two
 * zero-fresh cases apart. The reader already distinguishes them -- it returns
 * RUNTIME_ATTESTATION_MISSING for nothing at all and RUNTIME_ATTESTATION_STALE
 * for a record that has gone quiet -- and an earlier version of this function
 * threw that distinction away by branching on `fresh` alone. On a fully
 * drained machine every account role then read STALE, which `projectTopology`
 * counted as presence, so the launcher reported four external runtimes that
 * did not exist and refused the first Start SAFE.
 */
function judgeAttestation(
  contract: RoleContract,
  view: AccountAttestationView | null
): RoleStatus["attestation"] {
  if (contract.attests === null) return "NOT_APPLICABLE";
  if (view === null) return "UNKNOWN";
  const fresh = contract.attests === "BACKEND" ? view.backendFresh : view.workerFresh;
  const stale = contract.attests === "BACKEND" ? view.backendStale : view.workerStale;
  // A count we could not obtain is never read as a count of zero.
  if (fresh === null || stale === null) return "UNKNOWN";
  if (fresh === 1) return "HEALTHY";
  if (fresh > 1) return "DUPLICATE";
  return stale > 0 ? "STALE" : "ABSENT";
}

/**
 * What the operator is shown, with ownership and detection kept apart.
 *
 * The old tool answered "is this role on?" from its own state file alone, so
 * six healthy processes it had not started read as six OFF lines. Detection
 * fixes the reporting; it must not quietly widen what the tool is allowed to
 * TERMINATE, which is why presence is three-valued and every stop path keys
 * off OWNED alone.
 *
 * An account role's liveness comes from that ACCOUNT's attestation, not from a
 * process count: two execution workers share one command line and are told
 * apart only by the identity each one publishes.
 */
export function projectTopology(input: {
  census: EntrypointCensus;
  ownedRoles: readonly DualRole[];
  attestation: Readonly<Partial<Record<RuntimeAccount, AccountAttestationView | null>>>;
}): TopologyStatus {
  const owned = new Set(input.ownedRoles);
  const roles: RoleStatus[] = [];
  let anyExternal = false;

  for (const role of DUAL_ROLES) {
    const contract = ROLE_CONTRACTS[role];
    const attestation = judgeAttestation(contract, input.attestation[contract.account] ?? null);
    const listener = contract.port === null ? null : input.census.listeners[contract.port];
    const portOpen = contract.port === null ? null : listener !== null;

    // Evidence that THIS role is present, in order of strength: we own it; its
    // account attests FRESHLY to it; or its port is held. A generic role has no
    // attestation, so a process of its entrypoint is the only evidence there is.
    //
    // Only a FRESH attestation counts. A stale record says a runtime was here
    // within the TTL and has gone quiet -- which is a fault worth blocking a
    // start over, and `evaluateDualStartPreconditions` still does -- but it is
    // not evidence that a process is there now. An absent record is not
    // evidence of anything at all. Treating either as presence is what made a
    // drained machine unstartable.
    const attested = attestation === "HEALTHY" || attestation === "DUPLICATE";
    const processPresent = (input.census.counts[contract.entrypoint] ?? 0) > 0;
    const present = owned.has(role) || attested || portOpen === true || (contract.attests === null && processPresent);

    let presence: Presence = "OFF";
    if (owned.has(role)) presence = "OWNED";
    else if (present) {
      presence = "DETECTED";
      anyExternal = true;
    }

    roles.push({
      role,
      label: contract.label,
      presence,
      port: contract.port,
      portOpen,
      portLoopbackOk:
        contract.port === null || listener === null || listener === undefined
          ? null
          : !contract.loopbackOnly || isLoopback(listener.address),
      attestation,
    });
  }

  return { roles, entrypointCounts: input.census.counts, anyExternal };
}

// ---------------------------------------------------------------------------
// Start preconditions
// ---------------------------------------------------------------------------

export type DualVerdict = { ok: true } | { ok: false; reasons: string[] };

/**
 * Whether a six-role SAFE start may begin.
 *
 * Fails closed on every condition separately and reports ALL of them, because
 * an operator who fixes one and re-runs into the next learns the state one
 * refusal at a time.
 */
export function evaluateDualStartPreconditions(input: {
  status: TopologyStatus;
  envFiles: EnvFileVerdict;
  ownedAliveCount: number;
  /** The result of `accountIdentitiesAreDistinct`, read by the caller. */
  identities: DualVerdict;
}): DualVerdict {
  const reasons: string[] = [];

  if (!input.identities.ok) reasons.push(...input.identities.reasons);

  for (const failure of input.envFiles.failures) {
    reasons.push(
      `${describeEnvFileFailure(failure)} — every role takes its identity from its own ` +
        "file, and a file that cannot be read completely cannot be sanitised against."
    );
  }
  if (input.ownedAliveCount > 0) {
    reasons.push(
      "A launcher-owned runtime is already running. Stop it before starting another."
    );
  }

  for (const role of input.status.roles) {
    if (role.presence !== "OFF") {
      reasons.push(
        `${role.label} is already running (${role.presence.toLowerCase()}). ` +
          "Starting a second one would duplicate its attestation and compete for its port."
      );
    }
    if (role.port !== null && role.portOpen) {
      reasons.push(`Port ${role.port} is already in use (${role.label}).`);
    }
    if (role.portLoopbackOk === false) {
      reasons.push(
        `Port ${role.port} (${role.label}) is bound beyond loopback. An account control ` +
          "plane must not be reachable off-host."
      );
    }
    if (role.attestation === "DUPLICATE" || role.attestation === "STALE") {
      reasons.push(
        `${role.label} attestation is ${role.attestation}. Resolve it before starting anything.`
      );
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Whether the six roles came up exactly once each, with their ports as
 * contracted and each account attesting one BACKEND and one WORKER.
 */
export function verifyDualTopology(status: TopologyStatus): DualVerdict {
  const reasons: string[] = [];
  for (const role of status.roles) {
    if (role.presence === "OFF") reasons.push(`${role.label} is not running.`);
    // Running is not the same as OURS. This verification is the last step of a
    // Start SAFE that claims to have started these six roles, so a role it
    // merely DETECTED is a failure however healthy it looks: the launcher
    // cannot later stop what it cannot prove it started, and reporting success
    // over someone else's topology is how that gap stays invisible.
    else if (role.presence !== "OWNED") {
      reasons.push(
        `${role.label} is running but this launcher does not own it ` +
          `(${role.presence.toLowerCase()}). A start it did not perform is not a start.`
      );
    }
    if (role.port !== null && role.portOpen !== true) {
      reasons.push(`${role.label} is not listening on ${role.port}.`);
    }
    if (role.portLoopbackOk === false) {
      reasons.push(`${role.label} on ${role.port} is not loopback-only.`);
    }
    if (role.attestation === "DUPLICATE") reasons.push(`${role.label} has a DUPLICATE attestation.`);
    if (role.attestation === "STALE") reasons.push(`${role.label} attestation is STALE.`);
    if (role.attestation === "UNKNOWN") {
      reasons.push(`${role.label} attestation could not be read; it is not assumed healthy.`);
    }
    // ABSENT is the correct answer BEFORE a start and a failure AFTER one: this
    // runs only once every role has been spawned, so a role still publishing
    // nothing has not come up. Without this the ABSENT verdict introduced for
    // the drained-machine case would have opened a hole here.
    if (role.attestation === "ABSENT") {
      reasons.push(`${role.label} is not attesting; it started but never reported.`);
    }
  }
  // Two execution workers share an entrypoint, so the count is the only place a
  // third one would show up.
  const workerEntrypoint = ROLE_CONTRACTS["account-a-worker"].entrypoint;
  const workers = status.entrypointCounts[workerEntrypoint] ?? 0;
  if (workers > 2) reasons.push(`${workers} execution worker processes are running; exactly 2 are expected.`);
  const controlEntrypoint = ROLE_CONTRACTS["account-a-control"].entrypoint;
  const controls = status.entrypointCounts[controlEntrypoint] ?? 0;
  if (controls > 2) reasons.push(`${controls} account control processes are running; exactly 2 are expected.`);

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Shutdown safety, across BOTH accounts
// ---------------------------------------------------------------------------

/**
 * One account's answer to "is it safe to stop me?", as its OWN control plane
 * reports it.
 *
 * Asked of the account-bound process rather than derived in the launcher: the
 * launcher holds one identity at most, and `TradingControlService` resolves
 * the profile from the process environment, so a launcher-side read can only
 * ever describe whichever account the launcher happens to be. That is precisely
 * the single-account assumption this phase removes.
 */
export interface AccountShutdownState {
  readonly account: Exclude<RuntimeAccount, "GENERIC">;
  /** False when the account has no runtime at all, so nothing needs stopping. */
  readonly present: boolean;
  /** Null for anything that could not be read. Null refuses. */
  readonly systemState: string | null;
  readonly activeExecutions: number | null;
  readonly manualIntervention: number | null;
  readonly warnings: readonly string[] | null;
}

const RECOVERY_WARNINGS = ["MANUAL_INTERVENTION_REQUIRED", "FILLED_WITHOUT_VERIFIED_PROTECTION"];

/**
 * Whether the launcher may stop the runtime, judged over EVERY live account.
 *
 * Both accounts must answer, and either can refuse for both. The generic roles
 * are stopped in the same action, and an account whose worker is gone stops
 * protecting and reconciling its open positions -- so "Account B is quiet" is
 * not a reason to take Account A's worker away, and the reverse is equally
 * true.
 *
 * An account with NO runtime present is skipped rather than refused: there is
 * nothing to stop, and demanding an answer from a control plane that is not
 * running would make the tool unusable after a partial start.
 */
export function evaluateDualShutdownSafety(
  states: readonly AccountShutdownState[]
): DualVerdict {
  const reasons: string[] = [];

  for (const account of RUNTIME_ACCOUNTS) {
    const state = states.find((candidate) => candidate.account === account);
    if (!state) {
      reasons.push(`${account} was not evaluated. An unevaluated account is never assumed safe.`);
      continue;
    }
    if (!state.present) continue;

    if (
      state.systemState === null ||
      state.activeExecutions === null ||
      state.manualIntervention === null ||
      state.warnings === null
    ) {
      reasons.push(
        `${account}: its durable Trading Control state could not be read, so it is not assumed safe.`
      );
      continue;
    }
    if (state.systemState !== "SAFE_OFF") {
      reasons.push(`${account}: system state is ${state.systemState}, not SAFE OFF.`);
    }
    if (state.activeExecutions > 0) {
      reasons.push(`${account}: ${state.activeExecutions} execution(s) still active.`);
    }
    if (state.manualIntervention > 0) {
      reasons.push(`${account}: ${state.manualIntervention} execution(s) need manual intervention.`);
    }
    const blocking = state.warnings.filter((warning) => RECOVERY_WARNINGS.includes(warning));
    if (blocking.length > 0) {
      reasons.push(`${account}: recovery work outstanding (${blocking.join(", ")}).`);
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// LIVE-READY
// ---------------------------------------------------------------------------

/**
 * Why this tool no longer offers LIVE-READY, in the words the operator sees.
 *
 * Three source facts, any one of which is disqualifying:
 *
 *   1. The old action rewrites the three gate lines in `apps/backend/.env`.
 *      Since 11F.1 every one of the six processes takes its environment from
 *      its OWN file, so that write reaches nothing that is running. A control
 *      that appears to arm a runtime and does not is worse than no control.
 *   2. The gates it writes are process-wide. One file, one set of values, both
 *      accounts -- there is no shape of this action that arms exactly one.
 *   3. Its safety check, `evaluateDurableSafety`, reads ONE profile: whichever
 *      the launcher process itself resolves. It cannot see the other account's
 *      exposure, so it cannot authorise anything on its behalf.
 *
 * Arming is therefore account-scoped work for the account control plane and its
 * audited arming workflow, not for a deployment launcher.
 */
export const LIVE_READY_UNAVAILABLE = [
  "Account-scoped LIVE-READY requires the dedicated account arming workflow.",
  "",
  "This launcher no longer arms anything, for three reasons found in source:",
  "  - the gate file it used to rewrite is read by none of the six runtimes;",
  "  - those gates are process-wide, so one action could never arm just one account;",
  "  - its safety check could only ever see one account's exposure.",
  "",
  "Nothing was changed. Use Trading Control on the account's own control plane.",
];

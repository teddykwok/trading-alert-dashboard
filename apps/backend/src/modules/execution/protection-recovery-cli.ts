import type { PrismaClient } from "@prisma/client";

import { isNaturalWindowAvailable } from "./natural-authorization";
import { mapTradingSystemState, type TradingSystemState } from "../operator/trading-control.service";
import { configuredProfileIdentity, resolveExecutionProfile } from "./execution-profile.service";
import type { ProtectionLifecycleService } from "./protection-lifecycle.service";
import type { ProtectionRecoveryService } from "./protection-recovery.service";

/**
 * The operator boundary for recovering a stranded protection intervention.
 *
 * ## Why a CLI and not a button
 *
 * This runs approximately never, and when it runs it can put a live STOP on a
 * real position. A dashboard control would put that one mis-click away; a local
 * CLI requires an operator at a terminal, on this machine, typing an execution
 * id and a confirmation token that cannot be produced by accident. It follows
 * the shape the stuck-entry recovery already set.
 *
 * ## Two commands, deliberately asymmetric
 *
 *   evaluate  read-only, safe to run any time, exits non-zero unless recovery
 *             is judged safe — so it is usable as a check as well as a report.
 *   recover   mutating, requires the exact id AND the confirmation token, and
 *             re-gathers evidence itself immediately before acting.
 *
 * There is no bulk form, no `--all`, no symbol selector and no `--force`.
 */

/**
 * The confirmation token.
 *
 * Flag-shaped to match this repository's precedent (`--confirm-arm`,
 * `--confirm-recover-proven-absent`), and worded as the CLAIM the operator is
 * making rather than as a yes. `yes`, `y`, `true` and `--force` are rejected,
 * and there is no override of any kind.
 */
export const RECOVER_CONFIRMATION = "--confirm-protection-recovery";

/** Durable postures in which recovery may run. Both durably block new entry. */
export const RECOVERY_ELIGIBLE_STATES: readonly TradingSystemState[] = ["SAFE_OFF", "SAFE_RECOVERY"];

export const CLI_EXIT = { OK: 0, REFUSED: 1, USAGE: 2 } as const;

export interface GuardVerdict {
  allowed: boolean;
  systemState: TradingSystemState | null;
  reason: string | null;
}

/**
 * Whether the durable operator posture permits a recovery write.
 *
 * Judged on the DURABLE profile state, never on the deployment gates in `.env`.
 * That distinction is the point: during a real incident the gates are still
 * LIVE_READY — the operator disarms by engaging the kill switch and revoking
 * the window, which is precisely SAFE_RECOVERY. Reading `environmentIsArmed()`
 * here would refuse in exactly the state this command exists for.
 *
 * SAFE_OFF and SAFE_RECOVERY both mean `killSwitchActive === true`: new entry
 * is durably blocked. ARMED is refused. INVALID and UNKNOWN are refused too,
 * because "we could not tell" is not permission.
 *
 * Active executions are deliberately NOT checked — the stranded execution is
 * itself active, so requiring quiet would make recovery impossible.
 */
export function judgeRecoveryPosture(input: {
  isEnabled: boolean | null | undefined;
  killSwitchActive: boolean | null | undefined;
  availableWindows: number;
}): GuardVerdict {
  const systemState = mapTradingSystemState(input.isEnabled, input.killSwitchActive);

  if (!RECOVERY_ELIGIBLE_STATES.includes(systemState)) {
    return {
      allowed: false,
      systemState,
      reason:
        systemState === "ARMED"
          ? "Trading is ARMED. Engage the kill switch before recovering protection."
          : `The durable trading state is ${systemState}; recovery requires ${RECOVERY_ELIGIBLE_STATES.join(" or ")}.`,
    };
  }

  if (input.availableWindows > 0) {
    return {
      allowed: false,
      systemState,
      // A window that is still AVAILABLE can admit a trade the moment a runtime
      // goes live, and working on protection underneath it means acting while
      // new exposure could appear beside it.
      reason: "A natural authorization window is still AVAILABLE. Revoke it before recovering.",
    };
  }

  return { allowed: true, systemState, reason: null };
}

/** Reads the durable posture for the configured profile. */
export async function readRecoveryPosture(prisma: PrismaClient): Promise<GuardVerdict> {
  const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
  if (!resolution.ok) {
    return { allowed: false, systemState: null, reason: `The execution profile could not be resolved: ${resolution.message}` };
  }
  const profile = resolution.profile;
  const now = new Date();
  const windows = await prisma.executionCanaryAuthorization.findMany({
    where: {
      executionProfileId: profile.id,
      authorizationType: "NATURAL_WINDOW",
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
  return judgeRecoveryPosture({
    isEnabled: profile.isEnabled,
    killSwitchActive: profile.safetyPolicy?.killSwitchActive,
    availableWindows: windows.filter((row) => isNaturalWindowAvailable(row, now)).length,
  });
}

// ---------------------------------------------------------------------------
// Presentation — names, states and reason codes only. Never a payload.
// ---------------------------------------------------------------------------

const out = (line: string) => console.log(line);
const field = (label: string, value: string | number | boolean | null | undefined) =>
  out(`  ${label.padEnd(22)} ${value === null || value === undefined ? "—" : value}`);

export const USAGE = [
  "Stranded protection recovery (local operator CLI).",
  "",
  "  execution:protection-recovery evaluate <executionId>",
  `  execution:protection-recovery recover  <executionId> ${RECOVER_CONFIRMATION}`,
  "",
  "evaluate is read-only. recover re-gathers its own evidence and refuses",
  "unless every check passes. Exactly one executionId; there is no bulk,",
  "wildcard or force mode.",
].join("\n");

export interface CliDependencies {
  prisma: PrismaClient;
  recovery: ProtectionRecoveryService;
  /** Supplied ONLY for `recover`; `evaluate` never receives it. */
  protection?: ProtectionLifecycleService;
}

export interface CliResult {
  exitCode: number;
}

/**
 * READ-ONLY preview. Calls the same evaluator the mutation uses, so what it
 * shows is what `recover` will judge — but it writes nothing, takes no
 * confirmation, and is never handed the protection service.
 */
export async function evaluateCommand(argv: string[], deps: CliDependencies): Promise<CliResult> {
  const executionId = argv[0];
  if (!executionId || argv.length > 1) {
    out(USAGE);
    return { exitCode: CLI_EXIT.USAGE };
  }

  // Selected by id AND by the bound profile, in one predicate. Another
  // profile's row is never loaded here, so nothing about it can be printed
  // or handed onward.
  const execution = await deps.prisma.tradeExecution.findFirst({
    where: { id: executionId, executionProfileId: deps.recovery.boundExecutionProfileId },
    select: {
      id: true,
      symbol: true,
      positionSide: true,
      status: true,
      version: true,
      decisionReasonCode: true,
    },
  });
  if (!execution) {
    // EXISTENCE ONLY, and a count rather than a row: an operator who names
    // another profile's execution during an incident must not be told it
    // does not exist. Nothing here returns an object, so nothing here can
    // reach the recovery service.
    const elsewhere = await deps.prisma.tradeExecution.count({ where: { id: executionId } });
    if (elsewhere > 0) {
      out(`Execution ${executionId} belongs to a different execution profile than this process is bound to.`);
      out("Nothing was read from the exchange and nothing was changed.");
    } else {
      out(`No execution ${executionId} exists.`);
    }
    return { exitCode: CLI_EXIT.REFUSED };
  }

  out("Protection recovery — EVALUATE (read-only; nothing is written)");
  out("");
  field("executionId", execution.id);
  field("symbol", execution.symbol);
  field("side", execution.positionSide);
  field("status", execution.status);
  field("version", execution.version);
  field("decisionReasonCode", execution.decisionReasonCode);

  const evaluated = await deps.recovery.evaluate(executionId);
  if (!evaluated) {
    field("result", "NOT_APPLICABLE");
    out("");
    out("No such execution.");
    return { exitCode: CLI_EXIT.REFUSED };
  }

  const { verdict } = evaluated;
  field("result", verdict.safe ? "SAFE_TO_RECOVER" : verdict.reasonCode);
  field("stop already active", verdict.alreadyStopped);
  out("");
  out(`  checks passed (${verdict.checks.length}):`);
  for (const check of verdict.checks) out(`    ✓ ${check}`);

  if (verdict.safe) {
    out("");
    out("Recovery is safe on this evidence. To act on it, re-run with:");
    out(`  execution:protection-recovery recover ${executionId} ${RECOVER_CONFIRMATION}`);
    out("Recovery re-gathers this evidence itself; this preview is not carried over.");
    return { exitCode: CLI_EXIT.OK };
  }

  out("");
  out(`  blockers (${verdict.blockers.length}):`);
  for (const blocker of verdict.blockers) out(`    ✗ ${blocker}`);
  out("");
  out("Recovery is NOT safe. Nothing was changed.");
  return { exitCode: CLI_EXIT.REFUSED };
}

/**
 * The mutation. Requires the exact id AND the confirmation token, refuses
 * unless the durable posture permits it, and delegates the decision to the
 * service — which gathers CURRENT evidence rather than trusting any preview,
 * then hands the execution to the existing protection lifecycle.
 */
export async function recoverCommand(argv: string[], deps: CliDependencies): Promise<CliResult> {
  const [executionId, confirmation, ...rest] = argv;
  if (!executionId || rest.length > 0) {
    out(USAGE);
    return { exitCode: CLI_EXIT.USAGE };
  }

  if (confirmation !== RECOVER_CONFIRMATION) {
    out("Recovery refused: the confirmation token is missing or wrong.");
    out(`Required exactly: ${RECOVER_CONFIRMATION}`);
    out("There is no --force, and yes/y/true are not accepted. Nothing was changed.");
    return { exitCode: CLI_EXIT.REFUSED };
  }

  if (!deps.protection) {
    out("Recovery refused: the protection lifecycle is not available to this command.");
    return { exitCode: CLI_EXIT.REFUSED };
  }

  const posture = await readRecoveryPosture(deps.prisma);
  field("systemState", posture.systemState);
  if (!posture.allowed) {
    out("");
    out(`Recovery refused: ${posture.reason}`);
    out("Nothing was changed.");
    return { exitCode: CLI_EXIT.REFUSED };
  }

  // The service re-gathers evidence here. Whatever a previous `evaluate`
  // printed is irrelevant by design — the exchange may have changed since.
  const result = await deps.recovery.recover(executionId, deps.protection);

  out("");
  field("executionId", result.executionId);
  field("outcome", result.outcome);
  field("status", result.status);
  field("protectionState", result.protectionState);
  field("protectionReason", result.protectionReasonCode);
  out("");
  out(`  ${result.message}`);
  if (result.checks.length > 0) {
    out("");
    out(`  checks passed (${result.checks.length}):`);
    for (const check of result.checks) out(`    ✓ ${check}`);
  }
  if (result.blockers.length > 0) {
    out("");
    out(`  blockers (${result.blockers.length}):`);
    for (const blocker of result.blockers) out(`    ✗ ${blocker}`);
  }

  return { exitCode: result.ok ? CLI_EXIT.OK : CLI_EXIT.REFUSED };
}

/** Dispatches one subcommand. Anything unrecognised prints usage and exits 2. */
export async function runProtectionRecoveryCli(argv: string[], deps: CliDependencies): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === "evaluate") return evaluateCommand(rest, deps);
  if (command === "recover") return recoverCommand(rest, deps);
  out(USAGE);
  return { exitCode: CLI_EXIT.USAGE };
}

import type { PrismaClient } from "@prisma/client";

import type { EntryLifecycleService } from "./entry-lifecycle.service";
import type { ShutdownDrainService } from "./shutdown-drain.service";
import type { ShutdownPosture } from "./shutdown-drain";

/**
 * The operator boundary for preparing an intentional shutdown.
 *
 * ## Why this is a CLI and not part of the launcher
 *
 * The launcher states its own contract plainly: "This tool is a deployment
 * launcher; it never disarms, revokes or closes anything." Cancelling exchange
 * orders from inside it would contradict that in the one place an operator
 * relies on it being true. So the drain is a separate, explicit command with
 * its own confirmation, and the launcher's refusal is left exactly as it is —
 * once the drain has done its work, that refusal simply stops firing.
 *
 * ## Two commands, deliberately asymmetric
 *
 *   evaluate  read-only. Lists what a drain would target and why shutdown is
 *             currently blocked. Cancels nothing.
 *   drain     cancels Teddy-owned pending ENTRY orders, then reports whether
 *             the runtime may now be stopped.
 *
 * There is no bulk selector, no `--all`, no symbol argument and no `--force`.
 * The drain always targets exactly the pending entries this system created.
 */

/**
 * The confirmation token.
 *
 * Flag-shaped to match the repository's precedent, and worded as the ACTION
 * being authorized rather than as a yes. `yes`, `y`, `true` and `--force` are
 * rejected, and there is no override.
 */
export const DRAIN_CONFIRMATION = "--confirm-cancel-pending-entries";

/** What the confirmation actually authorizes, stated before it is accepted. */
export const DRAIN_WARNING = [
  "This will CANCEL Teddy-owned pending ENTRY orders on Binance so the runtime",
  "can be stopped safely.",
  "",
  "It will NOT close open positions, NOT cancel protection stops or take",
  "profits, and NOT touch any order this system did not place.",
  "",
  "A fill that wins the race against a cancellation is never cancelled over:",
  "the entry is reconciled instead and shutdown is refused so the worker stays",
  "to protect it.",
].join("\n");

export const CLI_EXIT = { OK: 0, REFUSED: 1, USAGE: 2 } as const;

const out = (line: string) => console.log(line);
const field = (label: string, value: string | number | boolean | null | undefined) =>
  out(`  ${label.padEnd(22)} ${value === null || value === undefined ? "—" : value}`);

export const USAGE = [
  "Prepare the runtime for an intentional shutdown (local operator CLI).",
  "",
  "  execution:prepare-shutdown evaluate",
  `  execution:prepare-shutdown drain ${DRAIN_CONFIRMATION}`,
  "",
  "evaluate is read-only. drain cancels Teddy-owned pending ENTRY orders and",
  "refuses to report the runtime stoppable unless EVERY one resolves cleanly.",
  "",
  "This makes an INTENTIONAL shutdown safe. It cannot protect against the",
  "laptop sleeping or losing power before it runs.",
].join("\n");

export interface CliDependencies {
  prisma: PrismaClient;
  drain: ShutdownDrainService;
  readPosture: () => Promise<ShutdownPosture>;
  /** Supplied ONLY for `drain`; `evaluate` never receives it. */
  entry?: EntryLifecycleService;
}

export interface CliResult {
  exitCode: number;
}

function report(verdictLines: string[], drained: { symbol: string; positionSide: string; outcome: string; detail: string }[]) {
  if (drained.length > 0) {
    out("");
    out(`  pending entries (${drained.length}):`);
    for (const entry of drained) {
      out(`    ${entry.outcome === "CANCELED_CLEAN" ? "✓" : "✗"} ${entry.symbol} ${entry.positionSide} — ${entry.outcome}`);
      out(`        ${entry.detail}`);
    }
  }
  if (verdictLines.length > 0) {
    out("");
    out(`  blocking shutdown (${verdictLines.length}):`);
    for (const reason of verdictLines) out(`    ✗ ${reason}`);
  }
}

/** READ-ONLY preview. Cancels nothing and is never handed the entry lifecycle. */
export async function evaluateCommand(argv: string[], deps: CliDependencies): Promise<CliResult> {
  if (argv.length > 0) {
    out(USAGE);
    return { exitCode: CLI_EXIT.USAGE };
  }

  const posture = await deps.readPosture();
  const result = await deps.drain.evaluate(posture);

  out("Prepare for shutdown — EVALUATE (read-only; nothing is cancelled)");
  out("");
  field("systemState", posture.systemState);
  field("authorization", posture.authorizationState);
  field("manualIntervention", posture.manualInterventionCount);
  field("openPositions", posture.openPositionCount);
  field("pendingEntries", result.verdict.drained.length);

  report(result.verdict.reasons, result.verdict.drained);

  if (result.verdict.drained.length === 0 && result.verdict.shutdownReady) {
    out("");
    out("Nothing to drain and nothing blocking: the runtime can be stopped.");
    return { exitCode: CLI_EXIT.OK };
  }

  out("");
  out("To cancel the pending entries above and re-check, run:");
  out(`  execution:prepare-shutdown drain ${DRAIN_CONFIRMATION}`);
  return { exitCode: CLI_EXIT.REFUSED };
}

/**
 * The mutation. Requires the confirmation token, refuses unless the durable
 * posture permits it, and delegates every cancellation to the entry lifecycle.
 */
export async function drainCommand(argv: string[], deps: CliDependencies): Promise<CliResult> {
  const [confirmation, ...rest] = argv;
  if (rest.length > 0) {
    out(USAGE);
    return { exitCode: CLI_EXIT.USAGE };
  }

  if (confirmation !== DRAIN_CONFIRMATION) {
    out(DRAIN_WARNING);
    out("");
    out("Refused: the confirmation token is missing or wrong.");
    out(`Required exactly: ${DRAIN_CONFIRMATION}`);
    out("There is no --force, and yes/y/true are not accepted. Nothing was changed.");
    return { exitCode: CLI_EXIT.REFUSED };
  }

  if (!deps.entry) {
    out("Refused: the entry lifecycle is not available to this command.");
    return { exitCode: CLI_EXIT.REFUSED };
  }

  const posture = await deps.readPosture();
  const result = await deps.drain.drain(posture, deps.entry);

  out("Prepare for shutdown — DRAIN");
  out("");
  field("systemState", posture.systemState);
  field("pendingEntries", result.verdict.drained.length);
  field("shutdownReady", result.verdict.shutdownReady);

  report(result.verdict.reasons, result.verdict.drained);

  if (!result.verdict.shutdownReady) {
    out("");
    out("The runtime must STAY ONLINE. Do not stop it and do not close the laptop.");
    return { exitCode: CLI_EXIT.REFUSED };
  }

  out("");
  out("Every pending entry resolved cleanly and nothing is open.");
  out("The runtime can now be stopped with the launcher's Stop Runtime option.");
  return { exitCode: CLI_EXIT.OK };
}

/** Dispatches one subcommand. Anything unrecognised prints usage and exits 2. */
export async function runShutdownDrainCli(argv: string[], deps: CliDependencies): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === "evaluate") return evaluateCommand(rest, deps);
  if (command === "drain") return drainCommand(rest, deps);
  out(USAGE);
  return { exitCode: CLI_EXIT.USAGE };
}

import type { PrismaClient } from "@prisma/client";

import {
  bindConfiguredExecutionProfileEnvironment,
  type BinanceProfileBindingFailure,
  type BinanceProfileBindingResult,
} from "./binance-profile-binding";
import { FILL_INGEST_REASON } from "./exchange-fill-ingest-window.service";

/**
 * The operator boundary for closing out windows whose attempt budget is spent.
 *
 * ## The zombie this repairs
 *
 * A worker claims the LAST allowed attempt -- the row goes to
 * `attempts = MAX_INGEST_ATTEMPTS`, PENDING, leased -- and then dies before
 * recording anything. Its lease expires and the row sits PENDING at the
 * ceiling forever: BOTH claim paths require `attempts < MAX`, so neither the
 * scheduled FIFO claim nor the targeted canary can ever look at it again. It is
 * not a coverage gap anybody can see acting, and because `completeIfDrained`
 * counts every PENDING row, it also stops an ACTIVE campaign from ever
 * reaching COMPLETED.
 *
 * ## What this command is, and is not
 *
 * It is ONE bounded database repair, run by a person. It issues no exchange
 * request, spends no request weight, touches no campaign, reads and writes no
 * circuit, materializes no roots and starts nothing. It does not complete a
 * campaign either: it only removes the row that was blocking completion, and
 * the existing drained-queue check does the rest on a later tick if a runtime
 * is ever enabled.
 *
 * AVAILABILITY IS NOT AUTOMATION. Nothing schedules this.
 *
 * ## Why there is no --limit
 *
 * The bound belongs to the audited service method, not to whoever is typing.
 * A flag here would let one invocation become an unbounded sweep, which is the
 * opposite of what a bounded repair means -- so the service capability this CLI
 * is handed (see `FinalizeCliWindowService`) cannot express a limit at all, and
 * a future edit wanting one would have to widen a published interface to do it.
 */

export const FINALIZE_CLI_EXIT = { OK: 0, REFUSED: 1, USAGE: 2 } as const;

export const FINALIZE_USAGE = [
  "Usage:",
  "  pnpm execution:fill-window-finalize-exhausted",
  "",
  "Takes NO arguments. Acts on the configured, environment-bound execution",
  "profile; no profile, account, window, force or limit flag exists.",
  "",
  "Finalizes ONLY pending historical ingest windows whose attempt budget is",
  "already spent and whose lease has expired. ONE bounded pass: no loop, no",
  "exchange request, no campaign change, no circuit change, no root",
  "materialization, and no runtime is started.",
].join("\n");

export interface FinalizeCliResult {
  exitCode: (typeof FINALIZE_CLI_EXIT)[keyof typeof FINALIZE_CLI_EXIT];
}

/**
 * Exactly the one repair this CLI may perform, and no way to steer it.
 *
 * Deliberately NARROWER than the real method: the service accepts optional
 * `now` and `limit`, and this type accepts neither. The real
 * `finalizeStaleExhausted` still satisfies it -- both extras are optional -- so
 * nothing about the audited method changes, while the CLI is left structurally
 * unable to override the clock or widen the batch bound.
 */
export interface FinalizeCliWindowService {
  finalizeStaleExhausted: (
    client: PrismaClient,
    options: { executionProfileId: string }
  ) => Promise<string[]>;
}

export interface FinalizeCliDependencies {
  /** The client the repair runs on. It owns its own transaction per row. */
  prisma: PrismaClient;
  work: FinalizeCliWindowService;
  /** Injectable only so tests can drive a binding failure; default is the real binder. */
  bindProfile?: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;
  /** Injectable so tests can read output instead of a terminal. */
  out?: (line: string) => void;
}

function line(out: (line: string) => void, label: string, value: unknown): void {
  out(`  ${label.padEnd(24)} ${value === null || value === undefined ? "—" : String(value)}`);
}

/**
 * Finalizes the bound profile's stale exhausted windows, or refuses.
 *
 * Accepts NOTHING in argv. Every other command in this module has at least one
 * flag, so the empty allowance is stated rather than implied: an operator who
 * types a half-remembered `--limit=` gets a usage failure and an unchanged
 * database, never a silently ignored flag and a wider sweep than they meant.
 */
export async function runFillFinalizeExhaustedCli(
  argv: string[],
  deps: FinalizeCliDependencies
): Promise<FinalizeCliResult> {
  const out = deps.out ?? ((text: string) => console.log(text));

  if (argv.length > 0) {
    out(FINALIZE_USAGE);
    return { exitCode: FINALIZE_CLI_EXIT.USAGE };
  }

  const bindProfile = deps.bindProfile ?? bindConfiguredExecutionProfileEnvironment;
  const binding = await bindProfile(deps.prisma);
  if (!binding.ok) {
    out("historical fill exhausted-window finalization");
    line(out, "outcome", "PROFILE_UNAVAILABLE");
    line(out, "reason", binding.reasonCode satisfies BinanceProfileBindingFailure);
    return { exitCode: FINALIZE_CLI_EXIT.REFUSED };
  }

  // The bound account, and nothing a caller could have named. No `limit` and
  // no `now` are passed: the audited defaults are the contract.
  const finalized = await deps.work.finalizeStaleExhausted(deps.prisma, {
    executionProfileId: binding.context.executionProfileId,
  });

  out("historical fill exhausted-window finalization");
  line(out, "outcome", "FINALIZED");
  line(out, "windows finalized", finalized.length);
  // Taken from the service's own constants rather than restated, so a change
  // to the terminal contract cannot silently disagree with what is printed.
  line(out, "terminal status", "ABANDONED");
  line(out, "terminal reason", FILL_INGEST_REASON.ATTEMPT_BUDGET_EXHAUSTED_AFTER_STALE_LEASE);
  // Window ids are opaque row identifiers for this account's own work. They
  // name no account and carry no credential, and an operator needs them to
  // review what was closed.
  for (const windowId of finalized) line(out, "window", windowId);

  return { exitCode: FINALIZE_CLI_EXIT.OK };
}

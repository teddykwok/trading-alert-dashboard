import { FillIngestHorizonRefusedError } from "./exchange-fill-day-roots";
import {
  FillRootRaceUnresolvedError,
  FillRootStructuralOverlapError,
  type FillRootBootstrapResult,
} from "./exchange-fill-root-bootstrap.service";
import { ExecutionSymbolLineageError } from "./exchange-fill-symbol-universe";

/**
 * The operator boundary for MATERIALIZING canonical historical root windows.
 *
 * One command, and it is the narrowest useful thing in this module: it makes
 * the rows that describe which days of which symbols still need ingesting, and
 * it stops there. It starts no campaign, claims no window, reserves no weight,
 * reads no breaker and contacts no exchange -- not because it declines to, but
 * because none of those collaborators exists anywhere in the graph it is handed.
 *
 * ## Why the dependency is one method wide
 *
 * `FillBootstrapCliService` names exactly ONE operation. A composition root
 * that wanted to hand this CLI a campaign service or an executor would have
 * nowhere to put it, and a future edit that reached for one would have to widen
 * a published interface to do it -- which is a reviewable act rather than an
 * accident. The structural tests then enforce what this interface merely
 * encourages.
 *
 * ## Why there is no Prisma client here
 *
 * Deliberate, and a real guarantee rather than a tidiness preference. This CLI
 * cannot read or write ANY table directly, because it holds no client to do it
 * with. Every durable effect it can possibly have is the one the bootstrap
 * service performs on its own client, under its own audited rules.
 *
 * ## Why the profile is never printed
 *
 * The bootstrap result and three of the four domain errors below carry the
 * bound `executionProfileId`, and two of them embed it in their `message`. An
 * operator does not need it -- there is only ever one bound account and no flag
 * can change which -- so it is dropped here, and refusals report their
 * `reasonCode` INSTEAD OF their message rather than as well as it.
 */

export const BOOTSTRAP_CLI_EXIT = { OK: 0, REFUSED: 1, USAGE: 2 } as const;

export const BOOTSTRAP_USAGE = [
  "Usage:",
  "  pnpm execution:fill-bootstrap-roots",
  "",
  "Takes NO arguments. Acts on the configured, environment-bound execution profile;",
  "no profile, account or force flag exists. The horizon is the configured",
  "EXECUTION_FILL_INGEST_HORIZON_DAYS and cannot be overridden from the terminal.",
  "",
  "Materializes canonical UTC-day root windows and nothing else: no campaign is",
  "created or read, no weight is reserved, no window is claimed, and no exchange",
  "request is made.",
].join("\n");

export interface FillBootstrapCliResult {
  exitCode: (typeof BOOTSTRAP_CLI_EXIT)[keyof typeof BOOTSTRAP_CLI_EXIT];
}

/** Exactly the one bootstrap operation this CLI may perform. Nothing wider. */
export interface FillBootstrapCliService {
  bootstrapHistoricalRoots: (options: {
    now: Date;
    horizonDays: number;
  }) => Promise<FillRootBootstrapResult>;
}

export interface FillBootstrapCliDependencies {
  /** The real `ExchangeFillRootBootstrap`, narrowed to its one public act. */
  bootstrap: FillBootstrapCliService;
  /**
   * The configured horizon, already validated at the env boundary (1..60) and
   * validated again by the pure day generator. It is a dependency rather than a
   * flag precisely so no terminal invocation can widen the account history this
   * command materializes.
   */
  horizonDays: number;
  /** Injectable so tests can pin the day arithmetic. */
  now?: () => Date;
  /** Injectable so tests can read output instead of a terminal. */
  out?: (line: string) => void;
}

function line(out: (line: string) => void, label: string, value: unknown): void {
  out(`  ${label.padEnd(20)} ${value === null || value === undefined ? "—" : String(value)}`);
}

/**
 * Every refusal this CLI understands, reported by code alone.
 *
 * Returns null for anything else, which leaves the error to the process wrapper
 * rather than flattening an unknown failure into a tidy exit code.
 */
function refusalCodeOf(error: unknown): string | null {
  if (error instanceof FillRootStructuralOverlapError) return error.reasonCode;
  if (error instanceof FillRootRaceUnresolvedError) return error.reasonCode;
  if (error instanceof FillIngestHorizonRefusedError) return error.reasonCode;
  if (error instanceof ExecutionSymbolLineageError) return error.reasonCode;
  return null;
}

/**
 * Materializes canonical roots for the bound profile, or refuses.
 *
 * Takes the whole argv slice and accepts NOTHING in it. Every other command in
 * this module has at least one flag, so the empty allowance is stated rather
 * than implied: an operator who types a half-remembered `--profile=` gets a
 * usage failure and an unchanged database, never a silently ignored flag and a
 * horizon materialized against an account they did not mean.
 */
export async function runFillBootstrapCli(
  argv: string[],
  deps: FillBootstrapCliDependencies
): Promise<FillBootstrapCliResult> {
  const out = deps.out ?? ((text: string) => console.log(text));

  // No flags, no positionals, no subcommands. Anything at all is a usage error.
  if (argv.length > 0) {
    out(BOOTSTRAP_USAGE);
    return { exitCode: BOOTSTRAP_CLI_EXIT.USAGE };
  }

  const now = (deps.now ?? (() => new Date()))();

  let result: FillRootBootstrapResult;
  try {
    result = await deps.bootstrap.bootstrapHistoricalRoots({
      now,
      horizonDays: deps.horizonDays,
    });
  } catch (error) {
    const reasonCode = refusalCodeOf(error);
    // Unknown failures are re-thrown, NOT flattened: the process wrapper owns
    // what an unexpected error looks like, and swallowing one here would report
    // a clean refusal for a fault nobody has classified.
    if (reasonCode === null) throw error;
    out("historical root bootstrap");
    line(out, "outcome", "REFUSED");
    line(out, "reason", reasonCode);
    return { exitCode: BOOTSTRAP_CLI_EXIT.REFUSED };
  }

  out("historical root bootstrap");

  if (result.outcome === "PROFILE_UNAVAILABLE") {
    // The binder's own code, unflattened, exactly as the executor reports it.
    line(out, "outcome", result.outcome);
    line(out, "reason", result.reasonCode);
    return { exitCode: BOOTSTRAP_CLI_EXIT.REFUSED };
  }

  // FIELD BY FIELD, never a spread of the service result.
  //
  // The BOOTSTRAPPED branch carries `executionProfileId`, so spreading it would
  // print the bound account today, and a spread would print whatever field this
  // result grows next without anyone deciding that it is safe to show.
  line(out, "outcome", result.outcome);
  line(out, "horizon days", result.horizonDays);
  line(out, "symbols", result.symbolCount);
  line(out, "days", result.dayCount);
  line(out, "expected roots", result.expectedRootCount);
  line(out, "already compatible", result.alreadyCompatibleCount);
  line(out, "created", result.createdCount);
  line(out, "race reconciled", result.raceReconciledCount);

  return { exitCode: BOOTSTRAP_CLI_EXIT.OK };
}

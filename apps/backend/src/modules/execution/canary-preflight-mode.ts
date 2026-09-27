import type { CanaryAuthorizationMode } from "./canary-readiness";

/**
 * `--mode` parsing for the canary preflight, on its own.
 *
 * Extracted from `run-canary-preflight.ts` unchanged. That file is an ACCOUNT
 * ENTRYPOINT: its first import is the account bootstrap, which refuses to load
 * a process that cannot say which account it is, and it runs `main()` at module
 * scope. Neither is something a unit test of an argv parser should have to
 * arrange, so the parser lives where it can be imported for what it is.
 *
 * Deliberately side-effect free: one TYPE import, which is erased, and no
 * bootstrap, Prisma, env or top-level statement. Importing this module does
 * nothing at all.
 */

/** The only spellings `--mode` accepts. Case-sensitive, so there is one answer. */
const MODE_VALUES: Record<string, CanaryAuthorizationMode> = {
  exact: "EXACT_SIGNAL",
  EXACT_SIGNAL: "EXACT_SIGNAL",
  natural: "NATURAL_WINDOW",
  NATURAL_WINDOW: "NATURAL_WINDOW",
};

export type ModeResolution =
  | { ok: true; mode: CanaryAuthorizationMode }
  | { ok: false; message: string };

/**
 * Resolves `--mode`, FAIL CLOSED.
 *
 * Absent means EXACT_SIGNAL, which is the historical behaviour every existing
 * caller depends on. But an explicitly SUPPLIED value must be recognized
 * exactly: the first version of this parser matched `natural` and fell through
 * to EXACT_SIGNAL for anything else, so `--mode=natrual` printed a full,
 * confident EXACT readiness report while the operator believed they were
 * reading NATURAL readiness. On a command whose entire purpose is deciding
 * whether real money may trade, a typo must never answer a different question
 * than the one that was asked.
 *
 * A repeated `--mode` is refused rather than resolved by precedence: with
 * `--mode=natural --mode=exact` there is no defensible "winner", and guessing
 * one produces exactly the same misreading.
 */
export function resolveMode(argv: readonly string[]): ModeResolution {
  const supplied = argv.filter((entry) => entry === "--mode" || entry.startsWith("--mode="));
  if (supplied.length === 0) return { ok: true, mode: "EXACT_SIGNAL" };
  if (supplied.length > 1) {
    return { ok: false, message: `--mode was supplied ${supplied.length} times; supply it at most once.` };
  }

  const [only] = supplied;
  const value = only === "--mode" ? "" : only.slice("--mode=".length);
  const resolved = MODE_VALUES[value];
  if (resolved === undefined) {
    return {
      ok: false,
      message:
        `--mode=${value} is not a known mode. Use one of: ${Object.keys(MODE_VALUES).join(", ")}. ` +
        "Omit --mode entirely for the default (EXACT_SIGNAL).",
    };
  }
  return { ok: true, mode: resolved };
}

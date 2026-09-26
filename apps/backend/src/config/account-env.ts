import { readFileSync } from "node:fs";

import { parse } from "dotenv";

/**
 * Phase 11F — proving an account process loaded the account file it was told to.
 *
 * ## The hole this closes
 *
 * `config/env.ts` starts with `import "dotenv/config"`, and dotenv's `override`
 * defaults to FALSE (`lib/main.js`: `const override = Boolean(options &&
 * options.override)`). A variable already present in the process environment
 * therefore WINS over the file.
 *
 * That is normally the behaviour you want, and here it is a trap. Launch
 * Account B from a shell that still exports Account A's identity:
 *
 *   BINANCE_API_KEY=<A>  DOTENV_CONFIG_PATH=<B file>  pnpm account-control
 *
 * and the process reads B's file, keeps A's inherited key, resolves A's
 * profile, and signs as A while every log line says B. Nothing downstream can
 * catch it: the profile, the credentials and the attestation identity are all
 * mutually consistent — consistently wrong.
 *
 * So an account process states which file it belongs to, and this asserts that
 * the values it actually ended up with are the ones that file names. A
 * disagreement is fatal BEFORE profile resolution, before any signed client,
 * before attestation and before any exchange request.
 *
 * ## What is never emitted
 *
 * Only the NAME of the disagreeing variable, and a reason code. No value, no
 * fragment, no length, no hash — a hash of a short account identifier is
 * guessable, and a length leaks too. The name alone tells an operator exactly
 * what to fix.
 */

/**
 * The variables that decide WHICH ACCOUNT a process is.
 *
 * Deliberately not "everything sensitive": these four are the ones whose
 * disagreement makes a process act as the wrong account. A shared
 * `DATABASE_URL` or `REDIS_URL` inherited from the parent is correct and
 * expected — both accounts use the same database and the same Redis.
 */
export const ACCOUNT_IDENTITY_KEYS = [
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER",
  "EXECUTION_PROFILE_ENVIRONMENT",
] as const;

export type AccountIdentityKey = (typeof ACCOUNT_IDENTITY_KEYS)[number];

export type AccountEnvVerdict =
  | { ok: true; reasonCode: "ACCOUNT_ENV_FILE_HONOURED" | "NO_ACCOUNT_ENV_FILE" }
  | {
      ok: false;
      reasonCode: "ACCOUNT_ENV_CONFLICT" | "ACCOUNT_ENV_UNREADABLE";
      /** Variable NAMES only. Never a value. */
      conflictingKeys: AccountIdentityKey[];
    };

export interface AccountEnvInput {
  /** Normally `process.env.DOTENV_CONFIG_PATH`. */
  envFilePath: string | undefined;
  /** Normally `process.env`, read AFTER dotenv has run. */
  effective: NodeJS.ProcessEnv;
  /** Injected so the check is testable without touching a real file. */
  readFile?: (path: string) => string;
}

/**
 * Compares the account file's identity values with the ones in force.
 *
 * Absent from BOTH is agreement: a deployment that leaves an optional variable
 * unset in the file and unset in the environment is consistent, and the env
 * schema decides whether that is allowed.
 */
export function checkAccountEnvIntegrity(input: AccountEnvInput): AccountEnvVerdict {
  const path = input.envFilePath?.trim();
  if (!path) {
    // No account file was named, so there is no second opinion to disagree
    // with. This is the single-account deployment that predates 11F.
    return { ok: true, reasonCode: "NO_ACCOUNT_ENV_FILE" };
  }

  let parsed: Record<string, string>;
  try {
    const read = input.readFile ?? ((target: string) => readFileSync(target, "utf8"));
    parsed = parse(read(path));
  } catch {
    // The path is reported; its CONTENT never is.
    return { ok: false, reasonCode: "ACCOUNT_ENV_UNREADABLE", conflictingKeys: [] };
  }

  const conflictingKeys = ACCOUNT_IDENTITY_KEYS.filter((key) => {
    const fromFile = parsed[key];
    const inForce = input.effective[key];
    // Undefined in the file means the file does not claim this variable, so it
    // cannot be contradicted. Only a stated value can disagree.
    if (fromFile === undefined) return false;
    return fromFile !== (inForce ?? "");
  });

  if (conflictingKeys.length > 0) {
    return { ok: false, reasonCode: "ACCOUNT_ENV_CONFLICT", conflictingKeys: [...conflictingKeys] };
  }
  return { ok: true, reasonCode: "ACCOUNT_ENV_FILE_HONOURED" };
}

/** What an account entrypoint prints, and nothing more. */
export function describeAccountEnvVerdict(verdict: AccountEnvVerdict, envFilePath?: string): string {
  if (verdict.ok) return `account environment: ${verdict.reasonCode}`;
  if (verdict.reasonCode === "ACCOUNT_ENV_UNREADABLE") {
    return `account environment: ACCOUNT_ENV_UNREADABLE (${envFilePath ?? "<unset>"} could not be read)`;
  }
  return (
    "account environment: ACCOUNT_ENV_CONFLICT — the running process disagrees with its " +
    `account file for: ${verdict.conflictingKeys.join(", ")}. An inherited value is overriding ` +
    "the file (dotenv does not override what the environment already set). Clear those " +
    "variables from the launching shell, or export the file's values explicitly."
  );
}

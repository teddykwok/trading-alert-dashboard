import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { parse } from "dotenv";

import {
  ACCOUNT_IDENTITY_KEYS,
  checkAccountEnvIntegrity,
  describeAccountEnvVerdict,
  type AccountEnvVerdict,
} from "./account-env";

/**
 * Phase 11F.1 -- the single place a backend process decides what its
 * environment is.
 *
 * ## The hole this closes
 *
 * `config/env.ts` used to begin with `import "dotenv/config"`, and that was
 * believed to be the moment the process environment came into being. It is
 * not. The GENERATED Prisma client loads an env file of its own, at module
 * initialization, before anything of ours runs:
 *
 *   node_modules/.prisma/client/index.js
 *     warnEnvConflicts({ schemaEnvPath: <abs>/apps/backend/.env })
 *       -> tryLoadEnvs(...) -> dotenv.config({ path })
 *
 * `schemaEnvPath` is BAKED AT `prisma generate` TIME as a path relative to the
 * generated client's own directory and resolved against its `__dirname`, so it
 * is the repository `.env` regardless of cwd, regardless of
 * DOTENV_CONFIG_PATH, and regardless of which account the process was launched
 * as. It is baked only when that file existed at generation time, which is why
 * the defect is invisible on a fresh checkout and present in production.
 *
 * Neither loader overrides: both skip a key already in `process.env` (dotenv's
 * `override` defaults to false, and Prisma passes none). So whichever loader
 * runs FIRST wins, key by key, and the consequences split in two:
 *
 *   ACCOUNT process, Prisma first -- the repository `.env` supplies identity
 *     and credentials, DOTENV_CONFIG_PATH is silently defeated, and the
 *     process runs as the WRONG ACCOUNT while every log line names the right
 *     one.
 *
 *   GENERIC process, bootstrap first -- import order is NOT enough. A generic
 *     env file deliberately OMITS the account keys, and omitted keys are
 *     exactly the ones Prisma is still free to fill. A process that is not
 *     supposed to hold any credential acquires Account A's.
 *
 * The second case is why this module exists rather than a rule about import
 * order. Ordering fixes the first and leaves the second untouched.
 *
 * ## How it is closed
 *
 * The process environment is MATERIALISED HERE, once, in a known order:
 *
 *   1. refuse if the generated Prisma client already loaded while an explicit
 *      env file was selected -- by then the damage is done and cannot be
 *      undone honestly, so the process must not continue
 *   2. apply the selected file, preserving dotenv's "do not override" rule so
 *      a deliberately exported variable still wins
 *   3. (account) compare the account file against the environment it produced,
 *      so an inherited value that survived step 2 is caught contradicting it
 *   4. QUARANTINE: every key the repository `.env` defines that the selected
 *      file does not, and that nothing has set, is pinned to an empty string.
 *      Both loaders skip a key that is merely PRESENT -- the test is
 *      `Object.prototype.hasOwnProperty`, not truthiness -- so a pinned key is
 *      a key Prisma cannot fill.
 *   5. load the Prisma client HERE, so its one and only env load is spent
 *      against the quarantine
 *   6. lift the quarantine, leaving those keys genuinely ABSENT rather than
 *      empty, so `process.env` tells the truth to anything that reads it
 *   7. enforce the mode's invariant and fail closed
 *
 * The result is exact: a process ends up with (what its shell exported) plus
 * (what its selected file declares), and nothing else. When no explicit file
 * is selected the selected file IS the repository `.env`, the quarantine is
 * empty, and behaviour is bit-for-bit what it was before this module -- which
 * is what makes it safe to introduce underneath a running deployment.
 */

/**
 * GENERIC   -- holds no account. Must end with no account credentials at all.
 * ACCOUNT   -- is exactly one account. Must end with an identity, and must
 *              never be quietly handed a different one.
 * INHERITED -- a library, a test, or an entrypoint that has not been migrated.
 *              Materialises the environment the same way, enforces no mode
 *              invariant, and still refuses the one situation it can prove is
 *              wrong (see `PRISMA_LOADED_BEFORE_ENV_BOOTSTRAP`).
 */
export type RuntimeEnvMode = "GENERIC" | "ACCOUNT" | "INHERITED";

export type RuntimeEnvRefusalCode =
  | "PRISMA_LOADED_BEFORE_ENV_BOOTSTRAP"
  | "RUNTIME_ENV_MODE_CONFLICT"
  | "RUNTIME_ENV_FILE_UNREADABLE"
  | "GENERIC_PROCESS_HOLDS_ACCOUNT_CREDENTIALS"
  | "ACCOUNT_IDENTITY_NOT_CONFIGURED"
  | "ACCOUNT_ENV_CONFLICT"
  | "ACCOUNT_ENV_UNREADABLE";

export interface RuntimeEnvBootstrapResult {
  readonly mode: RuntimeEnvMode;
  /** Absolute path of the file that was applied, or null when there was none. */
  readonly selectedEnvFile: string | null;
  /** True when DOTENV_CONFIG_PATH named a file other than the repository one. */
  readonly usedExplicitEnvFile: boolean;
  /** How many repository-`.env` keys were withheld. A COUNT, never the names. */
  readonly quarantinedKeyCount: number;
  readonly accountEnvVerdict: AccountEnvVerdict | null;
}

/** Carries a reason code and a message naming VARIABLES, never values. */
export class RuntimeEnvBootstrapError extends Error {
  constructor(
    readonly reasonCode: RuntimeEnvRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "RuntimeEnvBootstrapError";
  }
}

/**
 * The keys that make a process an account.
 *
 * `EXECUTION_PROFILE_ENVIRONMENT` is deliberately excluded: it says which
 * Binance a process talks to, not whose money it moves, and a generic process
 * may legitimately be told one.
 */
const ACCOUNT_CREDENTIAL_KEYS = ACCOUNT_IDENTITY_KEYS.filter(
  (key) => key !== "EXECUTION_PROFILE_ENVIRONMENT"
);

let bootstrapped: RuntimeEnvBootstrapResult | null = null;

/**
 * The backend root whose `.env` `prisma generate` baked into the client.
 *
 * Found by walking up to the directory that owns `prisma/schema.prisma` rather
 * than counting `..` from `__dirname`, because the compiled layout
 * (`dist/src/config`) is one level deeper than the source one and a fixed
 * count would silently resolve to `dist` in production.
 */
function findBackendRoot(start: string): string {
  let current = start;
  for (let hops = 0; hops < 12; hops += 1) {
    if (existsSync(join(current, "prisma", "schema.prisma"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/**
 * Has the GENERATED client been required already?
 *
 * It is plain CommonJS however our own sources are transformed, so it lands in
 * `require.cache` under a path containing `.prisma/client`. A missing cache is
 * read as "not loaded" rather than as an error: a runtime without one cannot
 * have loaded it through `require`.
 */
function prismaClientAlreadyLoaded(): boolean {
  const cache = (require as unknown as { cache?: Record<string, unknown> }).cache;
  if (!cache) return false;
  const needle = `${sep}.prisma${sep}client${sep}`;
  return Object.keys(cache).some((entry) => entry.includes(needle));
}

/** Loads the generated client so ITS env load happens under quarantine. */
function loadPrismaClient(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- must be
  // synchronous: this belongs between raising and lifting the quarantine, and
  // `await import` would let the rest of the module graph run in between.
  require("@prisma/client");
}

function parseEnvFile(path: string): Record<string, string> {
  return parse(readFileSync(path, "utf8"));
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function materialise(mode: RuntimeEnvMode): RuntimeEnvBootstrapResult {
  const backendRoot = findBackendRoot(__dirname);
  const prismaEnvFile = join(backendRoot, ".env");
  const explicit = process.env.DOTENV_CONFIG_PATH?.trim() || null;
  const usedExplicitEnvFile = explicit !== null && !samePath(explicit, prismaEnvFile);

  // 1. Too late to be honest about it.
  if (usedExplicitEnvFile && prismaClientAlreadyLoaded()) {
    throw new RuntimeEnvBootstrapError(
      "PRISMA_LOADED_BEFORE_ENV_BOOTSTRAP",
      "the generated Prisma client was imported before the runtime environment " +
        "was bootstrapped, so the repository .env has already supplied values that " +
        "DOTENV_CONFIG_PATH was supposed to supply. Import the runtime bootstrap " +
        "module first in this entrypoint."
    );
  }

  // 2. Apply the selected file, keeping dotenv's precedence.
  const selectedEnvFile = explicit ?? (existsSync(prismaEnvFile) ? prismaEnvFile : null);
  let selectedVars: Record<string, string> = {};
  if (selectedEnvFile !== null) {
    try {
      selectedVars = parseEnvFile(selectedEnvFile);
    } catch {
      if (explicit !== null) {
        throw new RuntimeEnvBootstrapError(
          "RUNTIME_ENV_FILE_UNREADABLE",
          `DOTENV_CONFIG_PATH names a file that could not be read: ${explicit}`
        );
      }
    }
    for (const [key, value] of Object.entries(selectedVars)) {
      if (!(key in process.env)) process.env[key] = value;
    }
  }

  // 3. Account integrity, judged on the environment the file produced.
  //
  // AFTER the file is applied, not before. The check asks whether the values in
  // force are the ones the account file names, and a key the file declares is
  // only in force once the file has been applied -- ask too early and every
  // declared key reads as a disagreement with nothing.
  //
  // Applying the file does not hide a real conflict, because applying it does
  // NOT override: an inherited value survives step 2 and is still sitting there,
  // contradicting the file, which is exactly the case this must catch.
  let accountEnvVerdict: AccountEnvVerdict | null = null;
  if (mode === "ACCOUNT") {
    accountEnvVerdict = checkAccountEnvIntegrity({
      envFilePath: explicit ?? undefined,
      effective: process.env,
    });
    if (!accountEnvVerdict.ok) {
      throw new RuntimeEnvBootstrapError(
        accountEnvVerdict.reasonCode,
        describeAccountEnvVerdict(accountEnvVerdict, explicit ?? undefined)
      );
    }
  }

  // 4. Withhold every repository-only key from the loader that comes next.
  const quarantined: string[] = [];
  if (usedExplicitEnvFile && existsSync(prismaEnvFile)) {
    let repositoryVars: Record<string, string> = {};
    try {
      repositoryVars = parseEnvFile(prismaEnvFile);
    } catch {
      repositoryVars = {};
    }
    for (const key of Object.keys(repositoryVars)) {
      if (!(key in process.env)) {
        process.env[key] = "";
        quarantined.push(key);
      }
    }
  }

  // 5 and 6. Spend Prisma's one env load against the quarantine, then lift it.
  if (quarantined.length > 0) {
    loadPrismaClient();
    for (const key of quarantined) delete process.env[key];
  }

  const result: RuntimeEnvBootstrapResult = {
    mode,
    selectedEnvFile,
    usedExplicitEnvFile,
    quarantinedKeyCount: quarantined.length,
    accountEnvVerdict,
  };

  // 7. The mode's invariant, enforced on the finished environment.
  if (mode === "GENERIC") assertGenericProcessHoldsNoAccount();
  if (mode === "ACCOUNT") assertAccountIdentityConfigured();

  bootstrapped = result;
  return result;
}

/**
 * A generic process holding ANY account credential is refused, whatever the
 * source -- leaked from the repository file or written into its own.
 *
 * Unconditional on purpose. "Absent unless it came from the right file" is a
 * rule about provenance, and provenance is exactly what was untrustworthy
 * here; "absent" is a rule about the finished state, and can be checked.
 */
function assertGenericProcessHoldsNoAccount(): void {
  const held = ACCOUNT_CREDENTIAL_KEYS.filter((key) => (process.env[key] ?? "") !== "");
  if (held.length === 0) return;
  throw new RuntimeEnvBootstrapError(
    "GENERIC_PROCESS_HOLDS_ACCOUNT_CREDENTIALS",
    "a generic process must hold no account credentials, but these are set: " +
      `${held.join(", ")}. Launch it with DOTENV_CONFIG_PATH pointing at a generic ` +
      "environment file that omits them, and clear them from the launching shell."
  );
}

/** An account process with no identity cannot resolve a profile. Say so now. */
function assertAccountIdentityConfigured(): void {
  if ((process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER ?? "").trim() !== "") return;
  throw new RuntimeEnvBootstrapError(
    "ACCOUNT_IDENTITY_NOT_CONFIGURED",
    "an account process requires EXECUTION_PROFILE_ACCOUNT_IDENTIFIER, and none is " +
      "set. Launch it with DOTENV_CONFIG_PATH pointing at its account environment file."
  );
}

/**
 * Declares what this process is and materialises its environment.
 *
 * Called for side effects by a `bootstrap-*` module that an entrypoint imports
 * FIRST, because static imports are hoisted: a call placed in the entrypoint
 * body would run after every one of its sibling imports, Prisma included.
 */
export function bootstrapRuntimeEnv(mode: "GENERIC" | "ACCOUNT"): RuntimeEnvBootstrapResult {
  if (bootstrapped !== null) {
    if (bootstrapped.mode === mode) return bootstrapped;
    throw new RuntimeEnvBootstrapError(
      "RUNTIME_ENV_MODE_CONFLICT",
      `the runtime environment was already bootstrapped as ${bootstrapped.mode} and ` +
        `cannot be re-declared as ${mode}. One process is one role.`
    );
  }
  return materialise(mode);
}

/**
 * The implicit path, for everything reaching `config/env` without having
 * declared a mode. Preserves the old behaviour exactly, and still refuses the
 * one case it can prove is a silent account switch.
 */
export function ensureRuntimeEnvBootstrapped(): RuntimeEnvBootstrapResult {
  return bootstrapped ?? materialise("INHERITED");
}

/** What an entrypoint prints on refusal: a code and variable names, no values. */
export function describeRuntimeEnvFailure(error: unknown): string {
  if (error instanceof RuntimeEnvBootstrapError) {
    return `runtime environment: ${error.reasonCode} - ${error.message}`;
  }
  return `runtime environment: refused to bootstrap (${
    error instanceof Error ? error.name : "unknown error"
  })`;
}

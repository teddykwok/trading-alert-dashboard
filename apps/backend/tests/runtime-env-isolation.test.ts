import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveTestDatabase } from "./helpers/test-database";

/**
 * Phase 11F.1 -- the process environment is what the selected file says, and
 * nothing else.
 *
 * ## What is actually being tested
 *
 * The generated Prisma client loads the repository `.env` at ITS module
 * initialization, and neither it nor dotenv overrides a key that is already
 * set. That produced two different failures, and both are exercised here
 * against the REAL generated client in REAL child processes:
 *
 *   - an account process launched with DOTENV_CONFIG_PATH silently ran as the
 *     repository's account
 *   - a generic process, whose env file deliberately omits the account keys,
 *     was handed them anyway, because omitted keys are exactly the ones the
 *     second loader is still free to fill
 *
 * ## Why these tests can skip, and why that is not a loophole
 *
 * `schemaEnvPath` is baked into the generated client at `prisma generate`
 * time, and only when the repository `.env` existed then. Where it was not
 * baked there is no second loader and therefore nothing to defend against, so
 * the scenario cannot be staged at all -- reporting a pass would be a lie and
 * reporting a failure would be noise.
 *
 * The suite also refuses to run when a repository `.env` already exists. These
 * tests must WRITE that file to stage the leak, and the one checkout where it
 * exists is the operator's live one. Skipping there is deliberate: no test is
 * worth overwriting a production environment file.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");
const FIXTURE = path.join(BACKEND, "tests", "fixtures", "runtime-env-probe.ts");
const REPOSITORY_ENV = path.join(BACKEND, ".env");
// The runner is invoked directly rather than through `npx`, which on Windows
// costs seconds per spawn and this suite spawns a dozen.
const TSX = path.join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs");

/** Synthetic throughout. No test here reads or writes a real account file. */
const REPOSITORY_ACCOUNT = "synthetic-repository-account";
const SELECTED_ACCOUNT = "synthetic-selected-account";

const REPOSITORY_ENV_BODY = [
  `EXECUTION_PROFILE_ACCOUNT_IDENTIFIER=${REPOSITORY_ACCOUNT}`,
  "EXECUTION_PROFILE_ENVIRONMENT=MAINNET",
  "BINANCE_API_KEY=synthetic-repository-key",
  "BINANCE_API_SECRET=synthetic-repository-secret",
  "DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_repository",
].join("\n");

const ACCOUNT_ENV_BODY = [
  `EXECUTION_PROFILE_ACCOUNT_IDENTIFIER=${SELECTED_ACCOUNT}`,
  "EXECUTION_PROFILE_ENVIRONMENT=MAINNET",
  "BINANCE_API_KEY=synthetic-selected-key",
  "BINANCE_API_SECRET=synthetic-selected-secret",
  "DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_selected",
].join("\n");

const GENERIC_ENV_BODY = [
  "DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_generic",
].join("\n");

const scratch = mkdtempSync(path.join(tmpdir(), "runtime-env-11f1-"));
const accountEnvFile = path.join(scratch, "account.env");
const genericEnvFile = path.join(scratch, "generic.env");
writeFileSync(accountEnvFile, ACCOUNT_ENV_BODY);
writeFileSync(genericEnvFile, GENERIC_ENV_BODY);

/**
 * The binding case is the only one that opens a connection, and it is pointed
 * at the TEST database. The synthetic identity matches no row there, which is
 * the point: the binder must refuse, and a refusal is what proves no exchange
 * client can exist before a profile does.
 */
let accountEnvOnTestDatabase: string | null = null;
try {
  accountEnvOnTestDatabase = path.join(scratch, "account-testdb.env");
  writeFileSync(
    accountEnvOnTestDatabase,
    `${ACCOUNT_ENV_BODY}\nDATABASE_URL=${resolveTestDatabase().url}\n`
  );
} catch {
  accountEnvOnTestDatabase = null;
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Does the generated client carry a baked env path -- i.e. a second loader? */
function generatedClientLoadsAnEnvFile(): boolean {
  try {
    const generated = path.join(
      path.dirname(require.resolve("@prisma/client")),
      "..",
      "..",
      ".prisma",
      "client",
      "index.js"
    );
    return readFileSync(generated, "utf8").includes('"schemaEnvPath"');
  } catch {
    return false;
  }
}

const stageable = !existsSync(REPOSITORY_ENV) && generatedClientLoadsAnEnvFile();
/** Each case boots a fresh TypeScript runtime; Windows needs the room. */
const PROBE_TIMEOUT_MS = 60_000;
const maybe = () => (stageable ? it : it.skip);

interface ProbeResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Stages the repository `.env`, runs the fixture, and always removes it again.
 */
function probe(
  args: readonly string[],
  env: Record<string, string | undefined>,
  repositoryBody: string = REPOSITORY_ENV_BODY
): ProbeResult {
  writeFileSync(REPOSITORY_ENV, repositoryBody);
  try {
    // A clean slate: the suite's own process carries whatever the developer's
    // shell and `tests/setup.ts` put there, and an inherited account variable
    // would silently change what every one of these cases means.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnv[key] = value;
    }
    for (const key of [
      "DOTENV_CONFIG_PATH",
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER",
      "EXECUTION_PROFILE_ENVIRONMENT",
    ]) {
      delete childEnv[key];
    }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }

    const run = spawnSync(process.execPath, [TSX, FIXTURE, ...args], {
      cwd: BACKEND,
      encoding: "utf8",
      env: childEnv,
    });
    return { status: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  } finally {
    rmSync(REPOSITORY_ENV, { force: true });
  }
}

function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8");
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The first specifier a module imports, comments stripped. */
function firstImportOf(relative: string): string {
  const source = withoutComments(codeOf(relative));
  const match = /(?:^|\n)\s*import\s+(?:[\s\S]*?from\s*)??["']([^"']+)["']/.exec(source);
  return match === null ? "<none>" : match[1];
}

// ---------------------------------------------------------------------------
// Behaviour, in real child processes, against the real generated client
// ---------------------------------------------------------------------------

describe("runtime environment isolation", () => {
  maybe()("1. an account file survives the generated client's own env load", () => {
    const result = probe(
      ["account", "bootstrap-first", BACKEND, "", SELECTED_ACCOUNT],
      { DOTENV_CONFIG_PATH: accountEnvFile }
    );
    expect(`${result.stderr}${result.stdout}`).toContain("BOOTSTRAP_COMPLETED");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("IDENTITY_MATCHES_EXPECTED true");
  }, PROBE_TIMEOUT_MS);

  maybe()("2. a generic process ends with no account credentials at all", () => {
    const result = probe(["generic", "bootstrap-first", BACKEND], {
      DOTENV_CONFIG_PATH: genericEnvFile,
    });
    expect(result.status).toBe(0);
    // Absent, not empty: `process.env` has to tell the truth to anything that
    // reads it directly, not only to the parsed config object.
    for (const key of [
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER",
    ]) {
      expect(`${key} ${result.stdout.includes(`${key} absent`)}`).toBe(`${key} true`);
    }
    // The generic file's own variables still arrive.
    expect(result.stdout).toContain("DATABASE_URL present");
  }, PROBE_TIMEOUT_MS);

  maybe()("3. an inherited identity that contradicts the account file refuses", () => {
    const result = probe(
      ["account", "bootstrap-first", BACKEND],
      { DOTENV_CONFIG_PATH: accountEnvFile, BINANCE_API_KEY: "synthetic-inherited-key" }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ACCOUNT_ENV_CONFLICT");
    // The NAME of the disagreeing variable, and no value of any kind.
    expect(result.stderr).toContain("BINANCE_API_KEY");
    expect(result.stderr).not.toContain("synthetic-inherited-key");
    // Nothing past the bootstrap ran.
    expect(result.stdout).not.toContain("BOOTSTRAP_COMPLETED");
  }, PROBE_TIMEOUT_MS);

  maybe()("4. an account process with no identity refuses rather than guessing", () => {
    const result = probe(
      ["account", "bootstrap-first", BACKEND],
      { DOTENV_CONFIG_PATH: undefined },
      "DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_repository"
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ACCOUNT_IDENTITY_NOT_CONFIGURED");
    expect(result.stdout).not.toContain("BOOTSTRAP_COMPLETED");
  }, PROBE_TIMEOUT_MS);

  maybe()("5. importing the client before the bootstrap is refused, not absorbed", () => {
    // The ordering guarantee itself. Without it the fix would rely on every
    // future entrypoint remembering to put one import before another.
    for (const mode of ["account", "generic"] as const) {
      const result = probe([mode, "prisma-first", BACKEND], {
        DOTENV_CONFIG_PATH: mode === "account" ? accountEnvFile : genericEnvFile,
      });
      expect(`${mode} status ${result.status}`).toBe(`${mode} status 1`);
      expect(result.stderr).toContain("PRISMA_LOADED_BEFORE_ENV_BOOTSTRAP");
    }
  }, PROBE_TIMEOUT_MS);

  const maybeBind = () => (stageable && accountEnvOnTestDatabase !== null ? it : it.skip);
  maybeBind()(
    "6. the read-only check's binding seam refuses an unknown profile, building nothing",
    () => {
      const result = probe(["bind", "bootstrap-first", BACKEND], {
        DOTENV_CONFIG_PATH: accountEnvOnTestDatabase ?? accountEnvFile,
      });
      // No exchange client is constructible before the profile is proven, so a
      // synthetic identity cannot reach Binance even in principle.
      expect(result.stdout).toContain("BIND_OK false");
      expect(result.stdout).toContain("BIND_REASON PROFILE_NOT_FOUND");
    },
    PROBE_TIMEOUT_MS
  );
});

// ---------------------------------------------------------------------------
// The migrated entrypoints, exercised through their OWN first import
// ---------------------------------------------------------------------------

describe("account and generic entrypoints", () => {
  const ACCOUNT_ENTRYPOINTS = [
    "src/account-control.server.ts",
    "src/modules/jobs/execution.worker.ts",
    "src/modules/binance/run-read-only-check.ts",
    "src/modules/execution/run-ensure-profile.ts",
  ];
  const GENERIC_ENTRYPOINTS = ["src/server.ts", "src/modules/jobs/vision-analysis.worker.ts"];

  for (const entrypoint of ACCOUNT_ENTRYPOINTS) {
    maybe()(`${entrypoint} cannot silently become the repository's account`, () => {
      // The fixture requires whatever THIS FILE imports first. Remove its
      // bootstrap import and this loads something else, and the repository
      // account walks back in.
      const result = probe(
        ["entrypoint", "bootstrap-first", BACKEND, path.join(BACKEND, entrypoint), SELECTED_ACCOUNT],
        { DOTENV_CONFIG_PATH: accountEnvFile }
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("IDENTITY_MATCHES_EXPECTED true");
    }, PROBE_TIMEOUT_MS);
  }

  for (const entrypoint of GENERIC_ENTRYPOINTS) {
    maybe()(`${entrypoint} cannot acquire the repository's credentials`, () => {
      const result = probe(
        ["entrypoint", "bootstrap-first", BACKEND, path.join(BACKEND, entrypoint)],
        { DOTENV_CONFIG_PATH: genericEnvFile }
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("BINANCE_API_KEY absent");
      expect(result.stdout).toContain("BINANCE_API_SECRET absent");
      expect(result.stdout).toContain("EXECUTION_PROFILE_ACCOUNT_IDENTIFIER absent");
    }, PROBE_TIMEOUT_MS);
  }

  it("declares its role in its very first import", () => {
    for (const entrypoint of ACCOUNT_ENTRYPOINTS) {
      expect(`${entrypoint} -> ${firstImportOf(entrypoint)}`).toBe(
        `${entrypoint} -> ${path
          .relative(path.dirname(path.join(BACKEND, entrypoint)), path.join(BACKEND, "src/config/bootstrap-account"))
          .split(path.sep)
          .join("/")
          .replace(/^(?!\.)/, "./")}`
      );
    }
    for (const entrypoint of GENERIC_ENTRYPOINTS) {
      expect(`${entrypoint} -> ${firstImportOf(entrypoint)}`).toBe(
        `${entrypoint} -> ${path
          .relative(path.dirname(path.join(BACKEND, entrypoint)), path.join(BACKEND, "src/config/bootstrap-generic"))
          .split(path.sep)
          .join("/")
          .replace(/^(?!\.)/, "./")}`
      );
    }
  });

  it("leaves exactly one place that materialises the environment", () => {
    // `dotenv/config` loads on import and cannot be sequenced, which is how
    // this defect existed at all. Nothing may import it again.
    //
    // Comments are stripped first. Both modules DISCUSS `dotenv/config` at
    // length, and an assertion that a file does not contain a string would be
    // satisfied by deleting the explanation rather than the import.
    const offenders = ["src/config/env.ts", "src/config/runtime-env.ts"].filter((file) =>
      /(?:^|\n)\s*import\s+["']dotenv\/config["']/.test(withoutComments(codeOf(file)))
    );
    expect(`modules importing dotenv/config: ${offenders.join(", ")}`).toBe(
      "modules importing dotenv/config: "
    );
    expect(codeOf("src/config/env.ts")).toContain("ensureRuntimeEnvBootstrapped()");
  });

  it("states the mode it bootstraps, so the two roles cannot be confused", () => {
    expect(codeOf("src/config/bootstrap-account.ts")).toContain('bootstrapRuntimeEnv("ACCOUNT")');
    expect(codeOf("src/config/bootstrap-generic.ts")).toContain('bootstrapRuntimeEnv("GENERIC")');
  });
});

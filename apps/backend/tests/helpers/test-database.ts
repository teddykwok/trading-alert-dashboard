import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

/**
 * The single place any test is allowed to obtain a database connection.
 *
 * Integration suites here delete rows, run startup recovery across the whole
 * table and drive lifecycle state machines. Pointed at the runtime database
 * that is a money-adjacent hazard: synthetic executions land in the canary
 * preflight's deliberately GLOBAL counts, and an orphaned fixture then blocks —
 * or worse, silently colours — a real activation decision.
 *
 * So this helper resolves `TEST_DATABASE_URL` and nothing else. It never falls
 * back to `DATABASE_URL`. Every failure is a hard throw during suite setup,
 * because a test that cannot prove which database it is on must not run at all.
 *
 * The runtime keeps using `DATABASE_URL` from `.env`; this file is the only
 * reader of `.env.test`, and no production module imports it.
 */

/** Name suffix a database must carry before destructive tests may touch it. */
const REQUIRED_TEST_SUFFIX = "_test";

/**
 * The runtime connection string as it was BEFORE the test process touched it.
 *
 * `tests/setup.ts` deliberately repoints `process.env.DATABASE_URL` at the test
 * database, and it imports this module to do so — which means this snapshot is
 * taken first, while the variable still holds whatever the operator's
 * environment provided. Reading `process.env.DATABASE_URL` later would compare
 * the test database against itself and misfire.
 */
const RUNTIME_URL_AT_IMPORT = process.env.DATABASE_URL?.trim() || null;

const BACKEND_ROOT = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

function readEnvFileValue(file: string, key: string): string | null {
  try {
    const pattern = new RegExp(`^${key}\\s*=\\s*"?([^"\\r\\n]+)"?\\s*$`, "m");
    const match = pattern.exec(readFileSync(path.join(BACKEND_ROOT, file), "utf8"));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** Host + port + database, with every credential dropped. */
function identity(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port}${parsed.pathname}`;
}

/** Database name only — safe to print. */
export function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

export interface TestDatabase {
  url: string;
  /** Sanitized: the database name, never host, user or password. */
  name: string;
}

/**
 * Resolves the test database, or throws.
 *
 * Deliberately NOT keyed on `NODE_ENV`. Vitest sets `NODE_ENV=test`
 * automatically, so it proves only that a test runner is present — it says
 * nothing about which database the connection string points at, which is the
 * fact that actually matters here. The distinction used instead is a separate
 * configuration variable that only tests read.
 */
export function resolveTestDatabase(): TestDatabase {
  const configured = process.env.TEST_DATABASE_URL?.trim() || readEnvFileValue(".env.test", "TEST_DATABASE_URL");

  if (!configured) {
    throw new Error(
      "TEST_DATABASE_URL is not configured. Integration tests refuse to run without a dedicated test database " +
        "and will NOT fall back to DATABASE_URL. Copy apps/backend/.env.test.example to apps/backend/.env.test, " +
        "or run: pnpm --filter @trading-alert-dashboard/backend test:db:setup"
    );
  }

  // `.env` is the authoritative runtime configuration; the import-time snapshot
  // covers environments that pass DATABASE_URL in without a file.
  const runtime = readEnvFileValue(".env", "DATABASE_URL") ?? RUNTIME_URL_AT_IMPORT;

  // The identity check: same server AND same database is the exact accident
  // this guard exists to prevent, whatever the two strings look like.
  if (runtime && identity(runtime) === identity(configured)) {
    throw new Error(
      `TEST_DATABASE_URL points at the runtime database ("${databaseNameOf(configured)}"). ` +
        "Destructive integration tests must never run against the runtime/canary database."
    );
  }

  const name = databaseNameOf(configured);
  if (!name.endsWith(REQUIRED_TEST_SUFFIX)) {
    throw new Error(
      `TEST_DATABASE_URL database "${name}" does not end in "${REQUIRED_TEST_SUFFIX}". ` +
        "Refusing to run destructive tests against a database that is not explicitly marked as a test database."
    );
  }

  return { url: configured, name };
}

/**
 * A client bound to the test database, plus whether it is reachable.
 *
 * Reachability is the ONLY condition a suite may skip on. A missing or unsafe
 * configuration throws instead, so "the guard was misconfigured" can never look
 * like "there was nothing to test".
 */
export async function connectTestDatabase(): Promise<{ prisma: PrismaClient; available: boolean; name: string }> {
  const { url, name } = resolveTestDatabase();

  // Imported lazily and deliberately. `@prisma/client` loads `.env` on import,
  // which would populate the whole runtime environment — WEBHOOK_SECRET and the
  // rest — before `tests/setup.ts` has installed its test defaults. Keeping the
  // import inside this function means the module graph `setup.ts` pulls in at
  // load time stays free of it.
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    // Prove the connection landed where the configuration said it would.
    const [row] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("select current_database() as db");
    if (row?.db !== name) {
      throw new Error(`Connected to database "${row?.db}" but expected "${name}".`);
    }
    return { prisma, available: true, name };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Connected to database")) throw error;
    console.warn(`[tests] Skipping — test database "${name}" is not reachable.`);
    return { prisma, available: false, name };
  }
}

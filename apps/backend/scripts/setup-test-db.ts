import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Provisions the dedicated integration-test database.
 *
 *   pnpm --filter @trading-alert-dashboard/backend test:db:setup
 *
 * Creates `<runtime database>_test` beside the runtime database, writes
 * `apps/backend/.env.test` if it does not exist, and applies the migrations.
 *
 * It reads the runtime `DATABASE_URL` only to borrow the SERVER coordinates —
 * it never writes to `.env`, never touches the runtime database, and prints no
 * credential or connection string. The runtime and the worker keep using
 * `DATABASE_URL`; only `tests/helpers/test-database.ts` reads what this writes.
 */

const BACKEND_ROOT = process.cwd();
const REQUIRED_TEST_SUFFIX = "_test";

function runtimeDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const match = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m.exec(readFileSync(path.join(BACKEND_ROOT, ".env"), "utf8"));
  if (!match) throw new Error("DATABASE_URL is not configured, so there is no server to create the test database on.");
  return match[1].trim();
}

async function main(): Promise<void> {
  const runtimeUrl = runtimeDatabaseUrl();
  const runtimeName = new URL(runtimeUrl).pathname.replace(/^\//, "");

  if (!runtimeName) throw new Error("DATABASE_URL names no database.");
  if (runtimeName.endsWith(REQUIRED_TEST_SUFFIX)) {
    throw new Error(`DATABASE_URL already points at "${runtimeName}", which looks like a test database. Refusing.`);
  }

  const testName = `${runtimeName}${REQUIRED_TEST_SUFFIX}`;
  const testUrl = new URL(runtimeUrl);
  testUrl.pathname = `/${testName}`;
  const adminUrl = new URL(runtimeUrl);
  adminUrl.pathname = "/postgres";

  console.log("Test database setup — the runtime database is never modified.");
  console.log(`  runtimeDatabaseName   ${runtimeName}`);
  console.log(`  testDatabaseName      ${testName}`);

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    const existing = await admin.$queryRawUnsafe<Array<{ ok: number }>>(
      `select 1 as ok from pg_database where datname = '${testName}'`
    );
    if (existing.length === 0) {
      // Identifier is derived from the runtime name plus a fixed suffix.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${testName}"`);
      console.log("  created               yes");
    } else {
      console.log("  created               already present");
    }
  } finally {
    await admin.$disconnect();
  }

  const envTestPath = path.join(BACKEND_ROOT, ".env.test");
  if (existsSync(envTestPath)) {
    console.log("  .env.test             already present (left untouched)");
  } else {
    writeFileSync(
      envTestPath,
      [
        "# Test-only database. Read ONLY by tests/helpers/test-database.ts.",
        "# The backend runtime, worker and operator CLIs use DATABASE_URL from .env.",
        "# Gitignored: local development credentials only.",
        `TEST_DATABASE_URL=${testUrl.toString()}`,
        "",
      ].join("\n"),
      "utf8"
    );
    console.log("  .env.test             written");
  }

  // Migrations run against the TEST url passed through the environment of the
  // child process only; this process's own DATABASE_URL is left alone.
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: "inherit",
    shell: true,
  });

  console.log("Test database is ready. No credential was printed and .env was not modified.");
}

main().catch((error) => {
  console.error(`Test database setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

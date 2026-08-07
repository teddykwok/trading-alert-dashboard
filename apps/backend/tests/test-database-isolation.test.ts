import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databaseNameOf, resolveTestDatabase } from "./helpers/test-database";

/**
 * The guard that keeps destructive integration tests off the runtime/canary
 * database.
 *
 * These are the assertions that matter before real money: every one of them
 * describes a way the suite could have silently written synthetic executions
 * into the database the canary preflight counts, and proves it now fails
 * instead.
 */

const BACKEND = process.cwd();
const RUNTIME = process.env.DATABASE_URL;
const TEST_URL = process.env.TEST_DATABASE_URL;

afterEach(() => {
  if (RUNTIME === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = RUNTIME;
  if (TEST_URL === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = TEST_URL;
});

describe("test database resolution", () => {
  it("resolves a database that is explicitly marked as a test database", () => {
    const resolved = resolveTestDatabase();
    expect(resolved.name.endsWith("_test")).toBe(true);
    // Sanitized comparison only — no host, user or password is ever read here.
    expect(resolved.name).not.toBe(databaseNameOf(readRuntimeUrl()));
  });

  it("refuses to run when no test database is configured anywhere", () => {
    process.env.TEST_DATABASE_URL = "";
    const envTest = path.join(BACKEND, ".env.test");
    const saved = readFileSync(envTest, "utf8");
    try {
      // Both sources gone: the only correct outcome is a hard failure. Falling
      // back to DATABASE_URL here is precisely the accident being prevented.
      rmSync(envTest);
      expect(() => resolveTestDatabase()).toThrow(/TEST_DATABASE_URL is not configured/);
    } finally {
      writeFileSync(envTest, saved, "utf8");
    }
  });

  it("refuses a test URL that points at the runtime database", () => {
    const runtime = readRuntimeUrl();
    process.env.TEST_DATABASE_URL = runtime;
    process.env.DATABASE_URL = runtime;
    expect(() => resolveTestDatabase()).toThrow(/points at the runtime database/);
  });

  it("refuses a database whose name is not marked as a test database", () => {
    const candidate = new URL(readRuntimeUrl());
    candidate.pathname = "/some_other_database";
    process.env.TEST_DATABASE_URL = candidate.toString();
    expect(() => resolveTestDatabase()).toThrow(/does not end in "_test"/);
  });

  it("never falls back to DATABASE_URL", () => {
    const helper = readFileSync(path.join(BACKEND, "tests", "helpers", "test-database.ts"), "utf8");
    const code = helper.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // DATABASE_URL appears only inside the equality guard, never as a source of
    // the connection actually returned.
    expect(code).not.toMatch(/configured\s*(\?\?|\|\|)\s*runtime/);
    expect(code).not.toMatch(/url:\s*runtime/);
    expect(code).toContain("identity(runtime) === identity(configured)");
  });

  it("does not rely on NODE_ENV to decide which database is safe", () => {
    const helper = readFileSync(path.join(BACKEND, "tests", "helpers", "test-database.ts"), "utf8");
    const code = helper.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // NODE_ENV proves a test runner is present, not which database is attached.
    expect(code).not.toContain("NODE_ENV");
  });

  it("pins DATABASE_URL for the whole test process, so production code cannot reach the runtime database", () => {
    // tests/setup.ts has already run. Anything constructing `new PrismaClient()`
    // with no datasource override — every operator CLI does — lands here.
    expect(databaseNameOf(process.env.DATABASE_URL ?? "")).toBe(resolveTestDatabase().name);
  });

  it("leaks no credential through its sanitized accessors", () => {
    const url = resolveTestDatabase().url;
    const parsed = new URL(url);
    const name = databaseNameOf(url);
    expect(name).not.toContain(parsed.password);
    expect(name).not.toContain(parsed.username);
    expect(name).not.toContain(parsed.hostname);
  });
});

function readRuntimeUrl(): string {
  const match = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m.exec(readFileSync(path.join(BACKEND, ".env"), "utf8"));
  if (!match) throw new Error("No runtime DATABASE_URL to compare against.");
  return match[1].trim();
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The breaker SCHEMA and MIGRATION, guarded as source.
 *
 * The integration suite proves what the live test database does. This proves
 * what ships — the migration text a production deploy will actually run, and
 * the model a future `prisma migrate dev` will generate from. The two drift
 * apart silently, and the thing that drifts here decides whether a systemic
 * fault can be bypassed.
 *
 * Needs no database, so it runs everywhere.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const MIGRATION_DIR = "prisma/migrations/20260918120000_add_historical_fill_circuit_breaker";
const MIGRATION = readFileSync(path.join(BACKEND, MIGRATION_DIR, "migration.sql"), "utf8");
const SCHEMA = readFileSync(path.join(BACKEND, "prisma/schema.prisma"), "utf8");

/** Source with comments removed: the prose here names the very things it forbids. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)(\/\/\/|\/\/|--).*$/, "$1"))
    .join("\n");
}

const MIGRATION_SQL = codeOf(MIGRATION);

describe("the breaker migration is additive", () => {
  it("drops, truncates, deletes and rewrites nothing", () => {
    expect(MIGRATION_SQL).not.toMatch(/\bDROP\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bUPDATE\s+"/i);
    expect(MIGRATION_SQL).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(MIGRATION_SQL).not.toMatch(/ALTER COLUMN/i);
  });

  it("touches only the new table", () => {
    const altered = [...MIGRATION_SQL.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["HistoricalFillCircuitBreaker"]));
    const created = [...MIGRATION_SQL.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(created).toEqual(["HistoricalFillCircuitBreaker"]);
  });

  it("creates the two-state enum", () => {
    const type = /CREATE TYPE "HistoricalFillCircuitState" AS ENUM \(([\s\S]*?)\);/.exec(
      MIGRATION_SQL
    );
    expect(type).not.toBeNull();
    expect([...type![1].matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual(["CLOSED", "OPEN"]);
  });

  it("keys the breaker on the PROFILE, never a campaign", () => {
    // The whole correction: campaign-scoped state could be bypassed by a
    // replacement campaign and could not record a trip against a paused one.
    expect(MIGRATION_SQL).toMatch(/PRIMARY KEY \("executionProfileId"\)/);
    expect(MIGRATION_SQL).not.toMatch(/campaignId/);
  });

  it("restricts the profile foreign key", () => {
    expect(MIGRATION_SQL).toMatch(
      /"HistoricalFillCircuitBreaker_executionProfileId_fkey"[\s\S]*?REFERENCES "ExecutionProfile"\("id"\) ON DELETE RESTRICT/
    );
  });

  it("gives state no column default", () => {
    const table = /CREATE TABLE "HistoricalFillCircuitBreaker"[\s\S]*?\n\);/.exec(MIGRATION_SQL)![0];
    expect(table).toMatch(/"state" "HistoricalFillCircuitState" NOT NULL,/);
    expect(table).not.toMatch(/"state"[^,]*DEFAULT/);
  });

  it("constrains the counter and the open/openedAt agreement", () => {
    expect(MIGRATION_SQL).toMatch(/CHECK \("consecutiveCount" >= 0\)/);
    expect(MIGRATION_SQL).toMatch(
      /CHECK \(\("state" = 'OPEN'\) = \("openedAt" IS NOT NULL\)\)/
    );
  });

  it("adds no index beyond the primary key", () => {
    expect(MIGRATION_SQL).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
  });

  it("stores no message, payload or history", () => {
    // Current state only. The permanent record of a trip is the log event.
    for (const forbidden of ["message", "sanitized", "payload", "body", "history", "audit"]) {
      expect(MIGRATION_SQL.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("the Prisma schema agrees with the migration", () => {
  const model = codeOf(/model HistoricalFillCircuitBreaker \{[\s\S]*?\n\}/.exec(SCHEMA)![0]);

  it("gives state no @default", () => {
    expect(model).toMatch(/state HistoricalFillCircuitState\s*$/m);
    expect(model).not.toMatch(/state HistoricalFillCircuitState.*@default/);
  });

  it("makes the profile the id and restricts the relation", () => {
    expect(model).toMatch(/executionProfileId String\s+@id/);
    expect(model).toMatch(/@relation\([^)]*onDelete: Restrict/);
  });

  it("defaults only the counter, and to zero", () => {
    expect(model).toMatch(/consecutiveCount Int @default\(0\)/);
  });

  it("declares every timestamp nullable", () => {
    // Whitespace-normalised rather than a regex: in a template literal a lone
    // backslash escape collapses, which silently weakens the pattern.
    const flat = model.replace(/[ 	]+/g, " ");
    for (const field of ["firstFailureAt", "lastFailureAt", "openedAt"]) {
      expect(flat).toContain(`${field} DateTime?`);
    }
  });

  it("declares the enum with exactly two states", () => {
    const body = /enum HistoricalFillCircuitState \{([\s\S]*?)\}/.exec(SCHEMA)![1];
    expect(
      codeOf(body)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    ).toEqual(["CLOSED", "OPEN"]);
  });

  it("gives ExecutionProfile the inverse relation", () => {
    const profile = /model ExecutionProfile \{[\s\S]*?\n\}/.exec(SCHEMA)![0];
    expect(profile).toMatch(/HistoricalFillCircuitBreaker\?/);
  });

  it("leaves the campaign model untouched by this slice", () => {
    const campaign = codeOf(/model HistoricalFillCampaign \{[\s\S]*?\n\}/.exec(SCHEMA)![0]);
    for (const forbidden of ["pauseReason", "systemicFailure", "circuit"]) {
      expect(campaign).not.toContain(forbidden);
    }
  });
});

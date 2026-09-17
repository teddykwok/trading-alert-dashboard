import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The campaign SCHEMA and MIGRATION, guarded as source.
 *
 * The integration suite proves what the live test database does. This proves
 * what ships — the migration text a production deploy will actually run, and
 * the model declaration a future `prisma migrate dev` will generate from. The
 * two can drift apart silently: an edit to `schema.prisma` that nobody
 * migrates, or a migration nobody reflects in the schema, both leave a test
 * database that agrees with itself and a production database that does not.
 *
 * Needs no database, so it runs everywhere.
 */

const BACKEND_ROOT = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const MIGRATION = readFileSync(
  path.join(BACKEND_ROOT, "prisma/migrations/20260917130000_add_historical_fill_campaign/migration.sql"),
  "utf8"
);
const SCHEMA = readFileSync(path.join(BACKEND_ROOT, "prisma/schema.prisma"), "utf8");
const SERVICE = readFileSync(
  path.join(BACKEND_ROOT, "src/modules/execution/historical-fill-campaign.service.ts"),
  "utf8"
);

/**
 * Source with comments removed.
 *
 * These assertions are about CODE, and the prose around this feature naturally
 * mentions the very words being searched for. Without this, a comment
 * explaining why something is absent would be enough to make the test believe
 * it is present.
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)(\/\/|--|\/\/\/).*$/, "$1"))
    .join("\n");
}

const MIGRATION_SQL = codeOf(MIGRATION);
const SERVICE_CODE = codeOf(SERVICE);

describe("the campaign migration is additive", () => {
  it("drops and truncates nothing", () => {
    expect(MIGRATION_SQL).not.toMatch(/\bDROP\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("rewrites no existing row", () => {
    // A backfill would be the one way this migration could change the meaning
    // of data written before campaigns existed.
    expect(MIGRATION_SQL).not.toMatch(/\bUPDATE\s+"/i);
    expect(MIGRATION_SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("adds campaignId nullable, with no default and no NOT NULL", () => {
    // NOT NULL here would fail outright on any table that already has rows, and
    // a default would invent a campaign for weight spent before campaigns
    // existed.
    const addColumn = /ADD COLUMN "campaignId" TEXT\s*;/.exec(MIGRATION_SQL);
    expect(addColumn).not.toBeNull();
    expect(MIGRATION_SQL).not.toMatch(/"campaignId"[^;]*NOT NULL/i);
    expect(MIGRATION_SQL).not.toMatch(/"campaignId"[^;]*DEFAULT/i);
  });

  it("alters no other existing column", () => {
    const alteredTables = [...MIGRATION_SQL.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(new Set(alteredTables)).toEqual(
      new Set(["HistoricalFillCampaign", "HistoricalFillWeightReservation"])
    );
    expect(MIGRATION_SQL).not.toMatch(/ALTER COLUMN/i);
  });
});

describe("the bounds that ship are in the migration", () => {
  it("writes the ceiling as a CHECK of 1..100", () => {
    expect(MIGRATION_SQL).toMatch(
      /CHECK \("maxDispatches" >= 1 AND "maxDispatches" <= 100\)/
    );
  });

  it("writes the counter CHECK against its own ceiling", () => {
    // `<= maxDispatches`, not a literal: the counter's bound is whatever the
    // campaign was authorised for, per row.
    expect(MIGRATION_SQL).toMatch(
      /CHECK \("dispatchesUsed" >= 0 AND "dispatchesUsed" <= "maxDispatches"\)/
    );
  });

  it("writes live-campaign uniqueness as a PARTIAL unique index", () => {
    const index = /CREATE UNIQUE INDEX "HistoricalFillCampaign_one_live_per_profile"[\s\S]*?;/.exec(
      MIGRATION_SQL
    );
    expect(index).not.toBeNull();
    const [sql] = index!;
    expect(sql).toMatch(/ON "HistoricalFillCampaign"\("executionProfileId"\)/);
    expect(sql).toMatch(/WHERE "status" IN \('ACTIVE', 'PAUSED'\)/);
  });

  it("creates no TOTAL unique index on the profile", () => {
    // A unique index on "executionProfileId" without a WHERE clause would let a
    // profile run exactly one backfill EVER, since finished campaigns stay in
    // the table as history. Every unique index here must be partial.
    const uniqueIndexes = [
      ...MIGRATION_SQL.matchAll(/CREATE UNIQUE INDEX[\s\S]*?ON "HistoricalFillCampaign"[\s\S]*?;/g),
    ].map((m) => m[0]);
    expect(uniqueIndexes.length).toBeGreaterThan(0);
    for (const index of uniqueIndexes) {
      expect(index).toMatch(/"executionProfileId"/);
      expect(index).toContain("WHERE");
    }
  });

  it("gives status no column default", () => {
    const table = /CREATE TABLE "HistoricalFillCampaign"[\s\S]*?\n\);/.exec(MIGRATION_SQL)![0];
    expect(table).toMatch(/"status" "HistoricalFillCampaignStatus" NOT NULL,/);
    expect(table).not.toMatch(/"status"[^,]*DEFAULT/);
    expect(table).not.toMatch(/"maxDispatches"[^,]*DEFAULT/);
  });

  it("restricts both new foreign keys", () => {
    // Nothing may delete a profile out from under its campaigns, nor a campaign
    // out from under the reservations that are its audit trail.
    expect(MIGRATION_SQL).toMatch(
      /"HistoricalFillCampaign_executionProfileId_fkey"[\s\S]*?ON DELETE RESTRICT/
    );
    expect(MIGRATION_SQL).toMatch(
      /"HistoricalFillWeightReservation_campaignId_fkey"[\s\S]*?ON DELETE RESTRICT/
    );
  });

  it("declares the five campaign states in order", () => {
    const type = /CREATE TYPE "HistoricalFillCampaignStatus" AS ENUM \(([\s\S]*?)\);/.exec(
      MIGRATION_SQL
    )![1];
    const labels = [...type.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(labels).toEqual(["ACTIVE", "PAUSED", "EXHAUSTED", "COMPLETED", "ABORTED"]);
  });
});

describe("the Prisma schema agrees with the migration", () => {
  const model = /model HistoricalFillCampaign \{[\s\S]*?\n\}/.exec(SCHEMA)![0];
  const modelCode = codeOf(model);
  const reservation = codeOf(/model HistoricalFillWeightReservation \{[\s\S]*?\n\}/.exec(SCHEMA)![0]);

  it("gives status no @default", () => {
    // The single most consequential line in the model. A default would let a
    // campaign exist because a field was omitted.
    expect(modelCode).toMatch(/status\s+HistoricalFillCampaignStatus\s*$/m);
    expect(modelCode).not.toMatch(/status\s+HistoricalFillCampaignStatus.*@default/);
  });

  it("gives maxDispatches no @default and keeps the counter at zero", () => {
    expect(modelCode).not.toMatch(/maxDispatches\s+Int\s+@default/);
    expect(modelCode).toMatch(/dispatchesUsed\s+Int\s+@default\(0\)/);
  });

  it("declares the profile relation with Restrict", () => {
    expect(modelCode).toMatch(/executionProfile\s+ExecutionProfile\s+@relation\([^)]*onDelete: Restrict/);
  });

  it("keeps campaignId optional on the reservation", () => {
    expect(reservation).toMatch(/campaignId\s+String\?/);
    expect(reservation).toMatch(
      /campaign\s+HistoricalFillCampaign\?\s+@relation\([^)]*onDelete: Restrict/
    );
  });

  it("declares the enum with the same five states", () => {
    const body = /enum HistoricalFillCampaignStatus \{([\s\S]*?)\}/.exec(SCHEMA)![1];
    expect(
      codeOf(body)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    ).toEqual(["ACTIVE", "PAUSED", "EXHAUSTED", "COMPLETED", "ABORTED"]);
  });
});

describe("the service cannot rewrite what it must not", () => {
  it("never writes maxDispatches outside creation", () => {
    // The ceiling is frozen at creation: raising it later would retroactively
    // change what an operator authorised. `create` is the only writer.
    const writes = [...SERVICE_CODE.matchAll(/maxDispatches/g)];
    expect(writes.length).toBeGreaterThan(0);
    for (const block of SERVICE_CODE.split(/\bupdateMany\(|\bupdate\(/).slice(1)) {
      expect(block.slice(0, 400)).not.toContain("maxDispatches");
    }
  });

  it("never writes dispatchesUsed at all", () => {
    // The counter belongs to admission, which this slice deliberately does not
    // contain. A lifecycle method that could move it would be a second, unlocked
    // way to spend slots.
    expect(SERVICE_CODE).not.toContain("dispatchesUsed");
  });

  it("takes the campaign lock on every mutating path", () => {
    const mutators = ["createCampaign", "private async transition"];
    for (const mutator of mutators) expect(SERVICE_CODE).toContain(mutator);
    // Two lock sites: one in create, one in the shared transition.
    expect([...SERVICE_CODE.matchAll(/lockCampaignForProfile\(tx,/g)]).toHaveLength(2);
  });

  it("uses a transaction-scoped lock, never a session lock", () => {
    const lock = codeOf(
      readFileSync(
        path.join(BACKEND_ROOT, "src/modules/execution/historical-fill-campaign-lock.ts"),
        "utf8"
      )
    );
    // A session lock on a pooled connection outlives the work it was taken for.
    expect(lock).toContain("pg_advisory_xact_lock");
    expect(lock).not.toContain("pg_advisory_lock(");
    expect(lock).not.toContain("pg_advisory_unlock");
    expect(lock).toContain("0xf111");
  });

  it("imports no exchange client", () => {
    expect(SERVICE_CODE).not.toMatch(/from "\.\.\/binance/);
    expect(SERVICE_CODE).not.toMatch(/binance/i);
  });
});

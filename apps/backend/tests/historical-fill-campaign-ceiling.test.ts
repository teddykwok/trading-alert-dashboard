import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  HistoricalFillCampaignService,
  HistoricalFillCampaignValidationError,
  MAX_CAMPAIGN_DISPATCHES,
} from "../src/modules/execution/historical-fill-campaign.service";

/**
 * The campaign ceiling, proven WITHOUT a database.
 *
 * Deliberately not an integration suite. The ceiling is the one bound that
 * decides how much of a real account's exchange allowance a backfill may spend,
 * so it must be proven in every environment — including one with no test
 * database, where an integration suite would skip and leave exactly this
 * unproven.
 *
 * The service is handed a Prisma stand-in that throws on ANY property access.
 * That turns "the value is rejected" into the stronger claim the design
 * actually makes: it is rejected BEFORE a connection, a transaction or a lock
 * is taken, so a malformed ceiling never reaches SQL at all.
 */

/** Any touch at all is a failure, so the assertion is "no database was used". */
const untouchableDatabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database was touched (.${String(property)}) before validation rejected the input`);
    },
  }
) as unknown as PrismaClient;

const service = new HistoricalFillCampaignService(untouchableDatabase);

function create(maxDispatches: number) {
  return service.createCampaign({ executionProfileId: "profile-never-read", maxDispatches });
}

describe("historical fill campaign dispatch ceiling", () => {
  it("publishes 100 as the ceiling", () => {
    expect(MAX_CAMPAIGN_DISPATCHES).toBe(100);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["one over the ceiling", 101],
    ["far over the ceiling", 1_000],
  ])("rejects %s without touching the database", async (_label, value) => {
    await expect(create(value)).rejects.toBeInstanceOf(HistoricalFillCampaignValidationError);
  });

  it.each([
    ["fractional", 2.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["beyond safe integers", Number.MAX_SAFE_INTEGER + 2],
  ])("rejects %s without touching the database", async (_label, value) => {
    await expect(create(value)).rejects.toBeInstanceOf(HistoricalFillCampaignValidationError);
  });

  it("names the offending value and the ceiling in the refusal", async () => {
    await expect(create(101)).rejects.toThrow(/between 1 and 100, received 101/);
  });

  it("calls a fractional value a whole-number problem, not a range problem", async () => {
    // 2.5 is inside 1..100, so a range-only check would accept it and Postgres
    // would round it. The message proves which check actually fired.
    await expect(create(2.5)).rejects.toThrow(/whole number/);
  });

  it.each([
    ["the lower bound", 1],
    ["the upper bound", MAX_CAMPAIGN_DISPATCHES],
    ["a mid-range value", 50],
  ])("accepts %s and proceeds to the database", async (_label, value) => {
    // Reaching the stand-in is the pass condition: validation let it through,
    // which is what distinguishes an accepted bound from a rejected one.
    await expect(create(value)).rejects.toThrow(/database was touched/);
  });
});

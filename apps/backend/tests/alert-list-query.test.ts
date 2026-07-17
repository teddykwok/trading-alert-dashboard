import { describe, expect, it } from "vitest";
import { listQuerySchema } from "../src/routes/alerts.routes";
import { env } from "../src/config/env";

/**
 * Query-schema behavior for the paged alert list. Limits are asserted against
 * the live env values (DASHBOARD_DEFAULT_LIMIT / DASHBOARD_MAX_LIMIT) so the
 * tests stay correct whatever the local .env configures.
 */
describe("listQuerySchema", () => {
  it("defaults limit to the env-driven page size and offset to 0", () => {
    const parsed = listQuerySchema.parse({});
    expect(parsed.limit).toBe(env.DASHBOARD_DEFAULT_LIMIT);
    expect(parsed.offset).toBe(0);
  });

  it("accepts limits up to the env-driven max and rejects anything above", () => {
    expect(listQuerySchema.parse({ limit: String(env.DASHBOARD_MAX_LIMIT) }).limit).toBe(
      env.DASHBOARD_MAX_LIMIT
    );
    expect(listQuerySchema.safeParse({ limit: String(env.DASHBOARD_MAX_LIMIT + 1) }).success).toBe(false);
  });

  it("parses comma-separated signals with whitespace tolerance", () => {
    expect(listQuerySchema.parse({ signals: "LONG,SHORT" }).signals).toEqual(["LONG", "SHORT"]);
    expect(listQuerySchema.parse({ signals: " LONG , SHORT " }).signals).toEqual(["LONG", "SHORT"]);
    expect(listQuerySchema.parse({ signals: "WATCH" }).signals).toEqual(["WATCH"]);
    expect(listQuerySchema.parse({}).signals).toBeUndefined();
  });

  it("rejects unknown signal values and negative offsets", () => {
    expect(listQuerySchema.safeParse({ signals: "LONG,BOGUS" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });

  it("accepts the full server-side filter set the dashboard sends", () => {
    const parsed = listQuerySchema.parse({
      status: "ANALYZED",
      symbol: "btc",
      signals: "LONG,SHORT",
      assetType: "CRYPTO",
      sourceTimeframe: "1D",
      levelColor: "RED",
      offset: "100",
    });
    expect(parsed).toMatchObject({
      status: "ANALYZED",
      symbol: "btc",
      signals: ["LONG", "SHORT"],
      assetType: "CRYPTO",
      sourceTimeframe: "1D",
      levelColor: "RED",
      offset: 100,
    });
  });
});

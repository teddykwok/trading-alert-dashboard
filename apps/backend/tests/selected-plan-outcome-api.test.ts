import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

/**
 * The API contract for persisted pre-execution evidence.
 *
 * Carried on the Extreme RR plan rather than through a new endpoint: Alert
 * Detail ALREADY fetches the plan for exactly this question
 * (`extremeRRApi.getForAlert`), so the smallest possible change is one extra
 * field on a payload the page loads anyway — no new route, no second request.
 *
 * It stays a structured domain object, never a formatted sentence. Wording
 * belongs to the frontend's shared reason vocabulary; an API that shipped
 * prose would fork that vocabulary in two.
 */

const SYNTHETIC_TAG = "selected-plan-api-synthetic";
const SYMBOL = "TESTAPIUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { recordSelectedPlanOutcome } = await import(
  "../src/modules/execution/selected-plan-outcome.service"
);

const maybe = () => (available ? it : it.skip);
let sequence = 0;

async function seed(status: "READY" | "INVALID" = "READY") {
  sequence += 1;
  const asset = await prisma!.asset.upsert({
    where: { symbol_assetType: { symbol: SYMBOL, assetType: "CRYPTO" } },
    update: {},
    create: { symbol: SYMBOL, assetType: "CRYPTO", exchange: "SYNTHETIC" },
  });
  const alert = await prisma!.alert.create({
    data: {
      assetId: asset.id,
      symbol: SYMBOL,
      assetType: "CRYPTO",
      exchange: "SYNTHETIC",
      timeframe: "15m",
      price: 100,
      signal: "LONG",
      indicatorName: `${SYNTHETIC_TAG}-${sequence}`,
      rawPayload: { note: SYNTHETIC_TAG },
      triggeredAt: new Date(),
    },
  });
  const plan = await prisma!.extremeRRPlan.create({
    data: {
      alertId: alert.id,
      status,
      direction: "LONG",
      entryPrice: "100",
      cutoffAt: new Date(),
      timeframe: "15m",
      selectedLookback: 300,
    },
  });
  return { alertId: alert.id, planId: plan.id };
}

const service = () => new ExtremeRRService(prisma!);

afterEach(async () => {
  if (!prisma || !available) return;
  await prisma.selectedPlanOutcome.deleteMany({
    where: { alert: { indicatorName: { startsWith: SYNTHETIC_TAG } } },
  });
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await prisma.selectedPlanOutcome.deleteMany({
      where: { alert: { indicatorName: { startsWith: SYNTHETIC_TAG } } },
    });
    await prisma.extremeRRPlan.deleteMany({
      where: { alert: { indicatorName: { startsWith: SYNTHETIC_TAG } } },
    });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: SYNTHETIC_TAG } } });
    await prisma.asset.deleteMany({ where: { symbol: SYMBOL, exchange: "SYNTHETIC" } });
  }
  await prisma.$disconnect();
});

// ===========================================================================

describe("A/D. the plan payload exposes the recorded verdict", () => {
  maybe()("returns the structured outcome when one was recorded", async () => {
    const { alertId, planId } = await seed();
    const evaluatedAt = new Date("2026-08-28T12:00:00.000Z");
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: {
        handled: false,
        reasonCode: "CANARY_AUTHORIZATION_REQUIRED",
        message: "nothing authorizes this signal",
      } as never,
      evaluatedAt,
    });

    const dto = await service().getForAlert(alertId);

    expect(dto!.executionOutcome).toEqual({
      handled: false,
      reasonCode: "CANARY_AUTHORIZATION_REQUIRED",
      message: "nothing authorizes this signal",
      executionId: null,
      evaluatedAt: evaluatedAt.toISOString(),
    });
  });

  maybe()("a handled outcome names its execution and carries no prose", async () => {
    const { alertId, planId } = await seed();
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: { handled: true, executionId: "exec-9", created: true, admitted: true, reasonCode: "ENTRY_SUBMITTED" },
      evaluatedAt: new Date(),
    });

    const dto = await service().getForAlert(alertId);
    expect(dto!.executionOutcome!.handled).toBe(true);
    expect(dto!.executionOutcome!.executionId).toBe("exec-9");
    expect(dto!.executionOutcome!.message).toBeNull();
  });
});

describe("B/E. the contract stays backward compatible and honest", () => {
  maybe()("an alert with no recorded verdict reports null, not a guess", async () => {
    const { alertId } = await seed();
    const dto = await service().getForAlert(alertId);
    expect(dto!.executionOutcome).toBeNull();
  });

  maybe()("every pre-existing field is untouched", async () => {
    const { alertId } = await seed();
    const dto = await service().getForAlert(alertId);

    // Additive only: the field is added, nothing is renamed or removed.
    for (const key of [
      "id",
      "alertId",
      "status",
      "direction",
      "entryBasis",
      "entryPrice",
      "cutoffAt",
      "timeframe",
      "template",
      "candidates",
      "selectedLookback",
      "selectedLeverage",
      "precision",
      "leverageLimitVerified",
      "errorReason",
      "generatedAt",
      "createdAt",
      "updatedAt",
    ]) {
      expect(Object.keys(dto!), key).toContain(key);
    }
    expect(Object.keys(dto!)).toContain("executionOutcome");
  });

  maybe()("the field is present on every path that serializes a plan", async () => {
    // A DTO that carried the verdict on one route and omitted it on another
    // would make its absence meaningless.
    const { alertId } = await seed();
    const fromRead = await service().getForAlert(alertId);
    const fromUpdate = await service().updateSelection(alertId, { selectedLookback: 200 });

    expect(fromRead).toHaveProperty("executionOutcome");
    expect(fromUpdate).toHaveProperty("executionOutcome");
  });
});

describe("F/G. the payload is safe", () => {
  const SHARED = readFileSync(
    path.resolve(__dirname, "../../../packages/shared/src/extreme-rr.ts"),
    "utf8"
  );

  maybe()("carries a structured shape, never a rendered sentence", () => {
    // Bounded to the interface body: slicing to end-of-file would sweep in
    // unrelated code and make the "no presentation" check meaningless.
    const start = SHARED.indexOf("export interface SelectedPlanOutcomeDto");
    const dto = SHARED.slice(start, SHARED.indexOf("\n}", start));

    for (const field of ["handled: boolean", "reasonCode: string | null", "evaluatedAt: string"]) {
      expect(dto, field).toContain(field);
    }
    // No presentation leaked into the contract — the wording lives in the
    // frontend's shared reason vocabulary, and only there. Scanned on the
    // DECLARATIONS: the doc comments legitimately discuss prose in order to
    // rule it out, and a raw-text scan would fail on its own explanation.
    const declarations = dto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(declarations).not.toMatch(/label|display|rendered|humanized|sentence/i);
    // Exactly five fields, all primitives.
    expect([...dto.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1])).toEqual([
      "handled",
      "reasonCode",
      "message",
      "executionId",
      "evaluatedAt",
    ]);
  });

  maybe()("exposes no stack trace, error object or environment", async () => {
    const { alertId, planId } = await seed();
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: { handled: false, reasonCode: "PROFILE_UNAVAILABLE", message: "profile missing" } as never,
      evaluatedAt: new Date(),
    });

    const serialized = JSON.stringify((await service().getForAlert(alertId))!.executionOutcome);
    for (const forbidden of ["stack", "at Object.", "postgres", "redis://", "process.env", "Bearer"]) {
      expect(`${forbidden}:${serialized.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  maybe()("the message is bounded so a long string cannot bloat the payload", async () => {
    const { alertId, planId } = await seed();
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: { handled: false, reasonCode: "CANDIDATE_INCOMPLETE", message: "x".repeat(5_000) } as never,
      evaluatedAt: new Date(),
    });

    const dto = await service().getForAlert(alertId);
    expect(dto!.executionOutcome!.message!.length).toBe(1_000);
  });
});

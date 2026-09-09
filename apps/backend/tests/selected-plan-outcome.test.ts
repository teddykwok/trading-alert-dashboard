import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

import {
  findSelectedPlanOutcome,
  recordSelectedPlanOutcome,
} from "../src/modules/execution/selected-plan-outcome.service";
import type { SelectedPlanOutcome } from "../src/modules/execution/selected-plan-executor";

/**
 * Durable evidence for a plan that was evaluated and produced no execution.
 *
 * ## The blind spot this closes
 *
 * `SelectedPlanExecutor.handleSelectedPlan` has eleven `handled: false` return
 * sites across nine reason codes, and every one of them returns BEFORE any
 * TradeExecution is created. Neither `ExecutionEvent` nor `SafetyAdmission` can
 * record them — both require a `tradeExecutionId` that does not exist yet — so
 * the decision was only ever logged, and Alert Detail could say nothing better
 * than "reason unavailable" for a READY plan with no execution.
 *
 * ## The property that makes this safe
 *
 * The executor already RETURNS its outcome, so the evidence is written at the
 * WORKER call site, strictly after the decision has been made and handed back.
 * `selected-plan-executor.ts` is therefore not modified at all — a fact these
 * tests pin directly, because it is the whole argument for why an observability
 * feature cannot alter a trading decision here.
 */

const SYNTHETIC_TAG = "selected-plan-outcome-synthetic";
const SYMBOL = "TESTSPOUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const BACKEND = path.resolve(__dirname, "..");
const EXECUTOR_SOURCE = readFileSync(
  path.join(BACKEND, "src/modules/execution/selected-plan-executor.ts"),
  "utf8"
);
const SERVICE_SOURCE = readFileSync(
  path.join(BACKEND, "src/modules/execution/selected-plan-outcome.service.ts"),
  "utf8"
);
const WORKER_SOURCE = readFileSync(
  path.join(BACKEND, "src/modules/jobs/vision-analysis.worker.ts"),
  "utf8"
);

/** Source with comments removed — the bans are about code, not about prose. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const maybe = () => (available ? it : it.skip);

let sequence = 0;

/** An alert with a plan, built through real rows in the guarded test database. */
async function alertWithPlan(): Promise<{ alertId: string; planId: string }> {
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
      status: "READY",
      direction: "LONG",
      entryPrice: "100",
      cutoffAt: new Date(),
      timeframe: "15m",
      selectedLookback: 300,
    },
  });
  return { alertId: alert.id, planId: plan.id };
}

const refusal = (reasonCode: string, message = "refused"): SelectedPlanOutcome =>
  ({ handled: false, reasonCode, message } as SelectedPlanOutcome);

const handled = (executionId: string, reasonCode: string | null = "ENTRY_SUBMITTED"): SelectedPlanOutcome => ({
  handled: true,
  executionId,
  created: true,
  admitted: true,
  reasonCode,
});

afterEach(async () => {
  if (!prisma || !available) return;
  await prisma.selectedPlanOutcome.deleteMany({
    where: { alert: { indicatorName: { startsWith: SYNTHETIC_TAG } } },
  });
});

beforeAll(async () => {
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
// A-D. The refusal becomes durable evidence
// ===========================================================================

describe("A-D. a pre-execution refusal is recorded exactly as decided", () => {
  maybe()("persists the canonical reason code verbatim", async () => {
    const { alertId, planId } = await alertWithPlan();
    const evaluatedAt = new Date("2026-08-28T12:00:00.000Z");

    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: refusal("CANARY_AUTHORIZATION_REQUIRED", "nothing authorizes this signal"),
      evaluatedAt,
    });

    const stored = await findSelectedPlanOutcome(prisma!, alertId);
    expect(stored).not.toBeNull();
    expect(stored!.handled).toBe(false);
    // Verbatim: no re-interpretation, no second vocabulary.
    expect(stored!.reasonCode).toBe("CANARY_AUTHORIZATION_REQUIRED");
    expect(stored!.message).toBe("nothing authorizes this signal");
    expect(stored!.executionId).toBeNull();
    expect(stored!.evaluatedAt.toISOString()).toBe(evaluatedAt.toISOString());
  });

  maybe()("links the alert AND the exact plan that was judged", async () => {
    const { alertId, planId } = await alertWithPlan();
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: refusal("MARGIN_PLAN_NOT_READY"),
      evaluatedAt: new Date(),
    });

    const row = await prisma!.selectedPlanOutcome.findUniqueOrThrow({ where: { alertId } });
    // The plan id is stored so the row can never be read as a verdict on some
    // later plan for the same alert.
    expect(row.extremeRRPlanId).toBe(planId);
    expect(row.alertId).toBe(alertId);
  });

  maybe()("records every reason code the executor can return", async () => {
    // Enumerated from the executor's own union, so a new code added there
    // without thought here shows up as a gap rather than as silence.
    const codes = [
      "PLAN_NOT_READY",
      "NO_SELECTED_CANDIDATE",
      "CANDIDATE_INCOMPLETE",
      "MARGIN_PLAN_NOT_READY",
      "PROFILE_UNAVAILABLE",
      "CANARY_AUTHORIZATION_REQUIRED",
      "CANARY_AUTHORIZATION_WRONG_SYMBOL",
      "CANARY_AUTHORIZATION_WRONG_DIRECTION",
      "CANARY_AUTHORIZATION_ALREADY_CONSUMED",
    ];
    for (const code of codes) {
      const { alertId, planId } = await alertWithPlan();
      await recordSelectedPlanOutcome(prisma!, {
        alertId,
        extremeRRPlanId: planId,
        outcome: refusal(code),
        evaluatedAt: new Date(),
      });
      expect((await findSelectedPlanOutcome(prisma!, alertId))!.reasonCode, code).toBe(code);
    }
  });

  maybe()("the executor's union still holds exactly those nine codes", () => {
    const union = EXECUTOR_SOURCE.slice(
      EXECUTOR_SOURCE.indexOf("export type SelectedPlanSkipReason"),
      EXECUTOR_SOURCE.indexOf(";", EXECUTOR_SOURCE.indexOf("export type SelectedPlanSkipReason"))
    );
    const found = [...union.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
    expect(found.sort()).toEqual(
      [
        "PLAN_NOT_READY",
        "NO_SELECTED_CANDIDATE",
        "CANDIDATE_INCOMPLETE",
        "MARGIN_PLAN_NOT_READY",
        "PROFILE_UNAVAILABLE",
        "CANARY_AUTHORIZATION_REQUIRED",
        "CANARY_AUTHORIZATION_WRONG_SYMBOL",
        "CANARY_AUTHORIZATION_WRONG_DIRECTION",
        "CANARY_AUTHORIZATION_ALREADY_CONSUMED",
      ].sort()
    );
  });
});

// ===========================================================================
// E-H. No execution-domain side effects
// ===========================================================================

describe("E-H. recording a refusal creates no execution and reserves nothing", () => {
  maybe()("fabricates no TradeExecution", async () => {
    const { alertId, planId } = await alertWithPlan();
    const before = await prisma!.tradeExecution.count();

    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: refusal("PROFILE_UNAVAILABLE"),
      evaluatedAt: new Date(),
    });

    expect(await prisma!.tradeExecution.count()).toBe(before);
    expect(await prisma!.tradeExecution.findFirst({ where: { alertId } })).toBeNull();
  });

  maybe()("writes to no execution, admission, authorization or order table", async () => {
    const { alertId, planId } = await alertWithPlan();
    const counts = async () => ({
      executions: await prisma!.tradeExecution.count(),
      admissions: await prisma!.safetyAdmission.count(),
      events: await prisma!.executionEvent.count(),
      orders: await prisma!.binanceOrder.count(),
      authorizations: await prisma!.executionCanaryAuthorization.count(),
    });

    const before = await counts();
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: refusal("CANARY_AUTHORIZATION_REQUIRED"),
      evaluatedAt: new Date(),
    });
    expect(await counts()).toEqual(before);
  });

  maybe()("the service can only reach two tables, and one model", () => {
    // Capacity, risk and margin are all DERIVED from execution rows. Touching
    // none of those rows is what makes "reservations unchanged" structural
    // rather than something to re-verify per call site.
    const models = [...codeOf(SERVICE_SOURCE).matchAll(/prisma\.(\w+)\./g)].map((match) => match[1]);
    expect([...new Set(models)]).toEqual(["selectedPlanOutcome"]);
  });

  maybe()("the service reaches no trading module at all", () => {
    const code = codeOf(SERVICE_SOURCE);
    for (const forbidden of [
      "tradeExecution",
      "TradeExecution",
      "binance",
      "Binance",
      "admitAndSubmit",
      "naturalWindow",
      "maxClaims",
      "claimedCount",
      "protection",
      "SafetyAdmission",
      "orchestrator",
    ]) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    const imports = [...code.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort();
    expect(imports).toEqual(["./selected-plan-executor", "@prisma/client", "@prisma/client"].sort());
  });
});

// ===========================================================================
// I/J. Idempotency and concurrency
// ===========================================================================

describe("I/J. repeated and concurrent recording stay deterministic", () => {
  maybe()("re-deciding the SAME frozen plan replaces rather than appends", async () => {
    // A READY plan is frozen — generateForAlert returns it untouched — so a
    // redelivered job re-decides identical inputs. Appending would manufacture
    // a history of repeated decisions that never happened.
    const { alertId, planId } = await alertWithPlan();
    const input = {
      alertId,
      extremeRRPlanId: planId,
      outcome: refusal("CANDIDATE_INCOMPLETE"),
      evaluatedAt: new Date("2026-08-28T12:00:00.000Z"),
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await recordSelectedPlanOutcome(prisma!, input);
    }

    expect(await prisma!.selectedPlanOutcome.count({ where: { alertId } })).toBe(1);
    const stored = await findSelectedPlanOutcome(prisma!, alertId);
    expect(stored!.reasonCode).toBe("CANDIDATE_INCOMPLETE");
  });

  maybe()("a later legitimate re-evaluation replaces a verdict whose subject is gone", async () => {
    // Only a NON-READY plan regenerates. Its old refusal described a plan state
    // that no longer exists, so the newer decision is the truthful one — and
    // evaluatedAt moves with it.
    const { alertId, planId } = await alertWithPlan();
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: refusal("PLAN_NOT_READY", "Plan is INVALID."),
      evaluatedAt: new Date("2026-08-28T12:00:00.000Z"),
    });

    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: refusal("CANARY_AUTHORIZATION_REQUIRED", "nothing authorizes this signal"),
      evaluatedAt: new Date("2026-08-28T15:00:00.000Z"),
    });

    const stored = await findSelectedPlanOutcome(prisma!, alertId);
    expect(stored!.reasonCode).toBe("CANARY_AUTHORIZATION_REQUIRED");
    expect(stored!.evaluatedAt.toISOString()).toBe("2026-08-28T15:00:00.000Z");
    expect(await prisma!.selectedPlanOutcome.count({ where: { alertId } })).toBe(1);
  });

  maybe()("a success replaces an earlier refusal for the same alert", async () => {
    const { alertId, planId } = await alertWithPlan();
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: refusal("MARGIN_PLAN_NOT_READY"),
      evaluatedAt: new Date("2026-08-28T12:00:00.000Z"),
    });
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: handled("exec-123"),
      evaluatedAt: new Date("2026-08-28T12:05:00.000Z"),
    });

    const stored = await findSelectedPlanOutcome(prisma!, alertId);
    expect(stored!.handled).toBe(true);
    expect(stored!.executionId).toBe("exec-123");
    // A handled outcome carries no sentence of its own — the execution row is
    // authoritative for it.
    expect(stored!.message).toBeNull();
  });

  maybe()("concurrent writers converge on one row without a lock", async () => {
    const { alertId, planId } = await alertWithPlan();
    const write = (code: string) =>
      recordSelectedPlanOutcome(prisma!, {
        alertId,
        extremeRRPlanId: planId,
        outcome: refusal(code),
        evaluatedAt: new Date(),
      });

    await Promise.all([write("CANDIDATE_INCOMPLETE"), write("CANDIDATE_INCOMPLETE"), write("CANDIDATE_INCOMPLETE")]);

    expect(await prisma!.selectedPlanOutcome.count({ where: { alertId } })).toBe(1);
  });

  maybe()("the database enforces one verdict per alert AND per plan", async () => {
    const { alertId, planId } = await alertWithPlan();
    await recordSelectedPlanOutcome(prisma!, {
      alertId,
      extremeRRPlanId: planId,
      outcome: refusal("PROFILE_UNAVAILABLE"),
      evaluatedAt: new Date(),
    });

    // A second row for the same plan is refused by the constraint, not by
    // application logic that could be forgotten.
    const other = await alertWithPlan();
    await expect(
      prisma!.selectedPlanOutcome.create({
        data: {
          alertId: other.alertId,
          extremeRRPlanId: planId,
          handled: false,
          reasonCode: "PROFILE_UNAVAILABLE",
          evaluatedAt: new Date(),
        },
      })
    ).rejects.toThrow();
  });

  maybe()("no lock, no Redis, no transaction wrapper is used", () => {
    const code = codeOf(SERVICE_SOURCE);
    for (const forbidden of ["redis", "Redis", "$transaction", "advisory", "lock"]) {
      expect(`${forbidden}:${code.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(
        `${forbidden}:false`
      );
    }
  });
});

// ===========================================================================
// K/P/Q/R. The trading decision path is untouched
// ===========================================================================

describe("K/P/Q/R. observability cannot alter a trading decision", () => {
  it("the executor has no route to the persistence path at all", () => {
    // This was once asserted by diffing the executor against `main`. That
    // proved the ORIGINAL change did not touch the file, but it was a claim
    // about branch ancestry rather than about the code: it passed again the
    // moment that branch merged, and it failed for any later, unrelated,
    // entirely legitimate edit to the executor. The durable claim is the one
    // the design actually rests on -- the outcome is RETURNED to the caller,
    // so the decision-making file needs no access to the writer and is given
    // none. That stays true however the executor evolves.
    const code = codeOf(EXECUTOR_SOURCE);
    // No import of the outcome module, under any specifier form.
    expect(code).not.toMatch(/from\s+["'][^"']*selected-plan-outcome[^"']*["']/);
    expect(code).not.toMatch(/require\(\s*["'][^"']*selected-plan-outcome[^"']*["']\s*\)/);
    // And no reference to the model, by any route.
    expect(code).not.toContain("selectedPlanOutcome");
  });

  it("the decision leaves the executor by RETURN, which is what lets it stay ignorant", () => {
    // The other half of the same argument, and the reason the check above is
    // sufficient: `handleSelectedPlan` hands its verdict back to the caller, so
    // the evidence is always available without the executor storing anything.
    // No future feature has a reason to reach for persistence here.
    const code = codeOf(EXECUTOR_SOURCE);
    expect(code).toContain("async handleSelectedPlan(");
    expect(code).toContain("Promise<SelectedPlanOutcome>");
  });

  maybe()("the executor never persists an outcome itself", () => {
    const code = codeOf(EXECUTOR_SOURCE);
    expect(code).not.toContain("selectedPlanOutcome");
    expect(code).not.toContain("recordSelectedPlanOutcome");
  });

  maybe()("persistence happens AFTER the decision, in its own guard", () => {
    const block = WORKER_SOURCE.slice(
      WORKER_SOURCE.indexOf("const outcome = await selectedPlanExecutor.handleSelectedPlan"),
      WORKER_SOURCE.indexOf("} catch (executionError) {")
    );
    // Order is the safety argument: decide, return, THEN record.
    expect(block.indexOf("handleSelectedPlan")).toBeLessThan(block.indexOf("recordSelectedPlanOutcome"));
    // Its own try/catch, so a write failure cannot reach the outer handler and
    // cause the job to retry and re-decide against different state.
    expect(block).toContain("try {");
    expect(block).toContain("catch (outcomeError)");
    expect(block).toContain("decision already stands");
  });

  maybe()("a persistence failure neither admits a trade nor reverses a refusal", async () => {
    // A prisma whose write always fails. The recorded decision is lost; the
    // decision itself is untouched, because it was already returned.
    const failing = {
      selectedPlanOutcome: {
        upsert: async () => {
          throw new Error("database unavailable");
        },
        update: async () => {
          throw new Error("database unavailable");
        },
      },
    } as unknown as PrismaClient;

    await expect(
      recordSelectedPlanOutcome(failing, {
        alertId: "a",
        extremeRRPlanId: "p",
        outcome: refusal("CANARY_AUTHORIZATION_REQUIRED"),
        evaluatedAt: new Date(),
      })
    ).rejects.toThrow("database unavailable");

    // It throws to its caller — which is the worker's dedicated catch — and
    // creates nothing on the way out.
    if (available) {
      expect(await prisma!.tradeExecution.count({ where: { alertId: "a" } })).toBe(0);
    }
  });

  maybe()("the worker logs the failure safely and carries on", () => {
    const block = WORKER_SOURCE.slice(WORKER_SOURCE.indexOf("catch (outcomeError)"));
    expect(block).toContain("logger.warn");
    expect(block).toContain("message.slice(0, 300)");
    // Never the raw error object, which can carry a connection string.
    expect(block).not.toContain("error: outcomeError,");
  });
});

// ===========================================================================
// S-V. No reach into other subsystems
// ===========================================================================

describe("S-V. no Binance, vision-queue or supervision interaction", () => {
  maybe()("the service makes no network call of any kind", () => {
    const code = codeOf(SERVICE_SOURCE);
    for (const forbidden of ["fetch(", "axios", "http", "https"]) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  maybe()("it touches neither the vision queue nor worker supervision", () => {
    const code = codeOf(SERVICE_SOURCE);
    for (const forbidden of ["bullmq", "Queue", "enqueue", "supervision", "attestation", "chromium"]) {
      expect(`${forbidden}:${code.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(
        `${forbidden}:false`
      );
    }
  });

  maybe()("the recent reliability features are unchanged in the worker", () => {
    // This branch adds a call; it must not have disturbed what was already there.
    for (const marker of [
      "startAlertQueueRecoveryScheduler",
      "startExecutionOrchestrationScheduler",
      "createRuntimeAttestationPublisher",
      "isReconciliationHealthy",
      "concurrency: 2",
    ]) {
      expect(WORKER_SOURCE, marker).toContain(marker);
    }
  });

  maybe()("logs carry no secret", () => {
    for (const forbidden of [
      "OPENAI_API_KEY",
      "DATABASE_URL",
      "REDIS_URL",
      "WEBHOOK_SECRET",
      "OPERATOR_API_TOKEN",
      "process.env",
      "Authorization",
    ]) {
      expect(`${forbidden}:${SERVICE_SOURCE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ===========================================================================
// M. Historical alerts stay honestly unknown
// ===========================================================================

describe("M. an alert with no recorded verdict stays unknown", () => {
  maybe()("returns null rather than inventing a reason", async () => {
    const { alertId } = await alertWithPlan();
    expect(await findSelectedPlanOutcome(prisma!, alertId)).toBeNull();
  });

  maybe()("nothing backfills historical rows", () => {
    const migration = readFileSync(
      path.join(BACKEND, "prisma/migrations/20260828120000_add_selected_plan_outcome/migration.sql"),
      "utf8"
    );
    // Additive only: one CREATE TABLE, no UPDATE/INSERT/ALTER of anything that
    // already held data.
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "SelectedPlanOutcome"');
    expect(migration).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP)\s/im);
    expect(migration).not.toMatch(/ALTER TABLE "(Alert|ExtremeRRPlan|TradeExecution)"/);
  });
});

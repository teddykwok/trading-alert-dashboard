import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Phase 9 runtime + downtime-recovery tests against a real Postgres.
 *
 * The scenario throughout is a notification runner that was NOT running while
 * the trading lifecycle recorded its history. Everything is driven through
 * runExecutionNotificationTick() — no test calls the materializer directly for
 * a specific execution — so what is proven here is the production path.
 *
 * The Telegram transport is an in-memory fake; nothing reaches
 * api.telegram.org, and no Binance connector is imported anywhere.
 */

const TAG = "phase9-recovery";
const SYMBOL = "TESTRUSDT";
const EXECUTION_CHAT = "-1003333333333";
const MAIN_CHAT = "-1004444444444";

function resolveDatabaseUrl(): string | null {
  for (const candidate of [path.join(process.cwd(), ".env"), path.join(process.cwd(), "apps", "backend", ".env")]) {
    try {
      const match = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m.exec(readFileSync(candidate, "utf8"));
      if (match) return match[1].trim();
    } catch {
      // Try the next candidate path.
    }
  }
  return process.env.DATABASE_URL ?? null;
}

const databaseUrl = resolveDatabaseUrl();
const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;

let available = false;
if (prisma) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch (error) {
    console.warn(
      `[phase9] Skipping recovery tests — no database reachable: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`
    );
  }
} else {
  console.warn("[phase9] Skipping recovery tests — no DATABASE_URL could be resolved.");
}

const { ExecutionNotificationService } = await import("../src/modules/notifications/execution-notification.service");
const { CriticalAlertService } = await import("../src/modules/execution/critical-alert.service");

type Service = InstanceType<typeof ExecutionNotificationService>;

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

class FakeTelegram {
  readonly sent: { chatId: string; text: string }[] = [];
  slow = false;

  readonly send = async (chatId: string, text: string) => {
    if (this.slow) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    // Other suites share this database and the dispatcher drains the whole
    // outbox; only this file's synthetic symbol is recorded.
    if (text.includes(SYMBOL)) this.sent.push({ chatId, text });
    return { delivered: true, retryable: false, errorCode: null, sanitizedError: null };
  };
}

let telegram: FakeTelegram;
let service: Service;
let profileId = "";
let sequence = 0;
const executionIds: string[] = [];

function build(overrides: Partial<{ execution: string | null; critical: string | null; deliveryEnabled: boolean }> = {}) {
  return new ExecutionNotificationService(prisma!, telegram.send, {
    execution: EXECUTION_CHAT,
    critical: MAIN_CHAT,
    deliveryEnabled: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Synthetic lifecycle history
// ---------------------------------------------------------------------------

/** A planned execution with no history yet. */
async function syntheticExecution(status = "PLAN_READY"): Promise<string> {
  sequence += 1;
  const execution = await prisma!.tradeExecution.create({
    data: {
      executionProfileId: profileId,
      symbol: SYMBOL,
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 200,
      signalTriggeredAt: new Date(Date.now() - 60_000),
      status: status as never,
      plannedEntryPrice: "0.2707",
      calculatedStopLoss: "0.2656",
      executableStopLoss: "0.2656",
      takeProfit: "0.3011",
      riskBudgetUsd: "1.50",
      quantityRaw: "0.25",
      plannedQuantity: "0.25",
      quantityStepSize: "0.01",
      actualPlannedLoss: "1.5",
      unusedRiskBudget: "0",
      positionNotional: "79.58",
      targetIsolatedMargin: "3.79",
      maximumIsolatedMargin: "5.00",
      selectedLeverage: 21,
      estimatedInitialMargin: "3.79",
      estimatedLiquidationPrice: "0.2601",
      requiredLiquidationBoundary: "0.2620",
      liquidationBufferRatio: "0.5",
      decisionReasonCode: `${TAG}-${sequence}`,
    },
  });
  executionIds.push(execution.id);
  return execution.id;
}

let eventSequence = 0;

/**
 * Appends one ENTRY_RECONCILED event exactly as Phase 6 writes it, including
 * the exact-string quantity metadata that makes the milestone recoverable.
 */
async function entryReconciled(
  executionId: string,
  options: {
    localOrderStatus: string;
    cumulativeFilledQuantity: string;
    averageFillPrice?: string | null;
    toStatus?: string;
    createdAt?: Date;
  }
): Promise<void> {
  eventSequence += 1;
  const next = await prisma!.tradeExecution.update({
    where: { id: executionId },
    data: { status: (options.toStatus ?? "ENTRY_PENDING") as never, version: { increment: 1 } },
  });
  await prisma!.executionEvent.create({
    data: {
      tradeExecutionId: executionId,
      sequenceNumber: next.version,
      eventType: "ENTRY_RECONCILED",
      toStatus: next.status,
      reasonCode: "ENTRY_RECONCILED",
      message: `Entry order is ${options.localOrderStatus}.`,
      metadata: {
        localOrderStatus: options.localOrderStatus,
        exchangeStatus: options.localOrderStatus,
        cumulativeFilledQuantity: options.cumulativeFilledQuantity,
        plannedQuantity: "0.25",
        originalQuantity: "0.25",
        averageFillPrice: options.averageFillPrice ?? null,
      },
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
}

/** Appends a terminal status event, as the lifecycle commits one. */
async function terminalEvent(executionId: string, toStatus: string, actual: Record<string, unknown> = {}): Promise<void> {
  const next = await prisma!.tradeExecution.update({
    where: { id: executionId },
    data: { status: toStatus as never, version: { increment: 1 }, ...actual },
  });
  await prisma!.executionEvent.create({
    data: {
      tradeExecutionId: executionId,
      sequenceNumber: next.version,
      eventType: "PROTECTION_CLEANUP",
      toStatus: next.status,
      reasonCode: "PROTECTION_VERIFIED",
      message: `Closed as ${toStatus}.`,
    },
  });
}

/**
 * Appends one durable proof that coverage was verified complete — the row the
 * Phase 7 protection transaction now writes.
 */
async function protectionVerified(executionId: string, quantity: string, generation = 1): Promise<void> {
  const protection = await prisma!.executionProtectionState.upsert({
    where: { tradeExecutionId: executionId },
    create: {
      tradeExecutionId: executionId,
      state: "PROTECTED",
      confirmedOpenQuantity: quantity,
      protectedStopQuantity: quantity,
      protectedTakeProfitQuantity: quantity,
      currentGeneration: generation,
      liquidationSafe: true,
    },
    update: {
      state: "PROTECTED",
      confirmedOpenQuantity: quantity,
      protectedStopQuantity: quantity,
      protectedTakeProfitQuantity: quantity,
      currentGeneration: generation,
      liquidationSafe: true,
      version: { increment: 1 },
    },
  });

  for (const [role, trigger] of [
    ["STOP_LOSS", "0.2656"],
    ["TAKE_PROFIT", "0.3011"],
  ] as const) {
    await prisma!.binanceOrder.upsert({
      where: {
        tradeExecutionId_role_generation: { tradeExecutionId: executionId, role, generation },
      },
      create: {
        tradeExecutionId: executionId,
        role,
        generation,
        clientOrderId: `${TAG}-${executionId}-${role}-${generation}`,
        clientAlgoId: `${TAG}-${executionId}-${role}-${generation}`,
        side: "SELL",
        positionSide: "LONG",
        orderType: role === "STOP_LOSS" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
        originalQuantity: quantity,
        triggerPrice: trigger,
        status: "NEW",
      },
      update: {},
    });
  }

  await prisma!.executionProtectionVerification.create({
    data: {
      tradeExecutionId: executionId,
      protectionVersion: protection.version,
      state: "PROTECTED",
      confirmedOpenQuantity: quantity,
      protectedStopQuantity: quantity,
      protectedTakeProfitQuantity: quantity,
      liquidationSafe: true,
      generation,
      verifiedAt: new Date(),
    },
  });
}

async function notificationsFor(executionId: string) {
  return prisma!.executionNotification.findMany({
    where: { tradeExecutionId: executionId },
    orderBy: [{ createdAt: "asc" }, { milestoneSequence: "asc" }, { id: "asc" }],
  });
}

function describeOf(rows: { notificationType: string; payloadSnapshot: unknown }[]): string[] {
  return rows.map((row) => {
    const payload = row.payloadSnapshot as { filledQuantity?: string; protectedQuantity?: string };
    const quantity = payload.filledQuantity ?? payload.protectedQuantity;
    return quantity ? `${row.notificationType} ${quantity}` : row.notificationType;
  });
}

beforeAll(async () => {
  telegram = new FakeTelegram();
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: { name: "Phase 9 recovery", accountIdentifier: `${TAG}-account`, environment: "TESTNET", isEnabled: true },
  });
  profileId = profile.id;
  service = build();
});

/**
 * Discovery is global by design: the runner drains whatever durable history has
 * no checkpoint. Other suites share this database and run in parallel, so their
 * events would otherwise fill this suite's bounded batches. Checkpointing them
 * up front is exactly what a caught-up production runner would already have
 * done, and it leaves this suite's own history as the only work to discover.
 */
async function catchUpForeignHistory(): Promise<void> {
  const foreignEvents = await prisma!.executionEvent.findMany({
    where: { notificationCheckpoint: null, tradeExecutionId: { notIn: executionIds } },
    select: { id: true },
    take: 5000,
  });
  const foreignVerifications = await prisma!.executionProtectionVerification.findMany({
    where: { notificationCheckpoint: null, tradeExecutionId: { notIn: executionIds } },
    select: { id: true },
    take: 5000,
  });
  const processedAt = new Date();
  await prisma!.executionNotificationCheckpoint.createMany({
    data: [
      ...foreignEvents.map((event) => ({ executionEventId: event.id, processedAt })),
      ...foreignVerifications.map((row) => ({ protectionVerificationId: row.id, processedAt })),
    ],
    skipDuplicates: true,
  });
}

beforeEach(async () => {
  if (telegram) {
    telegram.sent.length = 0;
    telegram.slow = false;
  }
  if (prisma && available) await catchUpForeignHistory();
});

afterEach(async () => {
  if (!prisma || !available) return;
  // Checkpoints are deliberately NOT cleared between cases. A processed event
  // staying processed is the real steady state, and it is also what keeps each
  // case isolated: the only uncheckpointed history a tick can find is the
  // history the current case just created.
  await catchUpForeignHistory();
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const events = await prisma.executionEvent.findMany({
      where: { tradeExecutionId: { in: executionIds } },
      select: { id: true },
    });
    const verifications = await prisma.executionProtectionVerification.findMany({
      where: { tradeExecutionId: { in: executionIds } },
      select: { id: true },
    });
    await prisma.executionNotificationCheckpoint.deleteMany({
      where: { OR: [{ executionEventId: { in: events.map((e) => e.id) } }, { protectionVerificationId: { in: verifications.map((v) => v.id) } }] },
    });
    await prisma.executionNotification.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.criticalAlert.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.executionProtectionVerification.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    // Restrict relations: both must go before the execution itself.
    await prisma.marginAdjustmentIntent.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.safetyAdmission.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.executionProtectionState.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.tradeExecution.deleteMany({ where: { id: { in: executionIds } } });
    if (profileId) await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
});

const describeDb = available ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 1. Production registration
// ---------------------------------------------------------------------------

describe("production runtime registration", () => {
  const BACKEND = process.cwd();
  const WORKER = path.join(BACKEND, "src", "modules", "jobs", "vision-analysis.worker.ts");
  const SCHEDULER = path.join(BACKEND, "src", "modules", "jobs", "execution-notification.scheduler.ts");

  it("is started from the existing worker entrypoint", () => {
    const worker = readFileSync(WORKER, "utf8");
    expect(worker).toContain("startExecutionNotificationScheduler");
    expect(worker).toMatch(/import \{ startExecutionNotificationScheduler \} from "\.\/execution-notification\.scheduler"/);
    // Started exactly once, at module scope, alongside the existing schedulers.
    expect(worker.match(/startExecutionNotificationScheduler\(\)/g)).toHaveLength(1);
  });

  it("is cleared by the existing shutdown handler", () => {
    const worker = readFileSync(WORKER, "utf8");
    const shutdown = worker.slice(worker.indexOf('process.on("SIGTERM"'));
    expect(shutdown).toContain("clearInterval(notificationTimer)");
  });

  it("calls the real tick and adds no second daemon", () => {
    const scheduler = readFileSync(SCHEDULER, "utf8");
    expect(scheduler).toContain("runExecutionNotificationTick");
    expect(scheduler).toContain("createExecutionNotificationService");
    // One interval, no queue, no worker process, no HTTP surface.
    expect(scheduler.match(/setInterval/g)).toHaveLength(1);
    for (const forbidden of ["new Worker", "Queue(", "fastify", "app.get", "app.post"]) {
      expect(`${forbidden}:${scheduler.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("guards against overlapping ticks and uses a conservative interval", async () => {
    const scheduler = await import("../src/modules/jobs/execution-notification.scheduler");
    expect(scheduler.NOTIFICATION_TICK_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(readFileSync(SCHEDULER, "utf8")).toContain("tickInFlight");
  });

  it("imports no Binance client anywhere in the runner", () => {
    for (const file of [SCHEDULER, path.join(BACKEND, "src", "modules", "notifications", "execution-notification.service.ts")]) {
      const imports = [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const forbidden of [
        "binance.client",
        "binance-read-only",
        "binance-execution.client",
        "binance-algo",
        "entry-lifecycle",
        "protection-lifecycle",
      ]) {
        expect(imports.some((entry) => entry.includes(forbidden)), `${path.basename(file)} -> ${forbidden}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2-3. The tick discovers and delivers without a manual materialize call
// ---------------------------------------------------------------------------

describeDb("automatic discovery", () => {
  it("materializes a persisted LIMIT milestone from one tick alone", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });

    // No materializeExecutionNotifications(id) anywhere — the tick finds it.
    const summary = await service.runExecutionNotificationTick();
    expect(summary.failed).toBe(false);
    expect(summary.eventsProcessed).toBeGreaterThanOrEqual(1);

    expect(describeOf(await notificationsFor(id))).toEqual(["LIMIT_PLACED"]);
  });

  it("delivers it through the fake Telegram sender in the same tick", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });

    await service.runExecutionNotificationTick();

    expect(telegram.sent.map((message) => message.text.split("\n")[0])).toContain("🟦 LIMIT PLACED");
    expect(telegram.sent[0].chatId).toBe(EXECUTION_CHAT);
    expect((await notificationsFor(id))[0].deliveryStatus).toBe("DELIVERED");
  });

  it("checkpoints an event that earns no milestone so it is not rescanned forever", async () => {
    const id = await syntheticExecution();
    const next = await prisma!.tradeExecution.update({
      where: { id },
      data: { version: { increment: 1 } },
    });
    const event = await prisma!.executionEvent.create({
      data: {
        tradeExecutionId: id,
        sequenceNumber: next.version,
        eventType: "ORDER_RESERVED",
        toStatus: "ENTRY_SUBMITTING",
        message: "reserved",
      },
    });

    await service.runExecutionNotificationTick();

    expect(await notificationsFor(id)).toHaveLength(0);
    const checkpoint = await prisma!.executionNotificationCheckpoint.findUnique({
      where: { executionEventId: event.id },
    });
    expect(checkpoint).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4-5. ENTRY downtime recovery
// ---------------------------------------------------------------------------

describeDb("entry downtime recovery", () => {
  it("recovers every intermediate fill the runner slept through", async () => {
    const id = await syntheticExecution();
    // The whole entry lifecycle happens with NO notification runner alive.
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });
    await entryReconciled(id, {
      localOrderStatus: "PARTIALLY_FILLED",
      cumulativeFilledQuantity: "0.10",
      averageFillPrice: "0.2707",
      toStatus: "PARTIALLY_FILLED",
    });
    await entryReconciled(id, {
      localOrderStatus: "PARTIALLY_FILLED",
      cumulativeFilledQuantity: "0.15",
      averageFillPrice: "0.2707",
      toStatus: "PARTIALLY_FILLED",
    });
    await entryReconciled(id, {
      localOrderStatus: "FILLED",
      cumulativeFilledQuantity: "0.25",
      averageFillPrice: "0.2707",
      toStatus: "ENTRY_FILLED",
    });

    await service.runExecutionNotificationTick();

    // The mutable order row would only ever have yielded the final 0.25.
    expect(describeOf(await notificationsFor(id))).toEqual([
      "LIMIT_PLACED",
      "PARTIAL_FILL 0.1",
      "PARTIAL_FILL 0.15",
      "POSITION_FILLED 0.25",
    ]);
  });

  it("creates no redundant partial for the final full quantity", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });
    await entryReconciled(id, {
      localOrderStatus: "FILLED",
      cumulativeFilledQuantity: "0.25",
      toStatus: "ENTRY_FILLED",
    });

    await service.runExecutionNotificationTick();

    const rows = await notificationsFor(id);
    expect(rows.filter((row) => row.notificationType === "PARTIAL_FILL")).toHaveLength(0);
    expect(describeOf(rows)).toEqual(["LIMIT_PLACED", "POSITION_FILLED 0.25"]);
  });

  it("recovers across several bounded batches without losing an event", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });
    await entryReconciled(id, { localOrderStatus: "PARTIALLY_FILLED", cumulativeFilledQuantity: "0.10", toStatus: "PARTIALLY_FILLED" });
    await entryReconciled(id, { localOrderStatus: "PARTIALLY_FILLED", cumulativeFilledQuantity: "0.15", toStatus: "PARTIALLY_FILLED" });
    await entryReconciled(id, { localOrderStatus: "FILLED", cumulativeFilledQuantity: "0.25", toStatus: "ENTRY_FILLED" });

    // One event at a time — a deliberately tiny batch budget.
    for (let pass = 0; pass < 8; pass += 1) {
      await service.runExecutionNotificationTick({ discoveryBatchSize: 1 });
    }

    expect(describeOf(await notificationsFor(id))).toEqual([
      "LIMIT_PLACED",
      "PARTIAL_FILL 0.1",
      "PARTIAL_FILL 0.15",
      "POSITION_FILLED 0.25",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Protection downtime recovery
// ---------------------------------------------------------------------------

describeDb("protection downtime recovery", () => {
  it("recovers both verified protected quantities", async () => {
    const id = await syntheticExecution("PROTECTED");
    await protectionVerified(id, "0.10", 1);
    await protectionVerified(id, "0.25", 2);

    await service.runExecutionNotificationTick();

    // The protection row alone only ever shows 0.25.
    expect(describeOf(await notificationsFor(id))).toEqual([
      "POSITION_PROTECTED 0.1",
      "POSITION_PROTECTED 0.25",
    ]);
    const current = await prisma!.executionProtectionState.findUniqueOrThrow({ where: { tradeExecutionId: id } });
    expect(current.protectedStopQuantity.toFixed()).toBe("0.25");
  });

  it("ignores a historical verification that did not prove full safe coverage", async () => {
    const id = await syntheticExecution("PROTECTED");
    await protectionVerified(id, "0.10", 1);
    // A recorded row whose liquidation safety was never established.
    await prisma!.executionProtectionVerification.updateMany({
      where: { tradeExecutionId: id },
      data: { liquidationSafe: null },
    });

    await service.runExecutionNotificationTick();
    expect(await notificationsFor(id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Idempotent re-runs
// ---------------------------------------------------------------------------

describeDb("repeated recovery", () => {
  it("creates zero duplicates when the tick runs again", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });
    await entryReconciled(id, { localOrderStatus: "PARTIALLY_FILLED", cumulativeFilledQuantity: "0.10", toStatus: "PARTIALLY_FILLED" });
    await protectionVerified(id, "0.10", 1);

    await service.runExecutionNotificationTick();
    const first = await notificationsFor(id);

    await service.runExecutionNotificationTick();
    await service.runExecutionNotificationTick();

    const after = await notificationsFor(id);
    expect(after.map((row) => row.id)).toEqual(first.map((row) => row.id));
  });

  it("creates no second row when a checkpoint is replayed", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "PARTIALLY_FILLED", cumulativeFilledQuantity: "0.10", toStatus: "PARTIALLY_FILLED" });
    await service.runExecutionNotificationTick();
    const before = await notificationsFor(id);

    // The cursor is lost but the notification rows survive — the deterministic
    // dedupe key is the backstop.
    const events = await prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, select: { id: true } });
    await prisma!.executionNotificationCheckpoint.deleteMany({
      where: { executionEventId: { in: events.map((event) => event.id) } },
    });
    await service.runExecutionNotificationTick();

    expect((await notificationsFor(id)).map((row) => row.id)).toEqual(before.map((row) => row.id));
  });
});

// ---------------------------------------------------------------------------
// 8-9. Crash semantics
// ---------------------------------------------------------------------------

describeDb("crash semantics", () => {
  it("keeps an event discoverable when the runner dies before the checkpoint commits", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "PARTIALLY_FILLED", cumulativeFilledQuantity: "0.10", toStatus: "PARTIALLY_FILLED" });

    // A crash before commit leaves NO checkpoint and NO notification.
    expect(await prisma!.executionNotificationCheckpoint.count({ where: { executionEventId: { not: null } } })).toBeGreaterThanOrEqual(0);
    expect(await notificationsFor(id)).toHaveLength(0);

    // The next runner rediscovers it, because discovery is "has no checkpoint",
    // not "is newer than a timestamp".
    await service.runExecutionNotificationTick();
    expect(describeOf(await notificationsFor(id))).toEqual(["LIMIT_PLACED", "PARTIAL_FILL 0.1"]);
  });

  it("rolls the checkpoint back with the notification when the transaction fails", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "PARTIALLY_FILLED", cumulativeFilledQuantity: "0.10", toStatus: "PARTIALLY_FILLED" });
    const [event] = await prisma!.executionEvent.findMany({ where: { tradeExecutionId: id } });

    // A wrapping Proxy, NOT Object.create: the Prisma client is itself a proxy
    // whose set trap forwards to the target, so assigning onto a derived object
    // would poison the real client for every later test.
    const poisoned = new Proxy(prisma!, {
      get(target, property, receiver) {
        if (property === "$transaction") {
          return async () => {
            throw new Error("simulated crash mid-transaction");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const failing = new ExecutionNotificationService(poisoned as never, telegram.send, {
      execution: EXECUTION_CHAT,
      critical: MAIN_CHAT,
      deliveryEnabled: true,
    });

    const summary = await failing.runExecutionNotificationTick();
    expect(summary.failed).toBe(true);

    // Neither side landed: no notification, no checkpoint.
    expect(await notificationsFor(id)).toHaveLength(0);
    expect(
      await prisma!.executionNotificationCheckpoint.findUnique({
        where: { executionEventId: event.id },
      })
    ).toBeNull();

    // And a healthy runner still recovers it.
    await service.runExecutionNotificationTick();
    expect(describeOf(await notificationsFor(id))).toEqual(["LIMIT_PLACED", "PARTIAL_FILL 0.1"]);
  });
});

// ---------------------------------------------------------------------------
// 10-11. Concurrency
// ---------------------------------------------------------------------------

describeDb("concurrent runners", () => {
  it("produces one checkpoint and one notification for two simultaneous runners", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "PARTIALLY_FILLED", cumulativeFilledQuantity: "0.10", toStatus: "PARTIALLY_FILLED" });
    const [event] = await prisma!.executionEvent.findMany({ where: { tradeExecutionId: id } });

    await Promise.all([build().runExecutionNotificationTick(), build().runExecutionNotificationTick()]);

    expect(
      await prisma!.executionNotificationCheckpoint.count({
        where: { executionEventId: event.id },
      })
    ).toBe(1);

    // The event earns LIMIT_PLACED and PARTIAL_FILL — each exactly once.
    const rows = await notificationsFor(id);
    expect(describeOf(rows)).toEqual(["LIMIT_PLACED", "PARTIAL_FILL 0.1"]);
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(rows.length);
  });

  it("loses and duplicates nothing across five simultaneous runners", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });
    await entryReconciled(id, { localOrderStatus: "PARTIALLY_FILLED", cumulativeFilledQuantity: "0.10", toStatus: "PARTIALLY_FILLED" });
    await entryReconciled(id, { localOrderStatus: "PARTIALLY_FILLED", cumulativeFilledQuantity: "0.15", toStatus: "PARTIALLY_FILLED" });
    await entryReconciled(id, { localOrderStatus: "FILLED", cumulativeFilledQuantity: "0.25", toStatus: "ENTRY_FILLED" });
    await protectionVerified(id, "0.25", 1);

    telegram.slow = true;
    await Promise.all(Array.from({ length: 5 }, () => build().runExecutionNotificationTick()));

    const rows = await notificationsFor(id);
    // Every milestone present exactly once.
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(rows.length);
    expect(describeOf(rows).sort()).toEqual(
      ["LIMIT_PLACED", "PARTIAL_FILL 0.1", "PARTIAL_FILL 0.15", "POSITION_FILLED 0.25", "POSITION_PROTECTED 0.25"].sort()
    );
    // And no message was sent twice.
    const texts = telegram.sent.map((message) => message.text);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

// ---------------------------------------------------------------------------
// 12-13. Ordering
// ---------------------------------------------------------------------------

describeDb("causal ordering", () => {
  it("respects sequenceNumber when several events share a createdAt", async () => {
    const id = await syntheticExecution();
    const sameInstant = new Date("2026-02-01T00:00:00.000Z");
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0", createdAt: sameInstant });
    await entryReconciled(id, {
      localOrderStatus: "PARTIALLY_FILLED",
      cumulativeFilledQuantity: "0.10",
      toStatus: "PARTIALLY_FILLED",
      createdAt: sameInstant,
    });
    await entryReconciled(id, {
      localOrderStatus: "FILLED",
      cumulativeFilledQuantity: "0.25",
      toStatus: "ENTRY_FILLED",
      createdAt: sameInstant,
    });

    const events = await prisma!.executionEvent.findMany({ where: { tradeExecutionId: id } });
    expect(new Set(events.map((event) => event.createdAt.getTime())).size).toBe(1);

    await service.runExecutionNotificationTick();

    const rows = await notificationsFor(id);
    const bySequence = [...rows].sort((a, b) => a.milestoneSequence - b.milestoneSequence);
    expect(describeOf(bySequence)).toEqual(["LIMIT_PLACED", "PARTIAL_FILL 0.1", "POSITION_FILLED 0.25"]);
  });

  it("delivers an offline CLOSED_TP after the fill it closes", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });
    await entryReconciled(id, { localOrderStatus: "FILLED", cumulativeFilledQuantity: "0.25", toStatus: "ENTRY_FILLED" });
    await terminalEvent(id, "CLOSED_TP", {
      actualExitPrice: "0.3011",
      realizedPnl: "3.00",
      tradingFeesUsd: "0.15",
      fundingPnlUsd: "-0.02",
    });

    await service.runExecutionNotificationTick();

    const headings = telegram.sent.map((message) => message.text.split("\n")[0]);
    expect(headings).toEqual(["🟦 LIMIT PLACED", "🟩 POSITION FILLED", "✅ CLOSED — TAKE PROFIT"]);
    // The closure is not allowed to overtake the fill just because it is the
    // execution's current state.
    expect(headings.indexOf("✅ CLOSED — TAKE PROFIT")).toBeGreaterThan(headings.indexOf("🟩 POSITION FILLED"));
  });
});

// ---------------------------------------------------------------------------
// 14-15. CriticalAlert runtime delivery
// ---------------------------------------------------------------------------

describeDb("critical alerts through the tick", () => {
  async function raise(executionId: string, alertType: string, reasonCode: string) {
    const alerts = new CriticalAlertService(prisma!, async () => {
      throw new Error("Phase 7 sender must not be used by the Phase 9 runner");
    });
    return alerts.raise({
      tradeExecutionId: executionId,
      alertType: alertType as never,
      reasonCode,
      details: { symbol: SYMBOL, positionSide: "LONG", confirmedOpenQuantity: "0.25", protectedStopQuantity: "0.10" },
    });
  }

  it("discovers and delivers an alert raised while the runner was offline", async () => {
    const id = await syntheticExecution("MANUAL_INTERVENTION");
    const alert = await raise(id, "STOP_NOT_VERIFIED", "STOP_NOT_VERIFIED");

    const summary = await service.runExecutionNotificationTick();
    expect(summary.delivery.criticalDelivered).toBeGreaterThanOrEqual(1);

    const stored = await prisma!.criticalAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(stored.status).toBe("SENT");
    // Phase 7 identity untouched, and no ExecutionNotification duplicate.
    expect(stored.dedupeKey).toBe(alert.dedupeKey);
    expect(await notificationsFor(id)).toHaveLength(0);
    expect(telegram.sent[0].text).toContain("🚨 CRITICAL — PROTECTION FAILURE");
    expect(telegram.sent[0].chatId).toBe(MAIN_CHAT);
  });

  it("delivers a newer critical alert before an older informational notification", async () => {
    const infoId = await syntheticExecution();
    await entryReconciled(infoId, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });
    // Materialize the informational intent first, so it is strictly older.
    await service.runExecutionNotificationTick();
    telegram.sent.length = 0;
    await prisma!.executionNotification.updateMany({
      where: { tradeExecutionId: infoId },
      data: { deliveryStatus: "PENDING", deliveredAt: null, attemptCount: 0 },
    });

    const criticalId = await syntheticExecution("MANUAL_INTERVENTION");
    await raise(criticalId, "LIQUIDATION_BUFFER_UNSAFE", "LIQUIDATION_BUFFER_UNSAFE");

    await service.runExecutionNotificationTick();

    const headings = telegram.sent.map((message) => message.text.split("\n")[0]);
    expect(headings[0]).toBe("🚨 CRITICAL — PROTECTION FAILURE");
    expect(headings).toContain("🟦 LIMIT PLACED");
  });
});

// ---------------------------------------------------------------------------
// 16. Telegram disabled
// ---------------------------------------------------------------------------

describeDb("Telegram disabled", () => {
  it("materializes durably, dispatches nothing and burns no attempts", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });
    const before = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });

    const disabled = build({ deliveryEnabled: false });
    // Several ticks, exactly as a scheduler would run them.
    for (let pass = 0; pass < 5; pass += 1) await disabled.runExecutionNotificationTick();

    const rows = await notificationsFor(id);
    // History is preserved...
    expect(describeOf(rows)).toEqual(["LIMIT_PLACED"]);
    expect(rows[0].deliveryStatus).toBe("PENDING");
    // ...nothing was sent...
    expect(telegram.sent).toHaveLength(0);
    // ...and no attempt was consumed, so the bounded retry budget is intact
    // when Telegram is switched back on.
    expect(rows[0].attemptCount).toBe(0);
    expect(rows[0].claimedAt).toBeNull();

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });
    expect(after.version).toBe(before.version);
    expect(after.status).toBe(before.status);

    // Re-enabling delivers the intent that was waiting.
    await service.runExecutionNotificationTick();
    expect((await notificationsFor(id))[0].deliveryStatus).toBe("DELIVERED");
  });
});

// ---------------------------------------------------------------------------
// 17. The tick changes no lifecycle state
// ---------------------------------------------------------------------------

describeDb("lifecycle isolation", () => {
  it("leaves every execution table byte-identical", async () => {
    const id = await syntheticExecution();
    await entryReconciled(id, { localOrderStatus: "NEW", cumulativeFilledQuantity: "0" });
    await entryReconciled(id, { localOrderStatus: "FILLED", cumulativeFilledQuantity: "0.25", toStatus: "ENTRY_FILLED" });
    await protectionVerified(id, "0.25", 1);
    await prisma!.safetyAdmission.create({
      data: {
        tradeExecutionId: id,
        evaluatedVersion: 1,
        evaluatedAt: new Date(),
        decision: "PASS",
        reasonCode: "CAPACITY_AVAILABLE",
      },
    });
    await prisma!.marginAdjustmentIntent.create({
      data: {
        tradeExecutionId: id,
        attempt: 1,
        symbol: SYMBOL,
        positionSide: "LONG",
        amount: "1.00",
        status: "CONFIRMED",
      },
    });

    const snapshot = async () => ({
      execution: await prisma!.tradeExecution.findUniqueOrThrow({ where: { id } }),
      orders: await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: id }, orderBy: { id: "asc" } }),
      protection: await prisma!.executionProtectionState.findUniqueOrThrow({ where: { tradeExecutionId: id } }),
      admissions: await prisma!.safetyAdmission.findMany({ where: { tradeExecutionId: id }, orderBy: { id: "asc" } }),
      margins: await prisma!.marginAdjustmentIntent.findMany({ where: { tradeExecutionId: id }, orderBy: { id: "asc" } }),
      events: await prisma!.executionEvent.findMany({ where: { tradeExecutionId: id }, orderBy: { sequenceNumber: "asc" } }),
      verifications: await prisma!.executionProtectionVerification.findMany({ where: { tradeExecutionId: id }, orderBy: { protectionVersion: "asc" } }),
    });

    const before = JSON.stringify(await snapshot());
    await service.runExecutionNotificationTick();
    await service.runExecutionNotificationTick();
    const after = JSON.stringify(await snapshot());

    expect(after).toBe(before);
    // And the tick genuinely did work.
    expect((await notificationsFor(id)).length).toBeGreaterThan(0);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Phase 9 outbox tests against a real Postgres with a FAKE Telegram sender.
 *
 * No test in this file can reach api.telegram.org or Binance: the transport is
 * an in-memory fake that records every call, and the code under test imports no
 * exchange connector. Every row is synthetic and removed in afterAll.
 */

const TAG = "phase9-synthetic";
const SYMBOL = "TESTNUSDT";
const EXECUTION_CHAT = "-1001111111111";
const MAIN_CHAT = "-1002222222222";

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
      `[phase9] Skipping notification outbox tests — no database reachable: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`
    );
  }
} else {
  console.warn("[phase9] Skipping notification outbox tests — no DATABASE_URL could be resolved.");
}

const { ExecutionNotificationService, CLAIM_LEASE_MS, MAX_RETRYABLE_ATTEMPTS, sanitizeNotificationPayload } =
  await import("../src/modules/notifications/execution-notification.service");
const { CriticalAlertService } = await import("../src/modules/execution/critical-alert.service");

type Service = InstanceType<typeof ExecutionNotificationService>;

// ---------------------------------------------------------------------------
// Fake Telegram transport
// ---------------------------------------------------------------------------

interface SentMessage {
  chatId: string;
  text: string;
}

class FakeTelegram {
  readonly sent: SentMessage[] = [];
  /** Scripted outcome for the next N calls. */
  mode: "OK" | "TRANSIENT" | "PERMANENT" | "THROW" = "OK";
  /** Resolves when a send has started, so a concurrent claim can be attempted. */
  gate: (() => void) | null = null;
  inFlight = 0;
  maxConcurrent = 0;

  readonly send = async (chatId: string, text: string) => {
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      if (this.gate) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (this.mode === "THROW") throw new Error("socket hang up at https://api.telegram.org/bot123:SECRET/sendMessage");
      if (this.mode === "TRANSIENT") {
        return {
          delivered: false,
          retryable: true,
          errorCode: "TELEGRAM_DELIVERY_RETRYABLE" as const,
          sanitizedError: "Telegram responded with HTTP 503.",
        };
      }
      if (this.mode === "PERMANENT") {
        return {
          delivered: false,
          retryable: false,
          errorCode: "TELEGRAM_DELIVERY_PERMANENT_FAILURE" as const,
          sanitizedError: "Telegram responded with HTTP 400.",
        };
      }
      // The dispatcher legitimately drains the whole outbox, and other suites
      // share this database. Only messages about THIS file's synthetic symbol
      // are recorded, so an assertion here measures this file's behaviour and
      // not another suite's leftovers.
      if (text.includes(SYMBOL)) this.sent.push({ chatId, text });
      return { delivered: true, retryable: false, errorCode: null, sanitizedError: null };
    } finally {
      this.inFlight -= 1;
    }
  };
}

let telegram: FakeTelegram;
let service: Service;
let profileId = "";
let sequence = 0;
const executionIds: string[] = [];

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

interface SyntheticOptions {
  status?: string;
  direction?: "LONG" | "SHORT";
  actual?: Record<string, unknown>;
  entry?: { status: string; executedQuantity: string; averageFillPrice?: string | null; reconciled?: boolean } | null;
  protection?: Record<string, unknown> | null;
  protectionOrders?: boolean;
}

async function synthetic(options: SyntheticOptions = {}): Promise<string> {
  sequence += 1;
  const direction = options.direction ?? "LONG";
  const execution = await prisma!.tradeExecution.create({
    data: {
      executionProfileId: profileId,
      symbol: SYMBOL,
      direction,
      positionSide: direction,
      selectedLookback: 200,
      signalTriggeredAt: new Date(Date.now() - 60_000),
      status: (options.status ?? "PLAN_READY") as never,
      plannedEntryPrice: "0.2707",
      calculatedStopLoss: "0.2656",
      executableStopLoss: "0.2656",
      takeProfit: "0.3011",
      riskBudgetUsd: "1.50",
      quantityRaw: "294",
      plannedQuantity: "294",
      quantityStepSize: "1",
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
      ...(options.actual ?? {}),
    },
  });
  executionIds.push(execution.id);

  if (options.entry !== null && options.entry !== undefined) {
    await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: "ENTRY",
        generation: 1,
        clientOrderId: `${TAG}-${execution.id}-ENTRY-1`,
        side: direction === "LONG" ? "BUY" : "SELL",
        positionSide: direction,
        orderType: "LIMIT",
        timeInForce: "GTC",
        price: "0.2707",
        originalQuantity: "294",
        executedQuantity: options.entry.executedQuantity,
        averageFillPrice: options.entry.averageFillPrice ?? undefined,
        status: options.entry.status as never,
        // The marker that separates "reconciliation read it back" from a bare
        // submission ACK.
        lastReconcileAt: options.entry.reconciled === false ? null : new Date(),
      },
    });
  }

  if (options.protection) {
    await prisma!.executionProtectionState.create({
      data: { tradeExecutionId: execution.id, ...options.protection } as never,
    });
    if (options.protectionOrders !== false) {
      for (const [role, trigger] of [
        ["STOP_LOSS", "0.2656"],
        ["TAKE_PROFIT", "0.3011"],
      ] as const) {
        await prisma!.binanceOrder.create({
          data: {
            tradeExecutionId: execution.id,
            role,
            generation: Number(options.protection.currentGeneration ?? 1),
            clientOrderId: `${TAG}-${execution.id}-${role}-${options.protection.currentGeneration ?? 1}`,
            clientAlgoId: `${TAG}-${execution.id}-${role}-${options.protection.currentGeneration ?? 1}`,
            side: direction === "LONG" ? "SELL" : "BUY",
            positionSide: direction,
            orderType: role === "STOP_LOSS" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
            originalQuantity: "294",
            triggerPrice: trigger,
            status: "NEW",
          },
        });
      }
    }
  }

  return execution.id;
}

function rowsFor(executionId: string) {
  return prisma!.executionNotification.findMany({
    where: { tradeExecutionId: executionId },
    orderBy: [{ createdAt: "asc" }, { milestoneSequence: "asc" }, { id: "asc" }],
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: { name: "Phase 9 profile", accountIdentifier: `${TAG}-account`, environment: "TESTNET", isEnabled: true },
  });
  profileId = profile.id;
});

afterEach(() => {
  if (telegram) {
    telegram.mode = "OK";
    telegram.gate = null;
  }
});

beforeAll(() => {
  telegram = new FakeTelegram();
  if (!prisma || !available) return;
  service = new ExecutionNotificationService(prisma, telegram.send, {
    execution: EXECUTION_CHAT,
    critical: MAIN_CHAT, deliveryEnabled: true,
  });
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await prisma.executionNotification.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.criticalAlert.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.executionProtectionState.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma.tradeExecution.deleteMany({ where: { id: { in: executionIds } } });
    if (profileId) await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
});

const describeDb = available ? describe : describe.skip;

/**
 * Delivery tests assert on exactly what left the transport, so each one starts
 * from an empty outbox. Rows left behind by the materialization suite are
 * removed rather than delivered — draining them would pollute the send log.
 */
async function emptyOutbox(): Promise<void> {
  await prisma!.executionNotification.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
  await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
  telegram.sent.length = 0;
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

describeDb("materialization", () => {
  it("creates one LIMIT_PLACED intent for a confirmed active entry", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    const result = await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    expect(result.created).toBe(1);
    const rows = await rowsFor(id);
    expect(rows.map((row) => row.notificationType)).toEqual(["LIMIT_PLACED"]);
    expect(rows[0].deliveryStatus).toBe("PENDING");
    expect(rows[0].attemptCount).toBe(0);
  });

  it("creates nothing from a submission that was never reconciled", async () => {
    const id = await synthetic({
      status: "ENTRY_SUBMITTING",
      entry: { status: "SUBMITTING", executedQuantity: "0", reconciled: false },
    });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    expect(await rowsFor(id)).toHaveLength(0);
  });

  it("is idempotent — a re-run against unchanged state creates nothing", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    const second = await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    expect(second.created).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(await rowsFor(id)).toHaveLength(1);
  });

  it("adds a new PARTIAL_FILL only when the cumulative quantity grows", async () => {
    const id = await synthetic({
      status: "PARTIALLY_FILLED",
      entry: { status: "PARTIALLY_FILLED", executedQuantity: "100", averageFillPrice: "0.2707" },
    });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    // Same observation again.
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    expect((await rowsFor(id)).filter((row) => row.notificationType === "PARTIAL_FILL")).toHaveLength(1);

    await prisma!.binanceOrder.updateMany({
      where: { tradeExecutionId: id, role: "ENTRY" },
      data: { executedQuantity: "150" },
    });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    const partials = (await rowsFor(id)).filter((row) => row.notificationType === "PARTIAL_FILL");
    expect(partials).toHaveLength(2);
    expect(partials.map((row) => (row.payloadSnapshot as { filledQuantity: string }).filledQuantity)).toEqual([
      "100",
      "150",
    ]);
  });

  it("closes the fill with POSITION_FILLED instead of a redundant final partial", async () => {
    const id = await synthetic({
      status: "PARTIALLY_FILLED",
      entry: { status: "PARTIALLY_FILLED", executedQuantity: "150", averageFillPrice: "0.2707" },
    });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    await prisma!.binanceOrder.updateMany({
      where: { tradeExecutionId: id, role: "ENTRY" },
      data: { executedQuantity: "294", status: "FILLED" },
    });
    await prisma!.tradeExecution.update({ where: { id }, data: { status: "ENTRY_FILLED" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    const types = (await rowsFor(id)).map((row) => row.notificationType);
    expect(types).toEqual(["LIMIT_PLACED", "PARTIAL_FILL", "POSITION_FILLED"]);
    // The final 294 was never announced as a partial.
    const partialQuantities = (await rowsFor(id))
      .filter((row) => row.notificationType === "PARTIAL_FILL")
      .map((row) => (row.payloadSnapshot as { filledQuantity: string }).filledQuantity);
    expect(partialQuantities).toEqual(["150"]);
  });

  it("earns a second POSITION_PROTECTED only when the protected exposure grows", async () => {
    const id = await synthetic({
      status: "PROTECTED",
      entry: { status: "PARTIALLY_FILLED", executedQuantity: "100" },
      protection: {
        state: "PROTECTED",
        confirmedOpenQuantity: "100",
        protectedStopQuantity: "100",
        protectedTakeProfitQuantity: "100",
        currentGeneration: 1,
        liquidationSafe: true,
      },
    });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    // Reconciled again, same coverage.
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    expect((await rowsFor(id)).filter((row) => row.notificationType === "POSITION_PROTECTED")).toHaveLength(1);

    await prisma!.executionProtectionState.update({
      where: { tradeExecutionId: id },
      data: { confirmedOpenQuantity: "294", protectedStopQuantity: "294", protectedTakeProfitQuantity: "294" },
    });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    const protectedRows = (await rowsFor(id)).filter((row) => row.notificationType === "POSITION_PROTECTED");
    expect(protectedRows).toHaveLength(2);
    expect(protectedRows.map((row) => (row.payloadSnapshot as { protectedQuantity: string }).protectedQuantity)).toEqual(
      ["100", "294"]
    );
  });

  it("requires proven zero exposure before announcing an expiry", async () => {
    const stillOpen = await synthetic({
      status: "ENTRY_EXPIRED",
      entry: { status: "CANCELED", executedQuantity: "100" },
      protection: {
        state: "PROTECTED",
        confirmedOpenQuantity: "100",
        protectedStopQuantity: "100",
        protectedTakeProfitQuantity: "100",
        currentGeneration: 1,
        liquidationSafe: true,
      },
    });
    await service.materializeExecutionNotifications({ executionId: stillOpen, evaluatedAt: new Date() });
    expect((await rowsFor(stillOpen)).map((row) => row.notificationType)).not.toContain("ENTRY_EXPIRED");

    const flat = await synthetic({ status: "ENTRY_EXPIRED", entry: { status: "EXPIRED", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: flat, evaluatedAt: new Date() });
    expect((await rowsFor(flat)).map((row) => row.notificationType)).toContain("ENTRY_EXPIRED");
  });

  it("creates exactly one closure intent per terminal status", async () => {
    for (const status of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY"]) {
      const id = await synthetic({
        status,
        entry: null,
        actual: { actualExitPrice: "0.3011", realizedPnl: "3.00", tradingFeesUsd: "0.15", fundingPnlUsd: "-0.02" },
      });
      await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
      await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

      const rows = await rowsFor(id);
      expect(rows.map((row) => row.notificationType), status).toEqual([status]);
      expect((rows[0].payloadSnapshot as { netPnlUsd: string }).netPnlUsd, status).toBe("2.83");
    }
  });

  it("creates one TRADE_SKIPPED for a terminal skip and none for a live execution", async () => {
    const skipped = await synthetic({ status: "SKIPPED", entry: null });
    await prisma!.tradeExecution.update({
      where: { id: skipped },
      data: { decisionReasonCode: "MAX_OPEN_POSITIONS_REACHED", sanitizedMessage: "Capacity is exhausted." },
    });
    await service.materializeExecutionNotifications({ executionId: skipped, evaluatedAt: new Date() });
    await service.materializeExecutionNotifications({ executionId: skipped, evaluatedAt: new Date() });
    expect((await rowsFor(skipped)).map((row) => row.notificationType)).toEqual(["TRADE_SKIPPED"]);

    const unavailable = await synthetic({ status: "PLAN_READY", entry: null });
    await prisma!.tradeExecution.update({
      where: { id: unavailable },
      data: { decisionReasonCode: "BINANCE_STATE_UNAVAILABLE" },
    });
    await service.materializeExecutionNotifications({ executionId: unavailable, evaluatedAt: new Date() });
    expect(await rowsFor(unavailable)).toHaveLength(0);
  });

  it("changes no execution lifecycle value", async () => {
    const id = await synthetic({ status: "PROTECTED", entry: { status: "FILLED", executedQuantity: "294" } });
    const before = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });
    const eventsBefore = await prisma!.executionEvent.count({ where: { tradeExecutionId: id } });

    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    await service.dispatchPendingNotifications();

    const after = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });
    expect(after.version).toBe(before.version);
    expect(after.status).toBe(before.status);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.requiresManualIntervention).toBe(before.requiresManualIntervention);
    expect(await prisma!.executionEvent.count({ where: { tradeExecutionId: id } })).toBe(eventsBefore);
  });

  it("returns an empty result for an unknown execution instead of throwing", async () => {
    const result = await service.materializeExecutionNotifications({
      executionId: "does-not-exist",
      evaluatedAt: new Date(),
    });
    expect(result).toEqual({ created: 0, alreadyPresent: 0, earned: 0 });
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describeDb("concurrent materialization", () => {
  it("creates one row when two materializers run at once", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    const results = await Promise.all([
      service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() }),
      service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() }),
    ]);

    expect(await rowsFor(id)).toHaveLength(1);
    expect(results.reduce((total, result) => total + result.created, 0)).toBe(1);
  });

  it("creates one row when five materializers run at once", async () => {
    const id = await synthetic({
      status: "ENTRY_FILLED",
      entry: { status: "FILLED", executedQuantity: "294", averageFillPrice: "0.2707" },
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() })
      )
    );

    const rows = await rowsFor(id);
    expect(rows).toHaveLength(2); // LIMIT_PLACED + POSITION_FILLED
    expect(results.reduce((total, result) => total + result.created, 0)).toBe(2);
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describeDb("delivery", () => {
  beforeEach(emptyOutbox);

  it("marks a successful send DELIVERED and sends it to the execution chat", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    const before = telegram.sent.length;
    const summary = await service.dispatchPendingNotifications();
    expect(summary.notificationsDelivered).toBeGreaterThanOrEqual(1);

    const [row] = await rowsFor(id);
    expect(row.deliveryStatus).toBe("DELIVERED");
    expect(row.deliveredAt).not.toBeNull();
    expect(row.attemptCount).toBe(1);
    expect(row.claimedAt).toBeNull();

    const sent = telegram.sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(EXECUTION_CHAT);
    expect(sent[0].text).toContain("🟦 LIMIT PLACED");
  });

  it("never re-sends a delivered notification", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    await service.dispatchPendingNotifications();

    const before = telegram.sent.length;
    await service.dispatchPendingNotifications();
    await service.dispatchPendingNotifications();
    expect(telegram.sent.length).toBe(before);
    expect((await rowsFor(id))[0].attemptCount).toBe(1);
  });

  it("keeps a transient failure retryable and increments the attempt count", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    telegram.mode = "TRANSIENT";
    await service.dispatchPendingNotifications();
    let [row] = await rowsFor(id);
    expect(row.deliveryStatus).toBe("RETRYABLE_FAILURE");
    expect(row.attemptCount).toBe(1);
    expect(row.lastErrorCode).toBe("TELEGRAM_DELIVERY_RETRYABLE");
    expect(row.deliveredAt).toBeNull();

    telegram.mode = "OK";
    await service.dispatchPendingNotifications();
    [row] = await rowsFor(id);
    expect(row.deliveryStatus).toBe("DELIVERED");
    expect(row.attemptCount).toBe(2);
    expect(row.lastErrorCode).toBeNull();
  });

  it("marks a rejected payload as a permanent failure and stops retrying it", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    telegram.mode = "PERMANENT";
    await service.dispatchPendingNotifications();
    const [row] = await rowsFor(id);
    expect(row.deliveryStatus).toBe("PERMANENT_FAILURE");
    expect(row.lastErrorCode).toBe("TELEGRAM_DELIVERY_PERMANENT_FAILURE");

    telegram.mode = "OK";
    const before = telegram.sent.length;
    await service.dispatchPendingNotifications();
    // The durable row still exists; it is simply not retried.
    expect(telegram.sent.length).toBe(before);
    expect(await prisma!.executionNotification.count({ where: { id: row.id } })).toBe(1);
  });

  it("treats a throwing transport as retryable and leaks no token from the error", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    telegram.mode = "THROW";
    await expect(service.dispatchPendingNotifications()).resolves.toBeDefined();
    const [row] = await rowsFor(id);
    expect(row.deliveryStatus).toBe("RETRYABLE_FAILURE");
    expect(row.sanitizedLastError ?? "").not.toContain("SECRET");
  });

  it("stops retrying a row that has exhausted the bounded attempt budget", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    await prisma!.executionNotification.updateMany({
      where: { tradeExecutionId: id },
      data: { attemptCount: MAX_RETRYABLE_ATTEMPTS, deliveryStatus: "RETRYABLE_FAILURE" },
    });

    const before = telegram.sent.length;
    await service.dispatchPendingNotifications();
    expect(telegram.sent.length).toBe(before);
  });

  it("honours the batch size", async () => {
    const ids = await Promise.all([
      synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } }),
      synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } }),
      synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } }),
    ]);
    for (const id of ids) await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    const summary = await service.dispatchPendingNotifications({ batchSize: 2 });
    expect(summary.notificationsDelivered).toBeLessThanOrEqual(2);
  });

  it("delivers in causal order after a restart materializes a whole history at once", async () => {
    const id = await synthetic({
      status: "CLOSED_TP",
      entry: { status: "FILLED", executedQuantity: "294", averageFillPrice: "0.2707" },
      protection: {
        state: "PROTECTED",
        confirmedOpenQuantity: "294",
        protectedStopQuantity: "294",
        protectedTakeProfitQuantity: "294",
        currentGeneration: 1,
        liquidationSafe: true,
      },
      actual: { actualExitPrice: "0.3011", realizedPnl: "3.00", tradingFeesUsd: "0.15", fundingPnlUsd: "-0.02" },
    });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    const before = telegram.sent.length;
    await service.dispatchPendingNotifications();
    const headings = telegram.sent.slice(before).map((message) => message.text.split("\n")[0]);

    expect(headings).toEqual([
      "🟦 LIMIT PLACED",
      "🟩 POSITION FILLED",
      "🛡 POSITION PROTECTED",
      "✅ CLOSED — TAKE PROFIT",
    ]);
  });

  it("falls back to the main chat when no execution chat is configured", async () => {
    const fallbackTelegram = new FakeTelegram();
    const fallbackService = new ExecutionNotificationService(prisma!, fallbackTelegram.send, {
      execution: MAIN_CHAT,
      critical: MAIN_CHAT, deliveryEnabled: true,
    });
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await fallbackService.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    await fallbackService.dispatchPendingNotifications();

    expect(fallbackTelegram.sent.map((message) => message.chatId)).toEqual([MAIN_CHAT]);
  });

  it("keeps the notification retryable when no destination exists at all", async () => {
    const orphanTelegram = new FakeTelegram();
    const orphanService = new ExecutionNotificationService(prisma!, orphanTelegram.send, {
      execution: null,
      critical: null, deliveryEnabled: true,
    });
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await orphanService.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    await orphanService.dispatchPendingNotifications();

    const [row] = await rowsFor(id);
    expect(orphanTelegram.sent).toHaveLength(0);
    expect(row.deliveryStatus).toBe("RETRYABLE_FAILURE");
    expect(row.lastErrorCode).toBe("TELEGRAM_DESTINATION_UNAVAILABLE");
  });

  it("never writes a chat id or a token into the stored row", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    await service.dispatchPendingNotifications();

    const serialized = JSON.stringify(await rowsFor(id));
    for (const forbidden of [EXECUTION_CHAT, MAIN_CHAT, "bot", "apiKey", "chat_id"]) {
      expect(`${forbidden}:${serialized.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent delivery / crash recovery
// ---------------------------------------------------------------------------

describeDb("concurrent delivery", () => {
  beforeEach(emptyOutbox);

  it("lets only one of two dispatchers send the same notification", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    const shared = new FakeTelegram();
    shared.gate = () => undefined; // slow the send so the claims genuinely overlap
    const a = new ExecutionNotificationService(prisma!, shared.send, { execution: EXECUTION_CHAT, critical: MAIN_CHAT, deliveryEnabled: true });
    const b = new ExecutionNotificationService(prisma!, shared.send, { execution: EXECUTION_CHAT, critical: MAIN_CHAT, deliveryEnabled: true });

    await Promise.all([a.dispatchPendingNotifications(), b.dispatchPendingNotifications()]);

    const forThisExecution = shared.sent.filter((message) => message.text.includes("0.2707"));
    expect(forThisExecution).toHaveLength(1);
    expect((await rowsFor(id))[0].attemptCount).toBe(1);
  });

  it("reclaims a lease left behind by a crashed process", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    // The process died after claiming and before Telegram answered.
    await prisma!.executionNotification.updateMany({
      where: { tradeExecutionId: id },
      data: { claimedAt: new Date(Date.now() - CLAIM_LEASE_MS * 2), claimOwner: "dead-process", attemptCount: 1 },
    });

    // A fresh lease is not stealable...
    await prisma!.executionNotification.updateMany({
      where: { tradeExecutionId: id },
      data: { claimedAt: new Date() },
    });
    const beforeFresh = telegram.sent.length;
    await service.dispatchPendingNotifications();
    expect(telegram.sent.length).toBe(beforeFresh);

    // ...but a stale one is.
    await prisma!.executionNotification.updateMany({
      where: { tradeExecutionId: id },
      data: { claimedAt: new Date(Date.now() - CLAIM_LEASE_MS * 2) },
    });
    await service.dispatchPendingNotifications();
    expect((await rowsFor(id))[0].deliveryStatus).toBe("DELIVERED");
  });

  it("re-sends once after a crash between a successful send and the delivered mark", async () => {
    // Telegram offers no exactly-once guarantee. The durable intent survives,
    // so recovery re-sends it: at-least-once, and a duplicate carries the same
    // Ref line rather than looking like a second trade event.
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });

    const before = telegram.sent.length;
    await service.dispatchPendingNotifications();
    expect(telegram.sent.length).toBe(before + 1);

    // Simulate the local mark never landing.
    await prisma!.executionNotification.updateMany({
      where: { tradeExecutionId: id },
      data: { deliveryStatus: "PENDING", deliveredAt: null, claimedAt: null, claimOwner: null },
    });
    await service.dispatchPendingNotifications();

    const sent = telegram.sent.slice(before);
    expect(sent).toHaveLength(2);
    const references = sent.map((message) => message.text.split("\n").at(-1));
    expect(references[0]).toBe(references[1]);
  });

  it("never reverts a delivered row to pending", async () => {
    const id = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    await service.dispatchPendingNotifications();

    telegram.mode = "TRANSIENT";
    await service.dispatchPendingNotifications();
    expect((await rowsFor(id))[0].deliveryStatus).toBe("DELIVERED");
  });
});

// ---------------------------------------------------------------------------
// CriticalAlert integration
// ---------------------------------------------------------------------------

describeDb("critical alert integration", () => {
  beforeEach(emptyOutbox);

  async function raiseCritical(executionId: string, alertType: string, reasonCode: string) {
    const alerts = new CriticalAlertService(prisma!, async () => {
      throw new Error("Phase 7 sender must not be used by the Phase 9 dispatcher");
    });
    return alerts.raise({
      tradeExecutionId: executionId,
      alertType: alertType as never,
      reasonCode,
      details: {
        symbol: SYMBOL,
        positionSide: "LONG",
        confirmedOpenQuantity: "294",
        protectedStopQuantity: "100",
        requiredAction: "Verify the stop on Binance.",
      },
    });
  }

  it("delivers the existing Phase 7 record without creating a second critical model", async () => {
    const id = await synthetic({ status: "MANUAL_INTERVENTION", entry: null });
    const alert = await raiseCritical(id, "STOP_NOT_VERIFIED", "STOP_NOT_VERIFIED");

    await service.materializeExecutionNotifications({ executionId: id, evaluatedAt: new Date() });
    // No ExecutionNotification row is ever created for a critical condition.
    expect(await rowsFor(id)).toHaveLength(0);

    const before = telegram.sent.length;
    const summary = await service.dispatchPendingNotifications();
    expect(summary.criticalDelivered).toBe(1);

    const sent = telegram.sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(MAIN_CHAT);
    expect(sent[0].text).toContain("🚨 CRITICAL — PROTECTION FAILURE");
    expect(sent[0].text).toContain("Reason: STOP_NOT_VERIFIED");
    expect(sent[0].text).toContain("Exposure: 294");

    const stored = await prisma!.criticalAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(stored.status).toBe("SENT");
    // The Phase 7 dedupe identity is untouched.
    expect(stored.dedupeKey).toBe(alert.dedupeKey);
  });

  it("does not spam when the same condition is re-raised", async () => {
    const id = await synthetic({ status: "MANUAL_INTERVENTION", entry: null });
    await raiseCritical(id, "PROTECTION_COVERAGE_INCOMPLETE", "PROTECTION_COVERAGE_INCOMPLETE");
    await raiseCritical(id, "PROTECTION_COVERAGE_INCOMPLETE", "PROTECTION_COVERAGE_INCOMPLETE");
    await raiseCritical(id, "PROTECTION_COVERAGE_INCOMPLETE", "PROTECTION_COVERAGE_INCOMPLETE");

    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: id } })).toBe(1);

    const before = telegram.sent.length;
    await service.dispatchPendingNotifications();
    await service.dispatchPendingNotifications();
    expect(telegram.sent.length).toBe(before + 1);
  });

  it("delivers every critical alert before any informational message", async () => {
    const infoId = await synthetic({ status: "ENTRY_PENDING", entry: { status: "NEW", executedQuantity: "0" } });
    await service.materializeExecutionNotifications({ executionId: infoId, evaluatedAt: new Date() });

    const criticalId = await synthetic({ status: "MANUAL_INTERVENTION", entry: null });
    // Raised AFTER the informational row, so chronology alone would put it last.
    await raiseCritical(criticalId, "LIQUIDATION_BUFFER_UNSAFE", "LIQUIDATION_BUFFER_UNSAFE");

    const before = telegram.sent.length;
    await service.dispatchPendingNotifications();
    const headings = telegram.sent.slice(before).map((message) => message.text.split("\n")[0]);

    expect(headings[0]).toBe("🚨 CRITICAL — PROTECTION FAILURE");
    expect(headings).toContain("🟦 LIMIT PLACED");
  });

  it("keeps a failed critical send retryable and leaves protection state untouched", async () => {
    const id = await synthetic({
      status: "MANUAL_INTERVENTION",
      entry: null,
      protection: {
        state: "PROTECTION_INCOMPLETE",
        confirmedOpenQuantity: "294",
        protectedStopQuantity: "100",
        protectedTakeProfitQuantity: "0",
        currentGeneration: 1,
        liquidationSafe: false,
      },
    });
    const alert = await raiseCritical(id, "STOP_NOT_VERIFIED", "STOP_SUBMISSION_RESULT_UNKNOWN");
    const protectionBefore = await prisma!.executionProtectionState.findUniqueOrThrow({
      where: { tradeExecutionId: id },
    });

    telegram.mode = "TRANSIENT";
    await service.dispatchPendingNotifications();

    let stored = await prisma!.criticalAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.attempts).toBe(1);
    expect(stored.claimedAt).toBeNull();

    const protectionAfter = await prisma!.executionProtectionState.findUniqueOrThrow({
      where: { tradeExecutionId: id },
    });
    expect(protectionAfter.version).toBe(protectionBefore.version);
    expect(protectionAfter.state).toBe(protectionBefore.state);
    expect(protectionAfter.updatedAt.getTime()).toBe(protectionBefore.updatedAt.getTime());

    telegram.mode = "OK";
    await service.dispatchPendingNotifications();
    stored = await prisma!.criticalAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(stored.status).toBe("SENT");
  });

  it("lets only one of two dispatchers send the same critical alert", async () => {
    const id = await synthetic({ status: "MANUAL_INTERVENTION", entry: null });
    await raiseCritical(id, "ORPHAN_PROTECTION_ORDER", "ORPHAN_PROTECTION_ORDER");

    const shared = new FakeTelegram();
    shared.gate = () => undefined;
    const a = new ExecutionNotificationService(prisma!, shared.send, { execution: EXECUTION_CHAT, critical: MAIN_CHAT, deliveryEnabled: true });
    const b = new ExecutionNotificationService(prisma!, shared.send, { execution: EXECUTION_CHAT, critical: MAIN_CHAT, deliveryEnabled: true });

    await Promise.all([a.dispatchPendingNotifications(), b.dispatchPendingNotifications()]);

    const forThisAlert = shared.sent.filter((message) => message.text.includes("ORPHAN_PROTECTION_ORDER"));
    expect(forThisAlert).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

describeDb("payload sanitization", () => {
  it("drops credential-like keys entirely rather than merely redacting the value", () => {
    const cleaned = sanitizeNotificationPayload({
      symbol: "FRAXUSDT",
      apiKey: "abc",
      nested: { apiSecret: "xyz", deep: { authorization: "Bearer x", chatId: "-100123", keep: "yes" } },
      list: [{ signature: "deadbeef", quantity: "1" }],
      walletBalance: "1000",
      accountIdentifier: "primary-futures",
      rawTelegramResponse: { ok: true },
    }) as Record<string, unknown>;

    const serialized = JSON.stringify(cleaned);
    for (const forbidden of [
      "apiKey",
      "apiSecret",
      "authorization",
      "chatId",
      "signature",
      "walletBalance",
      "accountIdentifier",
      "rawTelegramResponse",
      "abc",
      "xyz",
      "Bearer",
      "deadbeef",
      "1000",
      "primary-futures",
    ]) {
      expect(`${forbidden}:${serialized.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // Legitimate content survives.
    expect(serialized).toContain("FRAXUSDT");
    expect(serialized).toContain("yes");
  });

  it("bounds a pathological nesting depth", () => {
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let level = 0; level < 20; level += 1) deep = { nested: deep };
    expect(() => sanitizeNotificationPayload(deep)).not.toThrow();
  });
});

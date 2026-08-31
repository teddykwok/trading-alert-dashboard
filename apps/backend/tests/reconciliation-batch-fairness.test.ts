import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

/**
 * Whether the reconciliation batch can starve a row it never reaches.
 *
 * The selector takes the `batchSize` oldest reconcilable rows by `updatedAt`,
 * with no cursor and no offset. A row that is inspected but requires no durable
 * write keeps its `updatedAt`, so it sorts identically on the next tick — and
 * if a whole batch behaves that way, the batch never moves.
 *
 * The live signature that prompted this: `inspected 10, attempted 0,
 * progressed 0, recoveryPending 1`, repeated across ticks, while the one
 * recovery-required execution stayed untouched. `recoveryPending` counts the
 * whole table, not the batch, so it can report work that the batch never sees.
 *
 * Real orchestrator, real services, real selector, real database. Only the
 * exchange transports are fake.
 */

const TAG = "fairness-synthetic";
const SYMBOL = "FAIRPUSDT";

const OVERRIDDEN = ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT"];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = `${TAG}-account`;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExecutionOrchestrator } = await import("../src/modules/execution/execution-orchestrator");
const { EntryLifecycleService } = await import("../src/modules/execution/entry-lifecycle.service");
const { ProtectionLifecycleService } = await import(
  "../src/modules/execution/protection-lifecycle.service"
);
const { SafetyAdmissionService } = await import("../src/modules/execution/safety-admission.service");
const { CriticalAlertService } = await import("../src/modules/execution/critical-alert.service");
const { ExecutionService } = await import("../src/modules/execution/execution.service");
const { buildClientOrderId } = await import("../src/modules/execution/execution-safety");
const { RECONCILABLE_STATUSES } = await import("../src/modules/execution/execution-orchestrator");

const maybe = () => (available ? it : it.skip);

let profileId = "";
let sequence = 0;

const scenario = {
  /** Per positionSide+symbol; "MISSING" means the exchange omits the row. */
  positionAmt: "0.100" as string | "MISSING",
  flatFor: new Set<string>(),
  mutations: [] as string[],
};

function resetScenario() {
  scenario.positionAmt = "0.100";
  scenario.flatFor = new Set();
  scenario.mutations = [];
}

const readOnlyStub = {
  async getAccountSummary() {
    return {
      connection: { ok: true, host: "fake", serverTimeMs: Date.now(), serverTimeIso: "", clockOffsetMs: 0, roundTripMs: 1 },
      positionMode: "HEDGE", assetMode: "SINGLE_ASSET",
      usdtWalletBalance: "500", usdtAvailableBalance: "500",
      nonZeroPositionCount: 1, openOrderCount: 0, openOrderSymbols: [] as string[],
      positions: [] as { symbol: string }[], warnings: [],
    };
  },
  async inspectSymbol(symbol: string) {
    return {
      filters: { symbol, status: "TRADING", contractType: "PERPETUAL", tickSize: "0.01", stepSize: "0.001", minQty: "0.001", minNotional: "5" },
      brackets: [{ bracket: 1, initialLeverage: 50, notionalCap: "100000", notionalFloor: "0", maintMarginRatio: "0.01", cum: "0" }],
      maxInitialLeverage: 50, accountSymbolConfig: null,
    };
  },
  async getPositionForSide(symbol: string, positionSide: string) {
    if (scenario.flatFor.has(symbol)) return null;
    return {
      symbol, positionSide, positionAmt: positionSide === "SHORT" ? "-0.100" : "0.100",
      entryPrice: "100", markPrice: "100", liquidationPrice: positionSide === "SHORT" ? "110" : "90",
      isolatedMargin: "8.00", isolatedWallet: "8.00", leverage: "10",
      unrealizedProfit: "0", notional: "10", marginType: "isolated",
    };
  },
  async queryAlgoOrderByClientAlgoId() {
    return null;
  },
  async queryOrderByClientOrderId(symbol: string, clientOrderId: string) {
    // Echoes the symbol asked about. Every row here has its own, and the
    // entry-identity check correctly rejects a mismatch.
    return {
      orderId: "EN1", clientOrderId, symbol, status: "FILLED",
      side: "BUY", positionSide: "LONG", type: "LIMIT", timeInForce: "GTC",
      price: "100", origQty: "0.100", executedQty: "0.100", averagePrice: "100",
      reduceOnly: false, closePosition: false, updateTimeMs: Date.now(),
    };
  },
};

const mutationStub = {
  get blockedReason() {
    return null;
  },
  authorizeProtectionSubmission: (i: Record<string, unknown>) => ({ ...i, kind: "PROTECTION_SUBMISSION" }),
  authorizeProtectionCancellation: (i: Record<string, unknown>) => ({ ...i, kind: "PROTECTION_CANCELLATION" }),
  authorizeMarginAddition: (i: Record<string, unknown>) => ({ ...i, kind: "MARGIN_ADDITION" }),
  authorizeEmergencyClose: (i: Record<string, unknown>) => ({ ...i, kind: "EMERGENCY_CLOSE" }),
  authorizeEntryCancellation: (i: Record<string, unknown>) => ({ ...i, kind: "ENTRY_CANCELLATION" }),
  async submitProtectionOrder(c: Record<string, string>) {
    scenario.mutations.push(`SUBMIT ${c.role}`);
    return { algoId: "A1", clientAlgoId: c.clientAlgoId, symbol: SYMBOL, algoStatus: "NEW" };
  },
  async cancelProtectionOrder(c: Record<string, string>) {
    scenario.mutations.push("CANCEL");
    return { algoId: "A1", clientAlgoId: c.clientAlgoId, symbol: SYMBOL, algoStatus: "CANCELED" };
  },
  async addIsolatedMargin() {
    scenario.mutations.push("MARGIN");
    return { code: 200, msg: "success" };
  },
  async cancelOrder(c: Record<string, string>) {
    scenario.mutations.push("CANCEL_ENTRY");
    return { orderId: "EN1", clientOrderId: c.clientOrderId, symbol: SYMBOL, status: "CANCELED" };
  },
};

/**
 * The orchestrator the worker builds, wrapped so the test can see exactly
 * WHICH executions each tick visited.
 *
 * The spy sits on the injected protection service — an existing dependency
 * seam — rather than on new production logging.
 */
function workerOrchestrator(visited: string[]) {
  const alerts = new CriticalAlertService(prisma!, async () => false);
  const protection = new ProtectionLifecycleService(
    prisma!, readOnlyStub as never, mutationStub as never, alerts
  );
  const spied = new Proxy(protection, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === "reconcileProtectionAndClosure" && typeof value === "function") {
        return async (input: { executionId: string }) => {
          visited.push(input.executionId);
          return (value as (i: unknown) => unknown).call(target, input);
        };
      }
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });

  return new ExecutionOrchestrator({
    prisma: prisma!,
    readOnly: readOnlyStub as never,
    admission: new SafetyAdmissionService(prisma!, readOnlyStub as never),
    entry: new EntryLifecycleService(prisma!, readOnlyStub as never, mutationStub as never),
    protection: spied as never,
    executions: new ExecutionService(prisma!),
    profileIdentity: { accountIdentifier: `${TAG}-account`, environment: "TESTNET" },
  });
}

/**
 * A worker, reused across ticks exactly as the scheduler reuses one.
 *
 * This matters: the scheduler builds ONE orchestrator for startup recovery and
 * every periodic tick, so anything it remembers between ticks lives here. A
 * fresh orchestrator per tick would be a different program.
 */
function makeWorker() {
  const visited: string[] = [];
  const orchestrator = workerOrchestrator(visited);
  return {
    // Exposed for the telemetry cases below, which need the same seam the
    // scheduler holds: ONE long-lived orchestrator.
    orchestrator,
    async tick() {
      visited.length = 0;
      const result = await orchestrator.runExecutionReconciliationTick();
      return { result, visited: [...visited] };
    },
  };
}

/** A single tick from a fresh worker, for cases that need no continuity. */
async function tick() {
  return makeWorker().tick();
}

const reload = (id: string) => prisma!.tradeExecution.findUniqueOrThrow({ where: { id } });

async function persistExecution(options: {
  status: string;
  updatedAt: Date;
  symbol?: string;
  parkedReason?: string;
}) {
  sequence += 1;
  const symbol = options.symbol ?? `${SYMBOL}${sequence}`;
  const execution = await prisma!.tradeExecution.create({
    data: {
      executionProfileId: profileId,
      symbol,
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 200,
      status: options.status as never,
      plannedEntryPrice: "100", calculatedStopLoss: "96", executableStopLoss: "96",
      takeProfit: "108", riskBudgetUsd: "1.50",
      quantityRaw: "0.100", plannedQuantity: "0.100", quantityStepSize: "0.001",
      actualPlannedLoss: "1.50", unusedRiskBudget: "0", positionNotional: "10.00",
      targetIsolatedMargin: "8.00", maximumIsolatedMargin: "8.00", selectedLeverage: 10,
      estimatedInitialMargin: "8.00", estimatedLiquidationPrice: "90.1",
      requiredLiquidationBoundary: "94", liquidationBufferRatio: "0.5",
      filledQuantity: "0.100", averageFillPrice: "100",
      firstFillAt: new Date("2026-08-31T10:00:00.000Z"),
      entryFilledAt: new Date("2026-08-31T10:00:00.000Z"),
      requiresManualIntervention: options.parkedReason !== undefined,
    },
  });

  await prisma!.binanceOrder.create({
    data: {
      tradeExecutionId: execution.id, role: "ENTRY", generation: 1,
      clientOrderId: buildClientOrderId(execution.id, "ENTRY", 1),
      side: "BUY", positionSide: "LONG", orderType: "LIMIT", timeInForce: "GTC",
      price: "100", originalQuantity: "0.100", executedQuantity: "0.100", status: "FILLED",
    },
  });

  if (options.parkedReason) {
    await prisma!.executionProtectionState.create({
      data: {
        tradeExecutionId: execution.id,
        state: "MANUAL_INTERVENTION",
        reasonCode: options.parkedReason,
        confirmedOpenQuantity: "0.100",
        currentGeneration: 1,
      },
    });
  }

  // `updatedAt` is @updatedAt, so it must be forced with raw SQL — the whole
  // point is to control the selector's ordering key.
  await prisma!.$executeRaw`
    UPDATE "TradeExecution" SET "updatedAt" = ${options.updatedAt} WHERE "id" = ${execution.id}
  `;
  return { ...execution, symbol };
}

async function reset() {
  const ids = (
    await prisma!.tradeExecution.findMany({ where: { executionProfileId: profileId }, select: { id: true } })
  ).map((row) => row.id);
  if (ids.length > 0) {
    await prisma!.criticalAlert.deleteMany({ where: { tradeExecutionId: { in: ids } } });
    await prisma!.executionEvent.deleteMany({ where: { tradeExecutionId: { in: ids } } });
    await prisma!.executionProtectionState.deleteMany({ where: { tradeExecutionId: { in: ids } } });
    await prisma!.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: ids } } });
    await prisma!.tradeExecution.deleteMany({ where: { id: { in: ids } } });
  }
}

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: { name: "Fairness synthetic profile", accountIdentifier: `${TAG}-account`, environment: "TESTNET", isEnabled: true },
  });
  profileId = profile.id;
  await prisma.executionSafetyPolicy.create({
    data: {
      executionProfileId: profileId, killSwitchActive: false, allowedSymbols: [],
      maxOpenPositions: 50, maxPendingEntries: 50, maxTotalActiveTrades: 50,
      maxActivePerSymbolSide: 1, softOpenPositionTarget: 40,
      maxTotalPlannedRiskUsd: "500.00", maxTotalIsolatedMarginUsd: "5000.00",
    },
  });
});

afterEach(async () => {
  resetScenario();
  if (!prisma || !available) return;
  await reset();
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await reset();
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Ten rows that reconcile to nothing, plus one behind them that needs work.
 *
 * The blockers are parked executions with a NON-recoverable reason: closure
 * finds their position open and returns, recovery declines because the reason
 * is not on its allowlist, and neither writes to the execution row. That is a
 * faithful no-op — nothing is contrived to make it one.
 */
async function elevenRows(options: { starvedFlat?: boolean } = {}) {
  const base = Date.parse("2026-08-31T09:00:00.000Z");
  const blockers = [];
  for (let index = 0; index < 10; index += 1) {
    blockers.push(
      await persistExecution({
        status: "MANUAL_INTERVENTION",
        parkedReason: "POSITION_IDENTITY_MISMATCH",
        updatedAt: new Date(base + index * 1000),
      })
    );
  }
  // Newest, so the selector reaches it only after the ten ahead of it move.
  const starved = await persistExecution({
    status: "ENTRY_FILLED",
    updatedAt: new Date(base + 60_000),
  });
  if (options.starvedFlat !== false) scenario.flatFor.add(starved.symbol);
  return { blockers, starved };
}

// ===========================================================================
// F1 — the reproduction
// ===========================================================================

describe("F1. batch starvation, from the real production tick", () => {
  maybe()("F1. the window ADVANCES instead of pinning the same ten rows", async () => {
    const { blockers, starved } = await elevenRows();
    const blockerIds = new Set(blockers.map((row) => row.id));

    const worker = makeWorker();
    const seen: string[][] = [];
    for (let index = 0; index < 5; index += 1) {
      const { result, visited } = await worker.tick();
      seen.push(visited);
      expect(result.failed).toBe(false);
      // F11: every window stays bounded by the batch size.
      expect(result.inspected).toBeLessThanOrEqual(10);
    }

    // Before the cursor, tick 1 and tick 5 visited the SAME ten identities and
    // the eleventh row was never reached. Counts alone could not have shown
    // that, which is why the ids are captured.
    expect(seen[0]).not.toEqual(seen[1]);
    const everVisited = new Set(seen.flat());
    expect(everVisited.has(starved.id)).toBe(true);
    // And every blocker was still served across the cycle.
    for (const id of blockerIds) expect(everVisited.has(id)).toBe(true);
  });

  maybe()("F1b. the blockers keep their updatedAt and version, which is why they pin", async () => {
    const { blockers } = await elevenRows();
    const before = await Promise.all(blockers.map((row) => reload(row.id)));

    await tick();
    await tick();

    const after = await Promise.all(blockers.map((row) => reload(row.id)));
    for (let index = 0; index < before.length; index += 1) {
      // No durable write, so the ordering key never moves.
      expect(after[index].updatedAt.getTime()).toBe(before[index].updatedAt.getTime());
      expect(after[index].version).toBe(before[index].version);
    }
  });

  maybe()("F1c. recoveryPending counts the starved row the batch never sees", async () => {
    const { starved } = await elevenRows();
    const worker = makeWorker();
    const first = await worker.tick();

    // The FIRST window still looks exactly like the live reading: a full batch
    // of no-op rows, nothing progressed, and pending work it has not reached.
    expect(first.result.inspected).toBe(10);
    expect(first.result.advanced).toBe(0);
    expect(first.result.progressed).toBe(0);
    expect(first.result.recoveryPending).toBeGreaterThanOrEqual(1);
    expect(first.visited).not.toContain(starved.id);

    // The difference is what happens next: the window moves on rather than
    // re-serving the same ten for ever.
    const second = await worker.tick();
    expect(second.visited).toContain(starved.id);
  });
});

// ===========================================================================
// F2 — the property that must hold. FAILS before the fix.
// ===========================================================================

describe("F2. every eligible row is served within a bounded number of ticks", () => {
  maybe()("F2. the starved ENTRY_FILLED row is reached and converges", async () => {
    const { starved } = await elevenRows();

    // Two batch windows is the bound for 11 rows at batchSize 10.
    const worker = makeWorker();
    const visitedEver = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const { visited } = await worker.tick();
      for (const id of visited) visitedEver.add(id);
    }

    expect(visitedEver.has(starved.id)).toBe(true);
    // Flat and provably so, with no owned protection fill: canonical external
    // closure, and nothing sent to the exchange for a position already gone.
    expect((await reload(starved.id)).status).toBe("CLOSED_EXTERNAL");
    expect(scenario.mutations).toEqual([]);
  });
});

// ===========================================================================
// F3-F12 — the properties the fairness mechanism must not break
// ===========================================================================

describe("F3-F12. fairness without side effects", () => {
  maybe()("F3. rotation writes nothing to the rows it passes over", async () => {
    // The cursor must not buy fairness by touching lifecycle fields. Nothing
    // may be churned merely to move a row down the queue.
    const { blockers } = await elevenRows();
    const before = await Promise.all(blockers.map((row) => reload(row.id)));

    const worker = makeWorker();
    for (let index = 0; index < 4; index += 1) await worker.tick();

    const after = await Promise.all(blockers.map((row) => reload(row.id)));
    for (let index = 0; index < before.length; index += 1) {
      expect(after[index].updatedAt.getTime()).toBe(before[index].updatedAt.getTime());
      expect(after[index].version).toBe(before[index].version);
      expect(after[index].status).toBe(before[index].status);
      expect(after[index].lastReconciledAt?.getTime()).toBe(
        before[index].lastReconciledAt?.getTime()
      );
    }
  });

  maybe()("F4. a starved ENTRY_FILLED that is FLAT closes with zero exchange writes", async () => {
    const { starved } = await elevenRows();
    const worker = makeWorker();
    scenario.mutations = [];

    for (let index = 0; index < 3; index += 1) await worker.tick();

    const closed = await reload(starved.id);
    expect(closed.status).toBe("CLOSED_EXTERNAL");
    expect(closed.exitReason).toBe("EXTERNAL");
    expect(closed.actualExitPrice).toBeNull();
    expect(closed.realizedPnl).toBeNull();
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("F5. a starved ENTRY_FILLED that is LIVE reaches canonical protection", async () => {
    // Same starvation, opposite exchange reality.
    const { starved } = await elevenRows({ starvedFlat: false });
    const worker = makeWorker();

    for (let index = 0; index < 3; index += 1) await worker.tick();

    const after = await reload(starved.id);
    expect(after.status).not.toBe("ENTRY_FILLED");
    const roles = (
      await prisma!.binanceOrder.findMany({ where: { tradeExecutionId: starved.id } })
    )
      .filter((order) => order.role !== "ENTRY")
      .map((order) => order.role)
      .sort();
    expect(roles).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
  });

  maybe()("F6. a starved ENTRY_FILLED whose position is UNREADABLE parks fail-closed", async () => {
    const { starved } = await elevenRows({ starvedFlat: false });
    const original = readOnlyStub.getPositionForSide;
    readOnlyStub.getPositionForSide = async (symbol: string, positionSide: string) => {
      if (symbol === starved.symbol) throw new Error("positionRisk timed out");
      return original(symbol, positionSide) as never;
    };
    scenario.mutations = [];

    const worker = makeWorker();
    for (let index = 0; index < 3; index += 1) await worker.tick();
    readOnlyStub.getPositionForSide = original;

    const after = await reload(starved.id);
    // UNKNOWN is never FLAT, and nothing was sent for a position nobody saw.
    expect(after.exitReason).toBeNull();
    expect(after.closedAt).toBeNull();
    expect(scenario.mutations).toEqual([]);
    expect(after.status).toBe("MANUAL_INTERVENTION");
    expect(after.requiresManualIntervention).toBe(true);
  });

  maybe()("F7. recovery-required work is reached even behind a full batch", async () => {
    // The safety objective stated plainly: a filled, unprotected execution
    // cannot sit behind harmless rows for ever. It is reached within one full
    // cycle rather than given a priority lane, which would only invert the
    // problem onto the rows it overtakes.
    const { starved } = await elevenRows();
    const worker = makeWorker();

    let recoveryPendingAtEnd = -1;
    for (let index = 0; index < 3; index += 1) {
      recoveryPendingAtEnd = (await worker.tick()).result.recoveryPending;
    }

    expect((await reload(starved.id)).status).toBe("CLOSED_EXTERNAL");
    // The pending count falls as a direct result: the work was actually done.
    expect(recoveryPendingAtEnd).toBeLessThan(11);
  });

  maybe()("F8. every eligible row is served within one full cycle, over 3 windows", async () => {
    // 25 rows at batchSize 10: three windows cover the set.
    const base = Date.parse("2026-08-31T08:00:00.000Z");
    const ids: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const row = await persistExecution({
        status: "MANUAL_INTERVENTION",
        parkedReason: "POSITION_IDENTITY_MISMATCH",
        updatedAt: new Date(base + index * 1000),
      });
      ids.push(row.id);
    }

    const worker = makeWorker();
    const everVisited = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const { visited } = await worker.tick();
      for (const id of visited) everVisited.add(id);
    }

    // ceil(25 / 10) = 3 ticks, and nothing is left unserviced.
    for (const id of ids) expect(everVisited.has(id)).toBe(true);
  });

  maybe()("F9. revisiting rows creates no duplicate orders, events or alerts", async () => {
    const { starved } = await elevenRows();
    const worker = makeWorker();

    for (let index = 0; index < 6; index += 1) await worker.tick();

    const events = await prisma!.executionEvent.count({ where: { tradeExecutionId: starved.id } });
    const alerts = await prisma!.criticalAlert.count({ where: { tradeExecutionId: starved.id } });
    const orders = await prisma!.binanceOrder.count({ where: { tradeExecutionId: starved.id } });
    scenario.mutations = [];

    for (let index = 0; index < 6; index += 1) await worker.tick();

    // A terminal row leaves RECONCILABLE_STATUSES, so it is never revisited —
    // and the counts prove nothing was duplicated on the way there either.
    expect(await prisma!.executionEvent.count({ where: { tradeExecutionId: starved.id } })).toBe(events);
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: starved.id } })).toBe(alerts);
    expect(await prisma!.binanceOrder.count({ where: { tradeExecutionId: starved.id } })).toBe(orders);
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("F10. a restart rewinds the cursor without stranding anything", async () => {
    const { starved } = await elevenRows();

    // A worker that only ever runs its FIRST tick, restarted each time: the
    // cursor is process-local, so every restart begins at the oldest row.
    for (let index = 0; index < 3; index += 1) {
      const restarted = makeWorker();
      const { visited } = await restarted.tick();
      expect(visited).not.toContain(starved.id);
    }
    // Restarting in a tight loop delays the starved row — that is the honest
    // cost of process-local state, and it is a delay, not a strand.
    expect((await reload(starved.id)).status).toBe("ENTRY_FILLED");

    // A worker left running reaches it, which is the normal case.
    const running = makeWorker();
    await running.tick();
    await running.tick();
    expect((await reload(starved.id)).status).toBe("CLOSED_EXTERNAL");
  });

  maybe()("F11. no window ever exceeds the configured batch size", async () => {
    const base = Date.parse("2026-08-31T08:00:00.000Z");
    for (let index = 0; index < 23; index += 1) {
      await persistExecution({
        status: "MANUAL_INTERVENTION",
        parkedReason: "POSITION_IDENTITY_MISMATCH",
        updatedAt: new Date(base + index * 1000),
      });
    }

    const worker = makeWorker();
    for (let index = 0; index < 5; index += 1) {
      const { result, visited } = await worker.tick();
      expect(result.inspected).toBeLessThanOrEqual(10);
      expect(visited.length).toBeLessThanOrEqual(10);
    }
  });

  maybe()("F12. PLACING_PROTECTION and PARTIALLY_FILLED still route as before", async () => {
    // The cursor changes WHICH rows a window contains, never what happens to
    // one once selected.
    const placing = await persistExecution({
      status: "PLACING_PROTECTION",
      updatedAt: new Date("2026-08-31T07:00:00.000Z"),
    });
    const partial = await persistExecution({
      status: "PARTIALLY_FILLED",
      updatedAt: new Date("2026-08-31T07:00:01.000Z"),
    });
    scenario.flatFor.add(placing.symbol);

    const worker = makeWorker();
    await worker.tick();

    // Flat PLACING_PROTECTION terminalizes, exactly as the earlier fix made it.
    expect((await reload(placing.id)).status).toBe("CLOSED_EXTERNAL");
    // A live PARTIALLY_FILLED is protected rather than closed.
    expect((await reload(partial.id)).status).not.toBe("CLOSED_EXTERNAL");
  });
});

// ===========================================================================
// B1-B8 - the backlog measurement, and what it must not disturb
// ===========================================================================

/**
 * `inspected` alone cannot be interpreted.
 *
 * A window of ten is either the whole queue nearly drained or a thirtieth of
 * one, and those imply opposite things about a row that has not changed. These
 * pin the denominator: what it counts, that it is whole-table rather than
 * batch-shaped, that it stays distinct from `recoveryPending`, and above all
 * that measuring cannot disturb the thing measured.
 */
describe("B1-B8. reconciliation backlog telemetry", () => {
  /** 26 rows admission declines, plus the one parked row that needs recovery. */
  async function twentySevenRows() {
    const base = Date.parse("2026-08-31T09:00:00.000Z");
    // Parked with a NON-recoverable reason: a faithful no-op, and the only
    // recovery-required row, which is what makes the two counts differ.
    const parked = await persistExecution({
      status: "MANUAL_INTERVENTION",
      parkedReason: "POSITION_IDENTITY_MISMATCH",
      updatedAt: new Date(base),
    });
    const planned = [];
    for (let index = 1; index < 27; index += 1) {
      planned.push(
        await persistExecution({ status: "PLAN_READY", updatedAt: new Date(base + index * 1000) })
      );
    }
    // Real behaviour rather than a contrivance: with recovery outstanding,
    // `admitAndSubmit` returns RECOVERY_REQUIRED before touching any row.
    return { parked, planned };
  }

  maybe()("B1. the count uses the production RECONCILABLE_STATUSES, not its own list", async () => {
    // One row per lifecycle status. Whatever the constant says is eligible is
    // exactly what the count returns: no terminal row leaks in, and no
    // reconcilable status is forgotten.
    const every = [
      "PLAN_READY", "PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED",
      "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED", "MANUAL_INTERVENTION",
      "ENTRY_EXPIRED", "CLOSED_TP", "CLOSED_SL", "CANCELED", "SKIPPED", "FAILED",
      "CLOSED_EMERGENCY", "CLOSED_EXTERNAL",
    ];
    const base = Date.parse("2026-08-31T09:00:00.000Z");
    for (let index = 0; index < every.length; index += 1) {
      await persistExecution({ status: every[index], updatedAt: new Date(base + index * 1000) });
    }

    const total = await makeWorker().orchestrator.countReconcilable();

    // The expectation is derived from the production constant rather than
    // restated here, so widening it cannot silently desynchronise the two.
    expect(total).toBe(RECONCILABLE_STATUSES.length);
    expect(total).toBeLessThan(every.length);
  });

  maybe()("B2. the total is whole-table, not the batch length", async () => {
    await twentySevenRows();

    const { result } = await makeWorker().tick();

    // The distinction the live investigation needed: one bounded window over a
    // pool nearly three times its size.
    expect(result.inspected).toBe(10);
    expect(result.reconcilableTotal).toBe(27);
    expect(result.reconcilableTotal).not.toBe(result.inspected);
  });

  maybe()("B3. recoveryPending keeps its own, narrower meaning", async () => {
    await twentySevenRows();

    const { result } = await makeWorker().tick();

    expect(result.reconcilableTotal).toBe(27);
    // Unchanged: rows whose exposure is not yet provably resolved.
    expect(result.recoveryPending).toBe(1);
  });

  maybe()("B4. the total falls when an execution terminalizes through canonical behaviour", async () => {
    // The starved row is FLAT, so closure terminalizes it on the tick that
    // reaches it. Nothing here pushes the count down by hand.
    const { starved } = await elevenRows();
    const worker = makeWorker();

    const first = await worker.tick();
    expect(first.result.reconcilableTotal).toBe(11);
    expect((await reload(starved.id)).status).toBe("ENTRY_FILLED");

    const second = await worker.tick();
    expect((await reload(starved.id)).status).toBe("CLOSED_EXTERNAL");
    // CLOSED_EXTERNAL is not reconcilable, so the pool the cursor rotates
    // through is genuinely one smaller.
    expect(second.result.reconcilableTotal).toBe(10);
  });

  maybe()("B5. a failing telemetry count cannot fail the reconciliation it reports on", async () => {
    const { starved } = await elevenRows();
    const worker = makeWorker();
    (worker.orchestrator as unknown as { countReconcilable: () => Promise<number> })
      .countReconcilable = async () => {
        throw new Error("backlog count exploded");
      };

    const first = await worker.tick();
    const second = await worker.tick();

    for (const { result } of [first, second]) {
      expect(result.failed).toBe(false);
      // Unknown, which is not the same claim as an empty pool.
      expect(result.reconcilableTotal).toBeNull();
    }
    expect(first.result.inspected).toBe(10);
    // recoveryPending is a separate query and still answers.
    expect(first.result.recoveryPending).toBe(11);
    // And the real work still happened: the starved row closed anyway.
    expect((await reload(starved.id)).status).toBe("CLOSED_EXTERNAL");
  });

  maybe()("B6. measuring the backlog writes nothing", async () => {
    const { parked, planned } = await twentySevenRows();
    const rows = [parked, ...planned];
    const before = await Promise.all(rows.map((row) => reload(row.id)));
    scenario.mutations = [];

    const worker = makeWorker();
    for (let index = 0; index < 3; index += 1) {
      expect((await worker.tick()).result.reconcilableTotal).toBe(27);
    }

    const after = await Promise.all(rows.map((row) => reload(row.id)));
    for (let index = 0; index < before.length; index += 1) {
      expect(after[index].status).toBe(before[index].status);
      expect(after[index].version).toBe(before[index].version);
      expect(after[index].updatedAt.getTime()).toBe(before[index].updatedAt.getTime());
      expect(after[index].lastReconciledAt?.getTime()).toBe(before[index].lastReconciledAt?.getTime());
      expect(after[index].filledQuantity?.toString()).toBe(before[index].filledQuantity?.toString());
    }
    // Nothing durable landed elsewhere either, and nothing was sent. These
    // synthetic rows carry no session, so the accounting these executions
    // could touch is exactly the event, alert and protection state below.
    const ids = rows.map((row) => row.id);
    expect(await prisma!.executionEvent.count({ where: { tradeExecutionId: { in: ids } } })).toBe(0);
    expect(await prisma!.criticalAlert.count({ where: { tradeExecutionId: { in: ids } } })).toBe(0);
    expect(
      await prisma!.executionProtectionState.count({ where: { tradeExecutionId: { in: ids } } })
    ).toBe(1);
    expect(scenario.mutations).toEqual([]);
  });

  maybe()("B8. cursorActive reports rotation state and carries no row identity", async () => {
    const { parked, planned } = await twentySevenRows();
    const worker = makeWorker();

    // 27 rows at batchSize 10: two full windows, then a short one that ends
    // the cycle and rewinds the cursor. The existing wrap behaviour, observed
    // rather than altered.
    const flags: boolean[] = [];
    const payloads: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { result } = await worker.tick();
      flags.push(result.cursorActive);
      payloads.push(JSON.stringify(result));
    }
    expect(flags).toEqual([true, true, false]);

    // Nothing that could identify a row reaches telemetry.
    for (const payload of payloads) {
      for (const row of [parked, ...planned]) {
        expect(payload).not.toContain(row.id);
        expect(payload).not.toContain(row.symbol);
      }
    }
  });
});

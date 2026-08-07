import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCKER_SCOPE,
  CANARY_POLICY,
  CANARY_READINESS_CODES,
  evaluateCanaryPreflight,
  type CanaryPreflightInput,
} from "../src/modules/execution/canary-readiness";
import {
  CanaryPreflightService,
  detectExecutionOrchestration,
  detectNotificationScheduler,
} from "../src/modules/execution/canary-preflight.service";

/**
 * Phase 11A tests. Everything runs against fakes: no Binance call of any kind,
 * no real account, and no mutation anywhere.
 */

const BACKEND = process.cwd();

// ---------------------------------------------------------------------------
// Baseline: a fully prepared runtime with the gates correctly still closed
// ---------------------------------------------------------------------------

function baseline(overrides: Partial<CanaryPreflightInput> = {}): CanaryPreflightInput {
  return {
    infrastructure: {
      databaseReady: true,
      redisReady: true,
      executionWorkerReady: true,
      notificationSchedulerReady: true,
      executionOrchestrationWired: true,
      ...overrides.infrastructure,
    },
    binance: {
      connected: true,
      signedRequestWorks: true,
      consecutiveSignedSuccesses: 3,
      requiredConsecutiveSuccesses: 3,
      authenticationFailed: false,
      ipRestricted: false,
      positionMode: "HEDGE",
      assetMode: "SINGLE_ASSET",
      nonZeroPositionCount: 0,
      openOrderCount: 0,
      ...overrides.binance,
    },
    local: {
      activeExecutionCount: 0,
      pendingEntryCount: 0,
      openPositionCount: 0,
      recoveryRequiredCount: 0,
      ...overrides.local,
    },
    policy: {
      maxOpenPositions: 1,
      maxPendingEntries: 1,
      maxTotalActiveTrades: 1,
      maxActivePerSymbolSide: 1,
      maxTotalPlannedRiskUsd: "1.50",
      maxTotalIsolatedMarginUsd: "5.00",
      ...overrides.policy,
    },
    gates: {
      globalKillSwitch: true,
      profileKillSwitchEngaged: true,
      liveEntryEnabled: false,
      protectionReady: false,
      accountSetupMutationsEnabled: false,
      testOrderEnabled: false,
      autoAddMarginEnabled: false,
      emergencyCloseMode: "DISABLED",
      ...overrides.gates,
    },
  };
}

/** The gate posture during an authorized canary window. */
const OPEN_WINDOW = {
  globalKillSwitch: false,
  profileKillSwitchEngaged: false,
  liveEntryEnabled: true,
  protectionReady: true,
  accountSetupMutationsEnabled: false,
  testOrderEnabled: false,
  autoAddMarginEnabled: false,
  emergencyCloseMode: "DISABLED",
};

const codesOf = (input: CanaryPreflightInput) =>
  evaluateCanaryPreflight(input).findings.map((finding) => finding.code);

// ---------------------------------------------------------------------------
// Scope separation
// ---------------------------------------------------------------------------

describe("readiness scope", () => {
  it("treats closed live gates as expected, not as a preparation failure", () => {
    const result = evaluateCanaryPreflight(baseline());
    expect(result.preparationReady).toBe(true);
    expect(result.ready).toBe(false);
    // The only blockers are the ones that SHOULD block during 11A.
    expect(result.liveActivationBlockers.length).toBeGreaterThan(0);
    for (const finding of result.liveActivationBlockers) {
      expect(["CANARY_BLOCKED_KILL_SWITCH_STATE", "CANARY_BLOCKED_GATE_STATE"]).toContain(finding.code);
    }
  });

  it("reaches CANARY_READY only inside an authorized window", () => {
    const result = evaluateCanaryPreflight(baseline({ gates: OPEN_WINDOW as never }));
    expect(result.ready).toBe(true);
    expect(result.summary).toBe("CANARY_READY");
  });

  it("classifies every code with a documented scope", () => {
    for (const code of CANARY_READINESS_CODES) {
      if (code === "CANARY_READY") continue;
      expect(["PREPARATION", "LIVE_ACTIVATION"]).toContain(BLOCKER_SCOPE[code]);
    }
  });
});

// ---------------------------------------------------------------------------
// Clean account
// ---------------------------------------------------------------------------

describe("clean-account requirement", () => {
  it("passes with zero positions, zero orders and no local execution", () => {
    expect(evaluateCanaryPreflight(baseline()).preparationBlockers).toEqual([]);
  });

  it("blocks on one unrelated Binance position", () => {
    const codes = codesOf(baseline({ binance: { nonZeroPositionCount: 1 } as never }));
    expect(codes).toContain("CANARY_BLOCKED_EXISTING_POSITIONS");
  });

  it("blocks on five unrelated Binance positions and says nothing was closed", () => {
    const result = evaluateCanaryPreflight(baseline({ binance: { nonZeroPositionCount: 5 } as never }));
    const finding = result.findings.find((f) => f.code === "CANARY_BLOCKED_EXISTING_POSITIONS")!;
    expect(finding.detail).toContain("5");
    expect(finding.detail).toMatch(/nothing was closed/i);
  });

  it("blocks on one Binance open order", () => {
    expect(codesOf(baseline({ binance: { openOrderCount: 1 } as never }))).toContain("CANARY_BLOCKED_EXISTING_ORDERS");
  });

  it("never treats an unreadable count as zero", () => {
    expect(codesOf(baseline({ binance: { nonZeroPositionCount: null } as never }))).toContain(
      "CANARY_BLOCKED_EXISTING_POSITIONS"
    );
    expect(codesOf(baseline({ binance: { openOrderCount: null } as never }))).toContain(
      "CANARY_BLOCKED_EXISTING_ORDERS"
    );
  });

  it("blocks on a local pending execution", () => {
    expect(codesOf(baseline({ local: { pendingEntryCount: 1 } as never }))).toContain("CANARY_BLOCKED_LOCAL_EXECUTION");
  });

  it("blocks on a local protected (open) execution", () => {
    expect(codesOf(baseline({ local: { openPositionCount: 1 } as never }))).toContain("CANARY_BLOCKED_LOCAL_EXECUTION");
  });

  it("blocks when an execution needs recovery", () => {
    expect(codesOf(baseline({ local: { recoveryRequiredCount: 2 } as never }))).toContain(
      "CANARY_BLOCKED_RECOVERY_REQUIRED"
    );
  });
});

// ---------------------------------------------------------------------------
// Account mode and connectivity
// ---------------------------------------------------------------------------

describe("Binance readiness", () => {
  it("blocks a HEDGE mismatch", () => {
    expect(codesOf(baseline({ binance: { positionMode: "ONE_WAY" } as never }))).toContain(
      "CANARY_BLOCKED_ACCOUNT_MODE"
    );
  });

  it("blocks a SINGLE_ASSET mismatch", () => {
    expect(codesOf(baseline({ binance: { assetMode: "MULTI_ASSET" } as never }))).toContain(
      "CANARY_BLOCKED_ACCOUNT_MODE"
    );
  });

  it("blocks an authentication failure", () => {
    expect(codesOf(baseline({ binance: { authenticationFailed: true } as never }))).toContain(
      "CANARY_BLOCKED_BINANCE"
    );
  });

  it("blocks an IP restriction distinctly", () => {
    expect(codesOf(baseline({ binance: { ipRestricted: true } as never }))).toContain(
      "CANARY_BLOCKED_IP_RESTRICTION"
    );
  });

  it("requires repeated consecutive signed successes", () => {
    const codes = codesOf(baseline({ binance: { consecutiveSignedSuccesses: 1 } as never }));
    expect(codes).toContain("CANARY_BLOCKED_BINANCE");
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("canary policy", () => {
  it("requires exactly the documented one-trade policy", () => {
    expect(CANARY_POLICY).toEqual({
      maxOpenPositions: 1,
      maxPendingEntries: 1,
      maxTotalActiveTrades: 1,
      maxActivePerSymbolSide: 1,
      maxTotalPlannedRiskUsd: "1.50",
      maxTotalIsolatedMarginUsd: "5.00",
    });
  });

  it("blocks a widened open, pending or active limit", () => {
    for (const key of ["maxOpenPositions", "maxPendingEntries", "maxTotalActiveTrades"] as const) {
      const codes = codesOf(baseline({ policy: { [key]: 2 } as never }));
      expect(codes, key).toContain("CANARY_BLOCKED_POLICY");
    }
  });

  it("blocks planned risk above 1.50", () => {
    expect(codesOf(baseline({ policy: { maxTotalPlannedRiskUsd: "3.00" } as never }))).toContain(
      "CANARY_BLOCKED_POLICY"
    );
  });

  it("blocks isolated margin above 5.00", () => {
    expect(codesOf(baseline({ policy: { maxTotalIsolatedMarginUsd: "10.00" } as never }))).toContain(
      "CANARY_BLOCKED_POLICY"
    );
  });

  it("compares risk as an exact decimal, not a string", () => {
    // "1.5" and "1.50" are the same budget.
    expect(codesOf(baseline({ policy: { maxTotalPlannedRiskUsd: "1.5" } as never }))).not.toContain(
      "CANARY_BLOCKED_POLICY"
    );
  });
});

// ---------------------------------------------------------------------------
// Infrastructure and orchestration
// ---------------------------------------------------------------------------

describe("infrastructure readiness", () => {
  it("blocks on an unreachable database or Redis", () => {
    expect(codesOf(baseline({ infrastructure: { databaseReady: false } as never }))).toContain(
      "CANARY_BLOCKED_DATABASE"
    );
    expect(codesOf(baseline({ infrastructure: { redisReady: false } as never }))).toContain("CANARY_BLOCKED_REDIS");
  });

  it("blocks when the notification scheduler is not registered", () => {
    expect(codesOf(baseline({ infrastructure: { notificationSchedulerReady: false } as never }))).toContain(
      "CANARY_BLOCKED_WORKER"
    );
  });

  it("blocks when no production caller drives the execution lifecycle", () => {
    const result = evaluateCanaryPreflight(
      baseline({ infrastructure: { executionOrchestrationWired: false } as never, gates: OPEN_WINDOW as never })
    );
    expect(result.ready).toBe(false);
    expect(result.preparationReady).toBe(false);
    const finding = result.findings.find((f) => f.code === "CANARY_BLOCKED_ORCHESTRATION_NOT_WIRED")!;
    // Even with every gate open, a missing orchestrator still blocks.
    expect(finding.scope).toBe("PREPARATION");
    expect(finding.detail).toMatch(/no production caller/i);
  });
});

describe("runtime detection", () => {
  it("reports the Phase 9 notification scheduler as registered", async () => {
    await expect(detectNotificationScheduler()).resolves.toBe(true);
  });

  it("reports the execution orchestration as wired after Phase 11A.1", async () => {
    // The Phase 11A blocker is closed: the worker starts the orchestration
    // scheduler, which constructs all three lifecycle services and runs
    // startup recovery.
    await expect(detectExecutionOrchestration()).resolves.toBe(true);
  });

  it("constructs the lifecycle services in the scheduler, not in the HTTP app", () => {
    const scheduler = readFileSync(
      path.join(BACKEND, "src", "modules", "jobs", "execution-orchestration.scheduler.ts"),
      "utf8"
    );
    for (const needed of [
      "new SafetyAdmissionService",
      "new EntryLifecycleService",
      "new ProtectionLifecycleService",
      "new BinanceUsdMExecutionClient",
    ]) {
      expect(scheduler).toContain(needed);
    }
    // The HTTP app stays free of execution machinery.
    const app = readFileSync(path.join(BACKEND, "src", "app.ts"), "utf8");
    expect(app).not.toContain("new EntryLifecycleService");
    expect(app).not.toContain("new ProtectionLifecycleService");
  });
});

// ---------------------------------------------------------------------------
// Service behaviour with injected probes
// ---------------------------------------------------------------------------

describe("preflight service", () => {
  /** A Prisma stand-in that records every call so writes can be proven absent. */
  function fakePrisma(counts = { active: 0, pending: 0, open: 0, recovery: 0 }) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        $queryRaw: async () => {
          calls.push("$queryRaw");
          return [{ "?column?": 1 }];
        },
        tradeExecution: {
          count: async () => {
            calls.push("tradeExecution.count");
            const order = [counts.active, counts.pending, counts.open, counts.recovery];
            return order[calls.filter((c) => c === "tradeExecution.count").length - 1] ?? 0;
          },
        },
        executionSafetyPolicy: {
          findFirst: async () => {
            calls.push("executionSafetyPolicy.findFirst");
            return { killSwitchActive: true };
          },
        },
      } as never,
    };
  }

  function fakeBinance(overrides: Record<string, unknown> = {}) {
    let calls = 0;
    return {
      calls: () => calls,
      service: {
        checkAccountConnection: async () => {
          calls += 1;
          return {
            connected: true,
            signedRequestWorks: true,
            positionMode: "HEDGE",
            assetMode: "SINGLE_ASSET",
            nonZeroPositionCount: 0,
            openOrderCount: 0,
            readinessCodes: ["CONNECTED"],
            warnings: [],
            ...overrides,
          };
        },
      } as never,
    };
  }

  it("performs zero Binance mutations and zero Prisma writes", async () => {
    const prisma = fakePrisma();
    const binance = fakeBinance();
    const service = new CanaryPreflightService(prisma.client, {
      binance: binance.service,
      signedCheckCount: 3,
      probes: {
        redisReady: async () => true,
        executionWorkerReady: async () => true,
        notificationSchedulerReady: async () => true,
        executionOrchestrationWired: async () => false,
      },
    });

    const result = await service.run();

    // Only reads were issued.
    for (const call of prisma.calls) {
      expect(["$queryRaw", "tradeExecution.count", "executionSafetyPolicy.findFirst"]).toContain(call);
    }
    // The Binance service it used exposes only a read-only health check.
    expect(Object.keys(binance.service as object)).toEqual(["checkAccountConnection"]);
    expect(binance.calls()).toBe(3);
    expect(result.gathered.binance.consecutiveSignedSuccesses).toBe(3);
  });

  it("stops counting consecutive successes at the first signed failure", async () => {
    let call = 0;
    const service = new CanaryPreflightService(fakePrisma().client, {
      binance: {
        checkAccountConnection: async () => {
          call += 1;
          return {
            connected: true,
            signedRequestWorks: call === 1,
            positionMode: "HEDGE",
            assetMode: "SINGLE_ASSET",
            nonZeroPositionCount: 0,
            openOrderCount: 0,
            readinessCodes: [],
            warnings: [],
          };
        },
      } as never,
      signedCheckCount: 3,
      probes: {
        redisReady: async () => true,
        executionWorkerReady: async () => true,
        notificationSchedulerReady: async () => true,
        executionOrchestrationWired: async () => true,
      },
    });

    const result = await service.run();
    expect(result.gathered.binance.consecutiveSignedSuccesses).toBe(1);
    expect(result.findings.map((f) => f.code)).toContain("CANARY_BLOCKED_BINANCE");
  });

  it("detects an IP restriction from a sanitized warning", async () => {
    const service = new CanaryPreflightService(fakePrisma().client, {
      binance: fakeBinance({ warnings: ["Signed futures request failed (AUTH). Code -2015 IP restricted."] }).service,
      signedCheckCount: 1,
      probes: {
        redisReady: async () => true,
        executionWorkerReady: async () => true,
        notificationSchedulerReady: async () => true,
        executionOrchestrationWired: async () => true,
      },
    });
    const result = await service.run();
    expect(result.findings.map((f) => f.code)).toContain("CANARY_BLOCKED_IP_RESTRICTION");
  });
});

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

describe("Phase 11A boundary", () => {
  const FILES = [
    path.join(BACKEND, "src", "modules", "execution", "canary-readiness.ts"),
    path.join(BACKEND, "src", "modules", "execution", "canary-preflight.service.ts"),
    path.join(BACKEND, "src", "modules", "execution", "run-canary-preflight.ts"),
  ];

  const readCode = (file: string) =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("calls no account-setup or test-order endpoint", () => {
    for (const file of FILES) {
      const source = readCode(file);
      for (const forbidden of [
        "binance-account-setup",
        "setHedgeMode",
        "submitUsdMFuturesTestOrder",
        "order/test",
        "positionSide/dual",
        "authorizeTestOrder",
        "authorizeHedgeMode",
      ]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("performs no Prisma write and no execution mutation", () => {
    for (const file of FILES) {
      const source = readCode(file);
      for (const forbidden of [
        ".create(",
        ".update(",
        ".updateMany(",
        ".upsert(",
        ".delete(",
        ".deleteMany(",
        "$executeRaw",
        "$transaction",
      ]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("imports no execution mutation client", () => {
    for (const file of FILES) {
      const imports = [...readCode(file).matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const forbidden of ["binance-execution.client", "entry-lifecycle.service", "protection-lifecycle.service"]) {
        expect(imports.some((entry) => entry.includes(forbidden)), `${path.basename(file)} -> ${forbidden}`).toBe(false);
      }
    }
  });

  it("offers no safety bypass flag", () => {
    // CODE only: the file's doc comment names these flags precisely to record
    // that they do not exist, which is documentation rather than a bypass.
    const cli = readCode(path.join(BACKEND, "src", "modules", "execution", "run-canary-preflight.ts"));
    for (const forbidden of ["--force", "--skip-safety", "--ignore-preflight", "--force-live", "--yes"]) {
      expect(`${forbidden}:${cli.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // And no argv inspection at all — the command takes no arguments.
    expect(cli).not.toContain("process.argv");
  });

  it("prints no credential, balance, symbol detail or order id", () => {
    const cli = readCode(path.join(BACKEND, "src", "modules", "execution", "run-canary-preflight.ts"));
    for (const forbidden of [
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "apiKey",
      "apiSecret",
      "signature",
      "walletBalance",
      "availableBalance",
      "positionAmt",
      "orderId",
      "accountIdentifier",
    ]) {
      expect(`${forbidden}:${cli.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("registers no route and adds no worker", () => {
    const app = readFileSync(path.join(BACKEND, "src", "app.ts"), "utf8");
    expect(app).not.toContain("canary");
    for (const file of FILES) {
      const source = readCode(file);
      expect(source).not.toContain("fastify");
      expect(source).not.toContain("setInterval");
    }
  });
});

describe("operator documentation", () => {
  const REPO = path.join(BACKEND, "..", "..");
  const runbook = () => readFileSync(path.join(REPO, "docs", "live-canary-runbook.md"), "utf8");

  it("ships the canary runbook with the required sections", () => {
    const doc = runbook();
    for (const heading of [
      "Dedicated laptop readiness",
      "First LONG canary",
      "First SHORT canary",
      "CLOSED_TP checklist",
      "CLOSED_SL checklist",
      "Entry-expiry canary",
      "Restart canary",
      "Restoring the safe state",
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it("documents the gate window in three explicit phases", () => {
    const doc = runbook();
    expect(doc).toContain("BEFORE CANARY");
    expect(doc).toContain("AUTHORIZED CANARY WINDOW");
    expect(doc).toContain("AFTER CANARY");
  });

  it("never instructs the operator to enable account-setup or test-order gates during a canary", () => {
    const doc = runbook();
    expect(doc).not.toMatch(/BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED\s*=\s*true/);
    expect(doc).not.toMatch(/BINANCE_TEST_ORDER_ENABLED\s*=\s*true/);
  });
});

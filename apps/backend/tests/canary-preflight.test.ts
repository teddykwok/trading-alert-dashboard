import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  BLOCKER_SCOPE,
  CANARY_POLICY,
  CANARY_READINESS_CODES,
  effectiveCanaryLimits,
  evaluateCanaryPreflight,
  type CanaryPolicyLimits,
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

/** Exactly the pinned canary values, used for BOTH sides of the merge. */
const CANARY_LIMITS: CanaryPolicyLimits = {
  maxOpenPositions: 1,
  maxPendingEntries: 1,
  maxTotalActiveTrades: 1,
  maxActivePerSymbolSide: 1,
  softOpenPositionTarget: 1,
  maxTotalPlannedRiskUsd: "1.50",
  maxTotalIsolatedMarginUsd: "8.00",
};

/** One helper for the "global X / row Y" cases that dominate the policy tests. */
const withLimits = (
  global: Partial<CanaryPolicyLimits>,
  profile: Partial<CanaryPolicyLimits> | null
): Partial<CanaryPreflightInput> => ({ policy: { global, profile } as CanaryPreflightInput["policy"] });

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
      global: { ...CANARY_LIMITS, ...overrides.policy?.global },
      profile:
        overrides.policy && "profile" in overrides.policy
          ? overrides.policy.profile === null
            ? null
            : { ...CANARY_LIMITS, ...overrides.policy.profile }
          : { ...CANARY_LIMITS },
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
      // Soft == hard == 1: unchanged canary behaviour in this branch.
      softOpenPositionTarget: 1,
      maxTotalPlannedRiskUsd: "1.50",
      // 8.00 is the ONE-trade aggregate ceiling, sized so a single plan
      // reserving risk × 5.333333 = 7.9999995 fits. Capacity above is still 1
      // in every dimension — this is not room for a second trade.
      maxTotalIsolatedMarginUsd: "8.00",
    });
  });

  it("keeps the aggregate margin ceiling at or above the recommended per-plan ceiling", () => {
    // Admission reserves maximumIsolatedMargin, so a canary policy below the
    // per-plan ceiling could never admit even one trade. Both numbers are read
    // from their real homes rather than restated here.
    const example = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
    const value = (key: string) => example.match(new RegExp(`^${key}=(.*)$`, "m"))![1].trim();
    const perPlanCeiling =
      Number(value("EXECUTION_MAX_TOTAL_PLANNED_RISK_USD")) * Number(value("BINANCE_MAX_MARGIN_MULTIPLIER"));
    expect(perPlanCeiling).toBeLessThanOrEqual(Number(CANARY_POLICY.maxTotalIsolatedMarginUsd));
    expect(value("EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD")).toBe(CANARY_POLICY.maxTotalIsolatedMarginUsd);
  });

  it("blocks a widened open, pending or active limit on the GLOBAL side", () => {
    for (const key of ["maxOpenPositions", "maxPendingEntries", "maxTotalActiveTrades"] as const) {
      expect(codesOf(baseline(withLimits({ [key]: 2 }, {}))), key).toContain("CANARY_BLOCKED_POLICY");
    }
  });

  it("blocks planned risk above 1.50", () => {
    expect(codesOf(baseline(withLimits({ maxTotalPlannedRiskUsd: "3.00" }, {})))).toContain("CANARY_BLOCKED_POLICY");
  });

  it("compares risk as an exact decimal, not a string", () => {
    // "1.5" and "1.50" are the same budget, on BOTH sides of the merge.
    expect(
      codesOf(baseline(withLimits({ maxTotalPlannedRiskUsd: "1.5" }, { maxTotalPlannedRiskUsd: "1.5" })))
    ).not.toContain("CANARY_BLOCKED_POLICY");
  });
});

// ---------------------------------------------------------------------------
// Policy: global vs profile row vs effective
// ---------------------------------------------------------------------------

/**
 * The gap this closes: readiness used to judge the ENV alone. With the env at
 * 8.00 and a profile row still at 5.00, admission enforces min(8, 5) = 5.00 —
 * so a canary pinned to 8.00 would have reported READY while being unable to
 * admit its own plan. All three values are now judged.
 */
describe("canary policy — merge sources", () => {
  const marginFinding = (input: Parameters<typeof evaluateCanaryPreflight>[0]) =>
    evaluateCanaryPreflight(input).findings.find(
      (finding) => finding.code === "CANARY_BLOCKED_POLICY" && finding.detail.includes("maxTotalIsolatedMarginUsd")
    );

  it("1. global 8 / row 8 / effective 8 → no policy blocker", () => {
    expect(codesOf(baseline())).not.toContain("CANARY_BLOCKED_POLICY");
  });

  it("2. global 8 / row 5 / effective 5 → BLOCKED, naming the row as the clamp", () => {
    const finding = marginFinding(baseline(withLimits({}, { maxTotalIsolatedMarginUsd: "5.00" })));
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("PROFILE_POLICY_CLAMPS_REQUIRED_CANARY_LIMIT");
    expect(finding!.detail).toContain("global 8.00");
    expect(finding!.detail).toContain("row 5.00");
    expect(finding!.detail).toContain("effective 5.00");
    expect(finding!.detail).toContain("requires 8.00");
  });

  it("3. global 5 / row 8 / effective 5 → BLOCKED, naming the global", () => {
    const finding = marginFinding(baseline(withLimits({ maxTotalIsolatedMarginUsd: "5.00" }, {})));
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("GLOBAL_POLICY_MISMATCH");
    expect(finding!.detail).toContain("global 5.00");
    expect(finding!.detail).toContain("row 8.00");
    expect(finding!.detail).toContain("effective 5.00");
  });

  it("4. global 8 / row 10 / effective 8 → BLOCKED even though effective is correct", () => {
    // Decision, made explicitly rather than by omission: the ROW must also be
    // exact. A row wider than the canary yields a correct effective value only
    // for as long as the global keeps clamping it; relax the global later and
    // the canary silently runs under a limit nobody reviewed. A pinned canary
    // has to be reproducible from its own configuration.
    const finding = marginFinding(baseline(withLimits({}, { maxTotalIsolatedMarginUsd: "10.00" })));
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("PROFILE_POLICY_MISMATCH");
    expect(finding!.detail).toContain("row 10.00");
    expect(finding!.detail).toContain("effective 8.00");
  });

  it("4b. both sides wrong in the same direction is reported as an EFFECTIVE mismatch", () => {
    const finding = marginFinding(
      baseline(withLimits({ maxTotalIsolatedMarginUsd: "5.00" }, { maxTotalIsolatedMarginUsd: "5.00" }))
    );
    expect(finding!.detail).toContain("EFFECTIVE_POLICY_MISMATCH");
  });

  it("5. a count mismatch in the profile row blocks", () => {
    for (const key of ["maxOpenPositions", "maxPendingEntries", "maxTotalActiveTrades", "maxActivePerSymbolSide"] as const) {
      const codes = codesOf(baseline(withLimits({}, { [key]: 2 })));
      expect(codes, key).toContain("CANARY_BLOCKED_POLICY");
    }
  });

  it("6. a planned-risk mismatch in the profile row blocks", () => {
    const codes = codesOf(baseline(withLimits({}, { maxTotalPlannedRiskUsd: "0.50" })));
    expect(codes).toContain("CANARY_BLOCKED_POLICY");
  });

  it("7. every value exact on both sides → no policy blocker", () => {
    const result = evaluateCanaryPreflight(baseline());
    expect(result.findings.filter((finding) => finding.code === "CANARY_BLOCKED_POLICY")).toHaveLength(0);
    expect(result.preparationReady).toBe(true);
  });

  it("fails closed when the profile policy row cannot be read", () => {
    const finding = evaluateCanaryPreflight(baseline(withLimits({}, null))).findings.find(
      (entry) => entry.code === "CANARY_BLOCKED_POLICY"
    );
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain("PROFILE_POLICY_UNAVAILABLE");
  });

  it("8. leaves kill switches and gates as separate blockers", () => {
    // A policy mismatch must not absorb, mask or rename the gate blockers.
    const result = evaluateCanaryPreflight(baseline(withLimits({}, { maxTotalIsolatedMarginUsd: "5.00" })));
    expect(result.findings.map((finding) => finding.code)).toContain("CANARY_BLOCKED_KILL_SWITCH_STATE");
    expect(result.liveActivationBlockers.map((finding) => finding.code)).toContain("CANARY_BLOCKED_GATE_STATE");
    // The policy problem is a PREPARATION blocker, the gates are not.
    expect(result.preparationBlockers.map((finding) => finding.code)).toContain("CANARY_BLOCKED_POLICY");
    expect(result.preparationBlockers.map((finding) => finding.code)).not.toContain("CANARY_BLOCKED_GATE_STATE");
  });

  it("reuses the admission min-merge rather than its own arithmetic", () => {
    // Preflight and admission must never disagree about the effective policy.
    const global = { ...CANARY_LIMITS, maxTotalIsolatedMarginUsd: "8.00", maxOpenPositions: 3 };
    const profile = { ...CANARY_LIMITS, maxTotalIsolatedMarginUsd: "5.00", maxOpenPositions: 2 };
    expect(effectiveCanaryLimits(global, profile)).toEqual({
      ...CANARY_LIMITS,
      maxTotalIsolatedMarginUsd: "5.00",
      maxOpenPositions: 2,
    });
    const source = readFileSync(path.join(BACKEND, "src/modules/execution/canary-readiness.ts"), "utf8");
    expect(source).toContain("mergeCapacityLimits");
    // No second implementation of the merge.
    expect(source).not.toMatch(/Math\.min\(/);
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

// ---------------------------------------------------------------------------
// Per-plan margin envelope reporting
// ---------------------------------------------------------------------------

/**
 * The preflight knows the MULTIPLIERS but not the per-plan RISK they multiply.
 *
 * Per-trade risk is `plan.template.riskAmount`, frozen onto each Extreme RR
 * plan from whichever risk template was active when that plan was generated —
 * two plans alive at the same time can carry different values. The portfolio
 * caps (`maxTotalPlannedRiskUsd`, `maxTotalIsolatedMarginUsd`) are aggregate
 * ADMISSION ceilings and are never an input to per-plan sizing.
 *
 * The section once multiplied `maxTotalPlannedRiskUsd` by the margin
 * multipliers and labelled the result "per-plan". That was right only by
 * coincidence: at a one-trade policy the aggregate cap equalled the per-trade
 * budget. Raising the cap to 7.50 turned the same line into `30` on an
 * activation screen. These tests pin the shape of the fix so it cannot come
 * back — including via a plausible-looking substitute like
 * `cap / maxTotalActiveTrades`, which would be equally wrong.
 */
describe("per-plan margin envelope reporting", () => {
  const cli = readFileSync(path.join(BACKEND, "src", "modules", "execution", "run-canary-preflight.ts"), "utf8");
  /** CODE only: the comment block deliberately describes the removed bug. */
  const code = cli.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  /** Just the envelope section, so neighbouring sections cannot mask a match. */
  const section = code.slice(code.indexOf("Per-plan margin envelope"), code.indexOf("Safety posture"));

  it("still reports the three values the preflight actually knows", () => {
    expect(section).toContain("BINANCE_TARGET_MARGIN_MULTIPLIER");
    expect(section).toContain("BINANCE_MAX_MARGIN_MULTIPLIER");
    expect(section).toContain("BINANCE_MIN_MARGIN_USD");
    expect(section).toContain("targetMarginMultiplier");
    expect(section).toContain("maxMarginMultiplier");
    expect(section).toContain("minMarginUsd");
  });

  it("names plan.riskAmount as the per-plan authority instead of printing a figure", () => {
    expect(section).toContain("plan.riskAmount");
    expect(section).toMatch(/per-plan dollar envelope/);
  });

  it("derives NO dollar figure from the aggregate portfolio caps", () => {
    // The exact defect: a per-plan dollar value multiplied out of an aggregate
    // ceiling. Neither cap may appear in this section at all.
    expect(section).not.toContain("maxTotalPlannedRiskUsd");
    expect(section).not.toContain("maxTotalIsolatedMarginUsd");
    // No arithmetic of any kind on a Decimal in this section.
    expect(section).not.toContain("Prisma.Decimal");
    expect(section).not.toMatch(/\.times\(/);
  });

  it("does not substitute an INFERRED per-plan risk either", () => {
    // cap / maxTotalActiveTrades looks reasonable and is still wrong: plans do
    // not each carry an equal share of the portfolio cap.
    expect(section).not.toMatch(/\.div\(/);
    expect(section).not.toContain("maxTotalActiveTrades");
    // And it must not reach for today's active template — a plan freezes its
    // own, so the live template is not this section's authority.
    expect(section).not.toContain("riskTemplate");
    expect(section).not.toContain("findFirst");
  });

  it("keeps the aggregate caps where they belong — the policy section", () => {
    // They are still reported, just not as a per-plan margin: the four-way
    // policy comparison above owns them.
    const policySection = code.slice(0, code.indexOf("Per-plan margin envelope"));
    expect(policySection).toContain("CANARY_PINNED_LIMITS");
    expect(policySection).toContain("effectiveCanaryLimits");
  });

  it("would have caught the original bug: no 30 or 39.9999975 can be produced", () => {
    // Recreate the removed derivation against the ACTIVATED portfolio policy
    // and show those are exactly the numbers it yielded — none of which the
    // section can now emit, because it performs no multiplication at all.
    const aggregateRiskCap = new Prisma.Decimal("7.50");
    expect(aggregateRiskCap.times("4").toFixed()).toBe("30");
    expect(aggregateRiskCap.times("5.333333").toFixed()).toBe("39.9999975");

    // The TRUE per-plan envelope at the live template's 1.50 risk.
    const perPlanRisk = new Prisma.Decimal("1.50");
    expect(perPlanRisk.times("4").toFixed()).toBe("6");
    expect(perPlanRisk.times("5.333333").toFixed()).toBe("7.9999995");

    // The section prints neither pair, because it prints no dollars at all.
    for (const forbidden of ["30", "39.9999975", "6.00", "7.9999995"]) {
      expect(section, forbidden).not.toContain(`"${forbidden}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-trade risk authority
// ---------------------------------------------------------------------------

describe("per-trade risk authority", () => {
  const read = (relative: string) => readFileSync(path.join(BACKEND, relative), "utf8");

  it("takes the execution risk budget from the FROZEN plan template", () => {
    // The one production path that creates an execution.
    expect(read("src/modules/execution/selected-plan-executor.ts")).toContain(
      "riskBudgetUsd: plan.template.riskAmount"
    );
  });

  it("keeps the portfolio caps out of the sizing modules entirely", () => {
    // Structural, not behavioural: the modules that compute quantity, notional
    // and margin cannot reference a cap they never import.
    for (const file of [
      "../../packages/shared/src/binance-margin-engine.ts",
      "src/modules/binance/binance-margin-plan.service.ts",
    ]) {
      const source = read(file);
      expect(source, file).not.toContain("maxTotalPlannedRiskUsd");
      expect(source, file).not.toContain("maxTotalIsolatedMarginUsd");
    }
  });

  it("uses the aggregate cap ONLY as an admission ceiling", () => {
    const engine = read("src/modules/execution/safety-engine.ts");
    // Compared against the PROJECTED total, never handed to a sizing call.
    expect(engine).toContain("projectedRisk.greaterThan(new D(policy.maxTotalPlannedRiskUsd))");
    expect(engine).toContain("projectedMargin.greaterThan(new D(policy.maxTotalIsolatedMarginUsd))");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Phase 11D — the account-bound startup barrier.
 *
 * The worker used to compose everything account-specific at module load, each
 * piece reaching for configuration on its own. Now one binding is awaited and
 * everything able to act as the account is built from it.
 *
 * The property that matters is an ORDERING one, and it is deliberately proved
 * two ways:
 *
 *   - structurally, over the worker source, because importing that module
 *     would start real timers, a retention schedule and an attestation
 *     heartbeat, and a test that did all that would be testing the harness;
 *   - behaviourally, over the binder itself against the test database, because
 *     "fails closed" is a claim about what happens when binding fails, and the
 *     only honest way to show that is to make it fail.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const WORKER = readFileSync(
  path.join(BACKEND, "src", "modules", "jobs", "vision-analysis.worker.ts"),
  "utf8"
);

/** The bootstrap function, sliced out so ordering claims are about IT. */
const BOOTSTRAP = WORKER.slice(
  WORKER.indexOf("async function startAccountBoundRuntime(): Promise<void> {"),
  WORKER.indexOf("void startAccountBoundRuntime()")
);

const SHUTDOWN = WORKER.slice(WORKER.indexOf('process.on("SIGTERM"'));

// ---------------------------------------------------------------------------
// A, C. What the barrier owns, and that it is built once
// ---------------------------------------------------------------------------

describe("everything account-specific is built inside the barrier", () => {
  const OWNED = [
    ["the selected-plan executor", "new SelectedPlanExecutor({"],
    ["the orchestration scheduler", "startExecutionOrchestrationScheduler(runtime)"],
    ["the historical fill runtime", "startHistoricalFillWorkerRuntime(runtime)"],
    ["the extreme-RR consumer", "new Worker<ExtremeRRJobData>("],
  ] as const;

  for (const [description, construction] of OWNED) {
    it(`${description} is constructed inside the bootstrap, exactly once`, () => {
      expect(BOOTSTRAP).toContain(construction);
      // Once in the bootstrap, and nowhere else in the module.
      const everywhere = WORKER.split(construction).length - 1;
      expect(`${description} constructions: ${everywhere}`).toBe(
        `${description} constructions: 1`
      );
    });
  }

  it("the vision-analysis consumer stays OUTSIDE it", () => {
    // It handles no account-specific work, and holding it back would stop
    // screenshots and analysis for a reason that has nothing to do with them.
    expect(BOOTSTRAP).not.toContain("new Worker<VisionAnalysisJobData>(");
    expect(WORKER).toContain("new Worker<VisionAnalysisJobData>(");
  });

  it("the non-account schedulers stay OUTSIDE it", () => {
    for (const scheduler of [
      "startCleanupScheduler()",
      "startExecutionNotificationScheduler()",
      "startAlertQueueRecoveryScheduler()",
      "setupRetentionSchedule()",
    ]) {
      expect(`${scheduler} inside barrier: ${BOOTSTRAP.includes(scheduler)}`).toBe(
        `${scheduler} inside barrier: false`
      );
      expect(WORKER).toContain(scheduler);
    }
  });
});

// ---------------------------------------------------------------------------
// A, B. Ordering: bind, refuse, then build — and the queue is last
// ---------------------------------------------------------------------------

describe("the barrier binds before it builds, and consumes last", () => {
  it("binds first and refuses before anything is constructed", () => {
    const bind = BOOTSTRAP.indexOf("const bound = await bindConfiguredExchangeRuntime(prisma);");
    const refuse = BOOTSTRAP.indexOf("if (!bound.ok) {");
    const earlyReturn = BOOTSTRAP.indexOf("return;", refuse);
    const firstBuild = BOOTSTRAP.indexOf("new SelectedPlanExecutor({");

    expect(bind).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(bind);
    expect(earlyReturn).toBeGreaterThan(refuse);
    expect(earlyReturn).toBeLessThan(firstBuild);
  });

  it("starts the extreme-RR consumer LAST, after the executor it needs", () => {
    const executor = BOOTSTRAP.indexOf("new SelectedPlanExecutor({");
    const scheduler = BOOTSTRAP.indexOf("startExecutionOrchestrationScheduler(runtime)");
    const consumer = BOOTSTRAP.indexOf("new Worker<ExtremeRRJobData>(");

    expect(executor).toBeLessThan(consumer);
    expect(scheduler).toBeLessThan(consumer);
  });

  it("the refusal names a reason code and no credential or alias", () => {
    const refusal = BOOTSTRAP.slice(
      BOOTSTRAP.indexOf("if (!bound.ok) {"),
      BOOTSTRAP.indexOf("const runtime = bound.runtime;")
    );
    expect(refusal).toContain("reasonCode: bound.reasonCode");
    for (const forbidden of ["apiKey", "apiSecret", "accountIdentifier", "credentials"]) {
      expect(refusal).not.toContain(forbidden);
    }
  });

  it("is invoked without top-level await, and cannot take the worker down", () => {
    // CommonJS: there is no top-level await to reach for, and a bootstrap that
    // threw unhandled would kill a process that still has non-account duties.
    expect(WORKER).toContain("void startAccountBoundRuntime().catch((error) => {");
    expect(WORKER).not.toMatch(/^await /m);
  });
});

// ---------------------------------------------------------------------------
// D. No admission gap
// ---------------------------------------------------------------------------

describe("no selected-plan job can be handled without a bound executor", () => {
  it("the handler asserts the invariant rather than skipping", () => {
    const handler = WORKER.slice(
      WORKER.indexOf("async function processExtremeRRJob"),
      WORKER.indexOf("const extremeRRService")
    );
    expect(handler).toContain("const executor = selectedPlanExecutor;");
    expect(handler).toContain("if (!executor) {");
    // A THROW, so BullMQ retries. Never a return that drops the plan and hopes
    // reconciliation notices.
    const guard = handler.slice(handler.indexOf("if (!executor) {"));
    expect(guard).toContain("throw new Error(");
    expect(guard.slice(0, guard.indexOf("}"))).not.toContain("return");
  });

  it("the queue that reaches it does not exist until the executor does", () => {
    const executor = BOOTSTRAP.indexOf("selectedPlanExecutor = new SelectedPlanExecutor({");
    const consumer = BOOTSTRAP.indexOf("extremeRRWorker = new Worker<ExtremeRRJobData>(");
    expect(executor).toBeGreaterThan(-1);
    expect(consumer).toBeGreaterThan(executor);
  });
});

// ---------------------------------------------------------------------------
// E, F. Shutdown
// ---------------------------------------------------------------------------

describe("shutdown closes what exists and tolerates what does not", () => {
  it("every barrier-owned handle is closed optionally", () => {
    expect(SHUTDOWN).toContain("if (orchestrationTimer) clearInterval(orchestrationTimer);");
    expect(SHUTDOWN).toContain("await historicalFillRuntime?.stop();");
    expect(SHUTDOWN).toContain("await extremeRRWorker?.close();");
  });

  it("the resources it closed before are still closed", () => {
    for (const closed of [
      "await runtimeAttestation.stop();",
      "await attestationRedis.close();",
      "clearInterval(cleanupTimer);",
      "clearInterval(notificationTimer);",
      "clearInterval(alertRecoveryTimer);",
      "await worker.close();",
      "await retentionWorker?.close();",
      "await prisma.$disconnect();",
    ]) {
      expect(SHUTDOWN).toContain(closed);
    }
  });

  it("the historical drain still precedes the client disconnect", () => {
    const drain = SHUTDOWN.indexOf("await historicalFillRuntime?.stop();");
    const disconnect = SHUTDOWN.indexOf("await prisma.$disconnect();");
    expect(drain).toBeGreaterThan(-1);
    expect(drain).toBeLessThan(disconnect);
  });
});

// ---------------------------------------------------------------------------
// B, behaviourally: binding really does fail closed
// ---------------------------------------------------------------------------

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

const TAG = `phase11d-barrier-${randomBytes(6).toString("hex")}`;
const createdProfileIds: string[] = [];

let restoreEnv: (() => void) | null = null;

afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
  vi.resetModules();
});

afterAll(async () => {
  if (!prisma || !available) return;
  await prisma.executionSafetyPolicy.deleteMany({
    where: { executionProfileId: { in: createdProfileIds } },
  });
  await prisma.executionProfile.deleteMany({ where: { id: { in: createdProfileIds } } });
});

/** Re-imports the binder under a pinned environment; `env` is frozen at load. */
async function bindUnder(overrides: Record<string, string | undefined>) {
  const previous = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
  const module = await import("../src/modules/execution/exchange-runtime-binding");
  restoreEnv = () => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previous);
  };
  return module;
}

describe("a process that cannot bind builds nothing", () => {
  const CREDENTIALS = {
    BINANCE_API_KEY: "startup-barrier-test-key",
    BINANCE_API_SECRET: "startup-barrier-test-secret",
  };

  maybe()("A. an unknown configured profile refuses, naming only a reason code", async () => {
    const module = await bindUnder({
      ...CREDENTIALS,
      EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: `${TAG}-does-not-exist`,
      EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
    });

    const bound = await module.bindConfiguredExchangeRuntime(prisma!);
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.reasonCode).toBe("PROFILE_NOT_FOUND");
    expect(bound.message).not.toContain(CREDENTIALS.BINANCE_API_KEY);
    expect(bound.message).not.toContain(CREDENTIALS.BINANCE_API_SECRET);
  });

  maybe()("B. an unconfigured profile identity refuses before any query", async () => {
    const module = await bindUnder({
      ...CREDENTIALS,
      EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "",
      EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
    });

    const bound = await module.bindConfiguredExchangeRuntime(prisma!);
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.reasonCode).toBe("PROFILE_NOT_CONFIGURED");
  });

  maybe()("C. a profile with no safety policy refuses", async () => {
    const accountIdentifier = `${TAG}-no-policy`;
    const profile = await prisma!.executionProfile.create({
      data: { name: accountIdentifier, accountIdentifier, environment: "TESTNET" },
      select: { id: true },
    });
    createdProfileIds.push(profile.id);

    const module = await bindUnder({
      ...CREDENTIALS,
      EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: accountIdentifier,
      EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
    });

    const bound = await module.bindConfiguredExchangeRuntime(prisma!);
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.reasonCode).toBe("PROFILE_POLICY_MISSING");
  });

  const MISSING_CREDENTIAL = [
    ["D. the API key", { BINANCE_API_KEY: undefined, BINANCE_API_SECRET: "s" }],
    ["E. the API secret", { BINANCE_API_KEY: "k", BINANCE_API_SECRET: undefined }],
  ] as const;

  for (const [description, credentials] of MISSING_CREDENTIAL) {
    maybe()(`${description} missing refuses, after the profile and before any client`, async () => {
      const accountIdentifier = `${TAG}-${description.slice(0, 2)}`;
      const profile = await prisma!.executionProfile.create({
        data: { name: accountIdentifier, accountIdentifier, environment: "TESTNET" },
        select: { id: true },
      });
      createdProfileIds.push(profile.id);
      await prisma!.executionSafetyPolicy.create({
        data: { executionProfileId: profile.id },
      });

      const module = await bindUnder({
        ...credentials,
        EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: accountIdentifier,
        EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
        // The connector proof runs BEFORE credentials, so it has to pass for
        // this case to reach the credential check it is about.
        BINANCE_FUTURES_REST_BASE_URL: "https://testnet.binancefuture.com",
      });

      const bound = await module.bindConfiguredExchangeRuntime(prisma!);
      expect(bound.ok).toBe(false);
      if (bound.ok) return;
      expect(bound.reasonCode).toBe("EXCHANGE_CREDENTIALS_MISSING");
    });
  }

  maybe()("a refusal yields no runtime, so no projection and no options exist", async () => {
    const module = await bindUnder({
      ...CREDENTIALS,
      EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: `${TAG}-still-missing`,
      EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
    });

    const bound = await module.bindConfiguredExchangeRuntime(prisma!);
    // There is no `runtime` on a refusal, which is what makes "no client is
    // constructed" a type-level fact rather than a discipline.
    expect("runtime" in bound).toBe(false);
  });
});

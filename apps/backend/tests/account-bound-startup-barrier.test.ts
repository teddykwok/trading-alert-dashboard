import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Phase 11D's account-bound startup barrier, in the file that owns it now.
 *
 * 11D put the barrier inside the vision worker because there was one worker.
 * 11E split that process in two -- the generic queues are BullMQ competing
 * consumers, so a second copy of the combined worker would have made the
 * account that trades a signal a race -- and the barrier moved with the
 * account work into execution.worker.ts. The INVARIANTS did not change, so
 * this suite did not change either: it simply reads the entrypoint that now
 * holds them, and additionally proves the account work is not ALSO still in
 * the generic worker.
 *
 * The property that matters is an ORDERING one, and it is deliberately proved
 * two ways:
 *
 *   - structurally, over the worker source, because importing either module
 *     would start real timers, a retention schedule and an attestation
 *     heartbeat, and a test that did all that would be testing the harness;
 *   - behaviourally, over the binder itself against the test database, because
 *     "fails closed" is a claim about what happens when binding fails, and the
 *     only honest way to show that is to make it fail.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const EXECUTION_WORKER = readFileSync(
  path.join(BACKEND, "src", "modules", "jobs", "execution.worker.ts"),
  "utf8"
);

/** The other half of the split. Read so the account work can be proved ABSENT. */
const GENERIC_WORKER = readFileSync(
  path.join(BACKEND, "src", "modules", "jobs", "vision-analysis.worker.ts"),
  "utf8"
);

/** The bootstrap function, sliced out so ordering claims are about IT. */
const BOOTSTRAP = EXECUTION_WORKER.slice(
  EXECUTION_WORKER.indexOf("async function startExecutionRuntime(): Promise<void> {"),
  EXECUTION_WORKER.indexOf("void startExecutionRuntime()")
);

/** Shutdown is registered INSIDE the barrier: a process that never bound owns nothing. */
const SHUTDOWN = BOOTSTRAP.slice(BOOTSTRAP.indexOf('process.on("SIGTERM"'));

// ---------------------------------------------------------------------------
// A, C. What the barrier owns, that it is built once, and that the generic
//       worker does not also build it
// ---------------------------------------------------------------------------

describe("everything account-specific is built inside the barrier", () => {
  const OWNED = [
    ["the selected-plan executor", "new SelectedPlanExecutor({"],
    ["the orchestration scheduler", "startExecutionOrchestrationScheduler(runtime)"],
    ["the historical fill runtime", "startHistoricalFillWorkerRuntime(runtime)"],
    ["the plan adoption scheduler", "startSelectedPlanAdoptionScheduler("],
    ["the runtime attestation publisher", "createRuntimeAttestationPublisher({"],
  ] as const;

  for (const [description, construction] of OWNED) {
    it(`${description} is constructed inside the bootstrap, exactly once`, () => {
      expect(BOOTSTRAP).toContain(construction);
      // Once in the bootstrap, and nowhere else in the module.
      const everywhere = EXECUTION_WORKER.split(construction).length - 1;
      expect(`${description} constructions: ${everywhere}`).toBe(
        `${description} constructions: 1`
      );
    });

    it(`${description} is not ALSO built by the generic worker`, () => {
      // The split is only real if the account work left. A copy still sitting
      // in the generic worker would mean two processes competing to be the
      // account, which is the exact failure 11E exists to remove.
      expect(`${description} in generic worker: ${GENERIC_WORKER.includes(construction)}`).toBe(
        `${description} in generic worker: false`
      );
    });
  }
});

describe("the generic worker keeps the work that belongs to no account", () => {
  it("still consumes both generic queues", () => {
    for (const consumer of ["new Worker<VisionAnalysisJobData>(", "new Worker<ExtremeRRJobData>("]) {
      expect(GENERIC_WORKER).toContain(consumer);
      // And the execution worker consumes NO queue at all: it polls durable
      // rows instead, because a queue hands a job to exactly one consumer.
      expect(`${consumer} in execution worker: ${EXECUTION_WORKER.includes(consumer)}`).toBe(
        `${consumer} in execution worker: false`
      );
    }
  });

  it("still owns the schedulers that are not account-specific", () => {
    for (const scheduler of [
      "startCleanupScheduler()",
      "startExecutionNotificationScheduler()",
      "startAlertQueueRecoveryScheduler()",
      "setupRetentionSchedule()",
    ]) {
      expect(GENERIC_WORKER).toContain(scheduler);
      expect(`${scheduler} in execution worker: ${EXECUTION_WORKER.includes(scheduler)}`).toBe(
        `${scheduler} in execution worker: false`
      );
    }
  });

  it("binds no account and reaches for no credential", () => {
    for (const forbidden of [
      "bindConfiguredExchangeRuntime",
      "configuredExchangeClientOptions",
      "profileProjectionOf",
      "marginPlanServiceFromRuntime",
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
    ]) {
      expect(`${forbidden} in generic worker: ${GENERIC_WORKER.includes(forbidden)}`).toBe(
        `${forbidden} in generic worker: false`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// A, B. Ordering: bind, refuse, then build
// ---------------------------------------------------------------------------

describe("the barrier binds before it builds", () => {
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

  it("starts adoption only after the executor and the orchestration it needs", () => {
    const executor = BOOTSTRAP.indexOf("new SelectedPlanExecutor({");
    const scheduler = BOOTSTRAP.indexOf("startExecutionOrchestrationScheduler(runtime)");
    const adoption = BOOTSTRAP.indexOf("startSelectedPlanAdoptionScheduler(");

    expect(executor).toBeLessThan(adoption);
    expect(scheduler).toBeLessThan(adoption);
  });

  it("publishes the WORKER attestation only after it is actually orchestrating", () => {
    // A process that binds but never schedules must not be counted as a live
    // runtime: that was the false-READY 11D closed, and the split must not
    // reopen it in the file that inherited the heartbeat.
    const scheduler = BOOTSTRAP.indexOf("startExecutionOrchestrationScheduler(runtime)");
    const attestation = BOOTSTRAP.indexOf("createRuntimeAttestationPublisher({");
    expect(scheduler).toBeGreaterThan(-1);
    expect(attestation).toBeGreaterThan(scheduler);
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

  it("is invoked without top-level await, and cannot take the process down", () => {
    // CommonJS: there is no top-level await to reach for, and a bootstrap that
    // threw unhandled would leave a process with no diagnosis of why.
    expect(EXECUTION_WORKER).toContain("void startExecutionRuntime().catch((error) => {");
    expect(EXECUTION_WORKER).not.toMatch(/^await /m);
  });
});

// ---------------------------------------------------------------------------
// D. There is no admission gap left to close
// ---------------------------------------------------------------------------

describe("no account work can observe a half-built runtime", () => {
  it("holds no nullable account handle at all", () => {
    // 11D needed four module-level `let ... | null` handles, because the
    // account work shared a process with work that had to start immediately,
    // and it needed a guard in the queue handler to cover the window. After
    // the split every one of them is a const INSIDE the barrier, so the
    // half-built state it guarded against cannot be represented.
    expect(EXECUTION_WORKER).not.toMatch(/^let /m);
    expect(EXECUTION_WORKER).not.toContain("| null = null");
  });

  it("the generic worker cannot execute a plan even if it wanted to", () => {
    for (const forbidden of [
      "SelectedPlanExecutor",
      "handleSelectedPlan",
      "createExecutionOrchestrator",
    ]) {
      // A comment may name the thing that moved; code may not call it.
      const code = GENERIC_WORKER.split("\n")
        .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/*"))
        .join("\n");
      expect(`${forbidden} in generic worker code: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in generic worker code: false`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// E, F. Shutdown closes what THIS process owns, and nothing else
// ---------------------------------------------------------------------------

describe("shutdown is scoped to the process that registered it", () => {
  it("closes every handle the barrier created", () => {
    for (const closed of [
      "await runtimeAttestation.stop();",
      "await attestationRedis.close();",
      "clearInterval(orchestrationTimer);",
      "clearInterval(adoptionTimer);",
      "await historicalFillRuntime.stop();",
      "await prisma.$disconnect();",
    ]) {
      expect(SHUTDOWN).toContain(closed);
    }
  });

  it("the historical drain still precedes the client disconnect", () => {
    const drain = SHUTDOWN.indexOf("await historicalFillRuntime.stop();");
    const disconnect = SHUTDOWN.indexOf("await prisma.$disconnect();");
    expect(drain).toBeGreaterThan(-1);
    expect(drain).toBeLessThan(disconnect);
  });

  it("touches nothing the generic worker owns", () => {
    for (const foreign of [
      "await worker.close();",
      "extremeRRWorker",
      "retentionWorker",
      "cleanupTimer",
      "notificationTimer",
      "alertRecoveryTimer",
    ]) {
      expect(`${foreign} in execution shutdown: ${SHUTDOWN.includes(foreign)}`).toBe(
        `${foreign} in execution shutdown: false`
      );
    }
  });

  it("and the generic worker withdraws no attestation it never published", () => {
    const genericShutdown = GENERIC_WORKER.slice(
      GENERIC_WORKER.indexOf('process.on("SIGTERM"')
    );
    // Stopping the generic worker must not make an account look absent and
    // block activation, or make a live account look gone to the launcher.
    for (const foreign of ["runtimeAttestation", "attestationRedis", "orchestrationTimer"]) {
      expect(`${foreign} in generic shutdown: ${genericShutdown.includes(foreign)}`).toBe(
        `${foreign} in generic shutdown: false`
      );
    }
    expect(genericShutdown).toContain("await extremeRRWorker.close();");
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

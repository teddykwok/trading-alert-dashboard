import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 11E — the structural guarantees of the generic/account worker split.
 *
 * ## The failure this slice removes
 *
 * One alert produced one ExtremeRRPlan, one generic `extreme-rr-plan` BullMQ
 * job, and whichever worker dequeued that job created the single TradeExecution
 * stamped with its OWN profile. BullMQ queues are competing consumers — proved
 * from the installed `moveToActive-11.lua`, whose `RPOPLPUSH wait -> active`
 * carries the header "this operation guarantees that the worker owns the job…
 * so that no other worker picks this job again". With a second account that
 * makes "which account trades this signal" a race, and the loser never learns
 * the opportunity existed at all.
 *
 * So the split is by PROCESS:
 *
 *   vision-analysis.worker.ts   one process, no account, generic analysis
 *   execution.worker.ts         one process PER account
 *
 * Everything below is a property of the SOURCE, because importing either
 * entrypoint would start real timers, a retention schedule, queue consumers and
 * an attestation heartbeat. The behavioural half of this slice lives in
 * selected-plan-adoption.integration.test.ts, against real Postgres.
 */

const BACKEND = path.resolve(__dirname, "..");
const SRC = path.join(BACKEND, "src");

const GENERIC = "src/modules/jobs/vision-analysis.worker.ts";
const EXECUTION = "src/modules/jobs/execution.worker.ts";
const ADOPTION = "src/modules/jobs/selected-plan-adoption.service.ts";
const PREFLIGHT = "src/modules/execution/canary-preflight.service.ts";
const GENERATION = "src/modules/extreme-rr/extreme-rr.service.ts";
const LAUNCHER = "src/modules/operator/runtime-launcher.ts";
const SUPERVISION = "src/modules/operator/worker-supervision.ts";

const raw = (relative: string) => readFileSync(path.join(BACKEND, relative), "utf8");

/** Source with comments removed — these bans are about code, not about prose. */
function codeOf(relative: string): string {
  return raw(relative)
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

// ---------------------------------------------------------------------------
// 1–3. The two halves are actually separate
// ---------------------------------------------------------------------------

describe("the generic worker cannot act as an account", () => {
  it("1. imports no account-specific module", () => {
    const code = codeOf(GENERIC);
    for (const forbidden of [
      "exchange-runtime-binding",
      "selected-plan-executor",
      "selected-plan-outcome.service",
      "selected-plan-adoption.service",
      "execution-orchestration.scheduler",
      "historical-fill-worker-runtime",
      "binance-margin-plan.service",
      "runtime-attestation",
    ]) {
      expect(`${forbidden} imported by generic worker: ${code.includes(forbidden)}`).toBe(
        `${forbidden} imported by generic worker: false`
      );
    }
  });

  it("2. still owns the work that belongs to no account", () => {
    const code = codeOf(GENERIC);
    for (const kept of [
      "new Worker<VisionAnalysisJobData>(",
      "new Worker<ExtremeRRJobData>(",
      "startCleanupScheduler()",
      "startExecutionNotificationScheduler()",
      "startAlertQueueRecoveryScheduler()",
      "setupRetentionSchedule()",
    ]) {
      expect(code).toContain(kept);
    }
  });

  it("3. and the account worker consumes NO queue at all", () => {
    // The whole reason this file exists. A queue would hand each plan to
    // exactly one of the account processes, which is the race being removed.
    const code = codeOf(EXECUTION);
    for (const forbidden of ["new Worker<", "new Queue(", "bullConnection", "QUEUE_NAME"]) {
      expect(`${forbidden} in execution worker: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in execution worker: false`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4–5. The account cannot be chosen at runtime
// ---------------------------------------------------------------------------

describe("the account comes from the process, and from nowhere else", () => {
  it("4. binds exactly one runtime, with no profile parameter", () => {
    const code = codeOf(EXECUTION);
    expect(code.match(/bindConfiguredExchangeRuntime\(/g)).toHaveLength(1);
    // One binding, one profile, one process. No map, no registry, no loop.
    for (const forbidden of ["Map<", "forEach", "for (const profile", "profiles"]) {
      expect(`${forbidden} in execution worker: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in execution worker: false`
      );
    }
  });

  it("5. adoption has no way to be aimed at a profile it was not given", () => {
    const code = codeOf(ADOPTION);
    // No signature anywhere accepts a profile id...
    expect(`profile id parameter: ${/executionProfileId\s*:\s*string/.test(code)}`).toBe(
      "profile id parameter: false"
    );
    // ...and every use resolves from the injected bound projection.
    expect(code.match(/const executionProfileId = this\.deps\.boundProfile\.executionProfileId;/g))
      .toHaveLength(2);
  });

  it("6. nothing but the account worker starts an adoption pass", () => {
    const importers = productionSources().filter(
      (module) => module !== ADOPTION && codeOf(module).includes("selected-plan-adoption")
    );
    expect(importers).toEqual([EXECUTION]);
  });
});

// ---------------------------------------------------------------------------
// 7–10. The claim is the fence, and Postgres is the boundary
// ---------------------------------------------------------------------------

describe("the durable claim, not a queue and not Redis", () => {
  it("7. the claim precedes the executor, which reaches SIGNED endpoints", () => {
    const pass = codeOf(ADOPTION);
    const runOnce = pass.slice(pass.indexOf("async runOnce("));
    expect(runOnce.indexOf("await this.claim(")).toBeLessThan(
      runOnce.indexOf("executor.handleSelectedPlan(")
    );
    // And a worker that LOST the claim goes no further.
    const lost = runOnce.slice(runOnce.indexOf("if (adoptionId === null) {"));
    expect(lost.slice(0, lost.indexOf("}"))).toContain("continue;");
  });

  it("8. the correctness boundary is the database, never Redis", () => {
    const code = codeOf(ADOPTION);
    for (const forbidden of ["ioredis", "IORedis", "redis", "Redis", "SET NX", "redlock"]) {
      expect(`${forbidden} in adoption: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in adoption: false`
      );
    }
    // The winner is chosen by a unique index on an INSERT, and a reclaim is a
    // conditional update re-asserting the fencing token it read.
    expect(code).toContain("selectedPlanAdoption.create({");
    expect(code).toContain('error.code === "P2002"');
    expect(code).toContain("attempts: candidate.attempts,");
  });

  it("9. a refusal is terminal, exactly as the queue made it", () => {
    // The old handler RETURNED an outcome rather than throwing, so the job
    // completed and BullMQ's `attempts: 2` never applied. Two states only:
    // there is no RETRYABLE status to drift into.
    const schema = raw("prisma/schema.prisma");
    const block = schema.slice(
      schema.indexOf("enum SelectedPlanAdoptionStatus"),
      schema.indexOf("}", schema.indexOf("enum SelectedPlanAdoptionStatus"))
    );
    const members = block
      .slice(block.indexOf("{") + 1)
      .split(/\r?\n/)
      // The model carries doc comments; the members are the bare words.
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("/"));
    expect(members).toEqual(["PENDING", "COMPLETED"]);

    // And the terminal write refuses to rewrite a COMPLETED row.
    const code = codeOf(ADOPTION);
    const complete = code.slice(code.indexOf("private async complete("));
    expect(complete).toContain('where: { id: adoptionId, status: "PENDING", attempts },');
  });

  it("10. the freshness fence is the repository's own signal-lifetime rule", () => {
    const code = codeOf(ADOPTION);
    // Not a literal, and not cutoffAt > now(): cutoffAt is the alert's trigger
    // instant, so that comparison would adopt nothing at all, ever.
    expect(code).toContain("env.EXECUTION_MAX_ALERT_AGE_SECONDS * 1000");
    expect(code).toContain("cutoffAt: { gt: this.freshnessFloor(now) },");
  });
});

// ---------------------------------------------------------------------------
// 11–13. Adoption decides; it does not analyse, and it is bounded
// ---------------------------------------------------------------------------

describe("adoption stays inside its half of the split", () => {
  it("11. reads the persisted plan and never generates one", () => {
    const code = codeOf(ADOPTION);
    expect(code).toContain("this.deps.plans.getForAlert(candidate.alertId)");
    for (const forbidden of ["generateForAlert", "ensurePendingPlan", "updateSelection"]) {
      expect(`${forbidden} in adoption: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in adoption: false`
      );
    }
  });

  it("12. every pass is bounded and single-flight", () => {
    const code = codeOf(ADOPTION);
    expect(code).toContain("take: limit,");
    expect(code).toContain("if (passInFlight) return;");
    // An interval that cannot hold the process open on its own.
    expect(code).toContain("timer.unref?.();");
  });

  it("13a. no per-account evaluation writes the singleton row", () => {
    // SelectedPlanOutcome is keyed alertId UNIQUE with an upsert writer, so
    // it holds exactly one verdict per plan. Account B writing through it
    // would overwrite account A, and the dashboard would show whichever
    // finished last as though it were the system's decision.
    for (const module of [ADOPTION, EXECUTION, GENERIC]) {
      expect(
        `recordSelectedPlanOutcome in ${module}: ${codeOf(module).includes("recordSelectedPlanOutcome")}`
      ).toBe(`recordSelectedPlanOutcome in ${module}: false`);
    }
    // And nothing in production calls it any more.
    const writers = productionSources().filter(
      (module) =>
        module !== "src/modules/execution/selected-plan-outcome.service.ts" &&
        codeOf(module).includes("recordSelectedPlanOutcome(")
    );
    expect(writers).toEqual([]);
  });

  it("13. no trading decision reads the shared display row", () => {
    // SelectedPlanOutcome is keyed alertId UNIQUE, so it holds ONE verdict per
    // plan and could never have been the per-account record. It is written for
    // the UI and read by nothing that decides.
    for (const decider of [
      "src/modules/execution/selected-plan-executor.ts",
      "src/modules/execution/safety-admission.service.ts",
      "src/modules/execution/entry-lifecycle.service.ts",
      ADOPTION,
    ]) {
      expect(`findSelectedPlanOutcome in ${decider}: ${codeOf(decider).includes("findSelectedPlanOutcome")}`)
        .toBe(`findSelectedPlanOutcome in ${decider}: false`);
    }
  });
});

// ---------------------------------------------------------------------------
// 14–16. The rest of the system points at the new process
// ---------------------------------------------------------------------------

describe("readiness and deployment name the account worker", () => {
  it("14. execution readiness is detected from the ACCOUNT entrypoint", () => {
    const code = codeOf(PREFLIGHT);
    expect(code).toContain('"execution.worker.ts"');
    const detector = code.slice(
      code.indexOf("export async function detectExecutionOrchestration("),
      code.indexOf("export async function detectNotificationScheduler(")
    );
    // The generic worker exists in every deployment, so reading it would make
    // an execution-readiness check pass with no account running anywhere.
    expect(detector).toContain("readFileSync(EXECUTION_WORKER_ENTRYPOINT,");
    expect(`generic entrypoint in detector: ${detector.includes("WORKER_ENTRYPOINT,") && detector.includes("const worker =")}`)
      .toBe("generic entrypoint in detector: false");
    // And it now requires the adoption leg: a bound account that reconciles but
    // adopts nothing is ready to trade and structurally unable to.
    expect(detector).toContain("startSelectedPlanAdoptionScheduler");
  });

  it("14b. the rollout fence is durable, generic, and never consumed", () => {
    const adoption = codeOf(ADOPTION);
    const generation = codeOf(GENERATION);

    // Required to adopt at all.
    expect(adoption).toContain("executionFanoutReadyAt: { not: null },");

    // Written ONLY by the generic READY transition, and only for READY.
    expect(generation).toContain(
      'const executionFanoutReadyAt = status === \"READY\" ? new Date() : null;'
    );

    // Never cleared by an account: adoption and the execution worker must
    // not be able to write it at all, or account A finishing first would
    // lock account B out of that plan permanently.
    for (const module of [ADOPTION, EXECUTION]) {
      const code = codeOf(module);
      expect(
        `${module} writes the fanout marker: ${/executionFanoutReadyAt\s*:\s*(new Date|null)/.test(code)}`
      ).toBe(`${module} writes the fanout marker: false`);
    }

    // And nothing in production clears it anywhere.
    const clearers = productionSources().filter(
      (module) =>
        module !== GENERATION &&
        /executionFanoutReadyAt\s*:\s*null/.test(codeOf(module))
    );
    expect(clearers).toEqual([]);
  });

  it("15. the account worker is startable as its own process, WITHOUT a file watcher", () => {
    const pkg = JSON.parse(raw("package.json")) as { scripts: Record<string, string> };

    // `tsx watch` is a development file watcher, not a process supervisor. Its
    // wrapper respawns the target only on a file CHANGE; a target that exits on
    // its own leaves the wrapper alive forever with nothing underneath it. That
    // is exactly what happened in production: an owned root with no runtime,
    // which supervision could not see and could not repair.
    //
    // Plain `tsx` still spawns a child, but the wrapper EXITS with it, so a dead
    // runtime collapses the whole owned tree into an honest "gone".
    expect(pkg.scripts["execution-worker"]).toBe("tsx src/modules/jobs/execution.worker.ts");
    expect(pkg.scripts["execution-worker"]).not.toContain("watch");

    // Watch mode survives for developers, under a name production never uses.
    expect(pkg.scripts["execution-worker:watch"]).toBe("tsx watch src/modules/jobs/execution.worker.ts");

    // The generic one is out of scope for this branch and unchanged.
    expect(pkg.scripts.worker).toBe("tsx watch src/modules/jobs/vision-analysis.worker.ts");
  });

  it("15a. the launcher can never start the account worker in watch mode", () => {
    // The role contract names the script, so this is the one place the
    // production command is chosen.
    const contracts = codeOf("src/modules/operator/dual-account-topology.ts");
    expect((contracts.match(/script: "execution-worker"/g) ?? []).length).toBe(2);
    expect(contracts).not.toContain("execution-worker:watch");
    expect(codeOf(LAUNCHER)).not.toContain("execution-worker:watch");
  });

  it("15b. the launcher starts the generic AND the account worker", () => {
    const launcher = codeOf(LAUNCHER);
    // The account role points at the account entrypoint's script...
    expect(launcher).toContain(
      'worker: { filter: \"@trading-alert-dashboard/backend\", script: \"execution-worker\" },'
    );
    // ...and the generic role at the generic one, under its own name.
    expect(launcher).toContain(
      'analysis: { filter: \"@trading-alert-dashboard/backend\", script: \"worker\" },'
    );
    // Both are started, so a single-account deployment is complete.
    expect(launcher).toContain('"analysis",');
  });

  it("15c. only attesting roles are judged by attestation", () => {
    const launcher = codeOf(LAUNCHER);
    // The presentStatus literal, not the interface declaration above it.
    const judged = launcher.indexOf("health: {", launcher.indexOf("export function presentStatus("));
    const health = launcher.slice(judged, launcher.indexOf("ports: {", judged));
    // The generic worker publishes none. Judging it against the account
    // WORKER attestation is what made a healthy stack read STALE and got a
    // working process restarted three times.
    expect(`analysis judged by attestation: ${health.includes("analysis")}`).toBe(
      `analysis judged by attestation: false`
    );
    expect(health).toContain("backend: judgeRoleHealth(");
    expect(health).toContain("worker: judgeRoleHealth(");

    // And supervision still touches exactly one role: the account worker.
    expect(codeOf(SUPERVISION)).toContain(
      'export const SUPERVISED_ROLES: readonly LauncherRole[] = Object.freeze([\"worker\"]);'
    );
    // Replacing it leaves every other owned process alone, generic included.
    expect(codeOf(SUPERVISION)).toContain(
      'const others = state.processes.filter((entry) => entry.role !== \"worker\");'
    );
  });

  it("16. the migration is additive only", () => {
    const migration = raw(
      "prisma/migrations/20260920060000_add_selected_plan_adoption/migration.sql"
    );
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    // Nothing existing is dropped, renamed or retyped.
    for (const forbidden of ["DROP ", "ALTER COLUMN", "RENAME"]) {
      expect(`${forbidden} in migration: ${statements.includes(forbidden)}`).toBe(
        `${forbidden} in migration: false`
      );
    }
    // Two tables are altered, and only in additive ways: the one this
    // migration creates, and ExtremeRRPlan -- which gets a NULLABLE column
    // and nothing else. Nullable and un-backfilled IS the rollout fence:
    // every plan that reached READY before this migration keeps NULL.
    const altered = [...statements.matchAll(/ALTER TABLE "([^"]+)" ([A-Z ]+)/g)];
    for (const [, table, operation] of altered) {
      if (table === "ExtremeRRPlan") {
        expect(operation.trim()).toBe("ADD COLUMN");
        continue;
      }
      expect(`altered table: ${table}`).toBe("altered table: SelectedPlanAdoption");
    }
    expect(statements).toContain(
      'ALTER TABLE "ExtremeRRPlan" ADD COLUMN     "executionFanoutReadyAt" TIMESTAMP(3);'
    );
    // Not NOT NULL, and with no DEFAULT: either would make every historical
    // plan eligible the moment the migration ran.
    // Not NOT NULL, and with no DEFAULT: either would have made every
    // historical plan eligible the moment the migration ran.
    const fanoutColumn = statements.slice(
      statements.indexOf(`"executionFanoutReadyAt"`),
      statements.indexOf(`;`, statements.indexOf(`"executionFanoutReadyAt"`))
    );
    for (const forbidden of ["NOT NULL", "DEFAULT"]) {
      expect(`${forbidden} on the fanout column: ${fanoutColumn.includes(forbidden)}`).toBe(
        `${forbidden} on the fanout column: false`
      );
    }
    expect(statements).toContain('CREATE TABLE "SelectedPlanAdoption"');
    // THE correctness boundary, in the database rather than in every writer.
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "SelectedPlanAdoption_extremeRRPlanId_executionProfileId_key"'
    );
  });
});

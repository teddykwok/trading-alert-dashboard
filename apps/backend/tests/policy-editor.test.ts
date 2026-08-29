import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

/**
 * Operator editing of the durable execution policy LIMITS.
 *
 * ## The line this feature must never cross
 *
 * Open positions, pending entries, total active, reserved risk and reserved
 * margin are COUNTED from `TradeExecution` rows by the safety engine. They are
 * observed facts with no column to write, so "current state is read-only" is
 * not a rule this service follows — it is a property of the schema, and these
 * tests pin that no endpoint or column exists that could break it.
 *
 * ## Limits govern the NEXT admission, never the last one
 *
 * Lowering a limit below current exposure must refuse new work, not reach back
 * and close positions that were admitted legitimately under the old policy.
 * The service writes exactly one row — `ExecutionSafetyPolicy` — and these
 * tests prove it touches no execution and places no order.
 */

const SYNTHETIC_TAG = "policy-editor-synthetic";

/**
 * The profile identity must be overridden BEFORE `config/env` is evaluated,
 * because `configuredProfileIdentity()` reads a frozen snapshot of it. Setting
 * it in `beforeAll` would be too late — the service would resolve the real
 * configured profile instead of this suite's synthetic one.
 *
 * Vitest reuses a worker across files, so both variables are snapshotted and
 * put back afterwards: a leaked identity would silently retarget a later suite.
 */
const OVERRIDDEN = ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT"];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = `${SYNTHETIC_TAG}-account`;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const BACKEND = path.resolve(__dirname, "..");
const SERVICE_SOURCE = readFileSync(
  path.join(BACKEND, "src/modules/operator/policy-editor.service.ts"),
  "utf8"
);
const ROUTES_SOURCE = readFileSync(path.join(BACKEND, "src/routes/operator.routes.ts"), "utf8");

/** Source with comments removed — the bans are about code, not about prose. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const SERVICE_CODE = codeOf(SERVICE_SOURCE);

const { PolicyEditorService, EDITABLE_POLICY_FIELDS } = await import(
  "../src/modules/operator/policy-editor.service"
);

const maybe = () => (available ? it : it.skip);

let profileId = "";
let policyId = "";

/** A SAFE OFF profile: disabled, kill switch engaged, nothing active. */
async function reset(overrides: Record<string, unknown> = {}) {
  await prisma!.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });
  await prisma!.executionSafetyPolicy.update({
    where: { executionProfileId: profileId },
    data: {
      killSwitchActive: true,
      softOpenPositionTarget: 1,
      maxOpenPositions: 3,
      maxPendingEntries: 3,
      maxTotalActiveTrades: 5,
      maxActivePerSymbolSide: 1,
      maxTotalPlannedRiskUsd: "7.50",
      maxTotalIsolatedMarginUsd: "25.00",
      ...overrides,
    },
  });
  return prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } });
}

const service = () => new PolicyEditorService(prisma!);

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: {
      name: "Policy editor synthetic profile",
      accountIdentifier: `${SYNTHETIC_TAG}-account`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  profileId = profile.id;
  const policy = await prisma.executionSafetyPolicy.create({
    data: { executionProfileId: profileId, killSwitchActive: true },
  });
  policyId = policy.id;
});

afterEach(async () => {
  if (!prisma || !available) return;
  await prisma.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
  await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await prisma.tradeExecution.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ===========================================================================
// A. Current state is unreachable
// ===========================================================================

describe("A. current state cannot be written through the policy path", () => {
  maybe()("the editable set contains only limits", () => {
    expect([...EDITABLE_POLICY_FIELDS]).toEqual([
      "softOpenPositionTarget",
      "maxOpenPositions",
      "maxPendingEntries",
      "maxTotalActiveTrades",
      "maxActivePerSymbolSide",
      "maxTotalPlannedRiskUsd",
      "maxTotalIsolatedMarginUsd",
    ]);
  });

  maybe()("no current-state name is writable, because no such column exists", async () => {
    const before = await reset();
    for (const field of [
      "currentOpen",
      "currentPending",
      "currentActive",
      "currentRisk",
      "currentMargin",
      "openPositions",
      "reservedRiskUsd",
    ]) {
      const result = await service().save({ [field]: 0 }, before.version);
      expect(result.ok, field).toBe(false);
      expect(result.blockers, field).toContain("VALIDATION_REFUSED");
    }
  });

  maybe()("the service writes exactly one model, and it is the policy row", () => {
    const models = [...SERVICE_CODE.matchAll(/(?:tx|this\.prisma|client)\.(\w+)\.(\w+)\(/g)].map(
      (match) => `${match[1]}.${match[2]}`
    );
    const writes = models.filter((call) => /\.(update|create|delete|upsert)/i.test(call));
    expect([...new Set(writes)]).toEqual(["executionSafetyPolicy.updateMany"]);
  });

  maybe()("the kill switch and the allowlist are not reachable from here", () => {
    expect(SERVICE_CODE).not.toContain("killSwitchActive:");
    expect(SERVICE_CODE).not.toContain("allowedSymbols:");
    expect([...EDITABLE_POLICY_FIELDS]).not.toContain("killSwitchActive" as never);
    expect([...EDITABLE_POLICY_FIELDS]).not.toContain("allowedSymbols" as never);
  });
});

// ===========================================================================
// B-E. Editing works, durably and atomically
// ===========================================================================

describe("B-E. a valid edit persists in full", () => {
  maybe()("updates every supplied limit", async () => {
    const before = await reset();
    const result = await service().save(
      {
        maxOpenPositions: 2,
        maxTotalActiveTrades: 4,
        maxTotalPlannedRiskUsd: "5.00",
        maxTotalIsolatedMarginUsd: "20.00",
      },
      before.version
    );

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("SAVED");

    const after = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(after.maxOpenPositions).toBe(2);
    expect(after.maxTotalActiveTrades).toBe(4);
    expect(after.maxTotalPlannedRiskUsd.toString()).toContain("5");
    expect(after.version).toBe(before.version + 1);
  });

  maybe()("D. the engine reads the new durable values", async () => {
    const before = await reset();
    await service().save({ maxOpenPositions: 2 }, before.version);

    // The same row admission resolves its limits from.
    const { SafetyPolicyService } = await import("../src/modules/execution/safety-policy.service");
    const seen = await new SafetyPolicyService(prisma!).getByProfileId(profileId);
    expect(seen!.maxOpenPositions).toBe(2);
  });

  maybe()("E. a refused field leaves the WHOLE policy untouched", async () => {
    const before = await reset();
    // Valid risk, invalid count: the write must not land half a policy.
    const result = await service().save(
      { maxTotalPlannedRiskUsd: "9.00", maxOpenPositions: 0 },
      before.version
    );

    expect(result.ok).toBe(false);
    const after = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(after.maxTotalPlannedRiskUsd.toString()).toBe(before.maxTotalPlannedRiskUsd.toString());
    expect(after.maxOpenPositions).toBe(before.maxOpenPositions);
    expect(after.version).toBe(before.version);
  });

  maybe()("the whole policy lands in ONE statement", () => {
    // Atomicity is structural: one updateMany carrying every field, so there
    // is no ordering in which some limits land and others do not.
    expect(SERVICE_CODE.match(/executionSafetyPolicy\.updateMany/g) ?? []).toHaveLength(1);
    expect(SERVICE_CODE).toContain("data: { ...normalized, version: { increment: 1 } }");
  });

  maybe()("a stale version is refused rather than overwriting another operator", async () => {
    const before = await reset();
    const first = await service().save({ maxOpenPositions: 2 }, before.version);
    expect(first.ok).toBe(true);

    const stale = await service().save({ maxOpenPositions: 3 }, before.version);
    expect(stale.ok).toBe(false);
    expect(stale.blockers).toContain("VERSION_CONFLICT");
  });
});

// ===========================================================================
// F-J. Validation
// ===========================================================================

describe("F-J. invalid proposals are refused", () => {
  maybe()("F. a soft target above the hard cap is refused", async () => {
    const before = await reset();
    const result = await service().save({ softOpenPositionTarget: 9 }, before.version);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/softOpenPositionTarget/);
  });

  maybe()("F2. a total-active cap below an individual cap is refused", async () => {
    const before = await reset();
    for (const draft of [{ maxTotalActiveTrades: 1 }, { maxOpenPositions: 99 }]) {
      const result = await service().save(draft, before.version);
      expect(result.ok, JSON.stringify(draft)).toBe(false);
      expect(result.message).toMatch(/maxTotalActiveTrades/);
    }
  });

  maybe()("G/H. a non-positive risk or margin limit is refused", async () => {
    const before = await reset();
    for (const draft of [
      { maxTotalPlannedRiskUsd: "0" },
      { maxTotalPlannedRiskUsd: "-1.00" },
      { maxTotalIsolatedMarginUsd: "0.00" },
      { maxTotalIsolatedMarginUsd: "abc" },
    ]) {
      const result = await service().save(draft, before.version);
      expect(result.ok, JSON.stringify(draft)).toBe(false);
    }
  });

  maybe()("I. zero and negative counts are refused", async () => {
    const before = await reset();
    for (const draft of [
      { maxOpenPositions: 0 },
      { maxPendingEntries: -1 },
      { maxActivePerSymbolSide: 0 },
      { maxTotalActiveTrades: 1.5 },
    ]) {
      const result = await service().save(draft, before.version);
      expect(result.ok, JSON.stringify(draft)).toBe(false);
    }
  });

  maybe()("J. an unknown field is REFUSED, never silently dropped", async () => {
    // Ignoring it would report success for an edit that did not happen.
    const before = await reset();
    const result = await service().save({ maxOpenPositions: 2, sessionTradeBudget: 50 }, before.version);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/sessionTradeBudget/);

    const after = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(after.maxOpenPositions).toBe(before.maxOpenPositions);
  });

  maybe()("an empty draft is refused", async () => {
    const before = await reset();
    expect((await service().save({}, before.version)).ok).toBe(false);
  });

  maybe()("validation reuses the engine's ONE validator", () => {
    // A second set of rules would drift from the one the set-policy CLI uses.
    expect(SERVICE_CODE).toContain("this.policies.normalizeAndValidate");
    expect(SERVICE_CODE).not.toMatch(/DECIMAL_PATTERN|assertPositiveInt|assertPositiveDecimal/);
  });
});

// ===========================================================================
// K-M. Runtime-state rule
// ===========================================================================

describe("K-M. saving requires a SAFE, quiet system", () => {
  maybe()("L. a SAFE OFF, quiet system may edit", async () => {
    await reset();
    const read = await service().read();
    expect(read.editable).toBe(true);
    expect(read.blockers).toEqual([]);
  });

  maybe()("M. an enabled profile or released kill switch refuses", async () => {
    const before = await reset();
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: true } });

    const read = await service().read();
    expect(read.editable).toBe(false);
    expect(read.blockers).toContain("NOT_SAFE_OFF");

    const result = await service().save({ maxOpenPositions: 2 }, before.version);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("NOT_SAFE_OFF");

    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });
  });

  maybe()("M2. an AVAILABLE authorization window refuses", async () => {
    const before = await reset();
    await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        // No tokenHash, symbol or direction: `isNaturalWindow` treats a row
        // carrying any exact-signal identity as self-contradictory, so a
        // window with one is INVALID rather than AVAILABLE.
        expiresAt: new Date(Date.now() + 60 * 60_000),
        maxClaims: 5,
        claimedCount: 0,
        allowedDirections: ["LONG", "SHORT"],
      },
    });

    const result = await service().save({ maxOpenPositions: 2 }, before.version);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("AUTHORIZATION_AVAILABLE");
  });

  maybe()("validation stays available while blocked, because it writes nothing", async () => {
    const before = await reset();
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: true } });

    // The operator can prepare an edit before deciding to go safe.
    const dry = await service().validate({ maxOpenPositions: 2 });
    expect(dry.ok).toBe(true);
    expect(dry.changes).toEqual([{ field: "maxOpenPositions", from: "3", to: "2" }]);

    const after = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(after.version).toBe(before.version);
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });
  });
});

// ===========================================================================
// N-Q. Existing work is never disturbed
// ===========================================================================

describe("N-Q. lowering a limit governs the next admission only", () => {
  maybe()("Q. an active execution blocks the edit rather than being closed", async () => {
    const before = await reset();
    const alert = await prisma!.alert.create({
      data: {
        symbol: "TESTPOLUSDT", assetType: "CRYPTO", exchange: "SYNTHETIC", timeframe: "15m",
        price: 100, signal: "LONG", indicatorName: `${SYNTHETIC_TAG}-active`,
        rawPayload: {}, triggeredAt: new Date(),
      },
    });
    const execution = await prisma!.tradeExecution.create({
      data: {
        executionProfileId: profileId, alertId: alert.id, symbol: "TESTPOLUSDT",
        direction: "LONG", positionSide: "LONG", status: "PROTECTED",
        selectedLookback: 300, plannedEntryPrice: "100",
        calculatedStopLoss: "96", executableStopLoss: "96", riskBudgetUsd: "1.50",
        quantityRaw: "1", plannedQuantity: "1", quantityStepSize: "0.001",
        actualPlannedLoss: "1.50", unusedRiskBudget: "0", positionNotional: "100",
        targetIsolatedMargin: "3.75", maximumIsolatedMargin: "5.00",
        selectedLeverage: 10, estimatedInitialMargin: "3.75",
        liquidationBufferRatio: "0.5",
      },
    });

    // A VALID draft on purpose: an invalid one would be refused by the
    // validator first and would prove nothing about the runtime gate.
    const result = await service().save({ maxOpenPositions: 2 }, before.version);

    // Refused because work is live — and the work itself is untouched.
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("ACTIVE_EXECUTIONS");

    const unchanged = await prisma!.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(unchanged.status).toBe("PROTECTED");
    expect(unchanged.version).toBe(execution.version);
    expect(unchanged.closedAt).toBeNull();

    await prisma!.tradeExecution.deleteMany({ where: { id: execution.id } });
    await prisma!.alert.deleteMany({ where: { id: alert.id } });
  });

  maybe()("N/O/P. the service can neither read executions for mutation nor place an order", () => {
    // It counts them, and that is all. A count cannot close a position.
    const executionCalls = [...SERVICE_CODE.matchAll(/tradeExecution\.(\w+)\(/g)].map((m) => m[1]);
    expect([...new Set(executionCalls)]).toEqual(["count"]);

    for (const forbidden of ["binance", "Binance", "submitOrder", "cancel", "close", "emergency"]) {
      expect(`${forbidden}:${SERVICE_CODE.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(
        `${forbidden}:false`
      );
    }
  });

  maybe()("a lowered limit is simply what admission reads next", async () => {
    const before = await reset({ maxTotalActiveTrades: 5 });
    // Pending must come down with it: a total-active cap below an individual
    // cap is unreachable, and the engine refuses that combination. Lowering
    // one limit in isolation is exactly what the merged invariant catches.
    const result = await service().save(
      { maxTotalActiveTrades: 2, maxOpenPositions: 2, maxPendingEntries: 2 },
      before.version
    );
    expect(result.ok).toBe(true);

    // No execution existed to disturb, and the new ceiling is durable.
    const after = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(after.maxTotalActiveTrades).toBe(2);
    expect(await prisma!.tradeExecution.count({ where: { executionProfileId: profileId } })).toBe(0);
  });
});

// ===========================================================================
// S-W. No reach into other subsystems
// ===========================================================================

describe("S-W. the editor touches nothing else", () => {
  maybe()("S/T. no exchange call and no claim consumed", async () => {
    const before = await reset();
    const claimsBefore = await prisma!.executionCanaryAuthorization.count({
      where: { executionProfileId: profileId },
    });

    await service().save({ maxOpenPositions: 2 }, before.version);

    expect(
      await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })
    ).toBe(claimsBefore);
    // It only READS authorization rows, to decide whether editing is allowed.
    const authCalls = [...SERVICE_CODE.matchAll(/executionCanaryAuthorization\.(\w+)\(/g)].map((m) => m[1]);
    expect([...new Set(authCalls)]).toEqual(["findMany"]);
  });

  maybe()("U/V/W. no supervision, vision queue or plan-outcome interaction", () => {
    for (const forbidden of [
      "supervision",
      "attestation",
      "bullmq",
      "enqueue",
      "visionAnalysis",
      "selectedPlanOutcome",
      "chromium",
    ]) {
      expect(`${forbidden}:${SERVICE_CODE.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(
        `${forbidden}:false`
      );
    }
  });

  maybe()("it changes no trading algorithm — it only writes limits", () => {
    for (const forbidden of ["extremeRr", "riskTemplate", "leverage", "marginMultiplier", "allowedSourceTimeframes"]) {
      expect(`${forbidden}:${SERVICE_CODE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ===========================================================================
// K. Operator authorization, and the env ceiling
// ===========================================================================

describe("K. the write is behind the existing operator guard", () => {
  maybe()("all three routes require operator auth", () => {
    const block = ROUTES_SOURCE.slice(ROUTES_SOURCE.indexOf("Execution policy LIMITS"));
    const routes = [...block.matchAll(/app\.(get|post)\(\s*\n?\s*"([^"]+)"/g)];
    expect(routes.length).toBe(3);
    // Every one behind the same guard the other operator mutations use.
    expect(block.match(/requireOperatorAuth/g) ?? []).toHaveLength(3);
    // Both mutations also carry the strict operator budget.
    expect(block.match(/OPERATOR_ACTION_RATE_LIMIT/g) ?? []).toHaveLength(2);
  });

  maybe()("no second token or password is introduced", () => {
    for (const forbidden of ["password", "apiKey", "secret", "token"]) {
      expect(`${forbidden}:${SERVICE_CODE.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(
        `${forbidden}:false`
      );
    }
  });

  maybe()("reports the env ceiling instead of hiding it", async () => {
    // min(env, policy) means the environment can only tighten. A stored value
    // above its ceiling is legal and inert, and the read says so.
    await reset({ maxOpenPositions: 3 });
    const read = await service().read();
    const view = read.fields!.maxOpenPositions;

    expect(view.stored).toBe("3");
    expect(view.envCeiling).toBeTruthy();
    expect(view.cappedByEnv).toBe(view.effective !== view.stored);
  });

  maybe()("the effective value comes from the engine's own min-merge", () => {
    expect(SERVICE_CODE).toContain("mergeCapacityLimits");
  });
});

// ===========================================================================
// Session Trade Budget stays out of scope
// ===========================================================================

describe("the Session Trade Budget stays out of the POLICY EDITOR", () => {
  maybe()("the policy editor still knows nothing about sessions", () => {
    // This guard originally said "not in this branch", and Phase 2 has since
    // arrived — the routes file now legitimately carries session capability and
    // an unlimited flag. What must remain true is narrower and more durable:
    // the POLICY EDITOR is about durable limits and has no session concept.
    //
    // Keeping the ban on the editor alone is what stops the two from merging.
    // A session is a bounded window an operator opens and closes; a policy
    // limit is a standing rule. Editing one from the other would blur a
    // SAFE-only write with a control that runs while trading.
    for (const forbidden of [
      "sessionTradeBudget",
      "tradesRemaining",
      "sessionOpened",
      "unlimited",
      "tradingSession",
      "openedCount",
      "reservedCount",
    ]) {
      expect(`${forbidden}:${SERVICE_CODE.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(
        `${forbidden}:false`
      );
    }
    // And the editable set is still limits only — no session field crept in.
    expect([...EDITABLE_POLICY_FIELDS]).not.toContain("tradeBudget" as never);
  });

  maybe()("nor a daily loss limit", () => {
    for (const forbidden of ["dailyLoss", "realizedLossLimit", "pnlKillSwitch"]) {
      expect(`${forbidden}:${SERVICE_CODE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

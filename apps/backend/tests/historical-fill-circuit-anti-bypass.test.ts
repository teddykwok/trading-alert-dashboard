import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE anti-bypass proof for the circuit: every enforcement site checks the
 * latch, under the lock, BEFORE it changes anything.
 *
 * The behavioural suites prove each path refuses correctly. This one proves the
 * refusals are written where they have to be -- because the failure mode being
 * guarded against does not make a test go red. Moving the breaker read below
 * the campaign increment, or dropping the advisory lock from one of the four
 * sites, leaves every behavioural assertion passing while opening a window in
 * which a stopped account can spend a slot.
 *
 * Structural, comment-stripped, and needs no database, so it runs everywhere.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

/**
 * Source with comments removed.
 *
 * These assertions are about what the code DOES, and the prose around this
 * feature necessarily names the very identifiers being searched for -- the
 * ordering requirements are documented at length precisely because they are
 * load-bearing. Matching raw text would match the explanation instead.
 */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const BUDGET = "src/modules/execution/historical-fill-weight-budget.service.ts";
const BREAKER = "src/modules/execution/historical-fill-circuit-breaker.service.ts";
const GATE = "src/modules/execution/historical-fill-campaign-gate.service.ts";
const CAMPAIGNS = "src/modules/execution/historical-fill-campaign.service.ts";
const DRIVER = "src/modules/execution/exchange-fill-batch-driver.service.ts";

/** The body of one method, so an ordering claim is about THAT method. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n {2}(?:async |private |\/\*\*)/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

/** Asserts `first` appears before `second`, and that both appear at all. */
function ordered(body: string, first: string, second: string): void {
  const a = body.indexOf(first);
  const b = body.indexOf(second);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(-1);
  expect(a).toBeLessThan(b);
}

describe("admission checks the latch under the lock, before any mutation", () => {
  const body = methodBody(codeOf(BUDGET), "async admitCampaignDispatch(");

  it("takes the profile advisory lock FIRST", () => {
    ordered(body, "lockCampaignForProfile(tx,", "readCircuitState(tx,");
  });

  it("reads the latch BEFORE the campaign row is even looked at", () => {
    ordered(body, "readCircuitState(tx,", "historicalFillCampaign.findMany(");
  });

  it("denies BEFORE the campaign slot is incremented", () => {
    ordered(body, 'outcome: "SYSTEMIC_CIRCUIT_OPEN"', "dispatchesUsed: { increment: 1 }");
  });

  it("denies BEFORE any minute weight is reserved", () => {
    ordered(body, 'outcome: "SYSTEMIC_CIRCUIT_OPEN"', "reserveWeightWithin(tx,");
  });

  it("denies BEFORE a reservation row can be created", () => {
    ordered(body, 'outcome: "SYSTEMIC_CIRCUIT_OPEN"', "historicalFillWeightReservation.create(");
  });

  it("unwinds the transaction rather than returning the denial", () => {
    expect(body).toContain("throw new HistoricalFillCampaignAdmissionRollback({");
    expect(body).toContain('outcome: "SYSTEMIC_CIRCUIT_OPEN"');
  });

  it("reads the latch through the TRANSACTION, never the service client", () => {
    expect(body).toContain("readCircuitState(tx,");
    expect(body).not.toContain("readCircuitState(this.prisma");
  });

  it("stamps lastAdmissionAt in the SAME statement that spends the slot", () => {
    const update = /historicalFillCampaign\.updateMany\(\{[\s\S]*?\}\);/.exec(body);
    expect(update).not.toBeNull();
    expect(update![0]).toContain("dispatchesUsed: { increment: 1 }");
    expect(update![0]).toContain("lastAdmissionAt:");
  });
});

describe("the refund corrects the books but cannot reopen a stopped account", () => {
  const body = methodBody(codeOf(BUDGET), "private async reactivateIfFreed(");

  it("reads the latch before reactivating", () => {
    ordered(body, "readCircuitState(tx,", 'data: { status: "ACTIVE", endedAt: null }');
  });

  it("returns without reactivating when the latch is OPEN", () => {
    expect(body).toContain('if (circuit.state === "OPEN") return;');
  });

  it("reads it through the refund's own transaction", () => {
    expect(body).toContain("readCircuitState(tx,");
    expect(body).not.toContain("readCircuitState(this.prisma");
  });
});

describe("the campaign lifecycle checks the latch under the lock", () => {
  const source = codeOf(CAMPAIGNS);

  it("createCampaign checks it after the lock and before the row", () => {
    const body = methodBody(source, "async createCampaign(");
    ordered(body, "lockCampaignForProfile(tx,", "assertCircuitClosed(tx,");
    ordered(body, "assertCircuitClosed(tx,", "historicalFillCampaign.create(");
  });

  it("the shared transition checks it after the lock and before the update", () => {
    const body = methodBody(source, "private async transition(");
    ordered(body, "lockCampaignForProfile(tx,", "assertCircuitClosed(tx,");
    ordered(body, "assertCircuitClosed(tx,", "historicalFillCampaign.updateMany(");
  });

  it("resumeCampaign opts INTO the refusal", () => {
    expect(methodBody(source, "async resumeCampaign(")).toContain("refuseWhileCircuitOpen:");
  });

  it("pauseCampaign and abortCampaign do NOT", () => {
    expect(methodBody(source, "async pauseCampaign(")).not.toContain("refuseWhileCircuitOpen");
    expect(methodBody(source, "async abortCampaign(")).not.toContain("refuseWhileCircuitOpen");
  });

  it("the assertion reads the latch through the caller's locked transaction", () => {
    const helper = /async function assertCircuitClosed\([\s\S]*?\n\}/.exec(source);
    expect(helper).not.toBeNull();
    expect(helper![0]).toContain("readCircuitState(tx,");
  });

  it("there is no override, force flag or auto-acknowledgement", () => {
    expect(source).not.toContain("force");
    expect(source).not.toContain("acknowledge");
  });
});

describe("the gate refuses before the bootstrap, and the driver obeys both", () => {
  it("the gate reads the latch BEFORE it can return ACTIVE", () => {
    const body = methodBody(codeOf(GATE), "async resolveForBatch(");
    ordered(body, "readCircuitState(this.deps.prisma", 'outcome: "CIRCUIT_OPEN"');
    ordered(body, 'outcome: "CIRCUIT_OPEN"', 'outcome: "ACTIVE"');
  });

  it("the driver handles the gate's refusal BEFORE calling the bootstrap", () => {
    const driver = codeOf(DRIVER);
    ordered(driver, 'gate.outcome === "CIRCUIT_OPEN"', "bootstrap.bootstrapHistoricalRoots(");
  });

  it("the driver handles the admission's refusal BEFORE calling the executor", () => {
    const driver = codeOf(DRIVER);
    ordered(driver, 'admission.outcome === "SYSTEMIC_CIRCUIT_OPEN"', "executor.executeOne(");
  });

  it("both refusals return rather than falling through", () => {
    // Two distinct return sites, so neither denial can share a path that
    // continues into a dispatch.
    const returns = codeOf(DRIVER).match(/outcome: "SYSTEMIC_CIRCUIT_OPEN",/g) ?? [];
    expect(returns.length).toBe(2);
  });

  it("the driver does NOT yet observe outcomes into the breaker", () => {
    // 3B.2 ENFORCES an open circuit; it does not open one. Wiring the hook here
    // would silently turn on automatic tripping a slice early, so its absence
    // is pinned rather than assumed.
    expect(codeOf(DRIVER)).not.toContain("observeDispatchOutcome");
  });
});

/**
 * The epoch counter is the only breaker state that survives acknowledgement, so
 * everything about it is an ordering or an omission -- and an omission is
 * invisible to a behavioural test that was not written for it. A `generation`
 * quietly added to `acknowledge`'s data, or dropped from the reservation insert,
 * leaves every other assertion in this suite passing while reopening the exact
 * hole it was added to close.
 */
describe("the epoch moves in one place and is erased in none", () => {
  const breaker = codeOf(BREAKER);
  const budget = codeOf(BUDGET);

  it("increments ONLY inside the opening branch", () => {
    const increments = breaker.match(/generation: \{ increment: 1 \}/g) ?? [];
    expect(increments).toHaveLength(1);
    // The increment and the opening timestamp are written by the same guard, so
    // the epoch cannot advance on anything but a CLOSED -> OPEN transition.
    expect(breaker).toContain("...(opening ? { openedAt: now, generation: { increment: 1 } } : {})");
  });

  it("starts a row born OPEN at one and a streak row at zero", () => {
    expect(breaker).toContain("generation: opening ? 1 : 0");
  });

  it("acknowledge does NOT assign generation", () => {
    const body = methodBody(breaker, "async acknowledge(");
    expect(body).toContain('state: "CLOSED"');
    expect(body).toContain("openedAt: null");
    // The whole point: everything else is cleared, this is not.
    expect(body).not.toContain("generation");
  });

  it("the healthy streak reset does NOT assign generation", () => {
    const body = methodBody(breaker, "private async reset(");
    expect(body).toContain("consecutiveCount: 0");
    expect(body).not.toContain("generation");
  });

  it("an absent breaker row reads as generation zero", () => {
    expect(breaker).toMatch(/CLOSED_AND_CLEAN[\s\S]*?generation: 0/);
  });

  it("the campaign-aware reservation insert writes the epoch explicitly", () => {
    // Relying on the column DEFAULT here would tag every campaign-aware grant as
    // epoch zero forever, which reads as "granted before the first episode".
    const body = methodBody(budget, "async admitCampaignDispatch(");
    expect(body).toContain("circuitGeneration: circuit.generation");
    const insert = /historicalFillWeightReservation\.create\(\{[\s\S]*?\}\);/.exec(body);
    expect(insert).not.toBeNull();
    expect(insert![0]).toContain("circuitGeneration");
  });

  it("the admission reads the epoch through its own locked transaction", () => {
    const body = methodBody(budget, "async admitCampaignDispatch(");
    ordered(body, "lockCampaignForProfile(tx,", "readCircuitState(tx,");
    ordered(body, "readCircuitState(tx,", "circuitGeneration: circuit.generation");
    expect(body).not.toContain("readCircuitState(this.prisma");
  });

  it("the refund compares epochs AFTER the OPEN veto, and returns rather than throws", () => {
    const body = methodBody(budget, "private async reactivateIfFreed(");
    ordered(body, 'if (circuit.state === "OPEN") return;', "linked.circuitGeneration !==");
    expect(body).toContain("if (linked.circuitGeneration !== circuit.generation) return;");
    // A throw here would roll the accounting refund back with it, turning an
    // outage into a permanent overcount.
    expect(body).not.toMatch(/circuitGeneration[\s\S]{0,120}throw/);
  });

  it("the epoch fence stays BELOW the legacy no-campaign branch", () => {
    // A legacy grant carries no campaign, so it must never reach campaign
    // reactivation logic at all -- epoch comparison included.
    const body = methodBody(budget, "async releaseCertainNonDispatch(");
    ordered(body, "if (linked === null) {", "this.releaseWeightOnly(reservation)");
    expect(body).not.toContain("circuitGeneration");
  });
});

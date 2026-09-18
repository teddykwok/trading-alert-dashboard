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

  it("every refusal returns rather than falling through", () => {
    // Three distinct sites now: the gate's, the admission's, and the shared
    // post-observation stop. None may share a path that continues to dispatch.
    const returns = codeOf(DRIVER).match(/outcome: "SYSTEMIC_CIRCUIT_OPEN",/g) ?? [];
    expect(returns.length).toBe(3);
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

/**
 * ACTIVATION. Until 3B.3C1 the breaker could refuse work but nothing could open
 * it, and the structural test here pinned that absence. It now has to prove the
 * opposite, and prove it in the only way that matters: that the observation
 * happens at the one point in the loop where it is both durable and still able
 * to stop the next dispatch.
 *
 * Ordering is the whole guarantee, and none of it fails a behavioural test when
 * it drifts -- an observation moved above the refund still observes, and a stop
 * moved below the next admission still stops, one dispatch too late.
 */
describe("the driver reports outcomes to the breaker, in the right place", () => {
  const driver = codeOf(DRIVER);
  const loop = methodBody(driver, "async runHistoricalFillBatch(");

  it("calls observeDispatchOutcome", () => {
    expect(driver).toContain("observeDispatchOutcome({");
  });

  it("observes AFTER the executor returns a durable result", () => {
    // Before it there is no durable window fact to report -- and the breaker
    // must never run inside the executor's own transaction.
    ordered(loop, "executor.executeOne(", "this.observeOutcome(");
  });

  it("observes AFTER the certain zero-dispatch refund", () => {
    ordered(loop, "releaseCertainNonDispatch(reservation)", "this.observeOutcome(");
  });

  it("completes a drained campaign only AFTER the refund and the observation", () => {
    ordered(loop, "releaseCertainNonDispatch(reservation)", "completeIfDrained(");
    ordered(loop, "this.observeOutcome(", "completeIfDrained(");
  });

  it("stops before any further admission", () => {
    ordered(loop, "this.observeOutcome(", "stopsForCircuit(observation)");
    const lastStop = loop.lastIndexOf("stopsForCircuit(observation)");
    const lastCount = loop.lastIndexOf("outcomes[result.outcome] += 1;");
    expect(lastStop).toBeGreaterThan(lastCount);
  });

  it("counts the triggering outcome BEFORE stopping on it", () => {
    // The request already reached the exchange; dropping it from the summary
    // would understate exactly the spending this driver bounds.
    //
    // Anchored on the counted-outcome path specifically. The NO_WORK and
    // PROFILE_UNAVAILABLE branches also stop for an open circuit, and they sit
    // ABOVE this line -- a naive first-occurrence comparison would match one of
    // those and prove nothing about the branch that matters.
    const counted = loop.indexOf("outcomes[result.outcome] += 1;");
    expect(counted).toBeGreaterThan(-1);
    const stopAfterCounting = loop.indexOf("stopsForCircuit(observation)", counted);
    expect(stopAfterCounting).toBeGreaterThan(counted);
  });

  it("stops on the terminal branches too, and accounts their invocation", () => {
    // NO_WORK and PROFILE_UNAVAILABLE are NEUTRAL, so they can never OPEN the
    // latch -- but they can discover one another worker opened, and that
    // outranks an empty queue as the reason this account stopped.
    const stops = loop.match(/stopsForCircuit\(observation\)/g) ?? [];
    expect(stops.length).toBe(3);
    // Their terminal executor invocation is still counted as one.
    expect((loop.match(/outcomes, budget, used, campaign, 1\)/g) ?? []).length).toBe(2);
    expect((loop.match(/outcomes, budget, used, campaign, 0\)/g) ?? []).length).toBe(1);
  });

  it("treats CIRCUIT_OPENED and ALREADY_OPEN as the same instruction", () => {
    const predicate = /function stopsForCircuit\([\s\S]*?\n\}/.exec(driver);
    expect(predicate).not.toBeNull();
    expect(predicate![0]).toContain('"CIRCUIT_OPENED"');
    expect(predicate![0]).toContain('"ALREADY_OPEN"');
  });

  it("re-reads the campaign rather than reporting the pre-observation snapshot", () => {
    const stop = methodBody(driver, "private async circuitStop(");
    expect(stop).toContain("describeCampaign(campaign.id)");
    ordered(stop, "describeCampaign(campaign.id)", "campaignAccounting(settledCampaign)");
  });
});

describe("the driver forms no opinion of its own, and fails closed", () => {
  const driver = codeOf(DRIVER);
  const loop = methodBody(driver, "async runHistoricalFillBatch(");

  it("passes the executor's outcome and reason through untouched", () => {
    // No second classification table. A family or threshold decided here would
    // eventually disagree with the one that actually fires.
    const observe = methodBody(driver, "private async observeOutcome(");
    expect(observe).toContain("outcome: result.outcome");
    expect(observe).toContain("reasonCode: result.reasonCode ?? null");
    for (const owned of [
      "HARD_CONFIGURATION",
      "TRANSIENT_TRANSPORT",
      "RATE_LIMIT",
      "MALFORMED",
      "SYSTEMIC_THRESHOLD",
    ]) {
      expect(driver).not.toContain(owned);
    }
  });

  it("does not catch a failed observation", () => {
    // Not knowing whether protection was recorded must stop the batch, never
    // degrade into NO_CHANGE.
    const observe = methodBody(driver, "private async observeOutcome(");
    expect(observe).not.toContain("catch");
    expect(loop).not.toMatch(/observeOutcome\([\s\S]{0,200}?catch/);
  });

  it("fabricates no breaker call for an executor throw", () => {
    // `executeOne` throwing skips every line below it, so there is no reason
    // code to invent and no observation to make. Pinned because a future edit
    // wrapping that call in try/catch would silently change it.
    expect(loop).not.toMatch(/executeOne\([\s\S]{0,150}?catch/);
  });

  it("only a real transition carries the trip metadata", () => {
    const stop = methodBody(driver, "private async circuitStop(");
    expect(stop).toContain('observation.result === "CIRCUIT_OPENED"');
    // Both already-open paths state it explicitly rather than by omission.
    expect((driver.match(/circuitOpened: null,/g) ?? []).length).toBe(2);
  });

  it("leaks no generation into the transition metadata", () => {
    const transition = /export interface HistoricalFillCircuitTransition \{[\s\S]*?\n\}/.exec(driver);
    expect(transition).not.toBeNull();
    expect(transition![0]).not.toContain("generation");
  });

  it("refuses a campaign-governed loop with no observer wired", () => {
    const guard = /function assertCircuitObserver\([\s\S]*?\n\}/.exec(driver);
    expect(guard).not.toBeNull();
    expect(guard![0]).toContain("FillBatchRefusedError");
    expect(driver).toContain("assertCircuitObserver(");
  });
});

describe("the circuit-open event fires once per transition, and says only what is safe", () => {
  const RUNTIME = "src/modules/jobs/historical-fill-runtime.ts";
  const runtime = codeOf(RUNTIME);
  const emit = /if \(result\.outcome === "SYSTEMIC_CIRCUIT_OPEN"[\s\S]*?\n  \}/.exec(runtime);

  it("declares the dedicated event name", () => {
    expect(runtime).toContain('"historical_fill_campaign_circuit_opened"');
  });

  it("emits ONLY on a real transition, never on an already-open stop", () => {
    // Guarded on circuitOpened, never on the stop reason alone: all three ways
    // a batch stops for an open circuit share that reason, and only one of them
    // is a trip. Guarding on the reason would log every tick of an incident.
    expect(emit).not.toBeNull();
    expect(emit![0]).toContain("result.circuitOpened !== null");
  });

  it("logs no generation, no raw error and no account identifier", () => {
    for (const forbidden of ["generation", "executionProfileId", "accountIdentifier", "note"]) {
      expect(emit![0]).not.toContain(forbidden);
    }
  });

  it("takes family, reason, count and threshold from the service's own return", () => {
    for (const field of ["failureFamily", "lastReasonCode", "consecutiveCount", "threshold"]) {
      expect(emit![0]).toContain(`result.circuitOpened.${field}`);
    }
  });

  it("leaves the existing batch events alone", () => {
    expect(runtime).toContain('"historical_fill_batch_complete"');
    expect(runtime).toContain('"historical_fill_batch_failed"');
  });
});

/**
 * The executor's own outcome/reason pairing, pinned.
 *
 * The activation suite drives the driver with SCRIPTED executor results, which
 * is only worth anything if those scripts are shaped like results the executor
 * can actually produce. That realism is a claim about another file, and claims
 * about other files rot silently -- moving AUTH from the retryable set to the
 * terminal set would leave every activation test passing while they all drove a
 * pairing the executor had stopped producing.
 *
 * So the sets themselves are asserted here. If one moves, this fails, and the
 * scripts have to be revisited deliberately.
 */
describe("the scripted executor pairs match what the executor really returns", () => {
  const EXECUTOR = "src/modules/execution/exchange-fill-one-window-executor.service.ts";
  const executor = codeOf(EXECUTOR);

  const retryable = /const RETRYABLE_BINANCE_KINDS = new Set\(\[([\s\S]*?)\]\)/.exec(executor);
  const terminal = /const TERMINAL_BINANCE_KINDS = new Set\(\[([\s\S]*?)\]\)/.exec(executor);

  it("classifies the systemic kinds the activation suite drives as RETRYABLE", () => {
    expect(retryable).not.toBeNull();
    // Each of these reaches the driver as RETRY_SCHEDULED on a normal attempt,
    // and as ABANDONED only once the window's attempt budget is spent.
    for (const kind of [
      "AUTH",
      "PERMISSION",
      "MISSING_CREDENTIALS",
      "NETWORK",
      "TIMEOUT",
      "SERVER",
      "RATE_LIMIT",
      "TIMESTAMP",
      "MALFORMED_RESPONSE",
    ]) {
      expect(retryable![1]).toContain(`"${kind}"`);
    }
  });

  it("classifies REQUEST_INVALID and UNSUPPORTED_SYMBOL as TERMINAL", () => {
    expect(terminal).not.toBeNull();
    // These reach the driver as ABANDONED on ANY attempt.
    expect(terminal![1]).toContain('"REQUEST_INVALID"');
    expect(terminal![1]).toContain('"UNSUPPORTED_SYMBOL"');
    // ...and must never also be retryable, or the pairing would be ambiguous.
    expect(retryable![1]).not.toContain('"REQUEST_INVALID"');
    expect(retryable![1]).not.toContain('"UNSUPPORTED_SYMBOL"');
  });

  it("turns a retryable failure into RETRY_SCHEDULED until the budget is spent", () => {
    // The one line that decides which of the two shapes a retryable kind takes.
    expect(executor).toContain(
      'outcome: settled === "ABANDONED" ? "ABANDONED" : "RETRY_SCHEDULED"'
    );
  });

  it("abandons a terminal failure outright", () => {
    expect(executor).toMatch(/TERMINAL_BINANCE_KINDS\.has\(error\.kind\)[\s\S]{0,120}this\.abandon\(/);
  });

  it("the executor's self-decided contract breaches are abandoned", () => {
    // USER_TRADES_SYMBOL_MISMATCH and USER_TRADES_ROW_COUNT_EXCEEDS_LIMIT are
    // decided here rather than relayed, and both go straight to abandon.
    expect(executor).toMatch(/this\.abandon\(\s*claim,\s*FILL_INGEST_EXECUTION_REASON\.SYMBOL_MISMATCH/);
    expect(executor).toMatch(
      /this\.abandon\(\s*claim,\s*\r?\n?\s*FILL_INGEST_EXECUTION_REASON\.ROW_COUNT_EXCEEDS_LIMIT/
    );
  });

  it("the activation suite drives no pairing the executor cannot produce", () => {
    const suite = readFileSync(
      path.join(BACKEND, "tests/historical-fill-circuit-activation.integration.test.ts"),
      "utf8"
    );
    // A LEDGER RACE is retryable too, and is not a Binance kind: the executor
    // routes both race errors through the same scheduleRetry as a retryable
    // kind, so they reach the driver in exactly the same two shapes. Asserted
    // from source rather than exempted by name.
    expect(executor).toMatch(
      /FillLedgerInsertRaceError \|\| error instanceof FillLedgerRaceUnresolvedError\)\s*\{?\s*\r?\n?\s*return this\.scheduleRetry\(/
    );
    const ledgerRaces = ["FILL_LEDGER_INSERT_RACE", "FILL_LEDGER_RACE_UNRESOLVED"];
    /** Reasons the executor DECIDES itself and always abandons. */
    const selfDecided = ["USER_TRADES_SYMBOL_MISMATCH", "USER_TRADES_ROW_COUNT_EXCEEDS_LIMIT"];

    const pairs = [...suite.matchAll(/"(ABANDONED|RETRY_SCHEDULED):([A-Z_]+)"/g)];
    expect(pairs.length).toBeGreaterThan(0);
    for (const [, outcome, reason] of pairs) {
      const isRetryable = retryable![1].includes(`"${reason}"`) || ledgerRaces.includes(reason);
      const reachable =
        outcome === "RETRY_SCHEDULED"
          ? // Only something the executor schedules can come back as a retry.
            isRetryable
          : // ABANDONED is reachable for a terminal kind, for a reason the
            // executor decides itself, or for a retryable one out of budget.
            terminal![1].includes(`"${reason}"`) || selfDecided.includes(reason) || isRetryable;
      expect(`${outcome}:${reason}:${reachable}`).toBe(`${outcome}:${reason}:true`);
    }
  });
});

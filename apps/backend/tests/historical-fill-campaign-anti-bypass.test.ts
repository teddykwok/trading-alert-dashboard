import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE anti-bypass proof: no scheduled historical dispatch escapes a campaign.
 *
 * Every other test in this slice proves the campaign-aware path behaves
 * correctly. This one proves there is no OTHER path -- that the driver cannot
 * quietly go back to the legacy minute-only reservation, and that the two
 * orderings the design depends on are actually written in that order.
 *
 * Structural rather than behavioural on purpose: a regression here would not
 * make a test fail, it would silently restore an unbounded backfill. Needs no
 * database, so it runs everywhere.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

/**
 * Source with comments removed.
 *
 * These assertions are about what the code DOES, and the prose around this
 * feature necessarily mentions the very identifiers being searched for -- the
 * legacy method is documented at length precisely to say nobody may call it.
 * Matching raw text would fail on the explanation of its own absence.
 */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const DRIVER = "src/modules/execution/exchange-fill-batch-driver.service.ts";
const WORKER_RUNTIME = "src/modules/jobs/historical-fill-worker-runtime.ts";

/** Every .ts file under src, so a new bypass cannot hide in a new file. */
function productionSources(dir = path.join(BACKEND, "src")): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

describe("the scheduled historical path admits through a campaign", () => {
  it("the driver calls admitCampaignDispatch", () => {
    expect(codeOf(DRIVER)).toContain("admitCampaignDispatch({");
  });

  it("the driver never calls the legacy minute-only reservation", () => {
    // The one line that, if it came back, would restore an unbounded backfill
    // while every behavioural test still passed.
    const driver = codeOf(DRIVER);
    expect(driver).not.toContain(".reserve(");
    expect(driver).not.toContain("weightBudget.reserve");
  });

  it("the driver's dependency contract cannot even express the legacy call", () => {
    // Structural, not stylistic: a dep that no longer offers `reserve` makes
    // the bypass a compile error rather than a code-review question.
    const driver = codeOf(DRIVER);
    const deps = /weightBudget\?: \{[\s\S]*?\};/.exec(driver);
    expect(deps).not.toBeNull();
    expect(deps![0]).toContain("admitCampaignDispatch");
    expect(deps![0]).not.toContain("reserve");
  });

  it("NO production source calls .reserve( at all", () => {
    // The legacy method survives as a declaration for compatibility and for the
    // tests that pin 3B semantics. Nothing in src may invoke it.
    const callers = productionSources().filter((file) => codeOf(file).includes(".reserve("));
    expect(callers).toEqual([]);
  });

  it("the worker composes the driver with the budget, the gate AND the breaker", () => {
    const runtime = codeOf(WORKER_RUNTIME);
    const construction = /new HistoricalFillBatchDriver\(\{[\s\S]*?\}\);/.exec(runtime);
    expect(construction).not.toBeNull();
    for (const dependency of ["bootstrap", "executor", "weightBudget", "campaigns", "circuitBreaker"]) {
      expect(construction![0]).toContain(dependency);
    }
    expect(runtime).toContain("new HistoricalFillCampaignGate({ prisma })");
    expect(runtime).toContain("new HistoricalFillCircuitBreakerService(prisma)");
  });
});

describe("the two orderings the design depends on are written in that order", () => {
  it("the campaign gate is resolved BEFORE the bootstrap is called", () => {
    // If the bootstrap ran first, a profile with no campaign would seed a root
    // per symbol per day before discovering nothing authorises it -- the
    // expensive, hard-to-undo half of a backfill.
    const driver = codeOf(DRIVER);
    const gate = driver.indexOf("campaigns.resolveForBatch()");
    const bootstrap = driver.indexOf("bootstrap.bootstrapHistoricalRoots(");
    expect(gate).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(bootstrap);
  });

  it("the refund is issued BEFORE completion is evaluated", () => {
    // Refunding a COMPLETED campaign is a fail-closed invariant throw in the
    // budget service. This ordering is the only reason that is unreachable in
    // ordinary operation; reversed, a NO_WORK batch would strand its weight.
    const driver = codeOf(DRIVER);
    const refund = driver.indexOf("releaseCertainNonDispatch(reservation)");
    const complete = driver.indexOf("completeIfDrained(");
    expect(refund).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(-1);
    expect(refund).toBeLessThan(complete);
  });

  it("the gate and the bootstrap must agree on the account", () => {
    const driver = codeOf(DRIVER);
    expect(driver).toContain("campaignProfileId !== bootstrap.executionProfileId");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE EPOCH STAYS INTERNAL.
 *
 * `HistoricalFillCircuitBreaker.generation` exists for exactly one purpose: to
 * date a weight reservation against the breaker episode it was granted in, so a
 * refund landing after an acknowledgement cannot reopen a campaign nobody
 * restarted. It is accounting, and an operator can neither act on it nor be
 * helped by it -- while a monotonically rising number on a dashboard invites the
 * one reading that is definitely wrong, that a bigger number means worse.
 *
 * Nothing behavioural fails when it leaks. A serializer that spreads a Prisma
 * row, a CLI that prints a whole object, a log line that grows a field -- each
 * would pass every other test in this repository while putting it on a screen.
 * So the absence is asserted directly, at every surface a person can read.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");
const REPO = path.join(BACKEND, "..", "..");

/** Source with comments removed: the prose here names what it forbids. */
function codeOf(absolute: string): string {
  return readFileSync(absolute, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)(\/\/\/|\/\/).*$/, "$1"))
    .join("\n");
}

const backend = (relative: string) => codeOf(path.join(BACKEND, relative));

const SNAPSHOT = "src/modules/execution/historical-fill-operational-snapshot.service.ts";
const INTERPRETATION = "src/modules/execution/historical-fill-operational-interpretation.ts";
const ROUTES = "src/routes/operator.routes.ts";
const CLI = "src/modules/execution/fill-campaign-cli.ts";
const RUNTIME = "src/modules/jobs/historical-fill-runtime.ts";

describe("no operator-readable surface mentions the epoch", () => {
  it("the snapshot neither selects nor maps it", () => {
    const source = backend(SNAPSHOT);
    const select = /const CIRCUIT_SNAPSHOT_FIELDS = \{[\s\S]*?\} as const;/.exec(source);
    expect(select).not.toBeNull();
    expect(select![0]).not.toContain("generation");
    expect(select![0]).not.toContain("updatedAt");
    expect(select![0]).not.toContain("executionProfileId");
    const mapper = /function describeCircuitBreakerSnapshot\([\s\S]*?\n\}/.exec(source);
    expect(mapper).not.toBeNull();
    expect(mapper![0]).not.toContain("generation");
  });

  it("the public snapshot type does not declare it", () => {
    const shape = /export interface HistoricalFillCircuitBreakerSnapshot \{[\s\S]*?\n\}/.exec(
      backend(SNAPSHOT)
    );
    expect(shape).not.toBeNull();
    expect(shape![0]).not.toContain("generation");
  });

  it("the interpretation reads only the state", () => {
    const source = backend(INTERPRETATION);
    expect(source).toContain("OPEN");
    expect(source).not.toContain("generation");
    expect(source).not.toContain("consecutiveCount");
  });

  it("the route names its own fields and omits it", () => {
    const source = backend(ROUTES);
    const start = source.indexOf("circuitBreaker:");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, start + 700);
    expect(block).not.toContain("generation");
    expect(block).not.toContain("updatedAt");
    expect(block).not.toContain("...circuitBreaker");
  });

  it("the CLI prints only the safe fields", () => {
    const printer = /function describeCircuit\([\s\S]*?\n\}/.exec(backend(CLI));
    expect(printer).not.toBeNull();
    expect(printer![0]).not.toContain("generation");
    for (const field of [
      "state",
      "failureFamily",
      "lastReasonCode",
      "consecutiveCount",
      "firstFailureAt",
      "lastFailureAt",
      "openedAt",
    ]) {
      expect(printer![0]).toContain(field);
    }
  });

  it("the runtime circuit-open event omits it", () => {
    const emit = /if \(result\.outcome === "SYSTEMIC_CIRCUIT_OPEN"[\s\S]*?\n  \}/.exec(
      backend(RUNTIME)
    );
    expect(emit).not.toBeNull();
    expect(emit![0]).not.toContain("generation");
  });

  it("the frontend contract never declares or renders it", () => {
    for (const relative of [
      "apps/frontend/src/api/operator.ts",
      "apps/frontend/src/features/operator/historicalFillRunbook.ts",
      "apps/frontend/src/features/operator/historicalFillOperationsPresentation.ts",
      "apps/frontend/src/components/operator/HistoricalFillOperationsCard.tsx",
    ]) {
      const leaks = codeOf(path.join(REPO, relative)).includes("generation");
      expect(`${relative}:${leaks}`).toBe(`${relative}:false`);
    }
  });
});

describe("the operator surfaces are built, not forwarded", () => {
  it("the status CLI reports the circuit after the campaign, never instead of it", () => {
    const source = backend(CLI);
    const status = source.slice(source.indexOf("export async function statusCommand("));
    const noLive = status.indexOf("No live historical fill campaign");
    const report = status.indexOf("reportCircuit(deps, out, executionProfileId)");
    expect(noLive).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(noLive);
    // The "no campaign" branch must not return before the circuit is printed:
    // that is precisely the state a systemic fault tends to leave behind.
    expect(status.slice(noLive, report)).not.toContain("return { exitCode: CLI_EXIT.OK };");
  });

  it("the acknowledge command takes no selector and no override", () => {
    const command = /export async function acknowledgeCircuitCommand\([\s\S]*?\n\}/.exec(
      backend(CLI)
    );
    expect(command).not.toBeNull();
    expect(command![0]).toContain("if (argv.length > 0)");
    for (const forbidden of ["--profile", "--force", "--yes", "campaign-id"]) {
      expect(command![0]).not.toContain(forbidden);
    }
  });

  it("the acknowledge command delegates rather than reimplementing the latch", () => {
    const command = /export async function acknowledgeCircuitCommand\([\s\S]*?\n\}/.exec(
      backend(CLI)
    );
    expect(command![0]).toContain("deps.circuit.acknowledge({ executionProfileId })");
    for (const forbidden of ["createCampaign", "resumeCampaign", "pauseCampaign"]) {
      expect(command![0]).not.toContain(forbidden);
    }
  });

  it("the active-campaign refusal is surfaced, never swallowed", () => {
    const command = /export async function acknowledgeCircuitCommand\([\s\S]*?\n\}/.exec(
      backend(CLI)
    );
    expect(command![0]).toContain("HistoricalFillCircuitInvariantError");
    expect(command![0]).toContain("CLI_EXIT.REFUSED");
  });

  it("the snapshot reads the breaker inside the one repeatable-read transaction", () => {
    const source = backend(SNAPSHOT);
    const capture = source.slice(source.indexOf("async capture("));
    const read = capture.indexOf("tx.historicalFillCircuitBreaker.findUnique(");
    const isolation = capture.indexOf("Prisma.TransactionIsolationLevel.RepeatableRead");
    expect(read).toBeGreaterThan(-1);
    // Inside the callback, which closes before the isolation option is passed.
    expect(isolation).toBeGreaterThan(read);
    // Through `tx`, never a second unlocked read at a different instant.
    expect(capture).not.toContain("this.deps.prisma.historicalFillCircuitBreaker");
  });

  it("the new issue code is declared once and rendered generically", () => {
    const interpretation = backend(INTERPRETATION);
    const codes = /HISTORICAL_FILL_ISSUE_CODES = \[[\s\S]*?\] as const;/.exec(interpretation);
    expect(codes).not.toBeNull();
    expect(codes![0]).toContain("HISTORICAL_FILL_SYSTEMIC_CIRCUIT_OPEN");
    // First: the only condition that stops the whole account.
    const listed = [...codes![0].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(listed[0]).toBe("HISTORICAL_FILL_SYSTEMIC_CIRCUIT_OPEN");
  });
});

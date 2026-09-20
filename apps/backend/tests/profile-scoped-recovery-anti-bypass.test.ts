import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 11C — the structural half of profile isolation.
 *
 * The behavioural suite proves that a process bound to one profile does not
 * touch another one's rows. These tests pin the PROPERTY that makes that true,
 * because a regression here would not fail a behavioural test: with one
 * profile in the database, a query with the predicate and a query without it
 * return exactly the same rows.
 *
 * Two kinds of guarantee are used, and neither is a line number:
 *
 *   - compile-time tuples, asserted in typechecked source (the test project is
 *     excluded from `tsc`, so a contract pinned only here would never build);
 *   - source structure, over the discovery queries themselves.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const SRC = path.join(BACKEND, "src");

const ORCHESTRATOR = "src/modules/execution/execution-orchestrator.ts";
const DRAIN = "src/modules/execution/shutdown-drain.service.ts";
const ENTRY_RECOVERY = "src/modules/execution/entry-recovery.service.ts";
const PROTECTION_RECOVERY = "src/modules/execution/protection-recovery.service.ts";
const PREFLIGHT = "src/modules/execution/canary-preflight.service.ts";

/**
 * Source with comments removed.
 *
 * Line comments are stripped BEFORE block comments, and the order matters: a
 * line comment ending in a stray block-comment opener would otherwise swallow
 * every line until the next closing marker. The `[^:]` guard keeps `https://`
 * inside string literals intact.
 */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
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

/** The `where` object of a Prisma call, balanced-brace extracted. */
function whereBlockAfter(source: string, from: number): string {
  const at = source.indexOf("where", from);
  if (at === -1 || at - from > 400) return "";
  const open = source.indexOf("{", at);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < Math.min(source.length, open + 6000); i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open, open + 1500);
}

/**
 * Every TradeExecution query that DISCOVERS rows rather than addressing one.
 *
 * A query with `id:` in its `where` is already narrowed to a specific
 * execution reached through some other path; a query without one is choosing
 * which executions exist as far as its caller is concerned, and that is the
 * boundary the profile predicate has to sit on.
 */
function discoveryQueries(relative: string): Array<{ method: string; where: string }> {
  const source = codeOf(relative);
  const call = /tradeExecution\s*\.\s*(findMany|findFirst|count|updateMany|aggregate|groupBy)\s*\(/g;
  const found: Array<{ method: string; where: string }> = [];
  for (let match = call.exec(source); match !== null; match = call.exec(source)) {
    const where = whereBlockAfter(source, match.index + match[0].length);
    if (/\bid\s*:/.test(where)) continue;
    found.push({ method: match[1], where });
  }
  return found;
}

describe("every execution discovery query names a profile", () => {
  const MUST_BE_SCOPED = [
    [ORCHESTRATOR, "the orchestrator"],
    [DRAIN, "the shutdown drain"],
    [PREFLIGHT, "the canary preflight"],
  ] as const;

  for (const [module, description] of MUST_BE_SCOPED) {
    it(`${description} discovers nothing without executionProfileId`, () => {
      const unscoped = discoveryQueries(module).filter(
        (query) => !query.where.includes("executionProfileId")
      );
      expect(unscoped).toEqual([]);
    });

    it(`${description} has discovery queries at all, so the check is not vacuous`, () => {
      // A refactor that moved every query elsewhere would otherwise make the
      // assertion above pass by having nothing to say.
      expect(discoveryQueries(module).length).toBeGreaterThan(0);
    });
  }

  it("the predicate is in the query, not applied afterwards in memory", () => {
    const code = codeOf(ORCHESTRATOR);
    // The shape a later in-memory filter would take over a discovered batch.
    expect(code).not.toMatch(/\.filter\(\s*\(?\w+\)?\s*=>\s*\w+\.executionProfileId\s*===/);
    expect(code).not.toMatch(/executions\s*\.\s*filter\(/);
  });
});

describe("binding happens before discovery, and cannot be aimed", () => {
  it("the orchestrator is GIVEN its profile and resolves none of its own", () => {
    const code = codeOf(ORCHESTRATOR);
    // Phase 11D: injected at construction as a projection of the bound
    // runtime that also produced its clients' credentials.
    expect(code).toContain("boundProfile: BoundExecutionProfileProjection;");
    expect(code).toContain("return this.deps.boundProfile.executionProfileId;");
    // And there is nothing left that could re-resolve a different one.
    expect(code).not.toContain("resolveExecutionProfile(");
    expect(code).not.toContain("configuredProfileIdentity()");
    // No caller-supplied selector of any shape.
    for (const forbidden of ["profileId?:", "executionProfileId?:", "--profile-id"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("the tick reads its bound profile before it selects a batch", () => {
    const code = codeOf(ORCHESTRATOR);
    const bind = code.indexOf("const boundProfileId = this.boundProfileId();");
    const select = code.indexOf("await this.selectReconciliationBatch(");
    expect(bind).toBeGreaterThan(-1);
    expect(select).toBeGreaterThan(-1);
    expect(bind).toBeLessThan(select);
  });

  it("startup recovery counts its own profile and no other", () => {
    const code = codeOf(ORCHESTRATOR);
    const startup = code.indexOf("async runStartupRecovery(");
    const count = code.indexOf(
      "this.countRecoveryRequired(this.boundProfileId())",
      startup
    );
    expect(count).toBeGreaterThan(startup);
  });

  it("an unresolvable profile fails closed BEFORE an orchestrator exists", () => {
    // Phase 11D moved this refusal to the worker's startup barrier: the
    // orchestrator cannot be constructed without a bound projection, so
    // there is no per-tick failure branch left to take. Phase 11E moved
    // that barrier into the account execution worker.
    const worker = codeOf("src/modules/jobs/execution.worker.ts");
    const bind = worker.indexOf("const bound = await bindConfiguredExchangeRuntime(prisma);");
    const refuse = worker.indexOf("if (!bound.ok) {", bind);
    const build = worker.indexOf("createExecutionOrchestrator(runtime)");
    expect(bind).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(bind);
    expect(refuse).toBeLessThan(build);
  });
});

describe("the row identity assertion exists and is unconditional", () => {
  it("reconciliation compares the row to the bound profile before acting", () => {
    const code = codeOf(ORCHESTRATOR);
    expect(code).toContain("if (execution.executionProfileId !== boundProfileId) {");
    // Refused loudly, not skipped quietly.
    // The RECONCILIATION one, not admission's: both now compare against the
    // same injected id, and only the loop's copy is indented inside the tick.
    const at = code.indexOf(
      "        if (execution.executionProfileId !== boundProfileId) {"
    );
    expect(at).toBeGreaterThan(-1);
    const block = code.slice(at, at + 1200);
    expect(block).toContain("result.failed = true;");
    expect(block).toContain("PROFILE_MISMATCH_REASON_CODE");
    expect(block).toContain("continue;");
  });

  it("both operator recovery services check ownership before gathering evidence", () => {
    for (const module of [ENTRY_RECOVERY, PROTECTION_RECOVERY]) {
      const code = codeOf(module);
      expect(code).toContain("private belongsToBoundProfile(execution: TradeExecution): boolean {");
      expect(code).toContain(
        "execution.executionProfileId === this.boundProfile.executionProfileId"
      );
      // The check precedes the first evidence gather in the file.
      const check = code.indexOf("this.belongsToBoundProfile(execution)");
      const gather = code.indexOf("await this.gather(execution)");
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(gather);
    }
  });

  it("a foreign row is a named refusal, never a success shape", () => {
    for (const module of [ENTRY_RECOVERY, PROTECTION_RECOVERY]) {
      const code = codeOf(module);
      expect(code).toContain('"FOREIGN_PROFILE"');
    }
  });
});

/**
 * The operator recovery services are the one place an execution id arrives
 * from outside the system -- an operator types it. A row-addressed read
 * followed by a JavaScript ownership check would bring another account's
 * execution into the process; these tests pin that it is never selected.
 *
 * The whole-src sweep below cannot cover this: it deliberately exempts
 * queries carrying an `id:`, because those are addressing one row rather
 * than choosing which rows exist. So the predicate is asserted directly.
 */
describe("the operator recovery lookups name BOTH the id and the profile", () => {
  const RECOVERY_SERVICES = [
    [ENTRY_RECOVERY, "entry recovery"],
    [PROTECTION_RECOVERY, "protection recovery"],
  ] as const;

  for (const [module, description] of RECOVERY_SERVICES) {
    it(`${description} selects by id AND executionProfileId in one predicate`, () => {
      const code = codeOf(module);
      const at = code.indexOf("private async loadOwnedExecution(");
      expect(at).toBeGreaterThan(-1);
      const body = code.slice(at, at + 400);
      expect(body).toContain("findFirst(");
      expect(body).toContain(
        "where: { id: executionId, executionProfileId: this.boundProfile.executionProfileId }"
      );
    });

    it(`${description} has no row-addressed execution read left unscoped`, () => {
      // Every TradeExecution read in the file either names the profile or is
      // the existence-only COUNT, which returns no row at all.
      const code = codeOf(module);
      const reads = /tradeExecution\s*\.\s*(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|count)\s*\(/g;
      const offenders: string[] = [];
      for (let m = reads.exec(code); m !== null; m = reads.exec(code)) {
        const where = whereBlockAfter(code, m.index + m[0].length);
        if (where.includes("executionProfileId")) continue;
        // The probe is allowed, and only in its count form.
        if (m[1] === "count" && /^\{\s*id:\s*executionId\s*\}$/.test(where.replace(/\s+/g, " ").trim())) continue;
        offenders.push(`${m[1]} ${where.replace(/\s+/g, " ")}`);
      }
      expect(offenders).toEqual([]);
    });

    it(`${description} probes existence with a count, never with a row`, () => {
      const code = codeOf(module);
      const at = code.indexOf("private async existsUnderAnyProfile(");
      expect(at).toBeGreaterThan(-1);
      const body = code.slice(at, at + 300);
      // A count returns a number: there is no object to hand to `gather`.
      expect(body).toContain("tradeExecution.count(");
      expect(body).not.toContain("findFirst(");
      expect(body).not.toContain("findUnique(");
      expect(body).not.toContain("select:");
    });

    it(`${description} passes no probe result into evidence gathering`, () => {
      const code = codeOf(module);
      // `gather` is only ever reached with the row the scoped read returned.
      const gathers = code.match(/this\.gather\(\w+\)/g) ?? [];
      expect(gathers.length).toBeGreaterThan(0);
      for (const call of gathers) expect(call).toBe("this.gather(execution)");
    });
  }

  it("both operator CLIs load a display row through the same scoped predicate", () => {
    for (const module of [
      "src/modules/execution/entry-recovery-cli.ts",
      "src/modules/execution/protection-recovery-cli.ts",
    ]) {
      const code = codeOf(module);
      expect(code).toContain(
        "where: { id: executionId, executionProfileId: deps.recovery.boundExecutionProfileId }"
      );
      // And the refusal branch decides its wording from a count, not a row.
      expect(code).toContain("tradeExecution.count({ where: { id: executionId } })");
      expect(code).not.toContain("tradeExecution.findUnique(");
    }
  });
});

describe("the binding is construction-time and read-only", () => {
  it("no recovery service exposes a way to change or supply a profile", () => {
    for (const module of [ENTRY_RECOVERY, PROTECTION_RECOVERY, DRAIN]) {
      const code = codeOf(module);
      expect(code).toContain("executionProfileId");
      // A setter, or a method parameter, would reintroduce caller-chosen routing.
      expect(code).not.toMatch(/set\s+\w*[Pp]rofile\w*\s*\(/);
      expect(code).not.toMatch(/this\.executionProfileId\s*=/);
    }
  });

  it("the compile-time contracts that make omission a build error are present", () => {
    // Asserted in typechecked source; named here so deleting one is visible.
    expect(codeOf(DRAIN)).toContain("ConstructorParameters<typeof ShutdownDrainService>");
    expect(codeOf(ENTRY_RECOVERY)).toContain("ConstructorParameters<typeof EntryRecoveryService>");
    expect(codeOf(PROTECTION_RECOVERY)).toContain(
      "ConstructorParameters<typeof ProtectionRecoveryService>"
    );
    expect(codeOf(ORCHESTRATOR)).toContain(
      'Parameters<ExecutionOrchestrator["countReconcilable"]>'
    );
    expect(codeOf(ORCHESTRATOR)).toContain(
      'Parameters<ExecutionOrchestrator["countRecoveryRequired"]>'
    );
  });
});

describe("every runner binds the configured profile before building a client", () => {
  const RUNNERS = [
    ["src/modules/execution/run-entry-recovery.ts", "entry recovery"],
    ["src/modules/execution/run-protection-recovery.ts", "protection recovery"],
    ["src/modules/execution/run-shutdown-drain.ts", "the shutdown drain"],
  ] as const;

  for (const [module, description] of RUNNERS) {
    it(`${description} binds the canonical runtime and refuses without one`, () => {
      const code = codeOf(module);
      // Phase 11D: ONE binder, and it yields both the profile projection this
      // command owns and the credentials its clients are built from.
      expect(code).toContain("bindConfiguredExchangeRuntime(prisma)");
      expect(code).toContain("if (!bound.ok) {");
      expect(code).toContain("process.exitCode = 1;");
      // And no independent resolution survives alongside it.
      expect(code).not.toContain("resolveExecutionProfile(");
      expect(code).not.toContain("configuredProfileIdentity()");
    });

    it(`${description} builds no client before the binding succeeds`, () => {
      const code = codeOf(module);
      const refuse = code.indexOf("if (!bound.ok) {");
      const firstClient = Math.min(
        ...[
          "new BinanceReadOnlyService(",
          "new BinanceUsdMExecutionClient(",
          "new BinanceReadOnlyClient(",
        ]
          .map((needle) => code.indexOf(needle))
          .filter((at) => at > -1)
      );
      expect(refuse).toBeGreaterThan(-1);
      expect(firstClient).toBeGreaterThan(refuse);
    });

    it(`${description} accepts no profile argument from the operator`, () => {
      const code = codeOf(module);
      for (const forbidden of ["--profile", "--account", "profileId =", "PROFILE_ID"]) {
        expect(code).not.toContain(forbidden);
      }
    });
  }
});

describe("no other production module reintroduces an unscoped execution scan", () => {
  /**
   * Modules whose TradeExecution discovery is deliberately table-wide.
   *
   * Listed per file with the reason, never per directory, so a NEW file cannot
   * inherit an exemption. None of these can reach a signed Binance request
   * from a row they discover.
   */
  const REPORTING_ONLY = new Set([
    // The operator journal: a read-only history surface. It renders rows and
    // reaches no exchange client of any kind.
    "src/modules/execution/execution-journal.service.ts",
  ]);

  it("only the declared reporting surfaces scan across profiles", () => {
    const offenders = productionSources()
      .filter((module) => !REPORTING_ONLY.has(module))
      .filter((module) =>
        discoveryQueries(module).some((query) => !query.where.includes("executionProfileId"))
      );
    expect(offenders).toEqual([]);
  });

  it("the exemption list is exactly this, and cannot be widened quietly", () => {
    expect([...REPORTING_ONLY]).toEqual([
      "src/modules/execution/execution-journal.service.ts",
    ]);
  });

  it("the exempt module really is exchange-free", () => {
    const code = codeOf("src/modules/execution/execution-journal.service.ts");
    for (const client of [
      "BinanceReadOnlyService",
      "BinanceReadOnlyClient",
      "BinanceUsdMExecutionClient",
      "configuredExchangeClientOptions",
    ]) {
      expect(code).not.toContain(client);
    }
  });
});

/**
 * Phase 11D — no service may keep a second source of profile truth.
 */
describe("the bound projection is the only profile authority in recovery", () => {
  it("protection recovery reads no ExecutionProfile row at all", () => {
    const code = codeOf(PROTECTION_RECOVERY);
    expect(code).not.toContain("executionProfile.findUnique");
    expect(code).not.toContain("executionProfile.findFirst");
    expect(code).not.toContain("prisma.executionProfile");
  });

  it("its environment comes from the immutable bound projection", () => {
    const code = codeOf(PROTECTION_RECOVERY);
    expect(code).toContain("connectorEnvironmentMatches(this.boundProfile.environment");
    // Construction-time and read-only: no setter, no reassignment.
    expect(code).toContain("private readonly boundProfile: BoundExecutionProfileProjection");
    expect(code).not.toMatch(/this\.boundProfile\s*=/);
  });

  it("neither recovery service resolves a configured profile of its own", () => {
    for (const module of [ENTRY_RECOVERY, PROTECTION_RECOVERY]) {
      const code = codeOf(module);
      expect(code).not.toContain("resolveExecutionProfile(");
      expect(code).not.toContain("configuredProfileIdentity()");
      expect(code).not.toContain("bindConfiguredExchangeRuntime(");
    }
  });
});

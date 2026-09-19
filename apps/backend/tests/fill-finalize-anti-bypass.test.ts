import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE anti-bypass proof for the exhausted-window repair.
 *
 * Two claims, both load-bearing. The repair must not be able to reach anything
 * that spends money or starts work -- no exchange reader, no executor, no
 * driver, no bootstrap, no weight reservation, no scheduler. And the scheduled
 * path must not be able to reach the repair, because AVAILABILITY IS NOT
 * AUTOMATION: this slice makes a human able to run it, and nothing more.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const SRC = path.join(BACKEND, "src");

const ENTRYPOINT = "src/modules/execution/run-fill-window-finalize-exhausted.ts";
const COMPOSITION = "src/modules/execution/run-fill-finalize.ts";
const CLI = "src/modules/execution/fill-finalize-exhausted-cli.ts";
const WORK = "src/modules/execution/exchange-fill-ingest-window.service.ts";
const DRIVER = "src/modules/execution/exchange-fill-batch-driver.service.ts";
const EXECUTOR = "src/modules/execution/exchange-fill-one-window-executor.service.ts";
const BOOTSTRAP = "src/modules/execution/exchange-fill-root-bootstrap.service.ts";
const READER = "src/modules/binance/binance-read-only.service.ts";
const WORKER_RUNTIME = "src/modules/jobs/historical-fill-worker-runtime.ts";
const SCHEDULER = "src/modules/jobs/historical-fill.scheduler.ts";

/** Source with comments removed; the prose necessarily names what it excludes. */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every RUNTIME relative specifier this module imports.
 *
 * `import type` statements are stripped first: TypeScript erases them, so a
 * type-only edge loads no module and can carry no behaviour. What is bounded
 * here is what the command can DO, so the graph must be the runtime graph.
 */
function specifiersOf(relative: string): string[] {
  const code = codeOf(relative).replace(/import\s+type\s*\{[^}]*\}\s*from\s*"[^"]*";/g, "");
  const found: string[] = [];
  for (const match of code.matchAll(/from\s+"(\.[^"]*)"/g)) found.push(match[1]!);
  for (const match of code.matchAll(/import\s*\(\s*"(\.[^"]*)"\s*\)/g)) found.push(match[1]!);
  return found;
}

function resolveSpecifier(fromRelative: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(path.join(BACKEND, fromRelative)), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.startsWith(SRC)) {
      return path.relative(BACKEND, candidate).split(path.sep).join("/");
    }
  }
  return null;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const specifier of specifiersOf(current)) {
      const resolved = resolveSpecifier(current, specifier);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/** Every .ts file under src, so a new importer cannot hide in a new file. */
function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

const GRAPH = reachableFrom(ENTRYPOINT);
const OWN = new Set([ENTRYPOINT, COMPOSITION, CLI]);

describe("the repair cannot reach anything that spends or starts work", () => {
  it("resolves a real, non-trivial graph", () => {
    // Guards the walker: a resolver finding nothing would make every absence
    // assertion below vacuously true.
    expect(GRAPH.has(ENTRYPOINT)).toBe(true);
    expect(GRAPH.has(COMPOSITION)).toBe(true);
    expect(GRAPH.has(CLI)).toBe(true);
    expect(GRAPH.has(WORK)).toBe(true);
    expect(GRAPH.size).toBeGreaterThan(3);
  });

  const UNREACHABLE: ReadonlyArray<readonly [string, string]> = [
    [READER, "the Binance read-only reader"],
    [EXECUTOR, "the one-window executor"],
    [DRIVER, "the batch driver"],
    [BOOTSTRAP, "the root bootstrap"],
    [WORKER_RUNTIME, "the historical worker runtime"],
    [SCHEDULER, "the historical scheduler"],
    ["src/modules/execution/historical-fill-weight-budget.service.ts", "the shared weight budget"],
    ["src/modules/execution/historical-fill-circuit-breaker.service.ts", "the circuit breaker"],
    ["src/modules/execution/historical-fill-campaign.service.ts", "the campaign service"],
    ["src/modules/execution/historical-fill-campaign-gate.service.ts", "the campaign gate"],
    ["src/modules/execution/historical-fill-targeted-canary.service.ts", "the targeted canary"],
  ];

  for (const [module, description] of UNREACHABLE) {
    it(`cannot reach ${description}, at any depth`, () => {
      // The module exists; this is an absence from the graph, not a typo.
      expect(existsSync(path.join(BACKEND, module))).toBe(true);
      expect([...GRAPH]).not.toContain(module);
    });
  }

  it("reaches no module that issues an HTTP request", () => {
    const requesting = [...GRAPH].filter((module) =>
      /\bfetch\s*\(|\baxios\b|\bnode-fetch\b|\bhttps?\.request\s*\(/.test(codeOf(module))
    );
    expect(requesting).toEqual([]);
  });

  it("reaches no module naming the userTrades endpoint path", () => {
    const naming = [...GRAPH].filter((module) => /fapi\/v1\/userTrades/.test(codeOf(module)));
    expect(naming).toEqual([]);
  });

  it("constructs exactly the client and the window service", () => {
    const constructed = [...codeOf(COMPOSITION).matchAll(/new\s+([A-Za-z0-9_]+)\s*\(/g)].map(
      (match) => match[1]!
    );
    expect(constructed.sort()).toEqual(["ExchangeFillIngestWindowService", "PrismaClient"]);
  });

  it("the command's own files never name dispatch, campaign or circuit machinery", () => {
    for (const module of OWN) {
      const code = codeOf(module);
      for (const marker of [
        "BinanceReadOnlyService",
        "ExchangeFillOneWindowExecutor",
        "HistoricalFillBatchDriver",
        "ExchangeFillRootBootstrap",
        "HistoricalFillWeightBudgetService",
        "HistoricalFillCircuitBreakerService",
        "HistoricalFillCampaignService",
        "createHistoricalFillScheduler",
        "admitCampaignDispatch",
        "observeDispatchOutcome",
        "completeIfDrained",
        "bootstrapHistoricalRoots",
        "listRecentTradesOnce",
        "EXECUTION_FILL_RUNTIME_ENABLED",
      ]) {
        expect(code).not.toContain(marker);
      }
    }
  });

  it("calls exactly one service method, and it is the repair", () => {
    const cli = codeOf(CLI);
    const calls = cli.match(/deps\.work\.[A-Za-z]+\(/g) ?? [];
    expect(calls).toEqual(["deps.work.finalizeStaleExhausted("]);
  });
});

describe("availability is not automation", () => {
  const SCHEDULED = [
    [DRIVER, "the batch driver"],
    [WORKER_RUNTIME, "the worker runtime"],
    [SCHEDULER, "the historical scheduler"],
  ] as const;

  for (const [module, description] of SCHEDULED) {
    it(`${description} never imports the repair`, () => {
      const code = codeOf(module);
      for (const marker of [
        "run-fill-finalize",
        "run-fill-window-finalize-exhausted",
        "fill-finalize-exhausted-cli",
        "runFillFinalizeExhaustedCli",
        "runFillWindowFinalizeExhaustedCommand",
      ]) {
        expect(code).not.toContain(marker);
      }
    });
  }

  it("the batch driver never invokes the repair itself", () => {
    // The whole point of the slice: the driver must not silently gain an
    // automatic cleanup that nobody decided to run.
    expect(codeOf(DRIVER)).not.toContain("finalizeStaleExhausted");
  });

  it("NO production module outside the command's own files calls the repair", () => {
    const callers = productionSources()
      .filter((module) => !OWN.has(module))
      .filter((module) => module !== WORK)
      .filter((module) => codeOf(module).includes("finalizeStaleExhausted"));
    expect(callers).toEqual([]);
  });

  it("no production module outside the command's own files imports it", () => {
    const importers = productionSources()
      .filter((module) => !OWN.has(module))
      .filter((module) =>
        /run-fill-finalize|run-fill-window-finalize-exhausted|fill-finalize-exhausted-cli/.test(
          codeOf(module)
        )
      );
    expect(importers).toEqual([]);
  });

  it("is registered as an operator script and wired into no lifecycle hook", () => {
    const scripts = (
      JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["execution:fill-window-finalize-exhausted"]).toBe(
      "tsx src/modules/execution/run-fill-window-finalize-exhausted.ts"
    );
    const wired = Object.entries(scripts)
      .filter(([name]) => name !== "execution:fill-window-finalize-exhausted")
      .filter(([, command]) => command.includes("run-fill-window-finalize-exhausted"));
    expect(wired).toEqual([]);
    for (const hook of ["start", "dev", "worker", "prestart", "poststart", "prebuild", "postbuild", "postinstall"]) {
      expect(scripts[hook] ?? "").not.toContain("finalize-exhausted");
    }
  });
});

describe("the audited service method is untouched and unsteerable", () => {
  it("the CLI cannot express a limit or a clock", () => {
    const cli = codeOf(CLI);
    // The narrowed capability type is what makes this structural rather than a
    // habit: the CLI is handed a method that accepts neither.
    expect(cli).toContain("options: { executionProfileId: string }");
    // Actual CODE use, not the word. The usage text legitimately tells an
    // operator that no limit flag exists; what must never appear is the CLI
    // PASSING one, or reading a clock to override the service's own.
    expect(cli).not.toContain("limit:");
    expect(cli).not.toContain("options.limit");
    expect(cli).not.toContain("now:");
    expect(cli).not.toContain("deps.now");
  });

  it("the repair's own predicates still live in the service, not the CLI", () => {
    const work = codeOf(WORK);
    const finalize = work.slice(work.indexOf("async finalizeStaleExhausted("));
    expect(finalize).toContain('status: "PENDING"');
    expect(finalize).toContain("attempts: { gte: MAX_INGEST_ATTEMPTS }");
    expect(finalize).toContain("claimedAt: { lt: staleBefore }");
    expect(finalize).toContain("take: options.limit ?? 50");
    expect(finalize).toContain('status: "ABANDONED"');
    // And the CLI restates none of them.
    const cli = codeOf(CLI);
    expect(cli).not.toContain("MAX_INGEST_ATTEMPTS");
    expect(cli).not.toContain("staleBefore");
    expect(cli).not.toContain("updateMany");
    expect(cli).not.toContain("findMany");
  });

  it("no argument can choose an account, a window, a force or a bound", () => {
    const cli = codeOf(CLI);
    for (const flag of [
      "--profile", "--profile-id", "--execution-profile-id",
      "--account", "--account-id", "--window-id", "--force", "--limit", "--yes",
    ]) {
      expect(cli).not.toContain(`${flag}=`);
    }
    expect(cli).toContain("if (argv.length > 0)");
  });

  it("the CLI never prints the bound execution profile id", () => {
    const cli = codeOf(CLI);
    expect(cli).not.toContain("context.executionProfileId)");
    expect(cli).not.toContain("...binding");
  });
});

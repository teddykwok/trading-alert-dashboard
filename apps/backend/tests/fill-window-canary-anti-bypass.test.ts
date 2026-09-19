import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE anti-bypass proof for the targeted one-window canary.
 *
 * Two opposite claims are made here, and both matter. The canary must not be
 * able to reach the machinery that would let it materialize roots, loop, or
 * schedule itself -- and the scheduled path must not be able to reach the
 * canary at all. Behavioural tests can only show that something did not happen
 * on one run; these show it cannot happen on any.
 *
 * The canary DOES reach the Binance reader, deliberately: making one real
 * request is its entire purpose. What is bounded structurally is that there is
 * exactly one call site for it and no loop around it.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const SRC = path.join(BACKEND, "src");

const ENTRYPOINT = "src/modules/execution/run-fill-window-canary.ts";
const COMPOSITION = "src/modules/execution/run-fill-canary.ts";
const CLI = "src/modules/execution/fill-window-canary-cli.ts";
const CANARY = "src/modules/execution/historical-fill-targeted-canary.service.ts";
const EXECUTOR = "src/modules/execution/exchange-fill-one-window-executor.service.ts";
const WORK = "src/modules/execution/exchange-fill-ingest-window.service.ts";
const DRIVER = "src/modules/execution/exchange-fill-batch-driver.service.ts";
const WORKER_RUNTIME = "src/modules/jobs/historical-fill-worker-runtime.ts";
const SCHEDULER = "src/modules/jobs/historical-fill.scheduler.ts";
const BOOTSTRAP = "src/modules/execution/exchange-fill-root-bootstrap.service.ts";

/** Source with comments removed; the prose necessarily names what it excludes. */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every RUNTIME relative specifier this module imports.
 *
 * `import type` statements are stripped first, deliberately. TypeScript erases
 * them, so a type-only edge loads no module and can carry no behaviour -- and
 * counting one would report a module as "reachable" that the process never
 * evaluates. What these tests bound is what the canary can DO, so the graph
 * must be the runtime graph.
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

/** Every module reachable from `entry`, transitively, including `entry`. */
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

/** Every .ts file under src, so a new bypass cannot hide in a new file. */
function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

const CANARY_GRAPH = reachableFrom(ENTRYPOINT);
const CANARY_OWN = new Set([ENTRYPOINT, COMPOSITION, CLI, CANARY]);

describe("the canary cannot materialize, loop or schedule", () => {
  it("resolves a real, non-trivial graph", () => {
    // Guards the walker: a resolver finding nothing would make every absence
    // assertion below vacuously true.
    expect(CANARY_GRAPH.has(ENTRYPOINT)).toBe(true);
    expect(CANARY_GRAPH.has(CANARY)).toBe(true);
    expect(CANARY_GRAPH.has(EXECUTOR)).toBe(true);
    expect(CANARY_GRAPH.size).toBeGreaterThan(8);
  });

  const UNREACHABLE: ReadonlyArray<readonly [string, string]> = [
    [BOOTSTRAP, "the root bootstrap"],
    [WORKER_RUNTIME, "the historical worker runtime"],
    [SCHEDULER, "the historical scheduler"],
  ];

  for (const [module, description] of UNREACHABLE) {
    it(`cannot reach ${description}, at any depth`, () => {
      // The module exists; this is an absence from the graph, not a typo.
      expect(existsSync(path.join(BACKEND, module))).toBe(true);
      expect([...CANARY_GRAPH]).not.toContain(module);
    });
  }

  it("reaches the driver module only for a shared constant, and never uses it", () => {
    // HONEST ABOUT WHAT IS TRUE. The driver module is in the runtime graph, and
    // was before this slice existed: `historical-fill-weight-budget.service.ts`
    // imports `USER_TRADES_REQUEST_WEIGHT` from it, so ANYTHING that admits
    // weight -- the scheduled path included -- pulls the module in. What matters
    // is that the canary never builds or calls a driver.
    expect([...CANARY_GRAPH]).toContain(DRIVER);
    expect(codeOf("src/modules/execution/historical-fill-weight-budget.service.ts")).toContain(
      'import { USER_TRADES_REQUEST_WEIGHT } from "./exchange-fill-batch-driver.service"'
    );
    for (const module of CANARY_OWN) {
      expect(codeOf(module)).not.toContain("HistoricalFillBatchDriver");
      expect(codeOf(module)).not.toContain("runHistoricalFillBatch");
    }
  });

  it("the only reachable call to the root materializer is the driver's, which is never built", () => {
    // PRECISE, because the graph contains more than the canary uses. The one
    // reachable invocation of `bootstrapHistoricalRoots(` lives in the batch
    // driver and runs on `this.deps.bootstrap` -- an instance that exists only
    // when somebody constructs a driver. Nothing in the canary's own files
    // does, so the call site is present in the module graph and unreachable in
    // execution. `exchange-fill-day-roots` merely DEFINES the generator.
    const callers = [...CANARY_GRAPH].filter((module) =>
      codeOf(module).includes("bootstrapHistoricalRoots(")
    );
    expect(callers).toEqual([DRIVER]);
    expect(codeOf(DRIVER)).toContain("this.deps.bootstrap.bootstrapHistoricalRoots({");

    const definers = [...CANARY_GRAPH].filter((module) =>
      codeOf(module).includes("canonicalUtcDayRoots(")
    );
    expect(definers).toEqual(["src/modules/execution/exchange-fill-day-roots.ts"]);
    expect(codeOf(definers[0]!)).toContain("export function canonicalUtcDayRoots(");

    // And nobody in the graph constructs the bootstrap at all.
    const builders = [...CANARY_GRAPH].filter((module) =>
      codeOf(module).includes("new ExchangeFillRootBootstrap(")
    );
    expect(builders).toEqual([]);
  });

  it("the canary's own files never name the materializer at all", () => {
    for (const module of CANARY_OWN) {
      const code = codeOf(module);
      for (const marker of [
        "ExchangeFillRootBootstrap",
        "bootstrapHistoricalRoots",
        "canonicalUtcDayRoots",
      ]) {
        expect(code).not.toContain(marker);
      }
    }
  });

  it("never names the ingest horizon", () => {
    // Materialization is a different command's job; a horizon here would be the
    // first sign that this one had started doing it.
    for (const module of CANARY_OWN) {
      expect(codeOf(module)).not.toContain("EXECUTION_FILL_INGEST_HORIZON_DAYS");
    }
  });

  it("constructs no bootstrap, driver or scheduler", () => {
    const composition = codeOf(COMPOSITION);
    for (const forbidden of [
      "ExchangeFillRootBootstrap",
      "HistoricalFillBatchDriver",
      "createHistoricalFillScheduler",
    ]) {
      expect(composition).not.toContain(forbidden);
    }
  });

  it("constructs exactly the client and the seven guarded services", () => {
    const constructed = [...codeOf(COMPOSITION).matchAll(/new\s+([A-Za-z0-9_]+)\s*\(/g)].map(
      (match) => match[1]!
    );
    expect(constructed.sort()).toEqual([
      "BinanceReadOnlyService",
      "ExchangeFillIngestWindowService",
      "ExchangeFillLedgerService",
      "ExchangeFillOneWindowExecutor",
      "HistoricalFillCampaignService",
      "HistoricalFillCircuitBreakerService",
      "HistoricalFillTargetedCanary",
      "HistoricalFillWeightBudgetService",
      "PrismaClient",
    ]);
  });
});

describe("the scheduled path cannot reach the canary", () => {
  const SCHEDULED = [
    [DRIVER, "the batch driver"],
    [WORKER_RUNTIME, "the worker runtime"],
    [SCHEDULER, "the scheduler"],
  ] as const;

  for (const [module, description] of SCHEDULED) {
    it(`${description} never imports the canary`, () => {
      const code = codeOf(module);
      for (const marker of [
        "run-fill-canary",
        "run-fill-window-canary",
        "fill-window-canary-cli",
        "historical-fill-targeted-canary",
        "HistoricalFillTargetedCanary",
        "executeSpecificWindow",
        "claimSpecificWindow",
      ]) {
        expect(code).not.toContain(marker);
      }
    });
  }

  it("the driver knows nothing about window targeting", () => {
    const driver = codeOf(DRIVER);
    for (const marker of ["windowId", "targetWindowId", "window-id", "--window-id"]) {
      expect(driver).not.toContain(marker);
    }
  });

  it("no production module outside the canary's own files imports it", () => {
    const importers = productionSources()
      .filter((module) => !CANARY_OWN.has(module))
      .filter((module) =>
        /run-fill-canary|run-fill-window-canary|fill-window-canary-cli|historical-fill-targeted-canary/.test(
          codeOf(module)
        )
      );
    expect(importers).toEqual([]);
  });

  it("is wired into no lifecycle, start or worker script", () => {
    const scripts = (
      JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["execution:fill-window-canary"]).toBe(
      "tsx src/modules/execution/run-fill-window-canary.ts"
    );
    const wired = Object.entries(scripts)
      .filter(([name]) => name !== "execution:fill-window-canary")
      .filter(([, command]) => command.includes("run-fill-window-canary"));
    expect(wired).toEqual([]);
    for (const hook of ["prestart", "poststart", "prebuild", "postbuild", "postinstall"]) {
      expect(scripts[hook] ?? "").not.toContain("canary");
    }
  });
});

describe("the normal FIFO path is untouched", () => {
  it("executeOne still takes only a worker id and an optional clock", () => {
    expect(codeOf(EXECUTOR)).toContain(
      "async executeOne(options: { workerId: string; now?: Date }): Promise<FillIngestExecutionResult>"
    );
  });

  it("executeOne still claims through claimNextWindow", () => {
    const executor = codeOf(EXECUTOR);
    const one = executor.indexOf("async executeOne(");
    const specific = executor.indexOf("async executeSpecificWindow(");
    const fifoClaim = executor.indexOf("this.deps.work.claimNextWindow(");
    expect(one).toBeGreaterThan(-1);
    expect(fifoClaim).toBeGreaterThan(one);
    // The FIFO claim belongs to executeOne, not to the targeted method.
    expect(fifoClaim).toBeLessThan(specific);
  });

  it("claimNextWindow takes no targeting filter", () => {
    expect(codeOf(WORK)).toContain(
      "async claimNextWindow(\n    client: Prisma.TransactionClient,\n    options: { executionProfileId: string; workerId: string; now?: Date }\n  )".replace(
        /\n/g,
        "\r\n"
      )
    );
  });

  it("claimSpecificWindow is a separate method, not a branch inside the FIFO one", () => {
    const work = codeOf(WORK);
    expect(work).toContain("async claimSpecificWindow(");
    // One `windowId` predicate, and it is not inside claimNextWindow's body.
    const fifoStart = work.indexOf("async claimNextWindow(");
    const targetedStart = work.indexOf("async claimSpecificWindow(");
    expect(targetedStart).toBeGreaterThan(fifoStart);
    const fifoBody = work.slice(fifoStart, targetedStart);
    // The FIFO body legitimately RETURNS `windowId` as a field of its claim.
    // What it must never gain is a windowId INPUT or predicate.
    expect(fifoBody).not.toContain("options.windowId");
    expect(fifoBody).not.toContain("id: options.");
    expect(fifoBody).not.toContain("windowId:  string");
  });
});

describe("both routes converge before the exchange request", () => {
  it("the request has exactly one call site in the executor", () => {
    const executor = codeOf(EXECUTOR);
    const calls = executor.match(/this\.deps\.reader\.listRecentTradesOnce\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("both entrypoints delegate to the same post-claim method", () => {
    const executor = codeOf(EXECUTOR);
    const delegations = executor.match(/return this\.executeClaimed\(/g) ?? [];
    // executeOne and executeSpecificWindow, and nothing else.
    expect(delegations).toHaveLength(2);
    expect(executor).toContain("private async executeClaimed(");
  });

  it("the shared post-claim path owns the request, the planner and the ledger", () => {
    const executor = codeOf(EXECUTOR);
    const shared = executor.indexOf("private async executeClaimed(");
    const tail = executor.slice(shared);
    expect(tail).toContain("this.deps.reader.listRecentTradesOnce(");
    expect(tail).toContain("planUserTradesWindow({");
    expect(tail).toContain("return this.commit(");
  });

  it("the canary itself never touches the reader, the planner or the ledger", () => {
    // It orchestrates; it does not re-implement ingestion.
    const canary = codeOf(CANARY);
    for (const marker of [
      "listRecentTradesOnce",
      "planUserTradesWindow",
      "exchangeFillLedger",
      "claimNextWindow",
      "claimSpecificWindow",
    ]) {
      expect(canary).not.toContain(marker);
    }
  });

  it("the canary invokes the targeted executor exactly once, with no loop", () => {
    const canary = codeOf(CANARY);
    const calls = canary.match(/executeSpecificWindow\(\{/g) ?? [];
    expect(calls).toHaveLength(1);
    // No iteration of any kind around the dispatch.
    expect(canary).not.toMatch(/\bfor\s*\(/);
    expect(canary).not.toMatch(/\bwhile\s*\(/);
    expect(canary).not.toContain("maxWindows");
  });
});

describe("the canary spends nothing without the existing gates", () => {
  it("admits through the shared campaign and weight admission", () => {
    expect(codeOf(CANARY)).toContain("this.deps.weightBudget.admitCampaignDispatch({");
  });

  it("refuses an OPEN circuit before admission", () => {
    const canary = codeOf(CANARY);
    const read = canary.indexOf("this.deps.circuitBreaker.readState({");
    const admit = canary.indexOf("this.deps.weightBudget.admitCampaignDispatch({");
    expect(read).toBeGreaterThan(-1);
    expect(admit).toBeGreaterThan(read);
    expect(canary).toContain('state === "OPEN"');
  });

  it("checks the circuit before the campaign, so a paused campaign is not reported as the cause", () => {
    const canary = codeOf(CANARY);
    const circuit = canary.indexOf("this.deps.circuitBreaker.readState({");
    const campaign = canary.indexOf("this.deps.campaigns.getLiveCampaign(");
    expect(circuit).toBeLessThan(campaign);
  });

  it("observes the durable result through the existing breaker", () => {
    expect(codeOf(CANARY)).toContain("this.deps.circuitBreaker.observeDispatchOutcome({");
  });

  it("refunds only through the existing release service, never raw SQL", () => {
    const canary = codeOf(CANARY);
    expect(canary).toContain("this.deps.weightBudget.releaseCertainNonDispatch(");
    for (const marker of ["$executeRaw", "$queryRaw", "UPDATE ", "DELETE "]) {
      expect(canary).not.toContain(marker);
    }
  });

  it("creates, resumes, pauses or aborts no campaign", () => {
    const canary = codeOf(CANARY);
    for (const marker of ["createCampaign", "resumeCampaign", "pauseCampaign", "abortCampaign"]) {
      expect(canary).not.toContain(marker);
    }
  });

  it("never acknowledges the circuit", () => {
    // Clearing a latch is its own operator decision. A canary that could clear
    // one on its way past would defeat the stop it exists to respect.
    expect(codeOf(CANARY)).not.toContain("acknowledge");
    expect(codeOf(COMPOSITION)).not.toContain("acknowledge");
  });
});

describe("no argument chooses an account, and no output reveals one", () => {
  const FORBIDDEN_FLAGS = [
    "--profile",
    "--execution-profile-id",
    "--account",
    "--campaign-id",
    "--symbol",
    "--date",
    "--force",
    "--yes",
  ];

  for (const flag of FORBIDDEN_FLAGS) {
    it(`the CLI never reads ${flag}`, () => {
      expect(codeOf(CLI)).not.toContain(`${flag}=`);
    });
  }

  it("the CLI accepts exactly one argument", () => {
    expect(codeOf(CLI)).toContain("argv.length !== 1");
  });

  it("the CLI never prints the profile id, the generation or a raw result", () => {
    const cli = codeOf(CLI);
    expect(cli).not.toContain("executionProfileId");
    expect(cli).not.toContain("generation");
    expect(cli).not.toContain("...result");
  });

  it("the canary result type carries no profile id", () => {
    const canary = codeOf(CANARY);
    const start = canary.indexOf("export interface TargetedCanaryResult {");
    const body = canary.slice(start, canary.indexOf("}", start));
    expect(body).not.toContain("executionProfileId");
    expect(body).not.toContain("generation");
  });

  it("no CLI in the module accepts an execution profile selector", () => {
    for (const module of [CLI, COMPOSITION, ENTRYPOINT]) {
      expect(codeOf(module)).not.toContain("--execution-profile-id");
    }
  });
});

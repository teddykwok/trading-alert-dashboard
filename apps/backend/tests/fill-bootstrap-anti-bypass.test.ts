import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE zero-exchange proof for the standalone root bootstrap command.
 *
 * Behavioural tests can only show that a request did not HAPPEN to be made.
 * This file shows that one cannot be made at all: it walks the real import
 * graph out of the command's entrypoint and proves that no request-capable
 * module -- and no campaign, weight, breaker, executor, driver or scheduler
 * module -- is reachable from it by any path, at any depth.
 *
 * A regression here would not fail a behavioural test. It would quietly give an
 * operator-run materialization command the ability to spend a real account's
 * exchange allowance. Needs no database, so it runs everywhere.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const SRC = path.join(BACKEND, "src");
const ENTRYPOINT = "src/modules/execution/run-fill-bootstrap-roots.ts";
const COMPOSITION = "src/modules/execution/run-fill-bootstrap.ts";
const CLI = "src/modules/execution/fill-bootstrap-cli.ts";
const BOOTSTRAP = "src/modules/execution/exchange-fill-root-bootstrap.service.ts";
const WORKER_RUNTIME = "src/modules/jobs/historical-fill-worker-runtime.ts";
const DRIVER = "src/modules/execution/exchange-fill-batch-driver.service.ts";

/**
 * Source with comments removed.
 *
 * These assertions are about what the code DOES, and the prose around this
 * command necessarily names the very collaborators it must not have -- the
 * whole point of the composition doc-comment is to say which services are
 * absent. Matching raw text would fail on the explanation of their absence.
 */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every relative specifier this module imports or re-exports, comments stripped. */
function specifiersOf(relative: string): string[] {
  const code = codeOf(relative);
  const found: string[] = [];
  for (const match of code.matchAll(/from\s+"(\.[^"]*)"/g)) found.push(match[1]!);
  for (const match of code.matchAll(/import\s*\(\s*"(\.[^"]*)"\s*\)/g)) found.push(match[1]!);
  return found;
}

/** A specifier resolved to a repo-relative .ts path, or null when it is not one. */
function resolveSpecifier(fromRelative: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(path.join(BACKEND, fromRelative)), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.startsWith(SRC)) {
      return path.relative(BACKEND, candidate).split(path.sep).join("/");
    }
  }
  return null;
}

/**
 * Every module reachable from `entry`, transitively, including `entry`.
 *
 * Follows relative specifiers only: a package import cannot be a path back into
 * this repo's own services, and the forbidden list below is entirely made of
 * this repo's own files.
 */
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

const GRAPH = reachableFrom(ENTRYPOINT);

/** Every .ts file under src, so a new importer cannot hide in a new file. */
function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

/** Modules whose mere presence in the graph would be the regression. */
const FORBIDDEN_MODULES: ReadonlyArray<readonly [string, string]> = [
  ["src/modules/binance/binance-read-only.service.ts", "the Binance read-only reader"],
  ["src/modules/binance/binance.client.ts", "the Binance client"],
  ["src/modules/binance/binance-execution.client.ts", "the Binance execution client"],
  ["src/modules/binance/binance-account-setup.client.ts", "the Binance account setup client"],
  ["src/modules/execution/exchange-fill-one-window-executor.service.ts", "the one-window executor"],
  ["src/modules/execution/exchange-fill-batch-driver.service.ts", "the batch driver"],
  ["src/modules/execution/historical-fill-campaign.service.ts", "the campaign service"],
  ["src/modules/execution/historical-fill-weight-budget.service.ts", "the shared weight budget"],
  ["src/modules/execution/historical-fill-circuit-breaker.service.ts", "the circuit breaker"],
  ["src/modules/jobs/historical-fill-worker-runtime.ts", "the historical worker runtime"],
];

describe("the bootstrap command cannot reach the exchange", () => {
  it("resolves a real, non-trivial import graph", () => {
    // Guards the walker itself: a resolver that silently found nothing would
    // make every absence assertion below vacuously true.
    expect(GRAPH.has(ENTRYPOINT)).toBe(true);
    expect(GRAPH.has(COMPOSITION)).toBe(true);
    expect(GRAPH.has(CLI)).toBe(true);
    expect(GRAPH.has(BOOTSTRAP)).toBe(true);
    expect(GRAPH.size).toBeGreaterThan(5);
  });

  for (const [module, description] of FORBIDDEN_MODULES) {
    it(`cannot reach ${description}, at any depth`, () => {
      // The module exists -- this is an absence from the graph, not a typo.
      expect(existsSync(path.join(BACKEND, module))).toBe(true);
      expect([...GRAPH]).not.toContain(module);
    });
  }

  it("reaches no module that issues an HTTP request", () => {
    // Whole-graph, so a NEW request-capable module cannot be introduced under a
    // name this file has never heard of.
    const requesting = [...GRAPH].filter((module) =>
      /\bfetch\s*\(|\baxios\b|\bnode-fetch\b|\bhttps?\.request\s*\(/.test(codeOf(module))
    );
    expect(requesting).toEqual([]);
  });

  it("reaches no module naming the userTrades endpoint path", () => {
    // The ENDPOINT, not the word. One reachable module carries a refusal
    // message mentioning a "userTrades window" -- prose about a bound, in a
    // module with no imports and no transport. The capability to be excluded is
    // the request path itself.
    const naming = [...GRAPH].filter((module) => /fapi\/v1\/userTrades/.test(codeOf(module)));
    expect(naming).toEqual([]);
  });
});

describe("the bootstrap command composes no dispatch machinery", () => {
  const FORBIDDEN_CONSTRUCTIONS = [
    "HistoricalFillCampaignService",
    "HistoricalFillCampaignAdmissionService",
    "HistoricalFillCircuitBreakerService",
    "HistoricalFillSharedWeightBudget",
    "ExchangeFillOneWindowExecutor",
    "ExchangeFillBatchDriver",
    "BinanceReadOnlyService",
  ];

  for (const identifier of FORBIDDEN_CONSTRUCTIONS) {
    it(`never constructs ${identifier}`, () => {
      const composition = codeOf(COMPOSITION);
      expect(composition).not.toContain(`new ${identifier}`);
      expect(composition).not.toContain(identifier);
    });
  }

  it("constructs exactly the client, the window writer and the root bootstrap", () => {
    const composition = codeOf(COMPOSITION);
    const constructed = [...composition.matchAll(/new\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]!);
    expect(constructed.sort()).toEqual([
      "ExchangeFillIngestWindowService",
      "ExchangeFillRootBootstrap",
      "PrismaClient",
    ]);
  });

  it("takes its horizon from configuration rather than argv", () => {
    const composition = codeOf(COMPOSITION);
    expect(composition).toContain("env.EXECUTION_FILL_INGEST_HORIZON_DAYS");
    // argv reaches the CLI so that unexpected arguments can be REFUSED; it must
    // never reach the horizon or the profile.
    expect(composition).not.toMatch(/horizonDays\s*:\s*[^,\n]*argv/);
  });

  it("never overrides the profile binder in the composition root", () => {
    // The default binder takes no profile id precisely so a caller cannot name
    // one. Supplying an override here is how that guarantee would be lost.
    expect(codeOf(COMPOSITION)).not.toContain("bindProfile");
  });
});

describe("no argument can choose an account", () => {
  const FORBIDDEN_FLAGS = ["--profile", "--execution-profile-id", "--account", "--force"];

  for (const flag of FORBIDDEN_FLAGS) {
    it(`the CLI never reads ${flag}`, () => {
      const cli = codeOf(CLI);
      expect(cli).not.toContain(`"${flag.slice(2)}"`);
      expect(cli).not.toContain(flag);
    });
  }

  it("the CLI accepts no argv entry whatsoever", () => {
    // The one line that makes every flag test above redundant, and that must
    // therefore never soften into an allow-list.
    expect(codeOf(CLI)).toContain("if (argv.length > 0)");
  });

  it("the CLI holds no Prisma client and so can write no table itself", () => {
    const cli = codeOf(CLI);
    expect(cli).not.toContain("PrismaClient");
    expect(cli).not.toContain("prisma");
  });

  it("the CLI never prints the bound execution profile id", () => {
    // The BOOTSTRAPPED result carries it, so a spread of that result is exactly
    // how it would reach a terminal.
    const cli = codeOf(CLI);
    expect(cli).not.toContain("result.executionProfileId");
    expect(cli).not.toContain("...result");
  });
});

describe("the bootstrap service itself stays a materialization primitive", () => {
  const FORBIDDEN_REFERENCES = [
    "Campaign",
    "WeightBudget",
    "CircuitBreaker",
    "claimNextWindow",
    "userTrades",
    "reserve",
  ];

  for (const reference of FORBIDDEN_REFERENCES) {
    it(`ExchangeFillRootBootstrap never references ${reference}`, () => {
      expect(codeOf(BOOTSTRAP)).not.toContain(reference);
    });
  }

  it("still seeds through the one audited window writer", () => {
    // The CLI must not gain its own root-generation path, so the service's use
    // of the canonical generator and the shared writer is what it inherits.
    const bootstrap = codeOf(BOOTSTRAP);
    expect(bootstrap).toContain("canonicalUtcDayRoots(");
    expect(bootstrap).toContain("this.deps.work.seedWindow(");
  });

  it("the CLI never seeds a window itself", () => {
    // A second canonical-day implementation, or a direct seed with bounds the
    // generator would never produce, is the one way this command could write a
    // root the rest of the system does not understand.
    const cli = codeOf(CLI);
    expect(cli).not.toContain("seedWindow");
    expect(cli).not.toContain("canonicalUtcDayRoots");
    expect(cli).not.toContain("startTimeMs");
    expect(cli).not.toContain("endTimeMs");
  });
});

describe("the scheduled path is untouched by this command", () => {
  it("the worker runtime never imports the operator command", () => {
    const runtime = codeOf(WORKER_RUNTIME);
    expect(runtime).not.toContain("run-fill-bootstrap");
    expect(runtime).not.toContain("fill-bootstrap-cli");
    expect(runtime).not.toContain("runFillBootstrapCli");
    expect(runtime).not.toContain("runFillBootstrapRootsCommand");
  });

  it("the batch driver never imports the operator command", () => {
    const driver = codeOf(DRIVER);
    expect(driver).not.toContain("run-fill-bootstrap");
    expect(driver).not.toContain("fill-bootstrap-cli");
    expect(driver).not.toContain("runFillBootstrapCli");
  });

  it("the driver still bootstraps through its own dependency, exactly as before", () => {
    // The scheduled path's relationship to bootstrap is unchanged by this slice:
    // still injected, still called once per pass, still after the campaign gate.
    const driver = codeOf(DRIVER);
    expect(driver).toContain("this.deps.bootstrap.bootstrapHistoricalRoots({");
    const gateReturn = driver.indexOf('outcome: "NO_ACTIVE_FILL_CAMPAIGN"');
    const bootstrapCall = driver.indexOf("this.deps.bootstrap.bootstrapHistoricalRoots({");
    expect(gateReturn).toBeGreaterThan(-1);
    expect(bootstrapCall).toBeGreaterThan(gateReturn);
  });

  it("no production module outside the command's own three files imports it", () => {
    // Swept over ALL of src rather than over the command's own graph, which
    // could only ever contain what the command already reaches. This is the
    // direction that matters: nothing ELSE may pull the operator command in.
    const OWN = new Set([ENTRYPOINT, COMPOSITION, CLI]);
    const importers = productionSources()
      .filter((module) => !OWN.has(module))
      .filter((module) => /run-fill-bootstrap|fill-bootstrap-cli/.test(codeOf(module)));
    expect(importers).toEqual([]);
  });
});

describe("the command is reachable only as an explicit operator script", () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(BACKEND, "package.json"), "utf8")
  ) as { scripts: Record<string, string> };

  it("is registered under the established execution script convention", () => {
    expect(packageJson.scripts["execution:fill-bootstrap-roots"]).toBe(
      "tsx src/modules/execution/run-fill-bootstrap-roots.ts"
    );
  });

  it("is wired into no lifecycle, start or worker script", () => {
    // An auto-run hook is how a command that writes rows stops being a decision
    // somebody made and becomes something that merely happens.
    const wired = Object.entries(packageJson.scripts)
      .filter(([name]) => name !== "execution:fill-bootstrap-roots")
      .filter(([, command]) => command.includes("run-fill-bootstrap"));
    expect(wired).toEqual([]);
    for (const hook of ["prestart", "poststart", "prebuild", "postbuild", "postinstall"]) {
      expect(packageJson.scripts[hook] ?? "").not.toContain("fill-bootstrap");
    }
  });
});

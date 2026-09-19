import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE read-only proof for the rollout preflight.
 *
 * A preflight exists to be run just before arming a system, often in a hurry.
 * If it could write, start, or spend anything, it would be the most dangerous
 * command in the module rather than the safest. So two things are proved here:
 * the graph reaches nothing that can act, and nothing in it can mutate the
 * database -- and, in the other direction, that no scheduled path can reach
 * the preflight either.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const SRC = path.join(BACKEND, "src");

const ENTRYPOINT = "src/modules/execution/run-fill-rollout-preflight.ts";
const COMPOSITION = "src/modules/execution/run-fill-preflight.ts";
const CLI = "src/modules/execution/fill-rollout-preflight-cli.ts";
const DRIVER = "src/modules/execution/exchange-fill-batch-driver.service.ts";
const EXECUTOR = "src/modules/execution/exchange-fill-one-window-executor.service.ts";
const BOOTSTRAP = "src/modules/execution/exchange-fill-root-bootstrap.service.ts";
const READER = "src/modules/binance/binance-read-only.service.ts";
const WORKER_RUNTIME = "src/modules/jobs/historical-fill-worker-runtime.ts";
const SCHEDULER = "src/modules/jobs/historical-fill.scheduler.ts";
const RUNTIME_TICK = "src/modules/jobs/historical-fill-runtime.ts";

function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Runtime specifiers only: `import type` is erased and carries no behaviour. */
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

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

const GRAPH = reachableFrom(ENTRYPOINT);
const OWN = new Set([ENTRYPOINT, COMPOSITION, CLI]);

/** Every Prisma call that changes durable state. */
const MUTATIONS = [
  ".create(", ".createMany(", ".update(", ".updateMany(", ".upsert(",
  ".delete(", ".deleteMany(", "$executeRaw", "$executeRawUnsafe",
];

describe("the preflight reaches nothing that can act", () => {
  it("resolves a real, non-trivial graph", () => {
    expect(GRAPH.has(ENTRYPOINT)).toBe(true);
    expect(GRAPH.has(COMPOSITION)).toBe(true);
    expect(GRAPH.has(CLI)).toBe(true);
    expect(GRAPH.size).toBeGreaterThan(3);
  });

  const UNREACHABLE: ReadonlyArray<readonly [string, string]> = [
    [READER, "the Binance read-only reader"],
    [EXECUTOR, "the one-window executor"],
    [BOOTSTRAP, "the root bootstrap"],
    [WORKER_RUNTIME, "the historical worker runtime"],
    [SCHEDULER, "the historical scheduler"],
    [RUNTIME_TICK, "the runtime tick"],
    ["src/modules/execution/historical-fill-weight-budget.service.ts", "the weight budget"],
    ["src/modules/execution/historical-fill-circuit-breaker.service.ts", "the circuit breaker service"],
    ["src/modules/execution/historical-fill-campaign.service.ts", "the campaign service"],
    ["src/modules/execution/historical-fill-campaign-gate.service.ts", "the campaign gate"],
    ["src/modules/execution/historical-fill-targeted-canary.service.ts", "the targeted canary"],
    ["src/modules/execution/fill-finalize-exhausted-cli.ts", "the finalization command"],
    ["src/modules/execution/fill-window-canary-cli.ts", "the canary command"],
    ["src/modules/execution/fill-bootstrap-cli.ts", "the bootstrap command"],
  ];

  for (const [module, description] of UNREACHABLE) {
    it(`cannot reach ${description}, at any depth`, () => {
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

  it("names the userTrades path only in the constants table, which cannot call it", () => {
    // The endpoint TABLE is reachable because the request weight is defined
    // there, and it is a zero-import leaf: naming a path is not the ability to
    // call one. The HTTP-request assertion above is what bounds capability.
    const naming = [...GRAPH].filter((m) => /fapi\/v1\/userTrades/.test(codeOf(m)));
    expect(naming).toEqual(["src/modules/binance/binance.endpoints.ts"]);
    expect(codeOf("src/modules/binance/binance.endpoints.ts")).not.toMatch(/^import/m);
  });

  it("constructs exactly one thing: a Prisma client", () => {
    const constructed = [...codeOf(COMPOSITION).matchAll(/new\s+([A-Za-z0-9_]+)\s*\(/g)].map(
      (match) => match[1]!
    );
    expect(constructed).toEqual(["PrismaClient"]);
  });
});

describe("the preflight cannot write", () => {
  it("its own files contain no mutation call", () => {
    for (const module of OWN) {
      const code = codeOf(module);
      for (const mutation of MUTATIONS) {
        expect(code).not.toContain(mutation);
      }
    }
  });

  it("its own files use only counting and finding", () => {
    const composition = codeOf(COMPOSITION);
    const reads = [...composition.matchAll(/\.(count|findFirst|findUnique|findMany)\(/g)].map(
      (match) => match[1]!
    );
    // Four durable facts, read four ways -- and nothing else touches the client.
    expect(new Set(reads)).toEqual(new Set(["count", "findFirst", "findUnique"]));
    expect(composition).not.toContain("$transaction");
    expect(composition).not.toContain("pg_advisory");
  });

  it("no reachable module performs a mutation except the profile binder's neighbour", () => {
    // HONEST ABOUT WHAT IS TRUE. `execution-profile.service.ts` is reachable
    // through the configured profile BINDER, and it exports two functions: the
    // read-only `resolveExecutionProfile` the binder uses, and
    // `ensureExecutionProfile`, which creates a profile for the separate
    // `execution:ensure-profile` command. The preflight never names the latter.
    const mutating = [...GRAPH].filter((module) =>
      MUTATIONS.some((mutation) => codeOf(module).includes(mutation))
    ).sort();
    // EXACTLY two, each reached for a read-only or constant export:
    //  - execution-profile.service: the binder uses `resolveExecutionProfile`;
    //    its `ensureExecutionProfile` neighbour is the one that creates rows.
    //  - exchange-fill-ingest-window.service: the home of MAX_INGEST_ATTEMPTS.
    //    Its mutations belong to the SERVICE CLASS, which is never constructed.
    expect(mutating).toEqual([
      "src/modules/execution/exchange-fill-ingest-window.service.ts",
      "src/modules/execution/execution-profile.service.ts",
    ]);
    // The capability check: the preflight never builds the class that owns
    // those mutations, and imports only the constant.
    for (const module of OWN) {
      expect(codeOf(module)).not.toContain("new ExchangeFillIngestWindowService");
      expect(codeOf(module)).not.toContain("ExchangeFillIngestWindowService");
    }

    for (const module of OWN) {
      expect(codeOf(module)).not.toContain("ensureExecutionProfile");
    }
    expect(codeOf("src/modules/execution/binance-profile-binding.ts")).not.toContain(
      "ensureExecutionProfile"
    );
  });
});

describe("nothing scheduled can reach the preflight", () => {
  const SCHEDULED = [
    [DRIVER, "the batch driver"],
    [WORKER_RUNTIME, "the worker runtime"],
    [SCHEDULER, "the historical scheduler"],
    [RUNTIME_TICK, "the runtime tick"],
    ["src/modules/jobs/vision-analysis.worker.ts", "the normal worker"],
  ] as const;

  for (const [module, description] of SCHEDULED) {
    it(`${description} never imports the preflight`, () => {
      const code = codeOf(module);
      for (const marker of [
        "run-fill-preflight",
        "run-fill-rollout-preflight",
        "fill-rollout-preflight-cli",
        "runFillRolloutPreflightCli",
        "runFillRolloutPreflightCommand",
        "readPreflightState",
      ]) {
        expect(code).not.toContain(marker);
      }
    });
  }

  it("no production module outside the preflight's own files imports it", () => {
    const importers = productionSources()
      .filter((module) => !OWN.has(module))
      .filter((module) =>
        /run-fill-preflight|run-fill-rollout-preflight|fill-rollout-preflight-cli/.test(
          codeOf(module)
        )
      );
    expect(importers).toEqual([]);
  });

  it("is an operator script wired into no lifecycle, start or worker hook", () => {
    const scripts = (
      JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["execution:fill-rollout-preflight"]).toBe(
      "tsx src/modules/execution/run-fill-rollout-preflight.ts"
    );
    const wired = Object.entries(scripts)
      .filter(([name]) => name !== "execution:fill-rollout-preflight")
      .filter(([, command]) => command.includes("run-fill-rollout-preflight"));
    expect(wired).toEqual([]);
    for (const hook of [
      "start", "dev", "worker", "prestart", "poststart",
      "prebuild", "postbuild", "postinstall",
    ]) {
      expect(scripts[hook] ?? "").not.toContain("preflight");
    }
  });
});

describe("the command cannot be aimed or overridden", () => {
  it("accepts no argument at all", () => {
    expect(codeOf(CLI)).toContain("if (argv.length > 0)");
  });

  const FORBIDDEN_FLAGS = [
    "--profile", "--profile-id", "--execution-profile-id", "--account",
    "--account-id", "--force", "--confirm", "--window-id", "--limit",
    "--horizon", "--weight-cap", "--campaign-id",
  ];

  for (const flag of FORBIDDEN_FLAGS) {
    it(`never reads ${flag}`, () => {
      expect(codeOf(CLI)).not.toContain(`${flag}=`);
    });
  }

  it("never prints the bound execution profile id", () => {
    const cli = codeOf(CLI);
    // The id is PASSED to the read-only query -- it has to be. What must never
    // happen is printing it, so the assertion targets the output calls.
    expect(cli).toContain("deps.readState(binding.context.executionProfileId)");
    expect(cli).not.toMatch(/line\(out,[^)]*executionProfileId/);
    expect(cli).not.toMatch(/out\([^)]*executionProfileId/);
    expect(cli).not.toContain("...binding");
    expect(cli).not.toContain("...state");
    expect(cli).not.toContain("...config");
  });

  it("derives explicitness from the RAW key, never from the parsed number", () => {
    const composition = codeOf(COMPOSITION);
    // The parsed value cannot tell an explicit 30 from a defaulted 30, so the
    // source must come from key presence.
    expect(composition).toContain("raw[INGEST_HORIZON_KEY]");
    expect(composition).toContain('"EXECUTION_FILL_INGEST_HORIZON_DAYS"');
    expect(composition).not.toMatch(/horizonSource[^\n]*env\.EXECUTION_FILL_INGEST_HORIZON_DAYS/);
    // And the real command feeds it the actual process environment.
    expect(composition).toContain("preflightConfig(process.env)");
  });

  it("leaves the shared env parser untouched", () => {
    // The preflight reads `env`; it must not redefine how anything is parsed.
    for (const module of OWN) {
      expect(codeOf(module)).not.toContain("envSchema");
      expect(codeOf(module)).not.toContain("safeParse");
    }
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as shared from "@trading-alert-dashboard/shared";

/**
 * Slice 1 guard: the native signal engine is PURE.
 *
 * It must never acquire trading authority, credentials, a database, a queue, a
 * network or a clock — not now, and not by a later edit that seems harmless.
 * A scanner built on it inherits whatever it can reach, so what it can reach is
 * pinned here rather than trusted.
 */

const ENGINE_DIR = path.resolve(__dirname, "../../../packages/shared/src/native-signal");
const ENGINE_DIST_INDEX = path.resolve(__dirname, "../../../packages/shared/dist/cjs/native-signal/index.js");

const sources = readdirSync(ENGINE_DIR)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, text: readFileSync(path.join(ENGINE_DIR, file), "utf8") }));

/** Removes comments so prose about Prisma or fetch cannot trip, or hide from, the scan. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the native signal engine is pure", () => {
  it("consists of exactly the Slice 1 modules", () => {
    expect(sources.map((s) => s.file).sort()).toEqual(["engine.ts", "htf-aggregate.ts", "index.ts", "replay.ts", "types.ts"]);
  });

  it("imports nothing but its own modules and the shared timeframe vocabulary (types only)", () => {
    for (const { file, text } of sources) {
      const imports = [...code(text).matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s+"([^"]+)"/gm)].map(
        (match) => ({ typeOnly: Boolean(match[2]), specifier: match[3] })
      );
      for (const { typeOnly, specifier } of imports) {
        const local = /^\.\/[a-z-]+$/.test(specifier);
        const vocabulary = specifier === "../alert-context" && typeOnly;
        expect({ file, specifier, allowed: local || vocabulary }).toEqual({ file, specifier, allowed: true });
      }
      // No side-effect imports and no dynamic loading.
      expect(code(text)).not.toMatch(/^\s*import\s+"/m);
      expect(code(text)).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
    }
  });

  it.each([
    ["Prisma", /prisma/i],
    ["Redis", /redis/i],
    ["BullMQ", /bullmq|\bQueue\b|\bWorker\b/],
    ["Binance clients", /binance/i],
    ["exchange runtime binding", /exchange-runtime-binding|bindConfiguredExchangeRuntime/],
    ["execution modules", /\/execution\//],
    ["webhook service", /webhook/i],
    ["alerts service", /alerts\.service|AlertsService/],
    ["environment / bootstrap", /\bprocess\b|config\/env|bootstrap|dotenv/],
    ["globals", /\bglobalThis\b|\bwindow\b|\bglobal\b/],
    ["network", /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bhttps?:/],
    ["filesystem", /\bnode:|\bfs\b/],
    ["timers", /setTimeout|setInterval|setImmediate/],
    ["clock", /Date\.now|performance\.now|new Date\(\s*\)/],
    ["randomness", /Math\.random|crypto/],
    ["console", /console\./],
    ["host-timezone accessors", /\.get(FullYear|Month|Date|Day|Hours|Minutes|Seconds|TimezoneOffset)\(|toLocale/],
  ])("does not reference %s", (_label, pattern) => {
    for (const { file, text } of sources) {
      expect({ file, hit: code(text).match(pattern)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  it("loads with no environment read, no network call and no global left behind", () => {
    const realEnv = process.env;
    const realFetch = globalThis.fetch;
    const envReads: string[] = [];
    let fetchCalls = 0;
    const globalsBefore = new Set(Object.keys(globalThis));

    process.env = new Proxy(
      { ...realEnv },
      {
        get(target, key) {
          if (typeof key === "string") envReads.push(key);
          return Reflect.get(target, key);
        },
      }
    );
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("the engine must not reach the network");
    }) as typeof fetch;

    try {
      // The BUILT module, through plain require: no transform pipeline that
      // could read the environment on its own behalf.
      // Every engine module is evicted first, so each one is genuinely
      // re-evaluated here even if the package was already loaded as CJS.
      const load = createRequire(__filename);
      const engineDistDir = path.dirname(ENGINE_DIST_INDEX) + path.sep;
      for (const key of Object.keys(load.cache)) if (key.startsWith(engineDistDir)) delete load.cache[key];
      const engine = load(ENGINE_DIST_INDEX) as typeof shared;
      expect(Object.keys(load.cache).filter((key) => key.startsWith(engineDistDir)).length).toBe(5);
      expect(typeof engine.replayNativeEngine).toBe("function");
    } finally {
      process.env = realEnv;
      globalThis.fetch = realFetch;
    }

    expect(envReads).toEqual([]);
    expect(fetchCalls).toBe(0);
    expect([...Object.keys(globalThis)].filter((key) => !globalsBefore.has(key))).toEqual([]);
  });

  it("publishes the engine API from the package root, and not its in-place internals", () => {
    for (const name of [
      "createNativeEngineConfig",
      "createNativeEngineState",
      "stepNativeEngine",
      "replayNativeEngine",
      "htfPeriodStartMs",
      "advanceHtfAggregate",
      "evaluateLevelConditions",
      "pinePercentInputToFraction",
    ]) {
      expect(typeof (shared as Record<string, unknown>)[name]).toBe("function");
    }
    expect("applyBarInPlace" in shared).toBe(false);
    expect("cloneWorkingState" in shared).toBe(false);
  });
});

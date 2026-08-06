import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 6 boundary, configuration and credential guards.
 *
 * Source-level assertions: a future edit that adds a MARKET entry, a
 * protection order, a worker, a queue, a Telegram message, an HTTP route or a
 * fifth mutation endpoint fails here rather than in production.
 */

const BACKEND = process.cwd();
const EXECUTION_DIR = path.join(BACKEND, "src", "modules", "execution");
const BINANCE_DIR = path.join(BACKEND, "src", "modules", "binance");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Strips comments: the modules document what they must never do. */
function readCode(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\S)\s\/\/.*$/gm, "$1");
}

const PURE = path.join(EXECUTION_DIR, "entry-lifecycle.ts");
const SERVICE = path.join(EXECUTION_DIR, "entry-lifecycle.service.ts");
const CLIENT = path.join(BINANCE_DIR, "binance-execution.client.ts");
const ENDPOINTS = path.join(BINANCE_DIR, "binance-execution.endpoints.ts");
const PHASE_6_FILES = [PURE, SERVICE, CLIENT, ENDPOINTS];

describe("pure lifecycle purity", () => {
  const pure = readCode(PURE);

  it("imports nothing but the decimal type", () => {
    const imports = [...pure.matchAll(/^import .*? from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["@prisma/client"]);
  });

  it("never reads a clock", () => {
    expect(pure).not.toMatch(/Date\.now\(\)/);
    expect(pure).not.toMatch(/new Date\(\)/);
  });

  it("never reads the environment", () => {
    expect(pure).not.toMatch(/process\.env/);
    expect(pure).not.toMatch(/config\/env/);
  });

  it("performs no I/O, logging or queueing", () => {
    for (const forbidden of ["fetch(", "prisma.", "this.prisma", "console.", "logger.", "Queue("]) {
      expect(pure).not.toContain(forbidden);
    }
    for (const forbidden of ["bullmq", "telegram", "socket", "ioredis", "axios"]) {
      expect(pure.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("never parses monetary values through floats", () => {
    expect(pure).not.toMatch(/\bparseFloat\(/);
    expect(pure).not.toMatch(/\bparseInt\(/);
  });
});

describe("mutation surface", () => {
  it("declares exactly four mutation endpoints", () => {
    const endpoints = readCode(ENDPOINTS);
    const paths = [...endpoints.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(paths.sort()).toEqual(["/fapi/v1/leverage", "/fapi/v1/marginType", "/fapi/v1/order", "/fapi/v1/order"]);
  });

  it("declares only POST and DELETE", () => {
    const methods = [...readCode(ENDPOINTS).matchAll(/method:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect([...new Set(methods)].sort()).toEqual(["DELETE", "POST"]);
  });

  it("names no prohibited endpoint anywhere in the phase", () => {
    for (const file of PHASE_6_FILES) {
      const source = readCode(file);
      for (const forbidden of [
        "/fapi/v1/positionSide/dual\"",
        "/fapi/v1/multiAssetsMargin\"",
        "/fapi/v1/positionMargin",
        "/fapi/v1/batchOrders",
        "/fapi/v1/allOpenOrders",
        "/fapi/v1/countdownCancelAll",
        "/sapi/v1/futures/transfer",
        "/fapi/v1/listenKey",
      ]) {
        expect(`${path.basename(file)}:${source.includes(forbidden)}`).toBe(`${path.basename(file)}:false`);
      }
    }
  });

  it("submits no MARKET entry and no protection order", () => {
    const client = readCode(CLIENT);
    // The only order type expressible is the allowlisted LIMIT constant.
    expect(client).toContain("ALLOWED_ENTRY_ORDER_TYPE");
    for (const forbidden of ['"MARKET"', '"STOP"', '"STOP_MARKET"', '"TAKE_PROFIT"', '"TAKE_PROFIT_MARKET"', '"TRAILING_STOP_MARKET"']) {
      expect(client).not.toContain(forbidden);
    }
  });

  it("never sends CROSSED as a margin type", () => {
    expect(readCode(CLIENT)).not.toContain("CROSSED");
  });

  it("exposes no generic signed request method", () => {
    const client = readCode(CLIENT);
    // `mutate` is private; nothing public takes a caller-supplied path.
    expect(client).toMatch(/private async mutate</);
    expect(client).not.toMatch(/^\s{2}async (request|send|signedRequest)\b/m);
  });
});

describe("phase boundary", () => {
  it("adds no worker, queue, webhook, Telegram or frontend wiring", () => {
    for (const file of PHASE_6_FILES) {
      const source = readCode(file).toLowerCase();
      for (const forbidden of ["bullmq", "queue(", "worker(", "telegram", "socket.io", "webhook", "setinterval", "websocket", "listenkey"]) {
        expect(`${path.basename(file)}:${source.includes(forbidden)}`).toBe(`${path.basename(file)}:false`);
      }
    }
  });

  it("registers no HTTP route", () => {
    for (const file of PHASE_6_FILES) {
      const source = readCode(file);
      expect(source).not.toMatch(/fastify|FastifyInstance|\.get\(\s*"\/|\.post\(\s*"\//);
    }
    const app = read(path.join(BACKEND, "src", "app.ts")).toLowerCase();
    expect(app).not.toContain("entry");
    expect(app).not.toContain("execution");
  });

  it("has no polling daemon or automatic caller of the lifecycle methods", () => {
    // Nothing outside the service and its tests references the orchestration.
    const referencing = ["src/server.ts", "src/app.ts", "src/modules/jobs/vision-analysis.worker.ts"]
      .map((relative) => path.join(BACKEND, relative))
      .filter((file) => {
        try {
          return read(file).includes("EntryLifecycleService");
        } catch {
          return false;
        }
      });
    expect(referencing).toEqual([]);
  });

  it("keeps Phase 2 GET-only", () => {
    const readOnlyClient = readCode(path.join(BINANCE_DIR, "binance.client.ts"));
    expect(readOnlyClient).toContain("READ_ONLY_METHOD");
    expect(readOnlyClient).not.toMatch(/method:\s*"(POST|DELETE|PUT|PATCH)"/);

    const readOnlyEndpoints = readCode(path.join(BINANCE_DIR, "binance.endpoints.ts"));
    expect(readOnlyEndpoints).toContain('READ_ONLY_METHOD = "GET"');
    // The GET-only table carries no method field at all.
    expect(readOnlyEndpoints).not.toMatch(/^\s+\w+: \{ path: "[^"]+", method:/m);
  });

  it("never emergency-closes or submits a compensating trade", () => {
    const service = readCode(SERVICE);
    for (const forbidden of ["EMERGENCY_CLOSE", "reduceOnly", "closePosition", "oppositeSide"]) {
      expect(service).not.toContain(forbidden);
    }
  });

  it("only ever reserves ENTRY generation 1", () => {
    const service = readCode(SERVICE);
    expect(service).toContain('role: "ENTRY"');
    expect(service).not.toMatch(/generation:\s*2/);
    for (const role of ["STOP_LOSS", "TAKE_PROFIT"]) {
      expect(service).not.toContain(role);
    }
  });
});

describe("credential protection", () => {
  it("sources secrets only from configuration", () => {
    const client = readCode(CLIENT);
    expect(client).toMatch(/env\.BINANCE_API_KEY/);
    expect(client).toMatch(/env\.BINANCE_API_SECRET/);
    // No literal-looking credential anywhere.
    expect(client).not.toMatch(/(apiKey|apiSecret)\s*=\s*"[A-Za-z0-9]{16,}"/);
  });

  it("registers redactions and never logs a URL", () => {
    const client = readCode(CLIENT);
    expect(client).toContain("registerBinanceRedactions");
    expect(client).not.toMatch(/logger\.\w+\([^)]*\burl\b/);
  });

  it("persists no credential-like field", () => {
    const service = readCode(SERVICE);
    for (const forbidden of ["apiKey", "apiSecret", "signature", "X-MBX-APIKEY", "signedQuery", "Authorization"]) {
      expect(service).not.toContain(forbidden);
    }
  });

  it("stores no generic raw Binance response blob", () => {
    const schema = read(path.join(BACKEND, "prisma", "schema.prisma"));
    for (const forbidden of ["rawResponse", "rawPayloadJson", "binanceRawResponse", "rawOrderResponse"]) {
      expect(schema).not.toContain(forbidden);
    }
  });
});

describe("locked configuration", () => {
  const envSource = read(path.join(BACKEND, "src", "config", "env.ts"));

  it("defaults live entry to false", () => {
    expect(envSource).toMatch(/EXECUTION_LIVE_ENTRY_ENABLED[\s\S]{0,160}?\.default\("false"\)/);
  });

  it("defaults protection-ready to false", () => {
    expect(envSource).toMatch(/EXECUTION_PROTECTION_READY[\s\S]{0,160}?\.default\("false"\)/);
  });

  it("rejects a malformed boolean rather than defaulting it on", () => {
    for (const name of ["EXECUTION_LIVE_ENTRY_ENABLED", "EXECUTION_PROTECTION_READY"]) {
      expect(envSource).toMatch(new RegExp(`${name}: z\\s*\\n?\\s*\\.enum\\(\\["true", "false"\\]\\)`));
    }
  });

  it("validates the TTL and retry settings as positive integers", () => {
    expect(envSource).toMatch(/EXECUTION_ENTRY_TTL_SECONDS: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.default\(300\)/);
    expect(envSource).toMatch(/EXECUTION_ENTRY_RECONCILE_MAX_ATTEMPTS: z\.coerce\.number\(\)\.int\(\)\.positive\(\)/);
    expect(envSource).toMatch(/EXECUTION_ENTRY_RECONCILE_DELAY_MS: z\.coerce\.number\(\)\.int\(\)\.positive\(\)/);
  });

  it("documents the gates in both .env.example files with both defaults false", () => {
    for (const file of [path.join(BACKEND, ".env.example"), path.join(BACKEND, "..", "..", ".env.example")]) {
      const source = read(file);
      expect(source).toContain("EXECUTION_LIVE_ENTRY_ENABLED=false");
      expect(source).toContain("EXECUTION_PROTECTION_READY=false");
      expect(source).toContain("EXECUTION_ENTRY_TTL_SECONDS=300");
      expect(source).toMatch(/BOTH gates below/i);
    }
  });

  it("leaves the developer's real .env free of Phase 6 gates", () => {
    let real: string;
    try {
      real = read(path.join(BACKEND, ".env"));
    } catch {
      return; // No local .env — nothing to protect.
    }
    expect(real).not.toContain("EXECUTION_LIVE_ENTRY_ENABLED");
    expect(real).not.toContain("EXECUTION_PROTECTION_READY");
  });
});

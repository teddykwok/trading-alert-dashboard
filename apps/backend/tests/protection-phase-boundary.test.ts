import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 7 boundary, configuration and credential guards.
 *
 * Source-level assertions: a future edit that adds a MARKET entry, a trailing
 * stop, a margin removal, a position-mode change, a worker, a queue, an HTTP
 * route or an eighth mutation endpoint fails here rather than in production.
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

const PURE = path.join(EXECUTION_DIR, "protection-lifecycle.ts");
const SERVICE = path.join(EXECUTION_DIR, "protection-lifecycle.service.ts");
const ALERTS = path.join(EXECUTION_DIR, "critical-alert.service.ts");
const CLIENT = path.join(BINANCE_DIR, "binance-execution.client.ts");
const ENDPOINTS = path.join(BINANCE_DIR, "binance-execution.endpoints.ts");
const PHASE_7_FILES = [PURE, SERVICE, ALERTS, CLIENT, ENDPOINTS];

describe("pure protection purity", () => {
  const pure = readCode(PURE);

  it("imports nothing but the decimal type", () => {
    const imports = [...pure.matchAll(/^import .*? from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["@prisma/client"]);
  });

  it("never reads a clock", () => {
    expect(pure).not.toMatch(/Date\.now\(\)/);
    expect(pure).not.toMatch(/new Date\(/);
  });

  it("never reads the environment", () => {
    expect(pure).not.toMatch(/process\.env/);
    expect(pure).not.toMatch(/config\/env/);
  });

  it("performs no I/O, logging, queueing or notification", () => {
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
    expect(pure).not.toMatch(/\bNumber\(/);
  });
});

describe("mutation surface", () => {
  it("declares exactly seven mutation endpoints", () => {
    const endpoints = readCode(ENDPOINTS);
    const paths = [...endpoints.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(paths.sort()).toEqual([
      "/fapi/v1/algoOrder",
      "/fapi/v1/algoOrder",
      "/fapi/v1/leverage",
      "/fapi/v1/marginType",
      "/fapi/v1/order",
      "/fapi/v1/order",
      "/fapi/v1/positionMargin",
    ]);
  });

  it("declares only POST and DELETE", () => {
    const methods = [...readCode(ENDPOINTS).matchAll(/method:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect([...new Set(methods)].sort()).toEqual(["DELETE", "POST"]);
  });

  it("names no prohibited endpoint anywhere in the phase", () => {
    for (const file of PHASE_7_FILES) {
      const source = readCode(file);
      for (const forbidden of [
        '"/fapi/v1/positionSide/dual"',
        '"/fapi/v1/multiAssetsMargin"',
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

  it("submits no trailing stop or arbitrary conditional type", () => {
    const client = readCode(CLIENT);
    // Trailing-stop-only parameters and order types. ("TAKE_PROFIT" alone is
    // deliberately absent from this list: it is the ROLE name, and the order
    // type is separately pinned to TAKE_PROFIT_MARKET.)
    for (const forbidden of ['"TRAILING_STOP_MARKET"', '"STOP_LIMIT"', "callbackRate", "activationPrice"]) {
      expect(client).not.toContain(forbidden);
    }
    // The submitted type comes only from the allowlisted pair.
    expect(client).toMatch(/orderType:\s*ProtectionOrderType\s*=\s*input\.role === "STOP_LOSS" \? "STOP_MARKET" : "TAKE_PROFIT_MARKET"/);
  });

  it("offers no margin removal anywhere", () => {
    for (const file of PHASE_7_FILES) {
      const source = readCode(file);
      for (const forbidden of ["type: 2", "REMOVE_MARGIN", "removeMargin", "reduceIsolatedMargin"]) {
        expect(`${path.basename(file)}:${source.includes(forbidden)}`).toBe(`${path.basename(file)}:false`);
      }
    }
    // The ADD constant is the only adjustment type in the codebase.
    expect(readCode(ENDPOINTS)).toContain("MARGIN_ADD_TYPE = 1");
  });

  it("exposes no generic MARKET-order or signed-request method", () => {
    const client = readCode(CLIENT);
    expect(client).toMatch(/private async mutate</);
    for (const generic of ["submitMarketOrder", "newMarketOrder", "placeOrder", "signedRequest"]) {
      expect(client).not.toContain(generic);
    }
  });

  it("never sends reduceOnly or closePosition=true on protection", () => {
    const client = readCode(CLIENT);
    expect(client).toContain('closePosition: "false"');
    expect(client).not.toMatch(/reduceOnly:\s*(true|"true")/);
  });
});

describe("phase boundary", () => {
  it("adds no worker, queue, webhook, user-data stream or frontend wiring", () => {
    for (const file of PHASE_7_FILES) {
      const source = readCode(file).toLowerCase();
      for (const forbidden of ["bullmq", "queue(", "worker(", "socket.io", "webhook", "setinterval", "websocket", "listenkey"]) {
        expect(`${path.basename(file)}:${source.includes(forbidden)}`).toBe(`${path.basename(file)}:false`);
      }
    }
  });

  it("registers no HTTP route", () => {
    for (const file of PHASE_7_FILES) {
      expect(readCode(file)).not.toMatch(/fastify|FastifyInstance|\.get\(\s*"\/|\.post\(\s*"\//);
    }
    const app = read(path.join(BACKEND, "src", "app.ts")).toLowerCase();
    expect(app).not.toContain("protection");
    expect(app).not.toContain("execution");
  });

  it("has no automatic caller of the protection lifecycle", () => {
    const referencing = ["src/server.ts", "src/app.ts", "src/modules/jobs/vision-analysis.worker.ts"]
      .map((relative) => path.join(BACKEND, relative))
      .filter((file) => {
        try {
          return read(file).includes("ProtectionLifecycleService");
        } catch {
          return false;
        }
      });
    expect(referencing).toEqual([]);
  });

  it("keeps Phase 2 structurally GET-only", () => {
    const readOnlyClient = readCode(path.join(BINANCE_DIR, "binance.client.ts"));
    expect(readOnlyClient).toContain("READ_ONLY_METHOD");
    expect(readOnlyClient).not.toMatch(/method:\s*"(POST|DELETE|PUT|PATCH)"/);

    const readOnlyEndpoints = readCode(path.join(BINANCE_DIR, "binance.endpoints.ts"));
    expect(readOnlyEndpoints).toContain('READ_ONLY_METHOD = "GET"');
    expect(readOnlyEndpoints).not.toMatch(/^\s+\w+: \{ path: "[^"]+", method:/m);
    // Write paths still have no representation there.
    for (const writePath of ['"/fapi/v1/leverage"', '"/fapi/v1/marginType"', '"/fapi/v1/batchOrders"']) {
      expect(readOnlyEndpoints).not.toContain(writePath);
    }
  });

  it("never opens a position or submits a compensating trade", () => {
    const service = readCode(SERVICE);
    for (const forbidden of ["oppositeSide", "reopen", "increaseExposure"]) {
      expect(service).not.toContain(forbidden);
    }
    // The only MARKET order is the branded emergency close.
    const marketMentions = [...service.matchAll(/"MARKET"/g)];
    expect(marketMentions.length).toBeLessThanOrEqual(1);
  });

  it("only reserves protection and emergency-close roles", () => {
    const service = readCode(SERVICE);
    expect(service).toContain('"STOP_LOSS"');
    expect(service).toContain('"TAKE_PROFIT"');
    expect(service).toContain('"EMERGENCY_CLOSE"');
    // Emergency close never gets a second generation automatically.
    expect(service).not.toMatch(/EMERGENCY_CLOSE",\s*2/);
  });
});

describe("credential and payload protection", () => {
  it("persists no credential-like field", () => {
    const service = readCode(SERVICE);
    for (const forbidden of ["apiKey", "apiSecret", "signature", "X-MBX-APIKEY", "signedQuery", "Authorization"]) {
      expect(`service:${service.includes(forbidden)}`).toBe("service:false");
    }
    // The alert service names credential keys only to REDACT them, so the
    // check there is that it never reads or writes an actual credential.
    const alerts = readCode(ALERTS);
    for (const forbidden of ["env.BINANCE_API_KEY", "env.BINANCE_API_SECRET", "TELEGRAM_BOT_TOKEN", "X-MBX-APIKEY"]) {
      expect(`alerts:${alerts.includes(forbidden)}`).toBe("alerts:false");
    }
    expect(alerts).toContain("FORBIDDEN_DETAIL_KEYS");
  });

  it("stores no raw Binance payload field in the schema", () => {
    const schema = read(path.join(BACKEND, "prisma", "schema.prisma"));
    for (const forbidden of ["rawResponse", "rawAlgoResponse", "binanceRawResponse", "accountSnapshot", "rawPositionPayload"]) {
      expect(schema).not.toContain(forbidden);
    }
  });

  it("protects financial history with Restrict deletion semantics", () => {
    const schema = read(path.join(BACKEND, "prisma", "schema.prisma"));
    for (const model of ["ExecutionProtectionState", "MarginAdjustmentIntent", "CriticalAlert"]) {
      const block = new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`).exec(schema)?.[0] ?? "";
      expect(block).toContain("onDelete: Restrict");
    }
  });

  it("keeps alert content free of account data", () => {
    const alerts = readCode(ALERTS);
    expect(alerts).toContain("FORBIDDEN_DETAIL_KEYS");
    for (const forbidden of ["usdtAvailableBalance", "walletBalance", "positions:"]) {
      expect(alerts).not.toContain(forbidden);
    }
  });
});

describe("locked Phase 7 configuration", () => {
  const envSource = read(path.join(BACKEND, "src", "config", "env.ts"));

  it("keeps live entry and protection-ready defaulting to false", () => {
    expect(envSource).toMatch(/EXECUTION_LIVE_ENTRY_ENABLED[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_PROTECTION_READY[\s\S]{0,160}?\.default\("false"\)/);
  });

  it("defaults auto-add-margin to false", () => {
    expect(envSource).toMatch(/EXECUTION_AUTO_ADD_MARGIN_ENABLED[\s\S]{0,160}?\.default\("false"\)/);
  });

  it("defaults the emergency-close mode to DISABLED with only two allowed values", () => {
    expect(envSource).toMatch(
      /EXECUTION_EMERGENCY_CLOSE_MODE: z\.enum\(\["DISABLED", "ON_UNVERIFIED_STOP"\]\)\.default\("DISABLED"\)/
    );
  });

  it("validates the working types as a closed enum", () => {
    expect(envSource).toMatch(/EXECUTION_SL_WORKING_TYPE: z\.enum\(\["MARK_PRICE", "CONTRACT_PRICE"\]\)\.default\("MARK_PRICE"\)/);
    expect(envSource).toMatch(
      /EXECUTION_TP_WORKING_TYPE: z\.enum\(\["MARK_PRICE", "CONTRACT_PRICE"\]\)\.default\("CONTRACT_PRICE"\)/
    );
  });

  it("rejects a malformed boolean rather than defaulting it on", () => {
    for (const name of ["EXECUTION_AUTO_ADD_MARGIN_ENABLED", "EXECUTION_PROTECTION_PRICE_PROTECT"]) {
      expect(envSource).toMatch(new RegExp(`${name}: z\\s*\\n?\\s*\\.enum\\(\\["true", "false"\\]\\)`));
    }
  });

  it("validates the reconcile settings as positive integers", () => {
    expect(envSource).toMatch(/EXECUTION_PROTECTION_RECONCILE_MAX_ATTEMPTS: z\.coerce\.number\(\)\.int\(\)\.positive\(\)/);
    expect(envSource).toMatch(/EXECUTION_PROTECTION_RECONCILE_DELAY_MS: z\.coerce\.number\(\)\.int\(\)\.positive\(\)/);
  });

  it("documents the settings in both .env.example files with fail-closed defaults", () => {
    for (const file of [path.join(BACKEND, ".env.example"), path.join(BACKEND, "..", "..", ".env.example")]) {
      const source = read(file);
      expect(source).toContain("EXECUTION_PROTECTION_READY=false");
      expect(source).toContain("EXECUTION_AUTO_ADD_MARGIN_ENABLED=false");
      expect(source).toContain("EXECUTION_EMERGENCY_CLOSE_MODE=DISABLED");
      expect(source).toContain("EXECUTION_SL_WORKING_TYPE=MARK_PRICE");
      expect(source).toContain("EXECUTION_TP_WORKING_TYPE=CONTRACT_PRICE");
      expect(source).toContain("EXECUTION_PROTECTION_PRICE_PROTECT=false");
    }
  });

  it("leaves the developer's real .env free of Phase 7 settings", () => {
    let real: string;
    try {
      real = read(path.join(BACKEND, ".env"));
    } catch {
      return; // No local .env — nothing to protect.
    }
    for (const name of [
      "EXECUTION_PROTECTION_READY",
      "EXECUTION_AUTO_ADD_MARGIN_ENABLED",
      "EXECUTION_EMERGENCY_CLOSE_MODE",
    ]) {
      expect(real).not.toContain(name);
    }
  });
});

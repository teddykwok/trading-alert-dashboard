import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 10 boundary guards.
 *
 * Source-level assertions: a future edit that widens the maintenance surface,
 * reaches the real order endpoint, touches execution state, exposes account
 * setup over HTTP or leaks a credential fails here rather than silently turning
 * an operator tool into something that can trade.
 */

const BACKEND = process.cwd();
const REPO = path.join(BACKEND, "..", "..");
const MODULES = path.join(BACKEND, "src", "modules", "binance");

const ENDPOINTS = path.join(MODULES, "binance-account-setup.endpoints.ts");
const CLIENT = path.join(MODULES, "binance-account-setup.client.ts");
const PURE = path.join(MODULES, "binance-account-connection.ts");
const SERVICE = path.join(MODULES, "binance-account-connection.service.ts");
const HEALTH_CLI = path.join(MODULES, "run-account-health.ts");
const HEDGE_CLI = path.join(MODULES, "run-set-hedge-mode.ts");
const TEST_ORDER_CLI = path.join(MODULES, "run-test-order.ts");

const PHASE_10_FILES = [ENDPOINTS, CLIENT, PURE, SERVICE, HEALTH_CLI, HEDGE_CLI, TEST_ORDER_CLI];
const PHASE_10_CLIS = [HEALTH_CLI, HEDGE_CLI, TEST_ORDER_CLI];

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Scans CODE only — these modules document at length what they must never do. */
function readCode(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\S)\s\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// Mutation surface
// ---------------------------------------------------------------------------

describe("Phase 10 mutation surface", () => {
  it("adds exactly two endpoints and no more", () => {
    const paths = [...readCode(ENDPOINTS).matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(paths.sort()).toEqual(["/fapi/v1/order/test", "/fapi/v1/positionSide/dual"]);
  });

  it("declares POST only — Phase 10 adds no DELETE", () => {
    const methods = [...readCode(ENDPOINTS).matchAll(/method:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect([...new Set(methods)]).toEqual(["POST"]);
  });

  it("keeps the Phase 6/7 execution allowlist untouched", () => {
    const execution = readCode(path.join(MODULES, "binance-execution.endpoints.ts"));
    // Phase 10's two endpoints must NOT have leaked into the execution table.
    expect(execution).not.toContain('"/fapi/v1/positionSide/dual"');
    expect(execution).not.toContain("/fapi/v1/order/test");

    const paths = [...execution.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect([...new Set(paths)].sort()).toEqual([
      "/fapi/v1/algoOrder",
      "/fapi/v1/leverage",
      "/fapi/v1/marginType",
      "/fapi/v1/order",
      "/fapi/v1/positionMargin",
    ]);
  });

  it("keeps the Phase 2 connector GET-only", () => {
    const readOnly = readCode(path.join(MODULES, "binance.endpoints.ts"));
    expect(readOnly).toContain('READ_ONLY_METHOD = "GET"');
    expect(readOnly).not.toContain('method: "POST"');
    // The three surfaces stay in three separate files.
    expect(readOnly).not.toContain("/fapi/v1/order/test");
  });

  it("never names the real order endpoint in the maintenance client", () => {
    const client = readCode(CLIENT);
    // It reaches /fapi/v1/order/test through the endpoint table only, and the
    // real path never appears as a literal anywhere.
    expect(client).not.toContain('"/fapi/v1/order"');
    expect(client).not.toContain("newOrder");
    expect(client).not.toContain("BINANCE_MUTATION_ENDPOINTS");
  });

  it("names no prohibited endpoint anywhere in the phase", () => {
    for (const file of PHASE_10_FILES) {
      const source = readCode(file);
      for (const forbidden of [
        '"/fapi/v1/multiAssetsMargin"',
        "/fapi/v1/batchOrders",
        "/fapi/v1/allOpenOrders",
        "/fapi/v1/countdownCancelAll",
        "/sapi/v1/futures/transfer",
        "/sapi/v1/capital/withdraw",
        "/sapi/v1/asset/transfer",
        "/sapi/v1/account/apiRestrictions",
        "/fapi/v1/listenKey",
      ]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("has no way to request ONE_WAY position mode", () => {
    for (const file of PHASE_10_FILES) {
      const source = readCode(file);
      expect(`${path.basename(file)}:${source.includes('dualSidePosition: "false"')}`).toBe(
        `${path.basename(file)}:false`
      );
      expect(`${path.basename(file)}:${/setOneWay|ONE_WAY_MODE_PARAM|requestOneWay/.test(source)}`).toBe(
        `${path.basename(file)}:false`
      );
    }
    // The only mode constant is the hedge one.
    expect(readCode(ENDPOINTS)).toContain('ALLOWED_POSITION_MODE_PARAM = "true"');
  });
});

// ---------------------------------------------------------------------------
// Execution isolation
// ---------------------------------------------------------------------------

describe("execution isolation", () => {
  it("imports no Prisma client, so no execution row is expressible", () => {
    for (const file of PHASE_10_FILES) {
      const imports = [...readCode(file).matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const forbidden of ["@prisma/client", "plugins/prisma", "prisma"]) {
        // The pure module imports Prisma.Decimal only — a namespace with no
        // database access. Nothing else may touch Prisma at all.
        if (file === PURE && forbidden === "@prisma/client") continue;
        expect(
          imports.some((entry) => entry === forbidden || entry.endsWith(`/${forbidden}`)),
          `${path.basename(file)} imports ${forbidden}`
        ).toBe(false);
      }
    }
  });

  it("names no execution model or lifecycle service", () => {
    for (const file of PHASE_10_FILES) {
      const source = readCode(file);
      for (const forbidden of [
        "tradeExecution",
        "TradeExecution",
        "binanceOrder.",
        "BinanceOrder",
        "ExecutionProtectionState",
        "SafetyAdmission",
        "ExecutionNotification",
        "entry-lifecycle",
        "protection-lifecycle",
        "safety-admission",
        "execution-notification",
      ]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("touches none of the live trading gates", () => {
    for (const file of PHASE_10_FILES) {
      const source = readCode(file);
      // The health report READS the two gate values to display them, which is
      // the only permitted contact; nothing may write or override them.
      for (const forbidden of [
        "EXECUTION_LIVE_ENTRY_ENABLED = true",
        "EXECUTION_PROTECTION_READY = true",
        "EXECUTION_AUTO_ADD_MARGIN_ENABLED",
        "EXECUTION_EMERGENCY_CLOSE_MODE",
        "EXECUTION_GLOBAL_KILL_SWITCH",
      ]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("still ships the fail-closed live gate defaults", () => {
    const envSource = read(path.join(BACKEND, "src", "config", "env.ts"));
    expect(envSource).toMatch(/EXECUTION_LIVE_ENTRY_ENABLED[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_PROTECTION_READY[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_AUTO_ADD_MARGIN_ENABLED[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_EMERGENCY_CLOSE_MODE[\s\S]{0,120}?\.default\("DISABLED"\)/);
  });

  it("ships both Phase 10 gates fail-closed with a strict boolean", () => {
    const envSource = read(path.join(BACKEND, "src", "config", "env.ts"));
    for (const gate of ["BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED", "BINANCE_TEST_ORDER_ENABLED"]) {
      // z.enum rejects "TRUE", "1" and "" at startup rather than silently
      // reading them as false.
      expect(envSource).toMatch(new RegExp(`${gate}: z\\s*\\.enum\\(\\["true", "false"\\]\\)\\s*\\.default\\("false"\\)`));
    }
  });
});

// ---------------------------------------------------------------------------
// No HTTP surface, no worker
// ---------------------------------------------------------------------------

describe("no runtime surface", () => {
  it("registers no route", () => {
    const app = read(path.join(BACKEND, "src", "app.ts"));
    for (const forbidden of ["account-health", "accountSetup", "hedge-mode", "order/test", "binance-account"]) {
      expect(`${forbidden}:${app.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("declares no Fastify handler and no worker", () => {
    for (const file of PHASE_10_FILES) {
      const source = readCode(file);
      for (const forbidden of ["fastify", "FastifyInstance", "app.get(", "app.post(", "new Worker", "setInterval", "cron"]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("is invoked only through explicit operator CLI scripts", () => {
    const scripts = JSON.parse(read(path.join(BACKEND, "package.json"))).scripts as Record<string, string>;
    expect(scripts["binance:account-health"]).toContain("run-account-health.ts");
    expect(scripts["binance:set-hedge-mode"]).toContain("run-set-hedge-mode.ts");
    expect(scripts["binance:test-order"]).toContain("run-test-order.ts");
  });

  it("requires an explicit confirmation flag for both mutating CLIs", () => {
    expect(read(HEDGE_CLI)).toContain("--confirm-set-hedge-mode");
    expect(read(TEST_ORDER_CLI)).toContain("--confirm-test-order");
    // The read-only CLI needs no confirmation because it changes nothing.
    expect(read(HEALTH_CLI)).not.toContain("--confirm");
  });

  it("never prompts for a secret", () => {
    for (const file of PHASE_10_CLIS) {
      const source = readCode(file);
      for (const forbidden of ["readline", "prompt(", "createInterface", "stdin"]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe("credential protection", () => {
  it("stores no credential field in Prisma", () => {
    const schema = read(path.join(BACKEND, "prisma", "schema.prisma"));
    for (const forbidden of ["apiKey", "apiSecret", "binanceKey", "binanceSecret", "secretKey"]) {
      expect(`${forbidden}:${schema.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("adds no Prisma model for Phase 10", () => {
    const schema = read(path.join(BACKEND, "prisma", "schema.prisma"));
    // Connection health is ephemeral: there is nothing durable to store.
    for (const forbidden of ["model BinanceConnection", "model AccountConnection", "model BinanceCredential"]) {
      expect(`${forbidden}:${schema.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("keeps the real .env out of git", () => {
    const ignore = read(path.join(REPO, ".gitignore"));
    expect(ignore).toMatch(/^\.env$|^\*?\.env$|\.env\b/m);
  });

  it("puts no real-looking key into either .env.example", () => {
    for (const example of [path.join(BACKEND, ".env.example"), path.join(REPO, ".env.example")]) {
      const source = read(example);
      expect(source).toMatch(/^BINANCE_API_KEY=\s*$/m);
      expect(source).toMatch(/^BINANCE_API_SECRET=\s*$/m);
      // Both Phase 10 gates are documented and default to false.
      expect(source).toMatch(/^BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED=false$/m);
      expect(source).toMatch(/^BINANCE_TEST_ORDER_ENABLED=false$/m);
    }
  });

  it("leaves the real .env free of Phase 10 gate overrides", () => {
    let real: string;
    try {
      real = read(path.join(BACKEND, ".env"));
    } catch {
      return;
    }
    expect(real).not.toContain("BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED");
    expect(real).not.toContain("BINANCE_TEST_ORDER_ENABLED");
    expect(real).not.toContain("EXECUTION_LIVE_ENTRY_ENABLED");
    expect(real).not.toContain("EXECUTION_PROTECTION_READY");
  });

  it("never prints a credential from a CLI", () => {
    for (const file of PHASE_10_CLIS) {
      const source = readCode(file);
      for (const forbidden of [
        "BINANCE_API_KEY",
        "BINANCE_API_SECRET",
        "apiKey",
        "apiSecret",
        "signature",
        "X-MBX-APIKEY",
      ]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("prints no balance, position detail or order id from a CLI", () => {
    for (const file of PHASE_10_CLIS) {
      const source = readCode(file);
      for (const forbidden of [
        "walletBalance",
        "availableBalance",
        "positionAmt",
        "entryPrice",
        "markPrice",
        "liquidationPrice",
        "isolatedMargin",
        "orderId",
        "accountIdentifier",
      ]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("logs the endpoint name only, never a URL", () => {
    const client = readCode(CLIENT);
    for (const call of [...client.matchAll(/logger\.\w+\(([\s\S]{0,200}?)\)/g)].map((match) => match[1])) {
      expect(call).not.toContain("url");
      expect(call).not.toContain("query");
      expect(call).not.toContain("apiKey");
    }
  });

  it("is not reachable from the frontend", () => {
    const frontend = path.join(REPO, "apps", "frontend", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readFileSync ? require("node:fs").readdirSync(dir, { withFileTypes: true }) : []) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const source = readFileSync(full, "utf8");
          for (const forbidden of [
            "binance-account-setup",
            "binance-account-connection",
            "BINANCE_API_KEY",
            "BINANCE_API_SECRET",
            "BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED",
            "BINANCE_TEST_ORDER_ENABLED",
          ]) {
            if (source.includes(forbidden)) offenders.push(`${entry.name}: ${forbidden}`);
          }
        }
      }
    };
    walk(frontend);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Configuration behaviour
// ---------------------------------------------------------------------------

/** Loads config fresh under a scripted environment. */
async function withEnv<T>(overrides: Record<string, string>, run: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  vi.resetModules();
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("Phase 10 configuration", () => {
  it("defaults both gates to false", async () => {
    await withEnv({}, async () => {
      delete process.env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED;
      delete process.env.BINANCE_TEST_ORDER_ENABLED;
      const { env } = await import("../src/config/env");
      expect(env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED).toBe(false);
      expect(env.BINANCE_TEST_ORDER_ENABLED).toBe(false);
    });
  });

  it("rejects a malformed boolean at startup rather than reading it as false", async () => {
    for (const bad of ["TRUE", "1", "yes", ""]) {
      await withEnv({ BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED: bad }, async () => {
        await expect(import("../src/config/env")).rejects.toThrow(/Invalid environment variables/);
      });
      await withEnv({ BINANCE_TEST_ORDER_ENABLED: bad }, async () => {
        await expect(import("../src/config/env")).rejects.toThrow(/Invalid environment variables/);
      });
    }
  });

  it("leaves every live trading gate false when both Phase 10 gates are on", async () => {
    await withEnv(
      { BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED: "true", BINANCE_TEST_ORDER_ENABLED: "true" },
      async () => {
        const { env } = await import("../src/config/env");
        expect(env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED).toBe(true);
        expect(env.BINANCE_TEST_ORDER_ENABLED).toBe(true);
        // Enabling a Phase 10 gate authorizes only that one operation.
        expect(env.EXECUTION_LIVE_ENTRY_ENABLED).toBe(false);
        expect(env.EXECUTION_PROTECTION_READY).toBe(false);
        expect(env.EXECUTION_AUTO_ADD_MARGIN_ENABLED).toBe(false);
        expect(env.EXECUTION_EMERGENCY_CLOSE_MODE).toBe("DISABLED");
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

describe("operator documentation", () => {
  it("ships the manual Binance UI checklist", () => {
    const doc = read(path.join(REPO, "docs", "binance-api-key-setup.md"));
    for (const item of [
      "Dedicated key created for trading-alert-dashboard",
      "Withdrawal disabled",
      "IP whitelist configured when stable VPS IP exists",
    ]) {
      expect(doc).toContain(item);
    }
  });

  it("separates programmatic from manual verification", () => {
    const doc = read(path.join(REPO, "docs", "binance-api-key-setup.md"));
    expect(doc).toContain("PROGRAMMATICALLY VERIFIED");
    expect(doc).toContain("MANUALLY VERIFIED IN BINANCE UI");
  });

  it("hardcodes no IP address", () => {
    const doc = read(path.join(REPO, "docs", "binance-api-key-setup.md"));
    expect(doc).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });
});

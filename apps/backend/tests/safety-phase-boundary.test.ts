import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 5 boundary and configuration guards.
 *
 * These are source-level assertions: the safety engine must stay pure, and the
 * whole phase must remain evaluation + local reservation only. A future edit
 * that adds a Prisma call to the engine, or an order-submitting call anywhere
 * in the phase, fails here rather than in production.
 */

const EXECUTION_DIR = path.join(process.cwd(), "src", "modules", "execution");

function read(file: string): string {
  return readFileSync(path.join(EXECUTION_DIR, file), "utf8");
}

/**
 * Scans CODE only. The modules document what they must never do ("never
 * transfers funds", "no Telegram"), so scanning raw text would match the
 * prohibitions themselves.
 */
function readCode(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\S)\s\/\/.*$/gm, "$1");
}

const PHASE_5_FILES = [
  "capacity-status.ts",
  "safety-engine.ts",
  "safety-policy.service.ts",
  "safety-admission.service.ts",
];

describe("pure engine purity", () => {
  const engine = readCode("safety-engine.ts");

  it("imports nothing but decimal support, capacity classification and the take-profit floor", () => {
    /**
     * A DELIBERATELY short allow-list. The engine may reach for arbitrary
     * precision, the capacity classification it decides with, and one
     * narrowly-scoped domain rule — and nothing else.
     *
     * `./take-profit-notional` exists precisely so this dependency is not on
     * the protection LIFECYCLE. The engine and the lifecycle must agree on the
     * standard take-profit minimum-notional comparison, but neither may depend
     * on the other to get it: a decision engine pointed at a lifecycle module
     * is the wrong direction however pure that module happens to be today, and
     * a second copy of the formula is how the two drift apart. Both depend on
     * the rule instead.
     */
    const imports = [...engine.matchAll(/^import .*? from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports.sort()).toEqual(["./capacity-status", "./take-profit-notional", "@prisma/client"]);
  });

  it("still depends on no lifecycle, service or infrastructure module", () => {
    // The property the allow-list above exists to protect, asserted directly so
    // widening that list can never quietly re-introduce the coupling.
    const imports = [...engine.matchAll(/^import .*? from "([^"]+)";$/gm)].map((match) => match[1]);
    for (const forbidden of ["lifecycle", "service", "orchestrator", "client", "repository"]) {
      expect(imports.filter((name) => name.startsWith(".")).join(" ")).not.toContain(forbidden);
    }
  });

  it("the shared take-profit floor module is itself pure", () => {
    // The engine's purity is only as good as what it imports.
    const shared = readCode("take-profit-notional.ts");
    const imports = [...shared.matchAll(/^import .*? from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["@prisma/client"]);
    for (const forbidden of ["process.env", "Date.now()", "new Date()", "fetch(", "prisma.", "console.", "logger."]) {
      expect(shared).not.toContain(forbidden);
    }
  });

  it("never reads a clock", () => {
    expect(engine).not.toMatch(/Date\.now\(\)/);
    expect(engine).not.toMatch(/new Date\(\)/);
  });

  it("never reads the environment", () => {
    expect(engine).not.toMatch(/process\.env/);
    expect(engine).not.toMatch(/from "\.\.\/\.\.\/config\/env"/);
  });

  it("never performs I/O, logging or queueing", () => {
    // Case-sensitive on purpose: the `Prisma.Decimal` NAMESPACE is allowed (it
    // is the arbitrary-precision type), a `prisma.` CLIENT call is not.
    for (const forbidden of ["fetch(", "prisma.", "this.prisma", "console.", "logger.", "axios", "Queue("]) {
      expect(engine).not.toContain(forbidden);
    }
    for (const forbidden of ["bullmq", "telegram", "socket", "ioredis"]) {
      expect(engine.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("never uses float parsing on monetary values", () => {
    expect(engine).not.toMatch(/\bparseFloat\(/);
    expect(engine).not.toMatch(/\bparseInt\(/);
    expect(engine).not.toMatch(/\bNumber\(/);
  });
});

describe("phase boundary", () => {
  it("contains no order submission, cancellation or account mutation anywhere in the phase", () => {
    // Reading `expectedMarginType` from the profile is fine; CHANGING margin
    // type, leverage or position mode is what must never appear.
    const forbidden = [
      "/fapi/v1/order",
      "newOrder",
      "cancelOrder",
      "cancelAllOpenOrders",
      '"POST"',
      '"DELETE"',
      '"PUT"',
      '"PATCH"',
      "setLeverage",
      "changeLeverage",
      "setMarginType",
      "changeMarginType",
      "changePositionMode",
      "positionMargin",
      "positionSide/dual",
      "transfer",
      "closePosition(",
    ];
    for (const file of PHASE_5_FILES) {
      const source = readCode(file);
      for (const needle of forbidden) {
        expect(`${file}:${source.includes(needle)}`).toBe(`${file}:false`);
      }
    }
  });

  it("uses only the read-only connector, and only its GET accessors", () => {
    const service = read("safety-admission.service.ts");
    const calls = [...service.matchAll(/this\.readOnly\.(\w+)\(/g)].map((match) => match[1]);
    expect([...new Set(calls)].sort()).toEqual(["getAccountSummary", "inspectSymbol"]);
  });

  it("exposes no HTTP route for the internal safety policy service", () => {
    const routesDir = path.join(process.cwd(), "src");
    const policySource = read("safety-policy.service.ts");
    expect(policySource).not.toMatch(/fastify|\.get\(|\.post\(|routes/i);
    // And nothing under src/ registers a safety-policy route.
    const registered = readFileSync(path.join(routesDir, "app.ts"), "utf8");
    expect(registered.toLowerCase()).not.toContain("safety");
  });

  it("keeps the kill switch limited to blocking new admissions", () => {
    const service = read("safety-admission.service.ts");
    // No deletion of executions, orders or capacity records anywhere.
    expect(service).not.toMatch(/deleteMany|\.delete\(/);
  });
});

describe("locked canary configuration", () => {
  const envSource = readFileSync(path.join(process.cwd(), "src", "config", "env.ts"), "utf8");

  it("defaults the global kill switch to ACTIVE", () => {
    expect(envSource).toMatch(/EXECUTION_GLOBAL_KILL_SWITCH[\s\S]{0,200}?\.default\("true"\)/);
  });

  it("only releases the kill switch for the exact string 'false'", () => {
    expect(envSource).toMatch(/EXECUTION_GLOBAL_KILL_SWITCH[\s\S]{0,200}?z\s*\n?\s*\.enum\(\["true", "false"\]\)/);
  });

  it("ships the locked canary defaults", () => {
    const defaults: Array<[string, string]> = [
      ["EXECUTION_MAX_OPEN_POSITIONS", "1"],
      ["EXECUTION_MAX_PENDING_ENTRIES", "1"],
      ["EXECUTION_MAX_TOTAL_ACTIVE_TRADES", "1"],
      ["EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE", "1"],
      ["EXECUTION_MAX_ALERT_AGE_SECONDS", "300"],
    ];
    for (const [name, value] of defaults) {
      expect(envSource).toMatch(new RegExp(`${name}:[^\\n]*\\.default\\(${value}\\)`));
    }
    expect(envSource).toMatch(/EXECUTION_MAX_TOTAL_PLANNED_RISK_USD: positiveDecimalString\.default\("1\.50"\)/);
    expect(envSource).toMatch(/EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD: positiveDecimalString\.default\("5\.00"\)/);
  });

  it("keeps monetary limits as decimal strings, not coerced numbers", () => {
    expect(envSource).not.toMatch(/EXECUTION_MAX_TOTAL_PLANNED_RISK_USD: z\.coerce/);
    expect(envSource).not.toMatch(/EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD: z\.coerce/);
  });

  it("rejects a total-active cap below either individual cap", () => {
    expect(envSource).toContain("EXECUTION_MAX_TOTAL_ACTIVE_TRADES must be >= EXECUTION_MAX_OPEN_POSITIONS");
    expect(envSource).toContain("EXECUTION_MAX_TOTAL_ACTIVE_TRADES must be >= EXECUTION_MAX_PENDING_ENTRIES");
  });

  it("documents the limits in both .env.example files without any real value", () => {
    for (const file of [
      path.join(process.cwd(), ".env.example"),
      path.join(process.cwd(), "..", "..", ".env.example"),
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("EXECUTION_GLOBAL_KILL_SWITCH=true");
      expect(source).toContain("EXECUTION_MAX_TOTAL_PLANNED_RISK_USD=1.50");
      // The example carries the RECOMMENDED aggregate ceiling; the schema
      // default asserted above stays 5.00. Admission reserves the per-plan
      // MAXIMUM (risk × 5.333333 = 7.9999995), so 5.00 could not admit even
      // one trade under the recommended multipliers.
      expect(source).toContain("EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD=8.00");
      expect(source).toMatch(/blocks NEW admissions ONLY/i);
    }
  });
});

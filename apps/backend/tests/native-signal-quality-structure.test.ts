import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { NATIVE_PLAN_BUILTIN_DEFAULTS } from "@trading-alert-dashboard/shared";

import { NATIVE_CANARY_SOURCE_TIMEFRAMES, verifyNativeAccountAHandoff } from "../src/modules/native-canary/native-account-a-canary";
import { evaluateNativeDryAdmission } from "../src/modules/native-canary/native-dry-admission";
import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { NATIVE_RISK_CONTRACTS } from "../src/modules/native-canary/native-risk-contract";
import { NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS, NATIVE_OPERATIONAL_BAR_MS, NATIVE_POST_CLOSE_FRESHNESS_MS, nativeSignalExpiryOf } from "../src/modules/native-canary/native-signal-freshness";
import { ACCOUNT_A_POLICY, FRESH_NOW_MS, LIVE_READY_GATES, ARMED_PROFILE, canaryAlert, cleanRecords, eligibleEvidence, planFor } from "./helpers/native-canary-fixtures";

/**
 * M6.5 — structural safety of the Native signal-quality observatory (sections
 * 30 and 31). The value-import closure comes from the TypeScript AST (type-only
 * imports are erased), so "does not import X" is a fact about the program.
 */

const BACKEND = path.resolve(__dirname, "..");
const SQ = "src/modules/signal-quality";
const SQ_FILES = readdirSync(path.join(BACKEND, SQ)).map((f) => `${SQ}/${f}`).sort();
const ROUTES = "src/routes/signal-quality.routes.ts";

function sourceOf(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, readFileSync(path.join(BACKEND, rel), "utf8"), ts.ScriptTarget.Latest, true);
}

function valueSpecifiers(rel: string): string[] {
  const out: string[] = [];
  for (const s of sourceOf(rel).statements) {
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause;
      if (c?.isTypeOnly) continue;
      const n = c?.namedBindings;
      if (c && !c.name && n && ts.isNamedImports(n) && n.elements.length > 0 && n.elements.every((e) => e.isTypeOnly)) continue;
      out.push((s.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && !s.isTypeOnly) {
      out.push((s.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return out;
}

function resolveRelative(fromRel: string, spec: string): string {
  const base = path.resolve(path.dirname(path.join(BACKEND, fromRel)), spec);
  for (const c of [`${base}.ts`, path.join(base, "index.ts")]) if (existsSync(c)) return path.relative(BACKEND, c).split(path.sep).join("/");
  throw new Error(`unresolved ${spec} from ${fromRel}`);
}

function closure(root: string): { modules: string[]; packages: string[] } {
  const modules = new Set([root]);
  const packages = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    for (const spec of valueSpecifiers(rel)) {
      if (spec.startsWith(".")) {
        const r = resolveRelative(rel, spec);
        if (!modules.has(r)) {
          modules.add(r);
          queue.push(r);
        }
      } else packages.add(spec);
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

const codeOf = (rel: string) =>
  readFileSync(path.join(BACKEND, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

function productionSources(dir = path.join(BACKEND, "src")): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

const routes = closure(ROUTES);

// ===========================================================================
// Section 30: what the observatory can reach
// ===========================================================================

describe("the observatory's value-import closure (TypeScript AST)", () => {
  it("reaches no private exchange client, order adapter, account control, execution service, adoption, occupancy, fence runtime, queue, Redis, plugin or environment configuration", () => {
    const forbidden = [
      /^src\/modules\/binance\//, // signed/private clients, order and account-setup adapters
      /^src\/modules\/operator\//, // account control, gates, arming
      /^src\/modules\/jobs\//, // queues and workers
      /^src\/modules\/runtime\//,
      /^src\/plugins\//,
      /^src\/config\//,
      /^src\/modules\/execution\/(?!capacity-status\.ts$)/, // only the pure status vocabulary the canary names
      /native-account-a-adoption|native-occupancy|native-execution-fence|native-dry-admission/,
      /extreme-rr\.service|selected-plan|market-data\.service/,
    ];
    for (const module of routes.modules) {
      expect({ module, hit: forbidden.find((p) => p.test(module))?.source ?? null }).toEqual({ module, hit: null });
    }
    expect(routes.packages).toEqual(["@prisma/client", "@trading-alert-dashboard/shared", "node:crypto", "node:fs", "node:path"]);
  });

  it("the pure kernels are tiny: outcome and aggregate import nothing of the backend; rows only the outcome; the monitor only continuity", () => {
    expect(closure(`${SQ}/signal-quality-outcome.ts`).modules).toEqual([`${SQ}/signal-quality-outcome.ts`]);
    expect(closure(`${SQ}/signal-quality-aggregate.ts`).modules).toEqual([`${SQ}/signal-quality-aggregate.ts`]);
    expect(closure(`${SQ}/signal-quality-rows.ts`).modules).toEqual([`${SQ}/signal-quality-outcome.ts`, `${SQ}/signal-quality-rows.ts`]);
    expect(closure(`${SQ}/soak-monitor.ts`).modules).toEqual([`${SQ}/soak-continuity.ts`, `${SQ}/soak-monitor.ts`]);
    expect(closure(`${SQ}/soak-continuity.ts`).packages).toEqual([]);
    for (const kernel of ["signal-quality-outcome.ts", "signal-quality-aggregate.ts", "signal-quality-rows.ts", "signal-quality-export.ts"]) {
      expect({ kernel, packages: closure(`${SQ}/${kernel}`).packages }).toEqual({ kernel, packages: ["@trading-alert-dashboard/shared"] });
    }
  });

  it("the soak monitor CLI imports no database client, no environment configuration and no exchange client", () => {
    const monitor = closure(`${SQ}/run-signal-quality-soak-monitor.ts`);
    expect(monitor.modules).toEqual([`${SQ}/run-signal-quality-soak-monitor.ts`, `${SQ}/soak-continuity.ts`, `${SQ}/soak-monitor.ts`, "src/modules/native-scanner/scanner-paths.ts"].sort());
    expect(monitor.packages).toEqual(["node:fs", "node:path"]);
  });

  it("the facts module's canary import is a constant and the M5 freshness rule; the canary closure starts nothing (documented)", () => {
    const facts = codeOf(`${SQ}/signal-quality-facts.ts`);
    expect(facts).toMatch(/import \{ NATIVE_CANARY_SOURCE_TIMEFRAMES \} from "\.\.\/native-canary\/native-account-a-canary";/);
    expect(facts).toMatch(/import \{ judgeNativeSignalFreshness, nativeSignalWindowOf, type NativeSignalWindow \} from "\.\.\/native-canary\/native-signal-freshness";/);
    for (const module of closure("src/modules/native-canary/native-account-a-canary.ts").modules) {
      expect({ module, hit: codeOf(module).match(/setInterval\(|setTimeout\(|process\.env|fetch\(/)?.[0] ?? null }).toEqual({ module, hit: null });
    }
  });
});

describe("no signing, no private call, no mutation, no authority", () => {
  const all = [...SQ_FILES, ROUTES];

  it("nothing in the observatory signs, sends a key, or names a signed/private endpoint", () => {
    for (const rel of all) {
      expect({ rel, hit: codeOf(rel).match(/createHmac|apiSecret|apiKey|X-MBX-APIKEY|signQuery|recvWindow|\/fapi\/v[0-9]\/(order|account|balance|positionRisk|leverage|marginType|listenKey)/)?.[0] ?? null }).toEqual({ rel, hit: null });
    }
    const md = codeOf(`${SQ}/signal-quality-market-data.ts`);
    expect(md.match(/buildPublicFuturesUrl\(PUBLIC_FUTURES_ORIGIN, KLINES_PATH,/g)).toHaveLength(2);
    expect(md).toContain('const PUBLIC_FUTURES_ORIGIN = "https://fapi.binance.com";');
  });

  it("no database write, claim, lease, adoption, execution, handoff, order, risk or account-gate symbol appears", () => {
    // Prisma write calls take an object argument; an in-memory Map.delete(key) does not.
    const forbidden = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(\{|\$executeRaw|\$queryRaw|\$transaction|selectedPlanAdoption|tradeExecution|binanceOrder|executionCanaryAuthorization\.|decideNativeAccountACandidate|issueHandoff|NativeAccountAHandoff|handleNativeAccountACandidate|createExecutionFromReadyPlan|reserveNativeOccupancy|claimNaturalWindow|armNaturalWindow|reserveSessionSlot|NATIVE_RISK_CONTRACTS|NATIVE_EXECUTION_ENABLED/;
    for (const rel of all) expect({ rel, hit: codeOf(rel).match(forbidden)?.[0] ?? null }).toEqual({ rel, hit: null });
  });

  it("every route is a GET: no POST, PUT, PATCH or DELETE quality route", () => {
    const code = codeOf(ROUTES);
    expect(code.match(/app\.(post|put|patch|delete|route|all)\(/g)).toBeNull();
    expect(code.match(/app\.get(<[^>]*>)?\("\/api\/signal-quality\/[A-Za-z/:-]*"/g)).toHaveLength(6);
    expect(codeOf("src/app.ts")).toContain("await app.register(signalQualityRoutes);");
  });

  it("no environment key can enable execution, dry authority or resolve risk; the observatory reads the environment only for the scanner directory", () => {
    const env = codeOf("src/config/env.ts");
    expect(env).not.toMatch(/NATIVE_EXECUTION|NATIVE_RISK|SIGNAL_QUALITY|NATIVE_DRY/);
    for (const rel of SQ_FILES) {
      for (const m of codeOf(rel).matchAll(/process\.env(\.[A-Z_]+)?/g)) expect({ rel, use: m[0] }).toEqual({ rel, use: "process.env" });
    }
    expect(codeOf(ROUTES).match(/process\.env/g)).toEqual(["process.env"]);
  });

  it("no migration, no runtime role and no launcher change: the newest migration is unchanged and the launcher does not know the observatory", () => {
    const dir = path.join(BACKEND, "prisma/migrations");
    expect(readdirSync(dir).filter((e) => statSync(path.join(dir, e)).isDirectory()).sort().at(-1)).toBe("20261002090000_add_native_alert_source_and_delivery");
    const launcherFiles = productionSources().filter((rel) => rel.includes("runtime-launcher") || rel.includes("native-planner-launcher"));
    expect(launcherFiles.length).toBeGreaterThan(0);
    for (const rel of launcherFiles) expect({ rel, mentions: /signal-quality|soak-monitor/.test(codeOf(rel)) }).toEqual({ rel, mentions: false });
    const scripts = JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(Object.entries(scripts).filter(([name]) => name.startsWith("signal-quality"))).toEqual([["signal-quality:soak-monitor", "tsx src/modules/signal-quality/run-signal-quality-soak-monitor.ts"]]);
  });

  it("only the observatory's own route file imports the observatory service", () => {
    const importers = productionSources().filter((rel) => !rel.startsWith(SQ) && /signal-quality\.service|signal-quality-market-data/.test(codeOf(rel)));
    expect(importers).toEqual([ROUTES]);
  });
});

// ===========================================================================
// Section 31: M4 / M5 / M6 invariants, re-proved
// ===========================================================================

describe("section 31: the M4/M5/M6 invariants are unchanged", () => {
  it("Native execution is literally false; A and B risk UNRESOLVED; lookbacks 100/300 are windows, never money", () => {
    expect(NATIVE_EXECUTION_ENABLED).toBe(false);
    expect(codeOf("src/modules/native-canary/native-execution-switch.ts")).toMatch(/^\s*export const NATIVE_EXECUTION_ENABLED = false as const;\s*$/);
    expect(NATIVE_RISK_CONTRACTS.A.state).toBe("UNRESOLVED");
    expect(NATIVE_RISK_CONTRACTS.B.state).toBe("UNRESOLVED");
    expect(NATIVE_PLAN_BUILTIN_DEFAULTS).toEqual({ A: 100, B: 300 });
    expect(codeOf("src/modules/native-canary/native-risk-gate.ts")).not.toMatch(/lookback|NATIVE_PLAN_BUILTIN_DEFAULTS/i);
  });

  it("M5 freshness is unchanged; 1M stays execution-ineligible", () => {
    expect([NATIVE_OPERATIONAL_BAR_MS, NATIVE_POST_CLOSE_FRESHNESS_MS, NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS]).toEqual([900_000, 300_000, 1_200_000]);
    expect(nativeSignalExpiryOf(0, 61_234).expiresAtMs).toBe(1_200_000);
    expect(NATIVE_CANARY_SOURCE_TIMEFRAMES).toEqual(["1D", "1W"]);
  });

  it("M6 dry admission still has authority NONE and its result still fails the real hand-off verifier", () => {
    const records = cleanRecords();
    const alert = canaryAlert(records);
    const result = evaluateNativeDryAdmission({
      accountSlot: "ACCOUNT_A",
      executionProfileId: "profile-account-a",
      alert,
      plan: planFor(alert),
      accountPlanPolicy: ACCOUNT_A_POLICY,
      scannerEvidence: eligibleEvidence(records),
      occupancy: [],
      accountGates: { environment: LIVE_READY_GATES, profile: ARMED_PROFILE },
      phase5: null,
      nowMs: FRESH_NOW_MS,
    });
    expect(result.authority).toBe("NONE");
    expect(result.authoritative).toMatchObject({ terminalStage: "NATIVE_FENCE", reason: "NATIVE_EXECUTION_DISABLED" });
    expect(verifyNativeAccountAHandoff(result, { executionProfileId: "profile-account-a" })).toMatchObject({ ok: false, reasonCode: "HANDOFF_INVALID" });
  });

  it("integrity stays mandatory at the fence; the occupancy lock is unchanged", () => {
    const canary = codeOf("src/modules/native-canary/native-account-a-canary.ts");
    expect(canary).toContain("judgeNativeExecutionAdmission({ nativeExecutionEnabled: NATIVE_EXECUTION_ENABLED, integrity })");
    const occupancy = codeOf("src/modules/native-canary/native-occupancy.ts");
    expect(occupancy).toMatch(/const NATIVE_OCCUPANCY_LOCK_NAMESPACE = 0xa7e1;/);
  });
});

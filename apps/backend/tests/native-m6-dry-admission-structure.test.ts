import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { NATIVE_PLAN_BUILTIN_DEFAULTS } from "@trading-alert-dashboard/shared";

import { NATIVE_CANARY_SOURCE_TIMEFRAMES } from "../src/modules/native-canary/native-account-a-canary";
import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { NATIVE_RISK_CONTRACTS } from "../src/modules/native-canary/native-risk-contract";
import {
  NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS,
  NATIVE_OPERATIONAL_BAR_MS,
  NATIVE_POST_CLOSE_FRESHNESS_MS,
  nativeSignalExpiryOf,
} from "../src/modules/native-canary/native-signal-freshness";

/**
 * MILESTONE 6, structurally: what the Native dry admission can REACH.
 *
 * The value-import closure is computed from the TypeScript AST (type-only
 * imports are erased at compile time and reach nothing), so "the dry module
 * does not import X" is a fact about the emitted program, not about text.
 * Then every module in that closure is searched for the capabilities the dry
 * admission must not have, and the dry module itself for every
 * authority-bearing or I/O function it must not call.
 */

const BACKEND = path.resolve(__dirname, "..");
const DRY = "src/modules/native-canary/native-dry-admission.ts";

// ---------------------------------------------------------------------------
// The value-import closure, from the AST
// ---------------------------------------------------------------------------

function sourceOf(rel: string): ts.SourceFile {
  const file = path.join(BACKEND, rel);
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** Module specifiers this file imports or re-exports AS VALUES (erased type-only ones excluded). */
function valueSpecifiers(rel: string): string[] {
  const out: string[] = [];
  for (const statement of sourceOf(rel).statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      if (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)) continue;
      out.push((statement.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly)) continue;
      out.push((statement.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return out;
}

/** Dynamic `import()` and `require()` calls anywhere in the file. */
function dynamicLoads(rel: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      found.push(node.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(rel));
  return found;
}

function resolveRelative(fromRel: string, specifier: string): string {
  const base = path.resolve(path.dirname(path.join(BACKEND, fromRel)), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return path.relative(BACKEND, candidate).split(path.sep).join("/");
  }
  throw new Error(`unresolved ${specifier} from ${fromRel}`);
}

function valueClosure(root: string): { modules: string[]; packages: Map<string, string[]> } {
  const modules = new Set([root]);
  const packages = new Map<string, string[]>();
  const queue = [root];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    for (const specifier of valueSpecifiers(rel)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(rel, specifier);
        if (!modules.has(resolved)) {
          modules.add(resolved);
          queue.push(resolved);
        }
      } else {
        packages.set(specifier, [...(packages.get(specifier) ?? []), rel].sort());
      }
    }
  }
  return { modules: [...modules].sort(), packages };
}

function codeOf(rel: string): string {
  return readFileSync(path.join(BACKEND, rel), "utf8")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function withoutStrings(code: string): string {
  return code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

function productionSources(dir = path.join(BACKEND, "src")): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

function filesUnder(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" || entry === "dist" ? [] : filesUnder(full, pattern);
    return pattern.test(full) ? [full] : [];
  });
}

const closure = valueClosure(DRY);

// ===========================================================================
// Section 23 / 14: what the dry admission can reach
// ===========================================================================

describe("the dry admission's value-import closure (TypeScript AST)", () => {
  it("is exactly these 26 modules: the production judgment, Phase 5's pure judgments, and the canonical integrity evaluator with its vocabulary", () => {
    // Groups: the dry module and the production judgment it asks, with its hard
    // switch, risk contract and freshness rule (native-canary); Phase 5's pure
    // judgments, whose Prisma imports are type-only (execution); the canonical
    // integrity evaluator and the payload, event-id, checkpoint and profile
    // vocabulary it reads (native-integrity, native-alerts, native-scanner,
    // including the scanner's public-market constants: no signature, no
    // account, no request); and the alert-source and error vocabulary.
    expect(closure.modules).toEqual([
      "src/modules/alerts/alert-source.ts",
      "src/modules/execution/capacity-status.ts",
      "src/modules/execution/natural-authorization.ts",
      "src/modules/execution/trading-session.ts",
      "src/modules/native-alerts/native-alert-draft.ts",
      "src/modules/native-alerts/native-delivery-policy.ts",
      "src/modules/native-alerts/shadow-log-reader.ts",
      "src/modules/native-canary/native-account-a-canary.ts",
      "src/modules/native-canary/native-dry-admission.ts",
      "src/modules/native-canary/native-execution-switch.ts",
      "src/modules/native-canary/native-risk-contract.ts",
      "src/modules/native-canary/native-risk-gate.ts",
      "src/modules/native-canary/native-signal-freshness.ts",
      "src/modules/native-integrity/native-execution-integrity.ts",
      "src/modules/native-scanner/binance-public-futures.ts",
      "src/modules/native-scanner/canonical-json.ts",
      "src/modules/native-scanner/exchange-symbol.ts",
      "src/modules/native-scanner/historical-replay.ts",
      "src/modules/native-scanner/kline-cache.ts",
      "src/modules/native-scanner/live-shadow-checkpoint.ts",
      "src/modules/native-scanner/live-shadow-store.ts",
      "src/modules/native-scanner/scanner-lineage.ts",
      "src/modules/native-scanner/scanner-paths.ts",
      "src/modules/native-scanner/scanner-profile.ts",
      "src/modules/native-scanner/usdm-universe.ts",
      "src/utils/errors.ts",
    ]);
  });

  it("reaches no exchange client or order adapter, no Prisma client, no environment, no queue, no Redis, no route and no execution service", () => {
    const forbidden = [
      /^src\/modules\/binance\//, // signed/private clients, order and account-setup adapters
      /^src\/plugins\//, // the Prisma singleton, Redis, sockets
      /^src\/config\//, // the process environment
      /^src\/modules\/jobs\//, // queues and workers
      /^src\/modules\/runtime\//, // runtime attestation (Redis)
      /^src\/routes\//,
      /\.service\.ts$/, // every database-backed service
      /selected-plan-executor|execution-orchestrator|entry-lifecycle|protection-lifecycle|execution-safety|profile-lock/,
      /native-account-a-adoption|native-occupancy|native-execution-fence|canary-authorization/,
    ];
    for (const module of closure.modules) {
      expect({ module, hit: forbidden.find((pattern) => pattern.test(module))?.source ?? null }).toEqual({ module, hit: null });
    }
  });

  it("uses only these packages: Prisma's Decimal (never its client), the shared types, hashing and two file modules the dry path never calls", () => {
    expect(Object.fromEntries([...closure.packages].sort())).toEqual({
      "@prisma/client": ["src/modules/native-canary/native-risk-gate.ts"],
      "@trading-alert-dashboard/shared": [
        "src/modules/native-alerts/shadow-log-reader.ts",
        "src/modules/native-canary/native-account-a-canary.ts",
        "src/modules/native-scanner/historical-replay.ts",
        "src/modules/native-scanner/scanner-lineage.ts",
        "src/modules/native-scanner/scanner-profile.ts",
      ],
      "node:crypto": ["src/modules/native-alerts/shadow-log-reader.ts", "src/modules/native-scanner/canonical-json.ts", "src/modules/native-scanner/kline-cache.ts"],
      "node:fs": [
        "src/modules/native-integrity/native-execution-integrity.ts",
        "src/modules/native-scanner/kline-cache.ts",
        "src/modules/native-scanner/live-shadow-checkpoint.ts",
        "src/modules/native-scanner/live-shadow-store.ts",
      ],
      "node:path": [
        "src/modules/native-integrity/native-execution-integrity.ts",
        "src/modules/native-scanner/kline-cache.ts",
        "src/modules/native-scanner/live-shadow-checkpoint.ts",
        "src/modules/native-scanner/live-shadow-store.ts",
        "src/modules/native-scanner/scanner-paths.ts",
        "src/modules/native-scanner/scanner-profile.ts",
      ],
    });
    // The one value import from Prisma is the Decimal namespace the risk gate compares with.
    expect(codeOf("src/modules/native-canary/native-risk-gate.ts")).toMatch(/^import \{ Prisma \} from "@prisma\/client";$/m);
    for (const module of closure.modules) expect({ module, client: /\bPrismaClient\b/.test(codeOf(module)) }).toEqual({ module, client: false });
  });

  it("no module in it reads the environment, the clock or randomness, starts a timer, signs, makes a request, loads code dynamically or writes a database row", () => {
    const capabilities: [string, RegExp][] = [
      ["environment", /process\.env|\bprocess\.argv/],
      ["clock", /Date\.now\(|new Date\(\)|performance\.now\(/],
      ["randomness", /randomUUID|randomBytes|Math\.random/],
      ["timer", /setTimeout\(|setInterval\(|setImmediate\(/],
      ["signing", /createHmac|createSign\b|apiSecret|X-MBX/],
      ["network", /\bfetch\(|XMLHttpRequest|WebSocket|node:https?|node:net/],
      ["database", /\$transaction|\$executeRaw|\$queryRaw|\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(\{/],
      ["queue/redis", /bullmq|ioredis|\.enqueue\(|\.add\(\s*["'`]/],
    ];
    for (const module of closure.modules) {
      const code = codeOf(module);
      for (const [capability, pattern] of capabilities) {
        expect({ module, capability, hit: code.match(pattern)?.[0] ?? null }).toEqual({ module, capability, hit: null });
      }
      expect({ module, dynamic: dynamicLoads(module) }).toEqual({ module, dynamic: [] });
    }
  });

  it("the four modules holding file I/O hold it in functions the dry path never names", () => {
    const fileIo = closure.modules.filter((module) => /\b(readFileSync|existsSync|writeFileSync|appendFileSync|openSync|renameSync|mkdirSync|readdirSync)\b/.test(codeOf(module)));
    expect(fileIo).toEqual([
      "src/modules/native-integrity/native-execution-integrity.ts",
      "src/modules/native-scanner/kline-cache.ts",
      "src/modules/native-scanner/live-shadow-checkpoint.ts",
      "src/modules/native-scanner/live-shadow-store.ts",
    ]);
    // Every file call in those modules sits inside one of these four entry points, or in a
    // module-private write helper only those entry points call (AST)...
    const FS_CALLS = /^(readFileSync|existsSync|writeFileSync|appendFileSync|openSync|renameSync|mkdirSync|readdirSync|fsyncSync|closeSync|writeSync|readSync|statSync|unlinkSync|rmSync)$/;
    const owners = new Set<string>();
    const helperCallers = new Set<string>();
    for (const module of fileIo) {
      const visit = (node: ts.Node, owner: string | null) => {
        const named = (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name ? node.name.text : owner;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (FS_CALLS.test(node.expression.text)) owners.add(`${path.basename(module)}:${named ?? "<module scope>"}`);
          if (/^(writeAtomically|writeDurably)$/.test(node.expression.text)) helperCallers.add(`${node.expression.text}<-${named ?? "<module scope>"}`);
        }
        ts.forEachChild(node, (child) => visit(child, named));
      };
      visit(sourceOf(module), null);
    }
    expect([...owners].sort()).toEqual([
      "kline-cache.ts:KlineCacheStore",
      "kline-cache.ts:writeAtomically",
      "live-shadow-checkpoint.ts:LiveCheckpointStore",
      "live-shadow-checkpoint.ts:writeDurably",
      "live-shadow-store.ts:LiveShadowEventStore",
      "native-execution-integrity.ts:fileSystemNativeScannerEvidence",
    ]);
    expect([...helperCallers].sort()).toEqual(["writeAtomically<-KlineCacheStore", "writeDurably<-LiveCheckpointStore"]);
    expect(codeOf("src/modules/native-scanner/kline-cache.ts")).not.toMatch(/export (async )?function writeAtomically|export \{[^}]*writeAtomically/);
    expect(codeOf("src/modules/native-scanner/live-shadow-checkpoint.ts")).not.toMatch(/export (async )?function writeDurably|export \{[^}]*writeDurably/);
    // ...and neither the dry admission nor anything it calls on the dry path names one.
    const ioEntryPoints = /\b(fileSystemNativeScannerEvidence|KlineCacheStore|LiveCheckpointStore|LiveShadowEventStore)\b/;
    for (const caller of [DRY, "src/modules/native-canary/native-account-a-canary.ts", "src/modules/native-canary/native-signal-freshness.ts", "src/modules/native-canary/native-risk-gate.ts", "src/modules/execution/natural-authorization.ts", "src/modules/execution/trading-session.ts"]) {
      expect({ caller, hit: codeOf(caller).match(ioEntryPoints)?.[0] ?? null }).toEqual({ caller, hit: null });
    }
  });
});

// ===========================================================================
// Section 10 / 23: the dry module itself holds no authority
// ===========================================================================

describe("the dry module asks the judgment and nothing that acts", () => {
  const code = codeOf(DRY);
  const bare = withoutStrings(code);

  it("asks the production judgment exactly once, and never the decision that issues a hand-off", () => {
    expect(code.match(/\bjudgeNativeAccountACandidate\(/g)).toHaveLength(1);
    for (const name of ["decideNativeAccountACandidate", "issueHandoff", "ISSUED_HANDOFFS", "NATIVE_ACCOUNT_A_HANDOFF", "NativeAccountAHandoff", "verifyNativeAccountAHandoff", "assertNativeAccountAHandoff"]) {
      expect({ name, present: code.includes(name) }).toEqual({ name, present: false });
    }
  });

  it("names no executor, creation, occupancy reservation, adoption, claim, session reservation, fence runtime, exchange, database, environment, clock or file entry point", () => {
    for (const name of [
      "handleNativeAccountACandidate",
      "createExecutionFromReadyPlan",
      "reserveNativeOccupancy",
      "loadNativeOccupancyRows",
      "NativeAccountAAdoptionService",
      "startNativeAccountAAdoptionScheduler",
      "selectedPlanAdoption",
      "claimNaturalWindow",
      "armNaturalWindow",
      "prepareNaturalWindow",
      "revokeNaturalWindow",
      "resolveAdmissionAuthorization",
      "reserveSessionSlot",
      "nativeFenceRuntimeFromEnv",
      "nativeAlertFence",
      "fileSystemNativeScannerEvidence",
      "prisma",
      "tradeExecution",
      "binanceOrder",
      "clientOrderId",
      "process",
      "Date.now",
      "randomUUID",
    ]) {
      expect({ name, present: bare.includes(name) }).toEqual({ name, present: false });
    }
  });

  it("its only authority value is NONE, and it exports the evaluator, its policy name and its downstream stage list, nothing else", async () => {
    // Declared NONE on the result type, and NONE where the result is built: no other value exists.
    expect([...code.matchAll(/authority: "([A-Z_]+)"/g)].map((m) => m[1])).toEqual(["NONE", "NONE"]);
    expect(code).toMatch(/readonly authority: "NONE";/);
    const dry = await import("../src/modules/native-canary/native-dry-admission");
    expect(Object.keys(dry).sort()).toEqual(["NATIVE_DRY_ADMISSION_POLICY", "NATIVE_DRY_DOWNSTREAM_STAGES", "evaluateNativeDryAdmission"]);
    expect(dry.NATIVE_DRY_ADMISSION_POLICY).toBe("NATIVE_DRY_ADMISSION_V1");
  });

  it("every Phase 5 helper it asks is a pure judgment, and those judgments are what Phase 5's own functions now delegate to", () => {
    expect(code).toContain("judgeAdmissionAuthorization(");
    expect(code).toContain("judgeSessionReservation(");
    const admission = codeOf("src/modules/execution/safety-admission.service.ts");
    expect(admission).toContain("judgeAdmissionAuthorization(facts, execution.positionSide, evaluatedAt)");
    const session = codeOf("src/modules/execution/trading-session.service.ts");
    expect(session).toContain("const state = judgeSessionReservation({");
    const adoption = codeOf("src/modules/native-canary/native-account-a-adoption.ts");
    expect(adoption).toContain("nativeAdoptionDefers(preview, this.integrityOf(preview), clock().getTime())");
    expect(adoption).toContain("return nativeCanaryIntegrityOf(alert, this.deps.fence.evidence);");
  });
});

// ===========================================================================
// No runtime role, route, UI control, environment key or migration
// ===========================================================================

describe("the dry admission has no runtime role", () => {
  it("no production module imports it: it is a library, reached only by tests", () => {
    expect(productionSources().filter((rel) => rel !== DRY && /native-dry-admission|evaluateNativeDryAdmission|NATIVE_DRY_ADMISSION/.test(codeOf(rel)))).toEqual([]);
  });

  it("no route, plugin, app wiring, CLI script, UI control or environment key mentions it or Native execution authority", () => {
    const app = readFileSync(path.join(BACKEND, "src/app.ts"), "utf8");
    expect(app).not.toMatch(/native-dry|native-canary/);
    const pkg = readFileSync(path.join(BACKEND, "package.json"), "utf8");
    expect(pkg).not.toMatch(/native-dry|dry-admission/i);
    const frontend = filesUnder(path.resolve(BACKEND, "../frontend/src"), /\.(ts|tsx)$/).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(frontend).not.toMatch(/NATIVE_DRY_ADMISSION|dryAdmission|DryAdmission|native-dry/);
    const envSchema = codeOf("src/config/env.ts");
    expect(envSchema).not.toMatch(/NATIVE_DRY|NATIVE_EXECUTION|NATIVE_RISK/);
    for (const template of [path.resolve(BACKEND, "../../.env.example"), path.join(BACKEND, ".env.example"), path.join(BACKEND, ".env.test.example"), path.resolve(BACKEND, "../frontend/.env.example")]) {
      const text = existsSync(template) ? readFileSync(template, "utf8") : "";
      expect({ template: path.basename(template), hit: text.match(/NATIVE_DRY|NATIVE_EXECUTION|NATIVE_RISK/)?.[0] ?? null }).toEqual({ template: path.basename(template), hit: null });
    }
  });

  it("adds no migration: the newest migration is still M2's Native alert source", () => {
    const dir = path.join(BACKEND, "prisma/migrations");
    const migrations = readdirSync(dir).filter((entry) => statSync(path.join(dir, entry)).isDirectory()).sort();
    expect(migrations.at(-1)).toBe("20261002090000_add_native_alert_source_and_delivery");
  });
});

// ===========================================================================
// Section 18: the M4/M5 invariants, re-proved after M6
// ===========================================================================

describe("section 18: the M4/M5 invariants are unchanged", () => {
  it("the hard switch is still literally false, and no environment can set it", () => {
    expect(NATIVE_EXECUTION_ENABLED).toBe(false);
    expect(codeOf("src/modules/native-canary/native-execution-switch.ts")).toMatch(/^\s*export const NATIVE_EXECUTION_ENABLED = false as const;\s*$/);
    for (const rel of productionSources()) {
      const code = codeOf(rel);
      expect(`${rel}:${/process\.env\.NATIVE_EXECUTION|env\.NATIVE_EXECUTION|\[["'`]NATIVE_EXECUTION/.test(code)}`).toBe(`${rel}:false`);
      expect(`${rel}:${/\bNATIVE_EXECUTION_ENABLED\s*=(?!=)/.test(withoutStrings(code)) && rel !== "src/modules/native-canary/native-execution-switch.ts"}`).toBe(`${rel}:false`);
    }
  });

  it("Native risk is UNRESOLVED for A and B, and the contract file holds no amount", () => {
    expect(NATIVE_RISK_CONTRACTS.A).toMatchObject({ state: "UNRESOLVED", account: "A" });
    expect(NATIVE_RISK_CONTRACTS.B).toMatchObject({ state: "UNRESOLVED", account: "B" });
    expect(withoutStrings(codeOf("src/modules/native-canary/native-risk-contract.ts"))).not.toMatch(/maxRiskPerTradeUsd:\s*["'`\d]/);
    expect(codeOf("src/modules/native-canary/native-risk-contract.ts")).not.toMatch(/\d+\.\d+|process\.env/);
  });

  it("Account A's window is 100 candles and B's 300: lookbacks, not money", () => {
    expect(NATIVE_PLAN_BUILTIN_DEFAULTS).toEqual({ A: 100, B: 300 });
    expect(codeOf("src/modules/native-canary/native-risk-gate.ts")).not.toMatch(/lookback|NATIVE_PLAN_BUILTIN_DEFAULTS/i);
  });

  it("the M5 freshness rule is unchanged, TradingView keeps its 300 seconds, and only 1D/1W execute", () => {
    expect([NATIVE_OPERATIONAL_BAR_MS, NATIVE_POST_CLOSE_FRESHNESS_MS, NATIVE_ABSOLUTE_MAX_SIGNAL_AGE_MS]).toEqual([15 * 60_000, 5 * 60_000, 20 * 60_000]);
    const w = nativeSignalExpiryOf(0, 61_234);
    expect(w).toEqual({ barStartMs: 0, barCloseMs: 900_000, triggeredAtMs: 61_234, postCloseExpiryMs: 1_200_000, absoluteExpiryMs: 1_261_234, expiresAtMs: 1_200_000 });
    expect(codeOf("src/config/env.ts")).toContain("EXECUTION_MAX_ALERT_AGE_SECONDS: z.coerce.number().int().positive().default(300),");
    expect(NATIVE_CANARY_SOURCE_TIMEFRAMES).toEqual(["1D", "1W"]);
  });

  it("integrity stays mandatory at the fence, and the occupancy lock is still the keyed transaction lock in its own namespace", () => {
    const canary = codeOf("src/modules/native-canary/native-account-a-canary.ts");
    const fence = canary.slice(canary.indexOf("export function nativeFenceStage("), canary.indexOf("export function nativeRiskStage("));
    expect(fence).toContain("judgeNativeExecutionAdmission({ nativeExecutionEnabled: NATIVE_EXECUTION_ENABLED, integrity })");
    const occupancy = codeOf("src/modules/native-canary/native-occupancy.ts");
    expect(occupancy).toMatch(/const NATIVE_OCCUPANCY_LOCK_NAMESPACE = 0xa7e1;/);
    expect(occupancy).toContain("pg_advisory_xact_lock(${NATIVE_OCCUPANCY_LOCK_NAMESPACE}::int, ${nativeOccupancyLockKey(");
  });
});

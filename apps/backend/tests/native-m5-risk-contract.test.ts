import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_PLAN_BUILTIN_DEFAULTS, parseNativeAccountPlanPolicy } from "@trading-alert-dashboard/shared";

import { NATIVE_CANARY_REASON_CODES, decideNativeAccountACandidate } from "../src/modules/native-canary/native-account-a-canary";
import { nativeAccountSlotOf } from "../src/modules/native-canary/native-account-slot";
import { nativeFenceRuntimeFromEnv } from "../src/modules/native-canary/native-execution-fence";
import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { NATIVE_RISK_CONTRACTS, type NativeRiskContract } from "../src/modules/native-canary/native-risk-contract";
import { NATIVE_RISK_REFUSAL_CODES, evaluateNativeRiskContract, judgeNativeRiskReadiness } from "../src/modules/native-canary/native-risk-gate";
import { ENTRY_REASON_CODES } from "../src/modules/execution/entry-lifecycle";
import {
  FRESH_NOW,
  RISK_CONTRACT_MODULE,
  SYNTHETIC_RESOLVED_A,
  TEMPLATE,
  cleanRecords,
  eligibleEvidence,
  favourableInput,
  planFor,
  readerOf,
  resolvedAContracts,
} from "./helpers/native-canary-fixtures";

/**
 * MILESTONE 5, PART A: the Native risk contract.
 *
 * Pure and structural only. The production contracts are UNRESOLVED for both
 * accounts and carry no amount; nothing (no environment, no env file, no
 * TradingView template, no planner window) can resolve them; the gate that
 * asks for them sits behind the hard switch at every Native boundary; and a
 * SYNTHETIC resolved contract, which exists only inside a test module graph,
 * is what proves the gate is live. The numbers in the test names are the
 * milestone's required risk tests.
 */

const BACKEND = path.resolve(__dirname, "..");
const SWITCH = "../src/modules/native-canary/native-execution-switch";
const LOCAL = "C:\\Users\\someone\\AppData\\Local";
const envFile = (alias: string) => path.join(LOCAL, "trading-alert-dashboard", "env", `${alias}.env`);

/** Everything a process environment could carry that LOOKS like it might size or approve risk. */
const TEMPTING_ENV: NodeJS.ProcessEnv = {
  NATIVE_RISK: "5",
  NATIVE_RISK_A: "5",
  NATIVE_RISK_B: "5",
  NATIVE_RISK_PER_TRADE_USD: "5",
  NATIVE_MAX_RISK_PER_TRADE_USD: "5",
  NATIVE_RISK_RESOLVED: "true",
  NATIVE_EXECUTION_ENABLED: "true",
  NATIVE_PLAN_DEFAULT_LOOKBACK_A: "100",
  NATIVE_PLAN_DEFAULT_LOOKBACK_B: "300",
  EXTREME_RR_LOOKBACK_CANDLES: "300",
  EXECUTION_MAX_TOTAL_PLANNED_RISK_USD: "100",
  RISK_AMOUNT: "300",
  REFERENCE_CAPITAL: "300",
  RISK_PERCENT: "100",
};

afterEach(() => {
  vi.doUnmock(SWITCH);
  vi.doUnmock(RISK_CONTRACT_MODULE);
  vi.resetModules();
});

// ===========================================================================
// 1-2. Production status
// ===========================================================================

describe("1-2. production Native risk is UNRESOLVED for both accounts, with no amount", () => {
  it("1. Account A is UNRESOLVED", () => {
    expect(NATIVE_RISK_CONTRACTS.A).toEqual({ state: "UNRESOLVED", account: "A", reason: "No Native risk amount has been approved for Account A." });
    expect(judgeNativeRiskReadiness("ACCOUNT_A", TEMPLATE.riskAmount)).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
  });

  it("2. Account B is UNRESOLVED", () => {
    expect(NATIVE_RISK_CONTRACTS.B).toEqual({ state: "UNRESOLVED", account: "B", reason: "No Native risk amount has been approved for Account B." });
    expect(judgeNativeRiskReadiness("ACCOUNT_B", TEMPLATE.riskAmount)).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
  });

  it("generic and unproven processes have no contract at all", () => {
    for (const slot of ["GENERIC", "UNKNOWN"] as const) {
      expect(judgeNativeRiskReadiness(slot, TEMPLATE.riskAmount), slot).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
    }
  });

  it("the table is frozen, holds exactly A and B, and carries no number of any kind", () => {
    expect(Object.isFrozen(NATIVE_RISK_CONTRACTS) && Object.isFrozen(NATIVE_RISK_CONTRACTS.A) && Object.isFrozen(NATIVE_RISK_CONTRACTS.B)).toBe(true);
    expect(Object.keys(NATIVE_RISK_CONTRACTS).sort()).toEqual(["A", "B"]);
    expect(JSON.stringify(NATIVE_RISK_CONTRACTS)).not.toMatch(/\d/);
    expect(JSON.stringify(NATIVE_RISK_CONTRACTS)).not.toContain("maxRiskPerTradeUsd");
  });

  it("whatever budget a trade carries, an UNRESOLVED contract refuses it, and it never becomes a different refusal", () => {
    for (const budget of [TEMPLATE.riskAmount, "0.01", "100", "300", "999999", "", "abc", null, undefined, 1.5]) {
      for (const slot of ["ACCOUNT_A", "ACCOUNT_B"] as const) {
        expect(judgeNativeRiskReadiness(slot, budget), `${slot} ${String(budget)}`).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
      }
    }
  });
});

// ===========================================================================
// The judgment itself, on synthetic contracts
// ===========================================================================

describe("the gate's judgment (synthetic contracts, never production ones)", () => {
  const capAt = (maxRiskPerTradeUsd: string): NativeRiskContract => ({ state: "RESOLVED", account: "A", maxRiskPerTradeUsd });

  it("a resolved contract admits a budget at or below its cap, and refuses one above it; it never resizes", () => {
    expect(evaluateNativeRiskContract(capAt("1.50"), "A", "1.50")).toEqual({ ready: true, account: "A", riskBudgetUsd: "1.50", maxRiskPerTradeUsd: "1.50" });
    expect(evaluateNativeRiskContract(capAt("1.50"), "A", "1.4999")).toMatchObject({ ready: true, riskBudgetUsd: "1.4999" });
    expect(evaluateNativeRiskContract(capAt("1.50"), "A", "1.5001")).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_EXCEEDS_CONTRACT" });
    // Decimal, not float, comparison.
    expect(evaluateNativeRiskContract(capAt("0.3"), "A", "0.30000000000000001")).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_EXCEEDS_CONTRACT" });
  });

  it("only an exact positive decimal budget can be compared", () => {
    for (const budget of ["0", "0.0", "-1", "1e3", "1E3", " 1.5", "1.5 ", "+1.5", "01.5", "1.", ".5", "1,5", "abc", "", "NaN", "Infinity", 1.5, null, undefined, {}]) {
      expect(evaluateNativeRiskContract(capAt("999999"), "A", budget), JSON.stringify(budget)).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_BUDGET_INVALID" });
    }
  });

  it("a contract that names no exact positive amount resolves nothing", () => {
    for (const amount of ["0", "-5", "5e2", "", " 5", "five"]) {
      expect(evaluateNativeRiskContract(capAt(amount), "A", "1.50"), amount).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
    }
  });

  it("a contract for the other account, or no account, resolves nothing", () => {
    expect(evaluateNativeRiskContract({ state: "RESOLVED", account: "B", maxRiskPerTradeUsd: "999999" }, "A", "1.50")).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
    expect(evaluateNativeRiskContract(SYNTHETIC_RESOLVED_A, null, "1.50")).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
    expect(evaluateNativeRiskContract(null, "A", "1.50")).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
    expect(evaluateNativeRiskContract({ state: "MAYBE", account: "A" } as never, "A", "1.50")).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
  });

  it("its refusal codes are in every vocabulary that can carry them", () => {
    for (const code of NATIVE_RISK_REFUSAL_CODES) {
      expect((NATIVE_CANARY_REASON_CODES as readonly string[]).includes(code), code).toBe(true);
      expect((ENTRY_REASON_CODES as readonly string[]).includes(code), code).toBe(true);
    }
  });
});

// ===========================================================================
// 3-8. Nothing outside the code-fixed table can resolve Native risk
// ===========================================================================

describe("3-8. nothing can resolve Native risk silently", () => {
  it("3/4. the planner windows are lookbacks: 100 and 300 resolve nothing and are not money", () => {
    expect(NATIVE_PLAN_BUILTIN_DEFAULTS).toEqual({ A: 100, B: 300 });
    expect(parseNativeAccountPlanPolicy("A", undefined)).toMatchObject({ state: "RESOLVED", lookback: 100, source: "BUILTIN_DEFAULT" });
    expect(parseNativeAccountPlanPolicy("B", undefined)).toMatchObject({ state: "RESOLVED", lookback: 300, source: "BUILTIN_DEFAULT" });
    // Handed to the gate as if they were a budget, they still resolve nothing.
    for (const lookback of [100, 300, "100", "300"]) {
      expect(judgeNativeRiskReadiness("ACCOUNT_A", lookback)).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
      expect(judgeNativeRiskReadiness("ACCOUNT_B", lookback)).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
    }
  });

  it("3/4. what the gate judges is the plan's frozen template budget, never the window: two plans that differ only in window are judged on the same budget", async () => {
    vi.resetModules();
    vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
    vi.doMock(RISK_CONTRACT_MODULE, () => ({ NATIVE_RISK_CONTRACTS: Object.freeze({ A: { state: "RESOLVED", account: "A", maxRiskPerTradeUsd: TEMPLATE.riskAmount }, B: NATIVE_RISK_CONTRACTS.B }) }));
    const mutated = await import("../src/modules/native-canary/native-account-a-canary");
    const input = favourableInput();
    // Cap == the template's risk amount: admitted, and the hand-off carries the window separately.
    const admitted = mutated.decideNativeAccountACandidate(input);
    if (!admitted.admitted) throw new Error(`expected admission, got ${admitted.reasonCode}`);
    expect(admitted.handoff.lookback).toBe(100);
    expect(admitted.handoff.template.riskAmount).toBe(TEMPLATE.riskAmount);
    // A budget one cent above the cap is refused by RISK, although the window (100) is far below any cap.
    const richer = { ...input, plan: planFor(input.alert, { template: { ...TEMPLATE, riskAmount: "1.51" } }) };
    expect(mutated.decideNativeAccountACandidate(richer)).toMatchObject({ admitted: false, stage: "RISK", reasonCode: "NATIVE_RISK_EXCEEDS_CONTRACT" });
  });

  it("5. no generic environment can resolve it: the gate reads no environment, so even a process full of tempting keys stays UNRESOLVED", async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, TEMPTING_ENV);
      vi.resetModules();
      const fresh = await import("../src/modules/native-canary/native-risk-gate");
      for (const slot of ["ACCOUNT_A", "ACCOUNT_B", "GENERIC", "UNKNOWN"] as const) {
        expect(fresh.judgeNativeRiskReadiness(slot, TEMPLATE.riskAmount), slot).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
      }
      const contracts = await import("../src/modules/native-canary/native-risk-contract");
      expect(contracts.NATIVE_RISK_CONTRACTS.A.state).toBe("UNRESOLVED");
      expect(contracts.NATIVE_RISK_CONTRACTS.B.state).toBe("UNRESOLVED");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("6/7. an account process (account-a.env / account-b.env) only proves WHICH account it is; its own variables cannot resolve that account's contract", () => {
    for (const [alias, slot] of [["account-a", "ACCOUNT_A"], ["account-b", "ACCOUNT_B"]] as const) {
      const processEnv: NodeJS.ProcessEnv = { ...TEMPTING_ENV, LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: envFile(alias) };
      expect(nativeAccountSlotOf(processEnv)).toBe(slot);
      const runtime = nativeFenceRuntimeFromEnv(processEnv);
      expect(runtime.accountSlot).toBe(slot);
      expect(Object.keys(runtime).sort()).toEqual(["accountSlot", "evidence"]);
      expect(judgeNativeRiskReadiness(runtime.accountSlot!, TEMPLATE.riskAmount), alias).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
    }
  });

  it("8. a TradingView risk template, however valid, is not a Native risk contract: a plan sized by one is still refused once the switch lets it through", async () => {
    vi.resetModules();
    vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
    const mutated = await import("../src/modules/native-canary/native-account-a-canary");
    for (const template of [TEMPLATE, { ...TEMPLATE, referenceCapital: "300", riskPercent: "1", riskAmount: "3.00" }, { ...TEMPLATE, referenceCapital: "100", riskPercent: "3", riskAmount: "3.00" }]) {
      const input = favourableInput();
      const decision = mutated.decideNativeAccountACandidate({ ...input, plan: planFor(input.alert, { template }) });
      expect(decision, JSON.stringify(template)).toMatchObject({ admitted: false, stage: "RISK", reasonCode: "NATIVE_RISK_UNRESOLVED" });
    }
  });
});

// ===========================================================================
// 12-14. The synthetic contract, Account B, and the switch
// ===========================================================================

describe("12-14. the gate is live, B stays shut, and the switch still wins", () => {
  it("12. a SYNTHETIC resolved contract passes the gate, without enabling production execution", async () => {
    expect(evaluateNativeRiskContract(SYNTHETIC_RESOLVED_A, "A", TEMPLATE.riskAmount)).toMatchObject({ ready: true });
    // A test graph whose ONLY change is the contract: the real switch is still false and still refuses.
    vi.resetModules();
    vi.doMock(RISK_CONTRACT_MODULE, resolvedAContracts);
    const graph = await import("../src/modules/native-canary/native-account-a-canary");
    const gate = await import("../src/modules/native-canary/native-risk-gate");
    expect(gate.judgeNativeRiskReadiness("ACCOUNT_A", TEMPLATE.riskAmount)).toMatchObject({ ready: true });
    expect(graph.decideNativeAccountACandidate(favourableInput())).toMatchObject({ admitted: false, stage: "NATIVE_FENCE", reasonCode: "NATIVE_EXECUTION_DISABLED" });
    // And the production modules never saw it.
    expect(NATIVE_EXECUTION_ENABLED).toBe(false);
    expect(judgeNativeRiskReadiness("ACCOUNT_A", TEMPLATE.riskAmount)).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
  });

  it("12b. with BOTH the switch and a synthetic contract mutated, the decision admits; with the switch alone it refuses at RISK", async () => {
    vi.resetModules();
    vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
    const switchOnly = await import("../src/modules/native-canary/native-account-a-canary");
    expect(switchOnly.decideNativeAccountACandidate(favourableInput())).toMatchObject({ admitted: false, stage: "RISK", reasonCode: "NATIVE_RISK_UNRESOLVED", integrity: "ELIGIBLE" });
    vi.resetModules();
    vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
    vi.doMock(RISK_CONTRACT_MODULE, resolvedAContracts);
    const both = await import("../src/modules/native-canary/native-account-a-canary");
    expect(both.decideNativeAccountACandidate(favourableInput())).toMatchObject({ admitted: true });
  });

  it("13. Account B is non-runnable: refused at ACCOUNT with every gate open, its contract stays UNRESOLVED even when A's is resolved, and its scheduler starts nothing", async () => {
    vi.resetModules();
    vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
    vi.doMock(RISK_CONTRACT_MODULE, resolvedAContracts);
    const graph = await import("../src/modules/native-canary/native-account-a-canary");
    const gate = await import("../src/modules/native-canary/native-risk-gate");
    expect(graph.decideNativeAccountACandidate(favourableInput({}, { accountSlot: "ACCOUNT_B" }))).toMatchObject({ admitted: false, stage: "ACCOUNT", reasonCode: "ACCOUNT_NOT_A" });
    expect(gate.judgeNativeRiskReadiness("ACCOUNT_B", TEMPLATE.riskAmount)).toMatchObject({ ready: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
    const { startNativeAccountAAdoptionScheduler } = await import("../src/modules/native-canary/native-account-a-adoption");
    const trap = new Proxy({}, { get: () => () => { throw new Error("reached"); } });
    const timer = await startNativeAccountAAdoptionScheduler({
      prisma: trap as never,
      boundProfile: { executionProfileId: "p" } as never,
      executor: trap as never,
      plans: trap as never,
      workerId: "w",
      processEnv: { LOCALAPPDATA: LOCAL, DOTENV_CONFIG_PATH: envFile("account-b") },
    });
    expect(timer).toBeNull();
  });

  it("14. the hard switch still wins while false: the real decision and both real fences refuse NATIVE_EXECUTION_DISABLED even with a resolved contract", async () => {
    expect(decideNativeAccountACandidate(favourableInput())).toMatchObject({ stage: "NATIVE_FENCE", reasonCode: "NATIVE_EXECUTION_DISABLED" });
    vi.resetModules();
    vi.doMock(RISK_CONTRACT_MODULE, resolvedAContracts);
    const fence = await import("../src/modules/native-canary/native-execution-fence");
    const input = favourableInput();
    const records = cleanRecords();
    const prisma = {
      alert: { findUnique: async () => ({ source: "NATIVE", symbol: input.alert.symbol, triggeredAt: input.alert.triggeredAt, rawPayload: input.alert.rawPayload }) },
      executionEvent: { findFirst: async () => ({ metadata: { alertSource: "NATIVE" } }) },
    };
    const runtime = { evidence: readerOf(eligibleEvidence(records)), accountSlot: "ACCOUNT_A" as const };
    expect(await fence.nativeAlertFence(prisma as never, input.alert.id, runtime, TEMPLATE.riskAmount)).toMatchObject({ admitted: false, reasonCode: "NATIVE_EXECUTION_DISABLED" });
    expect(await fence.nativeExecutionFence(prisma as never, { id: "e", alertId: input.alert.id, riskBudgetUsd: { toFixed: () => TEMPLATE.riskAmount } } as never, runtime)).toMatchObject({
      applies: true,
      admitted: false,
      reasonCode: "NATIVE_EXECUTION_DISABLED",
    });
  });

  it("14b. past the switch (test graph), both fences refuse an UNRESOLVED contract with the canonical code, before admitting anything", async () => {
    vi.resetModules();
    vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
    const fence = await import("../src/modules/native-canary/native-execution-fence");
    const input = favourableInput();
    const prisma = {
      alert: { findUnique: async () => ({ source: "NATIVE", symbol: input.alert.symbol, triggeredAt: input.alert.triggeredAt, rawPayload: input.alert.rawPayload }) },
      executionEvent: { findFirst: async () => ({ metadata: { alertSource: "NATIVE" } }) },
    };
    for (const accountSlot of ["ACCOUNT_A", "ACCOUNT_B", undefined] as const) {
      const runtime = { evidence: readerOf(eligibleEvidence(cleanRecords())), accountSlot };
      expect(await fence.nativeAlertFence(prisma as never, input.alert.id, runtime, TEMPLATE.riskAmount), String(accountSlot)).toMatchObject({ admitted: false, reasonCode: "NATIVE_RISK_UNRESOLVED", integrity: "ELIGIBLE" });
      expect(await fence.nativeExecutionFence(prisma as never, { id: "e", alertId: input.alert.id, riskBudgetUsd: { toFixed: () => TEMPLATE.riskAmount } } as never, runtime)).toMatchObject({
        admitted: false,
        reasonCode: "NATIVE_RISK_UNRESOLVED",
      });
    }
  });
});

// ===========================================================================
// 9-11 (pure half). The executor refuses before the signed planner
// ===========================================================================

describe("9-11 (executor). unresolved or excessive Native risk never reaches the signed margin planner", () => {
  async function graphWithHandoff(contracts: () => unknown) {
    vi.resetModules();
    vi.doMock(SWITCH, () => ({ NATIVE_EXECUTION_ENABLED: true }));
    vi.doMock(RISK_CONTRACT_MODULE, contracts);
    const canary = await import("../src/modules/native-canary/native-account-a-canary");
    const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");
    const input = favourableInput();
    const decision = canary.decideNativeAccountACandidate(input);
    if (!decision.admitted) throw new Error(`fixture: ${decision.reasonCode}`);
    return { SelectedPlanExecutor, handoff: decision.handoff, input };
  }

  it("9. the executor's fence refuses NATIVE_RISK_UNRESOLVED for an account with no resolved contract, and touches nothing signed, no creation, no admission", async () => {
    const { SelectedPlanExecutor, handoff, input } = await graphWithHandoff(resolvedAContracts);
    for (const accountSlot of ["ACCOUNT_B", "GENERIC", "UNKNOWN", undefined] as const) {
      const touched: string[] = [];
      const trap = (name: string) => new Proxy({}, { get: (_t, key) => (touched.push(`${name}.${String(key)}`), () => { throw new Error(`${name} reached`); }) });
      const prisma = { alert: { findUnique: async () => ({ source: "NATIVE", symbol: input.alert.symbol, triggeredAt: input.alert.triggeredAt, rawPayload: input.alert.rawPayload }) } };
      const executor = new SelectedPlanExecutor({
        prisma: prisma as never,
        marginPlanner: trap("marginPlanner") as never,
        executions: trap("executions") as never,
        orchestrator: trap("orchestrator") as never,
        boundProfile: { executionProfileId: "profile-account-a", exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" } as never,
        nativeFence: { evidence: readerOf(eligibleEvidence(cleanRecords())), accountSlot },
      });
      expect(await executor.handleNativeAccountACandidate(handoff, FRESH_NOW), String(accountSlot)).toMatchObject({ handled: false, reasonCode: "NATIVE_RISK_UNRESOLVED" });
      expect(touched, String(accountSlot)).toEqual([]);
    }
  });

  it("the margin planner, when reached, is handed the plan's own frozen template budget, never a window", async () => {
    const { SelectedPlanExecutor, handoff, input } = await graphWithHandoff(resolvedAContracts);
    const seen: unknown[] = [];
    const prisma = { alert: { findUnique: async () => ({ source: "NATIVE", symbol: input.alert.symbol, triggeredAt: input.alert.triggeredAt, rawPayload: input.alert.rawPayload }) } };
    const executor = new SelectedPlanExecutor({
      prisma: prisma as never,
      marginPlanner: { planForSymbolWithSnapshot: async (request: unknown) => (seen.push(request), { plan: { status: "BLOCKED", reason: "TEST_STOP", selectedLeverage: null }, exchangeFilters: null }) } as never,
      executions: {} as never,
      orchestrator: {} as never,
      boundProfile: { executionProfileId: "profile-account-a", exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" } as never,
      nativeFence: { evidence: readerOf(eligibleEvidence(cleanRecords())), accountSlot: "ACCOUNT_A" },
    });
    expect(await executor.handleNativeAccountACandidate(handoff, FRESH_NOW)).toMatchObject({ handled: false, reasonCode: "MARGIN_PLAN_NOT_READY" });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { riskBudgetUsd: string }).riskBudgetUsd).toBe(TEMPLATE.riskAmount);
    expect(String((seen[0] as { riskBudgetUsd: string }).riskBudgetUsd)).not.toMatch(/^(100|300)$/);
  });
});

// ===========================================================================
// 15 + section 18. Structure
// ===========================================================================

describe("15 + structural proofs: no Native money in code, and the gate is where it must be", () => {
  const productionCode = productionSources().map((rel) => ({ rel, code: codeOf(rel) }));

  it("15. no production source holds a Native risk amount: no amount property is ever assigned, the contract module holds no digit, and no Native risk environment key exists", () => {
    const contract = codeOf("src/modules/native-canary/native-risk-contract.ts");
    expect(contract).not.toMatch(/\d/);
    expect(contract).not.toMatch(/maxRiskPerTradeUsd\s*:\s*["'`\d]/);
    for (const { rel, code } of productionCode) {
      expect(`${rel}:${/maxRiskPerTradeUsd\s*:\s*["'`\d]/.test(code)}`).toBe(`${rel}:false`);
    }
    // The amount field is named in exactly two places: its type, and the gate that reads it.
    expect(productionCode.filter((f) => f.code.includes("maxRiskPerTradeUsd")).map((f) => f.rel).sort()).toEqual([
      "src/modules/native-canary/native-risk-contract.ts",
      "src/modules/native-canary/native-risk-gate.ts",
    ]);
    // The only RESOLVED a production contract source mentions is the type's own variant.
    expect(contract.match(/"RESOLVED"/g)).toHaveLength(1);
    expect(contract).toMatch(/readonly state: "RESOLVED";/);
    const envSource = codeOf("src/config/env.ts");
    expect(envSource).not.toMatch(/NATIVE[A-Z_]*RISK|RISK[A-Z_]*NATIVE/);
  });

  it("only the Native canary modules know Native risk readiness exists; the gate is called only by the decision and the fence", () => {
    const importers = (needle: string) => productionCode.filter((f) => f.code.includes(needle)).map((f) => f.rel).sort();
    expect(importers("native-risk-contract")).toEqual(["src/modules/native-canary/native-risk-gate.ts"]);
    expect(importers("native-risk-gate")).toEqual(["src/modules/native-canary/native-account-a-canary.ts", "src/modules/native-canary/native-execution-fence.ts"]);
    expect(importers("judgeNativeRiskReadiness(")).toEqual([
      "src/modules/native-canary/native-account-a-canary.ts",
      "src/modules/native-canary/native-execution-fence.ts",
      "src/modules/native-canary/native-risk-gate.ts",
    ]);
    expect(importers("evaluateNativeRiskContract(")).toEqual(["src/modules/native-canary/native-risk-gate.ts"]);
    expect(importers("NATIVE_RISK_CONTRACTS")).toEqual(["src/modules/native-canary/native-risk-contract.ts", "src/modules/native-canary/native-risk-gate.ts"]);
  });

  it("no environment, file or configuration value reaches a Native risk contract", () => {
    for (const rel of ["src/modules/native-canary/native-risk-contract.ts", "src/modules/native-canary/native-risk-gate.ts"]) {
      const code = codeOf(rel);
      expect(code, rel).not.toMatch(/process\.env|\benv\b|config\/env|dotenv|readFileSync|existsSync|prisma\.|fetch\(|Date\.now|new Date\(/);
      const imports = [...code.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]).sort();
      expect(imports, rel).toEqual(rel.endsWith("native-risk-contract.ts") ? [] : ["./native-account-a-canary", "./native-risk-contract", "@prisma/client"]);
    }
  });

  it("planner lookback constants cannot flow into risk sizing: neither the gate nor any sizing or admission module names a window", () => {
    const LOOKBACK = /[Ll]ookback|requestedCandles|NATIVE_PLAN_BUILTIN_DEFAULTS|EXTREME_RR_LOOKBACK/;
    for (const rel of [
      "src/modules/native-canary/native-risk-contract.ts",
      "src/modules/native-canary/native-risk-gate.ts",
      "src/modules/binance/binance-margin-plan.service.ts",
      "src/modules/execution/safety-engine.ts",
      "src/modules/execution/safety-admission.service.ts",
      "src/modules/execution/entry-lifecycle.ts",
      "src/modules/execution/entry-lifecycle.service.ts",
      "src/modules/risk-template/risk-template.service.ts",
    ]) {
      expect(`${rel}:${LOOKBACK.test(codeOf(rel))}`).toBe(`${rel}:false`);
    }
    const engine = readFileSync(path.resolve(BACKEND, "../../packages/shared/src/binance-margin-engine.ts"), "utf8");
    expect(LOOKBACK.test(engine)).toBe(false);
    // The executor sizes a Native trade from the hand-off's frozen template amount, and from nothing else.
    const executor = codeOf("src/modules/execution/selected-plan-executor.ts");
    const native = executor.slice(executor.indexOf("async handleNativeAccountACandidate("));
    expect([...native.matchAll(/riskBudgetUsd: ([^,\n]+)/g)].map((m) => m[1].trim())).toEqual(["handoff.template.riskAmount"]);
    expect(native).toContain("nativeAlertFence(this.deps.prisma, handoff.alertId, this.deps.nativeFence ?? nativeFenceRuntimeFromEnv(), handoff.template.riskAmount)");
  });

  it("no new private path exists before risk resolution: the decision issues a hand-off only after RISK, and the fence admits only after the risk gate", () => {
    const canary = codeOf("src/modules/native-canary/native-account-a-canary.ts");
    // The judgment: the switch, then RISK; only an admitted judgment reaches the hand-off.
    const judgment = canary.slice(canary.indexOf("export function judgeNativeAccountACandidate("));
    const order = [
      "nativeFenceStage(input.integrity)",
      "nativeRiskStage(input.accountSlot, evaluated.candidate.template.riskAmount)",
      "if (!risk.ok) return risk.refusal;",
      "if (!judgment.admitted) return judgment;",
      "issueHandoff(judgment.candidate)",
    ].map((n) => judgment.indexOf(n));
    expect(order.every((p) => p > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // And the RISK stage is the risk gate, refusing on anything it does not admit.
    const riskStage = canary.slice(canary.indexOf("export function nativeRiskStage("), canary.indexOf("export function evaluateNativeAccountACandidate("));
    expect(riskStage.indexOf("judgeNativeRiskReadiness(accountSlot, riskBudgetUsd)")).toBeGreaterThan(-1);
    expect(riskStage.indexOf('if (!risk.ready) return refusal("RISK"')).toBeGreaterThan(riskStage.indexOf("judgeNativeRiskReadiness("));
    const fence = codeOf("src/modules/native-canary/native-execution-fence.ts");
    const judge = fence.slice(fence.indexOf("function judgeNativeAlert("), fence.indexOf("export async function nativeAlertFence("));
    const steps = ["judgeNativeExecutionAdmission(", "if (!admission.admitted) {", "judgeNativeRiskReadiness(runtime.accountSlot ?? \"UNKNOWN\", riskBudgetUsd)", "if (!risk.ready) return refuse(", "return { applies: true, admitted: true };"].map((n) => judge.indexOf(n));
    expect(steps.every((p) => p > -1)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // The only "admitted" outcome of a Native alert judgment is that last line.
    expect(judge.match(/admitted: true/g)).toHaveLength(1);
  });

  it("no env switch enables Native execution, and no UI or HTTP control was added for risk", () => {
    expect(codeOf("src/modules/native-canary/native-execution-switch.ts")).toMatch(/^\s*export const NATIVE_EXECUTION_ENABLED = false as const;\s*$/);
    for (const { rel, code } of productionCode) {
      // Code only: messages legitimately QUOTE "(NATIVE_EXECUTION_ENABLED = false)".
      const bare = withoutStrings(code);
      expect(`${rel}:${/\bNATIVE_EXECUTION_ENABLED\s*=(?!=)/.test(bare) && rel !== "src/modules/native-canary/native-execution-switch.ts"}`).toBe(`${rel}:false`);
      expect(`${rel}:${/process\.env\.NATIVE_EXECUTION|env\.NATIVE_EXECUTION|\[["'`]NATIVE_EXECUTION/.test(code)}`).toBe(`${rel}:false`);
    }
    const app = readFileSync(path.join(BACKEND, "src/app.ts"), "utf8");
    expect(app).not.toMatch(/native-risk|native-canary/);
    const routes = productionSources(path.join(BACKEND, "src/routes")).map((rel) => codeOf(rel)).join("\n");
    expect(routes).not.toMatch(/native-risk|NativeRisk|NATIVE_RISK/);
    const frontend = readdirRecursive(path.resolve(BACKEND, "../frontend/src")).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(frontend).not.toMatch(/NATIVE_RISK|nativeRisk|NativeRisk|maxRiskPerTradeUsd/);
  });
});

// ---------------------------------------------------------------------------

function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function productionSources(dir = path.join(BACKEND, "src")): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

function withoutStrings(code: string): string {
  return code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

function readdirRecursive(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return readdirRecursive(full);
    return /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

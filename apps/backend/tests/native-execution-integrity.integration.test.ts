import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Alert, PrismaClient } from "@prisma/client";
import { NATIVE_PLAN_EXECUTION_STATUS } from "@trading-alert-dashboard/shared";

import { connectTestDatabase } from "./helpers/test-database";
import type { SnapshotCandle } from "../src/modules/market-data/market-data.types";
import { buildNativeAlertDraftV2 } from "../src/modules/native-alerts/native-alert-draft";
import { selectNativeDeliveriesV2 } from "../src/modules/native-alerts/native-delivery-policy-v2";
import { fileSystemNativeScannerEvidence } from "../src/modules/native-integrity/native-execution-integrity";
import { parseShadowEventLog } from "../src/modules/native-alerts/shadow-log-reader";
import { LIVE_CHECKPOINT_SCHEMA, LiveCheckpointStore } from "../src/modules/native-scanner/live-shadow-checkpoint";
import type { ShadowClassification, ShadowRecord } from "../src/modules/native-scanner/live-shadow-store";
import { TEDDY_7_ALL_ACTIVE_V1, engineFingerprintOf, liveShadowEngineDir, profileSummaryOf } from "../src/modules/native-scanner/scanner-profile";
import { makeRunId } from "../src/modules/native-scanner/supervisor-run-manifest";
import { M15, bar, commit, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * 11-13, 19-20: the execution-integrity line in the Native plan read model.
 * Real V2 Native alert payloads, a real READY plan, scanner evidence in a TEMP
 * %LOCALAPPDATA% tree. TEST database only; fixture candles; no Binance request.
 * A blocked verdict leaves the alert and its READY plan exactly as they were
 * and creates no adoption, execution or order row.
 */

const queue = vi.hoisted(() => ({ enqueueVisionAnalysis: vi.fn(async () => undefined), enqueueExtremeRRPlan: vi.fn(async () => undefined) }));
vi.mock("../src/modules/jobs/queue", () => queue);

const TAG = "native-integrity-it";
const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { ExtremeRRService, NATIVE_PLAN_LIST_LIMIT } = await import("../src/modules/extreme-rr/extreme-rr.service");
const { resolveNativeAccountPlanPolicies } = await import("../src/modules/native-planning/native-account-plan-policy");

const PROFILE = TEDDY_7_ALL_ACTIVE_V1;
const FINGERPRINT = engineFingerprintOf(PROFILE);
const LINEAGE = "c".repeat(64);
const SWITCHOVER = bar(-100);

/** Candles around the alert's own entry price, with one clear extreme above it. */
function candles(trigger: Date, entry: number): SnapshotCandle[] {
  const lastOpen = Math.floor(trigger.getTime() / M15) * M15 - M15;
  const rows: SnapshotCandle[] = [];
  for (let i = 319; i >= 0; i -= 1) {
    const openTimeMs = lastOpen - i * M15;
    rows.push({ openTimeMs, closeTimeMs: openTimeMs + M15 - 1, high: (entry * (i === 40 ? 1.3 : 1.02)).toFixed(6), low: (entry * 0.98).toFixed(6) });
  }
  return rows;
}
const TEMPLATE = { id: "tpl-native-integrity", name: "native integrity", referenceCapital: "400", riskPercent: "1", rewardRatio: "1.5", isActive: true, createdAt: new Date(), updatedAt: new Date() };
const db = new Proxy(prisma, { get: (target, key) => (key === "riskTemplate" ? { findFirst: async () => TEMPLATE } : Reflect.get(target, key)) }) as PrismaClient;
const planner = () => new ExtremeRRService(db, async (a: Alert) => candles(a.triggeredAt, Number(a.price)), async () => 100 as const);

const roots: string[] = [];
let seq = 0;

/** One Native alert on bar(1), written from the real V2 draft, plus a temp scanner tree whose bar(1) closes as `finalClass`. */
async function scenario(finalClass: ShadowClassification | "OPEN") {
  const symbol = `NINTEG${++seq}${Date.now() % 100000}USDT`;
  const obs = observation({ symbol, lineageId: LINEAGE, sourceTf: "1W", barMs: bar(1) });
  const records: ShadowRecord[] = [commit(bar(0), "QUARANTINED_CURRENT_BAR", LINEAGE, symbol), obs, ...(finalClass === "OPEN" ? [] : [commit(bar(1), finalClass, LINEAGE, symbol)])];
  const parsed = parseShadowEventLog(logOf(records), { lineageId: LINEAGE, marketType: "USDM_PERPETUAL", symbol, chartInterval: "15m" });
  const decision = selectNativeDeliveriesV2(parsed, PROFILE.delivery).flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []))[0];
  const draft = buildNativeAlertDraftV2(decision, { profile: profileSummaryOf(PROFILE), runId: makeRunId(Date.UTC(2026, 9, 1, 11, 0), "1a2b3c4d") });
  const alert = await prisma.alert.create({
    data: {
      symbol: draft.symbol, assetType: draft.assetType, exchange: draft.exchange, timeframe: draft.timeframe, price: draft.price, signal: draft.signal,
      indicatorName: TAG, source: draft.source, sourceTimeframe: draft.sourceTimeframe, eventType: draft.eventType, levelColor: draft.levelColor,
      touchDirection: draft.touchDirection, triggeredAt: draft.triggeredAt, rawPayload: draft.rawPayload as never,
    },
  });

  const local = mkdtempSync(path.join(tmpdir(), "native-integrity-it-"));
  roots.push(local);
  const dir = liveShadowEngineDir(path.join(local, "trading-alert-dashboard", "scanner"), FINGERPRINT, "USDM_PERPETUAL", symbol, "15m");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "events.jsonl"), logOf(records));
  const hwm = finalClass === "OPEN" ? bar(1) : bar(2);
  new LiveCheckpointStore(dir).save(
    {
      schema: LIVE_CHECKPOINT_SCHEMA, lineageId: LINEAGE, marketType: "USDM_PERPETUAL", symbol, chartInterval: "15m", compatibilitySwitchoverMs: SWITCHOVER,
      stateSha256AtSwitchover: "e".repeat(64), hwmOpenTimeMs: hwm, lastCommittedBarOpenTimeMs: hwm - M15, causalBarCount: (hwm - SWITCHOVER) / M15,
      causalInputSha256ThroughHwm: "b".repeat(64), stateSha256: "a".repeat(64),
    },
    "2026-10-01T12:31:00.000Z"
  );
  return { alert, reader: fileSystemNativeScannerEvidence({ LOCALAPPDATA: local }) };
}

const planRow = (alertId: string) => prisma.extremeRRPlan.findUniqueOrThrow({ where: { alertId } });
const alertRow = (id: string) => prisma.alert.findUniqueOrThrow({ where: { id } });

async function cleanup() {
  if (!available) return;
  await prisma.alert.deleteMany({ where: { OR: [{ symbol: { startsWith: "NINTEG" } }, { indicatorName: TAG }] } });
}
beforeAll(cleanup);
afterAll(async () => {
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
  await cleanup();
  if (available) await prisma.$disconnect();
});

describe("11-13, 19-20. the Native plan list shows execution integrity, read-only", () => {
  maybe()("ELIGIBLE / PENDING / RE-QUARANTINED side by side: each READY plan and its alert stay exactly as they were", async () => {
    const cases = [
      ["SHADOW_LIVE_ONLY", "ELIGIBLE"],
      ["OPEN", "PENDING_BAR_CLOSE"],
      ["QUARANTINED_CURRENT_BAR", "INELIGIBLE_REQUARANTINED"],
      ["REPLAYED_NON_ACTIONABLE", "INELIGIBLE_REQUARANTINED"],
    ] as const;
    const service = planner();
    for (const [finalClass, expected] of cases) {
      const { alert, reader } = await scenario(finalClass);
      await service.generateForAlert(alert.id);
      const planBefore = await planRow(alert.id);
      const alertBefore = await alertRow(alert.id);
      expect([planBefore.status, planBefore.executionFanoutReadyAt]).toEqual(["READY", null]);

      const list = await service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max, resolveNativeAccountPlanPolicies({}), reader);
      const item = list.items.find((i) => i.alertId === alert.id)!;
      expect(item.executionIntegrity.status, finalClass).toBe(expected);
      expect(item.executionIntegrity.barOpenTime).toBe(new Date(bar(1)).toISOString());
      // 11/12: the blocked (or pending) alert is still listed with its READY plan; planning stays PLANNING ONLY.
      expect(item.plan.planStatus).toBe("READY");
      expect(item.plan.execution).toBe(NATIVE_PLAN_EXECUTION_STATUS);
      expect(list.nativeExecutionEnabled).toBe(false);

      // 13/19/20: nothing was written: same rows, no adoption, no execution, no outcome, fan-out marker null.
      expect(await planRow(alert.id)).toEqual(planBefore);
      expect(await alertRow(alert.id)).toEqual(alertBefore);
      expect(await prisma.selectedPlanAdoption.count({ where: { extremeRRPlanId: planBefore.id } })).toBe(0);
      expect(await prisma.tradeExecution.count({ where: { alertId: alert.id } })).toBe(0);
      expect(await prisma.selectedPlanOutcome.count({ where: { alertId: alert.id } })).toBe(0);
    }
  });

  maybe()("no evidence reader (the default) is UNREADABLE for every item -- never eligible", async () => {
    const { alert } = await scenario("SHADOW_LIVE_ONLY");
    const service = planner();
    await service.generateForAlert(alert.id);
    const item = (await service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max, resolveNativeAccountPlanPolicies({}))).items.find((i) => i.alertId === alert.id)!;
    expect(item.executionIntegrity.status).toBe("UNREADABLE");
  });

  maybe()("15. a TradingView plan is not in the Native list and its own plan read carries no integrity verdict", async () => {
    const tv = await prisma.alert.create({ data: { symbol: `NINTEGTV${Date.now() % 100000}USDT`, assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 100, signal: "LONG", indicatorName: TAG, rawPayload: { note: TAG }, triggeredAt: new Date(bar(1) + 61_234) } });
    const service = planner();
    await service.generateForAlert(tv.id);
    const list = await service.listNativePlans(NATIVE_PLAN_LIST_LIMIT.max, resolveNativeAccountPlanPolicies({}), () => {
      throw new Error("the reader must never be asked about a TradingView alert");
    });
    expect(list.items.some((i) => i.alertId === tv.id)).toBe(false);
    const plan = await service.getForAlert(tv.id);
    expect(plan).not.toBeNull();
    expect(JSON.stringify(plan)).not.toMatch(/executionIntegrity|PENDING_BAR_CLOSE|INELIGIBLE_/);
  });

  it("the HTTP route hands the list the read-only file-system reader built from the process environment", () => {
    const route = readFileSync(path.resolve(__dirname, "../src/routes/extreme-rr.routes.ts"), "utf8");
    expect(route).toContain("const integrityEvidence = fileSystemNativeScannerEvidence(process.env);");
    expect(route).toContain("service.listNativePlans(raw === undefined ? NATIVE_PLAN_LIST_LIMIT.default : Number(raw), undefined, integrityEvidence)");
  });
});

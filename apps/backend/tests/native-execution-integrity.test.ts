import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NATIVE_EXECUTION_INTEGRITY_STATUSES, type NativeExecutionIntegrityDto } from "@trading-alert-dashboard/shared";

import { NATIVE_ALERT_PAYLOAD_SCHEMA, buildNativeAlertDraftV2 } from "../src/modules/native-alerts/native-alert-draft";
import { selectNativeDeliveriesV2 } from "../src/modules/native-alerts/native-delivery-policy-v2";
import {
  evaluateNativeExecutionIntegrity,
  fileSystemNativeScannerEvidence,
  judgeNativeExecutionAdmission,
  nativeExecutionIntegrityOf,
  nativeExecutionProvenanceOf,
  type NativeIntegrityAlert,
  type NativeScannerEvidence,
} from "../src/modules/native-integrity/native-execution-integrity";
import { parseShadowEventLog } from "../src/modules/native-alerts/shadow-log-reader";
import { canonicalSha256 } from "../src/modules/native-scanner/canonical-json";
import { LIVE_CHECKPOINT_SCHEMA, LiveCheckpointStore, type LiveCheckpointBody, type LiveCheckpointFile } from "../src/modules/native-scanner/live-shadow-checkpoint";
import type { ShadowClassification, ShadowRecord } from "../src/modules/native-scanner/live-shadow-store";
import { TEDDY_7_ALL_ACTIVE_V1, engineFingerprintOf, liveShadowEngineDir, profileSummaryOf } from "../src/modules/native-scanner/scanner-profile";
import { makeRunId } from "../src/modules/native-scanner/supervisor-run-manifest";
import { M15, bar, commit as fixtureCommit, lineOf, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * NATIVE EXECUTION DATA INTEGRITY: the evaluator, its read-only evidence
 * loader and the unwired future admission guard. Pure and temp-dir only: no
 * database, no real scanner directory, no network.
 */

const BACKEND = path.resolve(__dirname, "..");
const PROFILE = TEDDY_7_ALL_ACTIVE_V1;
const FINGERPRINT = engineFingerprintOf(PROFILE);
const LINEAGE = "c".repeat(64);
const OTHER_LINEAGE = "d".repeat(64);
const SYMBOL = "GRIFFAINUSDT";
const RUN_ID = makeRunId(Date.UTC(2026, 9, 5, 7, 40), "1a2b3c4d");
const SWITCHOVER = bar(-100);
const STATE = "a".repeat(64); // the fixture commits' state hash
const CAUSAL = "b".repeat(64); // the fixture commits' causal-input hash

const obs = (barMs: number, extra: Parameters<typeof observation>[0] = {}) => observation({ symbol: SYMBOL, lineageId: LINEAGE, sourceTf: "1W", barMs, ...extra });
const commit = (barMs: number, classification: ShadowClassification = "SHADOW_LIVE_ONLY", lineageId = LINEAGE) => fixtureCommit(barMs, classification, lineageId, SYMBOL);

/** The Alert row the real V2 pipeline writes for one live observation (rawPayload exactly as delivered). */
function alertFor(records: readonly ShadowRecord[], observationIndex: number): NativeIntegrityAlert & { id: string } {
  const parsed = parseShadowEventLog(logOf(records), { lineageId: records[observationIndex].lineageId, marketType: "USDM_PERPETUAL", symbol: SYMBOL, chartInterval: "15m" });
  const target = parsed[observationIndex];
  const selections = selectNativeDeliveriesV2(parsed, PROFILE.delivery);
  const decision = selections.flatMap((s) => (s.kind === "DELIVER" && s.decision.winner.eventId === target.eventId ? [s.decision] : []))[0];
  if (decision === undefined) throw new Error("fixture: the observation was not delivered");
  const draft = buildNativeAlertDraftV2(decision, { profile: profileSummaryOf(PROFILE), runId: RUN_ID });
  return { id: `alert-${target.eventId.slice(0, 8)}`, source: draft.source, symbol: draft.symbol, rawPayload: draft.rawPayload };
}

function checkpointBody(hwmOpenTimeMs: number, over: Partial<LiveCheckpointBody> = {}): LiveCheckpointBody {
  return {
    schema: LIVE_CHECKPOINT_SCHEMA,
    lineageId: LINEAGE,
    marketType: "USDM_PERPETUAL",
    symbol: SYMBOL,
    chartInterval: "15m",
    compatibilitySwitchoverMs: SWITCHOVER,
    stateSha256AtSwitchover: "e".repeat(64),
    hwmOpenTimeMs,
    lastCommittedBarOpenTimeMs: hwmOpenTimeMs - M15,
    causalBarCount: (hwmOpenTimeMs - SWITCHOVER) / M15,
    causalInputSha256ThroughHwm: CAUSAL,
    stateSha256: STATE,
    ...over,
  };
}
const checkpointFile = (body: LiveCheckpointBody): LiveCheckpointFile => ({ body, bodySha256: canonicalSha256(body), writtenAt: "2026-10-05T12:00:00.000Z" });

function evidence(records: readonly ShadowRecord[] | string | null, hwm: number | null, over: Partial<NativeScannerEvidence> = {}): NativeScannerEvidence {
  return {
    currentEngineFingerprint: FINGERPRINT,
    eventLogText: records === null ? null : typeof records === "string" ? records : logOf(records),
    checkpoint: hwm === null ? null : checkpointFile(checkpointBody(hwm)),
    ...over,
  };
}

const B = bar(1);
/** The clean shape: readiness bar quarantined, B observed live and committed live. */
const clean = (): ShadowRecord[] => [commit(bar(0), "QUARANTINED_CURRENT_BAR"), obs(B), commit(B)];
const statusOf = (alert: NativeIntegrityAlert, ev: NativeScannerEvidence) => evaluateNativeExecutionIntegrity(alert, ev).status;

// ===========================================================================
// 1-9. The rule
// ===========================================================================

describe("Native execution integrity: the source 15m bar's FINAL scanner evidence", () => {
  it("1. the source bar is still forming (observed, checkpoint at B, no commit) -> PENDING_BAR_CLOSE, never eligible", () => {
    const records: ShadowRecord[] = [commit(bar(0), "QUARANTINED_CURRENT_BAR"), obs(B)];
    const verdict = evaluateNativeExecutionIntegrity(alertFor(records, 1), evidence(records, B));
    expect(verdict).toEqual({ status: "PENDING_BAR_CLOSE", reason: expect.any(String), barOpenTime: new Date(B).toISOString() });
    expect(judgeNativeExecutionAdmission({ nativeExecutionEnabled: true, integrity: verdict }).admitted).toBe(false);
  });

  it("2. the source bar closes cleanly (one live commit, contiguous, checkpoint agrees) -> ELIGIBLE", () => {
    const records = clean();
    expect(statusOf(alertFor(records, 1), evidence(records, bar(2)))).toBe("ELIGIBLE");
    // Later live bars and a checkpoint that has moved on do not change it.
    const later = [...records, commit(bar(2)), commit(bar(3))];
    expect(statusOf(alertFor(later, 1), evidence(later, bar(4)))).toBe("ELIGIBLE");
    // A checkpoint ahead of the newest commit (a silent restart catch-up) cannot be compared, and does not unprove B.
    expect(statusOf(alertFor(later, 1), evidence(later, bar(9)))).toBe("ELIGIBLE");
  });

  it("3. observed live, then the SAME bar re-quarantined (backpressure/detach/reconnect) or replayed -> INELIGIBLE_REQUARANTINED", () => {
    for (const classification of ["QUARANTINED_CURRENT_BAR", "REPLAYED_NON_ACTIONABLE"] as const) {
      const records: ShadowRecord[] = [commit(bar(0)), obs(B), commit(B, classification)];
      expect(statusOf(alertFor(records, 1), evidence(records, bar(2))), classification).toBe("INELIGIBLE_REQUARANTINED");
    }
  });

  it("4. a real hole before the source bar (no commit for B - 1 bar) -> INELIGIBLE_GAP", () => {
    const records: ShadowRecord[] = [commit(bar(-1), "QUARANTINED_CURRENT_BAR"), obs(B), commit(B)];
    expect(statusOf(alertFor(records, 1), evidence(records, bar(2)))).toBe("INELIGIBLE_GAP");
    // Nothing at all before B is a hole too: B's predecessor is unproven.
    const alone: ShadowRecord[] = [obs(B), commit(B)];
    expect(statusOf(alertFor(alone, 0), evidence(alone, bar(2)))).toBe("INELIGIBLE_GAP");
  });

  it("5. duplicate closed-bar identity (exact or conflicting repeat of a commit) -> INELIGIBLE_DUPLICATE", () => {
    const records = clean();
    const alert = alertFor(records, 1);
    const exact = logOf(records) + lineOf(commit(B));
    expect(statusOf(alert, evidence(exact, bar(2)))).toBe("INELIGIBLE_DUPLICATE");
    const conflicting = logOf(records) + lineOf({ ...commit(B), finalBar: { open: 1, high: 2, low: 0.5, close: 1.5 } });
    expect(statusOf(alert, evidence(conflicting, bar(2)))).toBe("INELIGIBLE_DUPLICATE");
  });

  it("6. checkpoint ambiguity -> INELIGIBLE_CHECKPOINT_MISMATCH", () => {
    const records = clean();
    const alert = alertFor(records, 1);
    // Sits exactly at the newest commit but disagrees with its hashes.
    expect(statusOf(alert, evidence(records, null, { checkpoint: checkpointFile(checkpointBody(bar(2), { stateSha256: "f".repeat(64) })) }))).toBe("INELIGIBLE_CHECKPOINT_MISMATCH");
    expect(statusOf(alert, evidence(records, null, { checkpoint: checkpointFile(checkpointBody(bar(2), { causalInputSha256ThroughHwm: "f".repeat(64) })) }))).toBe("INELIGIBLE_CHECKPOINT_MISMATCH");
    // Behind a durable commit (rewound / restored): behind B's own commit, or behind a later one.
    expect(statusOf(alert, evidence(records, B))).toBe("INELIGIBLE_CHECKPOINT_MISMATCH");
    const later = [...records, commit(bar(2)), commit(bar(3))];
    expect(statusOf(alertFor(later, 1), evidence(later, bar(3)))).toBe("INELIGIBLE_CHECKPOINT_MISMATCH");
    // Behind the alert's own observed bar.
    expect(statusOf(alertFor([obs(B)], 0), evidence([obs(B)], bar(0)))).toBe("INELIGIBLE_CHECKPOINT_MISMATCH");
    // Present but unverifiable (torn, edited, hash mismatch).
    expect(statusOf(alert, evidence(records, null, { checkpoint: { unverifiable: "checkpoint body does not match its hash" } }))).toBe("INELIGIBLE_CHECKPOINT_MISMATCH");
    // For another symbol.
    expect(statusOf(alert, evidence(records, null, { checkpoint: checkpointFile(checkpointBody(bar(2), { symbol: "OTHERUSDT" })) }))).toBe("INELIGIBLE_CHECKPOINT_MISMATCH");
  });

  it("7. stale generation / detached lineage -> INELIGIBLE_STALE_GENERATION", () => {
    const records = clean();
    const alert = alertFor(records, 1);
    expect(statusOf(alert, evidence(records, bar(2), { currentEngineFingerprint: "9".repeat(64) }))).toBe("INELIGIBLE_STALE_GENERATION");
    expect(statusOf(alert, evidence(records, bar(2), { currentEngineFingerprint: null }))).toBe("INELIGIBLE_STALE_GENERATION");
    expect(statusOf(alert, evidence(records, null, { checkpoint: checkpointFile(checkpointBody(bar(2), { lineageId: OTHER_LINEAGE })) }))).toBe("INELIGIBLE_STALE_GENERATION");
    // The log now holds another lineage's records.
    expect(statusOf(alert, evidence(logOf(records) + lineOf(commit(bar(2), "SHADOW_LIVE_ONLY", OTHER_LINEAGE)), bar(2)))).toBe("INELIGIBLE_STALE_GENERATION");
  });

  it("8. missing or unreadable scanner evidence -> UNREADABLE (never eligible)", () => {
    const records = clean();
    const alert = alertFor(records, 1);
    expect(statusOf(alert, evidence(null, bar(2)))).toBe("UNREADABLE"); // no event log
    expect(statusOf(alert, evidence(records, null))).toBe("UNREADABLE"); // no checkpoint
    expect(statusOf(alert, evidence([commit(bar(0)), commit(B)], bar(2)))).toBe("UNREADABLE"); // the alert's observation is not in the log
    expect(statusOf(alert, evidence(`${logOf(records)}{"torn"\n`, bar(2)))).toBe("UNREADABLE"); // strict validation fails
    expect(statusOf(alert, evidence(`${logOf(records)}\n`, bar(2)))).toBe("UNREADABLE"); // empty line
    // Moved past B without any durable commit for it (a silent restart catch-up, or a commit lost after its checkpoint).
    const noCommit: ShadowRecord[] = [commit(bar(0)), obs(B)];
    expect(statusOf(alertFor(noCommit, 1), evidence(noCommit, bar(3)))).toBe("UNREADABLE");
    // No reader at all.
    expect(nativeExecutionIntegrityOf(alert, null).status).toBe("UNREADABLE");
    // A reader that throws.
    expect(nativeExecutionIntegrityOf(alert, () => { throw new Error("disk gone"); }).status).toBe("UNREADABLE");
  });

  it("8b. a trailing PARTIAL line (the scanner mid-append) is not evidence yet: B is judged without it", () => {
    const records: ShadowRecord[] = [commit(bar(0)), obs(B)];
    const partialCommit = lineOf(commit(B)).slice(0, 40);
    // The commit is not complete, so B is still pending; it is never read as committed.
    expect(statusOf(alertFor(records, 1), evidence(logOf(records) + partialCommit, B))).toBe("PENDING_BAR_CLOSE");
  });

  it("9. old or partial provenance is never guessed eligible -> UNREADABLE", () => {
    const records = clean();
    const good = alertFor(records, 1);
    const payload = good.rawPayload as Record<string, any>;
    const ev = evidence(records, bar(2));
    const variants: Record<string, unknown> = {
      v1Schema: { ...payload, schema: NATIVE_ALERT_PAYLOAD_SCHEMA },
      noProfile: { ...payload, profile: undefined },
      noDelivery: { ...payload, delivery: undefined },
      noLineage: { ...payload, delivery: { ...payload.delivery, lineageId: undefined } },
      noBar: { ...payload, delivery: { ...payload.delivery, barStart: undefined } },
      barDisagrees: { ...payload, barTime: new Date(bar(2)).toISOString() },
      offBoundary: { ...payload, barTime: new Date(B + 60_000).toISOString(), delivery: { ...payload.delivery, barStart: new Date(B + 60_000).toISOString() } },
      tamperedEventId: { ...payload, delivery: { ...payload.delivery, shadowEventId: "0".repeat(64) } },
      otherLevel: { ...payload, delivery: { ...payload.delivery, levelKey: "1W:GOR:1" } },
      otherInterval: { ...payload, timeframe: "5m" },
      noFingerprint: { ...payload, profile: { ...payload.profile, engineFingerprint: "x" } },
      notAnObject: "LONG GRIFFAINUSDT",
      nothing: null,
    };
    for (const [name, rawPayload] of Object.entries(variants)) {
      const verdict = evaluateNativeExecutionIntegrity({ ...good, rawPayload }, ev);
      expect(verdict.status, name).toBe("UNREADABLE");
      expect(nativeExecutionProvenanceOf({ ...good, rawPayload }).ok, name).toBe(false);
    }
    // A payload whose symbol is not the row's symbol proves nothing about the row.
    expect(statusOf({ ...good, symbol: "LDOUSDT" }, ev)).toBe("UNREADABLE");
    // The unmodified payload is eligible against the same evidence: the variants above are the only difference.
    expect(statusOf(good, ev)).toBe("ELIGIBLE");
  });
});

// ===========================================================================
// 10. GRIFFAIN: live when observed, re-quarantined after backpressure
// ===========================================================================

describe("10. GRIFFAIN-style prefix-deterministic case: the alert stays, execution integrity is blocked", () => {
  // The real DRY-soak shape (GRIFFAINUSDT, 2026-10-05): recovery replays, readiness bar quarantined,
  // FOUR live observations on 08:30 (two at update 1, two at update 191), then 08:30 itself
  // finally committed QUARANTINED_CURRENT_BAR after a backpressure detach; 08:45 live again.
  const T0830 = Date.UTC(2026, 9, 5, 8, 30);
  const at = (n: number) => T0830 + n * M15;
  const g = (sourceTf: "1D" | "1W" | "1M", candidateSequence: number, updateSequence: number, created: number, proven: boolean) =>
    observation({ symbol: SYMBOL, lineageId: LINEAGE, barMs: at(0), sourceTf, candidateSequence, updateSequence, condition: "GOG", createdBarOpenTimeMs: created, eventTimeMs: at(0) + updateSequence * 1_000, evidenceClass: proven ? "PROVEN_INTRABAR_POSSIBLE" : "POSSIBLE_ONLY" });
  const log: ShadowRecord[] = [
    commit(at(-3), "REPLAYED_NON_ACTIONABLE"),
    commit(at(-2), "REPLAYED_NON_ACTIONABLE"),
    commit(at(-1), "QUARANTINED_CURRENT_BAR"),
    g("1D", 0, 1, 1775697300000, false),
    g("1W", 1, 1, 1775538900000, false),
    g("1M", 2, 191, 1788430500000, true),
    g("1D", 3, 191, 1775611800000, true),
    commit(at(0), "QUARANTINED_CURRENT_BAR"),
    commit(at(1), "SHADOW_LIVE_ONLY"),
  ];

  it("every delivered GRIFFAIN alert on 08:30 is INELIGIBLE_REQUARANTINED, even with a clean checkpoint and a clean next bar", () => {
    const delivered = [3, 4, 5, 6].flatMap((i) => {
      try {
        return [alertFor(log, i)];
      } catch {
        return []; // a superseded same-slot observation is not delivered at all
      }
    });
    expect(delivered.length).toBeGreaterThan(0);
    for (const alert of delivered) {
      const verdict = evaluateNativeExecutionIntegrity(alert, evidence(log, at(2)));
      expect(verdict.status).toBe("INELIGIBLE_REQUARANTINED");
      expect(verdict.barOpenTime).toBe("2026-10-05T08:30:00.000Z");
      // The future guard refuses it even in a fixture that pretends execution is enabled.
      expect(judgeNativeExecutionAdmission({ nativeExecutionEnabled: true, integrity: verdict })).toEqual({ admitted: false, reason: "NATIVE_INTEGRITY_NOT_ELIGIBLE", integrity: "INELIGIBLE_REQUARANTINED" });
    }
  });

  it("the verdict is a read: the alert payload and the evidence are untouched (the historical alert remains as delivered)", () => {
    const alert = alertFor(log, 3);
    const ev = evidence(log, at(2));
    const before = JSON.stringify([alert, ev]);
    evaluateNativeExecutionIntegrity(alert, ev);
    nativeExecutionIntegrityOf(alert, () => ev);
    expect(JSON.stringify([alert, ev])).toBe(before);
  });
});

// ===========================================================================
// 14-15. Deterministic; TradingView never judged
// ===========================================================================

describe("14-15. deterministic, Native-only", () => {
  it("14. the same alert and the same evidence always give the same verdict (no clock, no memory)", () => {
    const records = clean();
    const alert = alertFor(records, 1);
    for (const hwm of [B, bar(2)]) {
      const ev = evidence(hwm === B ? [commit(bar(0)), obs(B)] : records, hwm);
      const first = evaluateNativeExecutionIntegrity(alert, ev);
      for (let i = 0; i < 5; i += 1) expect(evaluateNativeExecutionIntegrity(alert, ev)).toEqual(first);
    }
    const code = codeOf("src/modules/native-integrity/native-execution-integrity.ts");
    expect(code).not.toMatch(/Date\.now|new Date\(\)|performance\.now|Math\.random/);
  });

  it("15. a TradingView (or any non-Native) alert is never judged by this rule: the evaluator refuses to run", () => {
    const records = clean();
    const native = alertFor(records, 1);
    for (const source of ["TRADINGVIEW", null, undefined, "OTHER"]) {
      expect(() => evaluateNativeExecutionIntegrity({ ...native, source }, evidence(records, bar(2)))).toThrow(/Native-only/);
      expect(() => nativeExecutionIntegrityOf({ ...native, source }, () => evidence(records, bar(2)))).toThrow(/Native-only/);
    }
  });

  it("15b. no TradingView path imports the rule (webhook, planning queue, adoption, executor, execution service)", () => {
    for (const rel of [
      "src/modules/webhook/webhook.service.ts",
      "src/modules/jobs/selected-plan-adoption.service.ts",
      "src/modules/execution/selected-plan-executor.ts",
      "src/modules/execution/execution.service.ts",
      "src/modules/jobs/execution.worker.ts",
      "src/modules/jobs/vision-analysis.worker.ts",
    ]) {
      const file = path.join(BACKEND, rel);
      expect(`${rel}:${readFileSync(file, "utf8").includes("native-execution-integrity")}`).toBe(`${rel}:false`);
    }
    // In the plan read model it is reached only for the Native list, never for a single (TradingView or Native) plan read.
    const service = codeOf("src/modules/extreme-rr/extreme-rr.service.ts");
    expect(service.match(/nativeExecutionIntegrityOf\(/g)?.length).toBe(1);
    const list = service.slice(service.indexOf("async listNativePlans("), service.indexOf("async updateSelection("));
    expect(list).toContain("where: { alert: { source: NATIVE_ALERT_SOURCE } }");
    expect(list).toContain("executionIntegrity: nativeExecutionIntegrityOf(plan.alert, integrityEvidence)");
  });

  it("every status the shared contract names is one the evaluator can return, and nothing else", () => {
    const code = codeOf("src/modules/native-integrity/native-execution-integrity.ts");
    const returned = [...new Set([...code.matchAll(/result\("([A-Z_]+)"/g)].map((m) => m[1]))].sort();
    expect(returned).toEqual([...NATIVE_EXECUTION_INTEGRITY_STATUSES].sort());
    expect(code.match(/result\("ELIGIBLE"/g)?.length).toBe(1);
  });
});

// ===========================================================================
// 16-20. The execution fence is untouched and still first
// ===========================================================================

describe("16-20. the hard Native execution fence stays first; integrity can only add a refusal", () => {
  const eligible: NativeExecutionIntegrityDto = { status: "ELIGIBLE", reason: "clean", barOpenTime: new Date(B).toISOString() };

  it("16. ELIGIBLE integrity with nativeExecutionEnabled=false is still refused (the switch is checked first)", () => {
    expect(judgeNativeExecutionAdmission({ nativeExecutionEnabled: false, integrity: eligible })).toEqual({ admitted: false, reason: "NATIVE_EXECUTION_DISABLED", integrity: "ELIGIBLE" });
  });

  it("16b. the selected-plan executor refuses an integrity-ELIGIBLE Native plan before touching prisma, the margin planner, executions or the orchestrator", async () => {
    const { SelectedPlanExecutor } = await import("../src/modules/execution/selected-plan-executor");
    const touched: string[] = [];
    const trap = (name: string) => new Proxy({}, { get: (_t, key) => (touched.push(`${name}.${String(key)}`), () => { throw new Error(`${name} reached`); }) });
    const executor = new SelectedPlanExecutor({
      prisma: trap("prisma") as never, marginPlanner: trap("marginPlanner") as never, executions: trap("executions") as never, orchestrator: trap("orchestrator") as never,
      boundProfile: { executionProfileId: "never", exchange: "BINANCE", product: "USDM_FUTURES", environment: "TESTNET" } as never,
    });
    const records = clean();
    const alert = alertFor(records, 1);
    expect(evaluateNativeExecutionIntegrity(alert, evidence(records, bar(2))).status).toBe("ELIGIBLE");
    const plan = { alertId: alert.id, alertSource: "NATIVE", status: "READY", selectedLookback: 100, executionIntegrity: eligible } as never;
    expect(await executor.handleSelectedPlan(plan, SYMBOL)).toMatchObject({ handled: false, reasonCode: "NATIVE_ALERT_EXECUTION_FORBIDDEN" });
    // 17. refused before any canary lookup, signed/private Binance (margin planner), margin or order creation.
    expect(touched).toEqual([]);
  });

  it("16c. the fence code itself is unchanged and does not consult integrity", () => {
    const executor = codeOf("src/modules/execution/selected-plan-executor.ts");
    const handle = executor.slice(executor.indexOf("async handleSelectedPlan("));
    expect(handle.indexOf("if (plan.alertSource !== EXECUTABLE_ALERT_SOURCE) {")).toBeGreaterThan(-1);
    expect(executor).not.toMatch(/integrity/i);
    const execution = codeOf("src/modules/execution/execution.service.ts");
    expect(execution).toContain('assertExecutableAlertSource({ id: input.alertId, source: alert.source }, "execution");');
    expect(execution).not.toMatch(/integrity/i);
    const fence = codeOf("src/modules/alerts/alert-source.ts");
    expect(fence).toContain('export const EXECUTABLE_ALERT_SOURCE = "TRADINGVIEW" as const');
    expect(fence).not.toMatch(/integrity|ELIGIBLE/);
  });

  it("18. a blocked or unknown integrity refuses even in a fixture that pretends execution is enabled; only ELIGIBLE + enabled would pass", () => {
    for (const status of NATIVE_EXECUTION_INTEGRITY_STATUSES.filter((s) => s !== "ELIGIBLE")) {
      expect(judgeNativeExecutionAdmission({ nativeExecutionEnabled: true, integrity: { status, reason: "x", barOpenTime: null } }), status).toEqual({ admitted: false, reason: "NATIVE_INTEGRITY_NOT_ELIGIBLE", integrity: status });
    }
    expect(judgeNativeExecutionAdmission({ nativeExecutionEnabled: true, integrity: null })).toEqual({ admitted: false, reason: "NATIVE_INTEGRITY_NOT_ELIGIBLE", integrity: null });
    expect(judgeNativeExecutionAdmission({ nativeExecutionEnabled: true, integrity: { status: "eligible" as never, reason: "x", barOpenTime: null } }).admitted).toBe(false);
    for (const enabled of [false, "true", 1, null, undefined] as never[]) {
      expect(judgeNativeExecutionAdmission({ nativeExecutionEnabled: enabled, integrity: eligible }).admitted).toBe(false);
    }
    // The single admitted combination exists only so a FUTURE reviewed change has one place to look.
    expect(judgeNativeExecutionAdmission({ nativeExecutionEnabled: true, integrity: eligible })).toEqual({ admitted: true });
  });

  it("18b. the admission guard is wired into nothing: no production module calls it", () => {
    const callers = productionSources().filter((rel) => rel !== "src/modules/native-integrity/native-execution-integrity.ts" && readFileSync(path.join(BACKEND, rel), "utf8").includes("judgeNativeExecutionAdmission"));
    expect(callers).toEqual([]);
  });

  it("19. the evaluator and its loader write nothing: no database, no file write, no lock, no queue", () => {
    const code = codeOf("src/modules/native-integrity/native-execution-integrity.ts");
    expect(code).not.toMatch(/prisma|PrismaClient|\.save\(|writeFile|appendFile|mkdir|rmSync|unlink|rename|openSync|LiveShadowEventStore|ScannerLock|acquire|bullmq|enqueue|Queue/);
    expect(code).not.toMatch(/from "\.\.\/binance|from "\.\.\/execution|from "\.\.\/jobs/);
  });

  it("20. the integrity read never sets or reads executionFanoutReadyAt (Native plans keep it null)", () => {
    const code = codeOf("src/modules/native-integrity/native-execution-integrity.ts");
    expect(code).not.toContain("executionFanoutReadyAt");
    const plans = codeOf("src/modules/extreme-rr/extreme-rr.service.ts");
    expect(plans).toContain('const executionFanoutReadyAt = status === "READY" && !native ? new Date() : null;');
  });
});

// ===========================================================================
// The read-only file-system loader
// ===========================================================================

describe("the file-system evidence loader reads the scanner tree and changes nothing", () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  function scannerTree(records: readonly ShadowRecord[] | null, body: LiveCheckpointBody | null) {
    const local = mkdtempSync(path.join(tmpdir(), "native-integrity-"));
    roots.push(local);
    const dir = liveShadowEngineDir(path.join(local, "trading-alert-dashboard", "scanner"), FINGERPRINT, "USDM_PERPETUAL", SYMBOL, "15m");
    mkdirSync(dir, { recursive: true });
    if (records !== null) writeFileSync(path.join(dir, "events.jsonl"), logOf(records));
    if (body !== null) new LiveCheckpointStore(dir).save(body, "2026-10-05T12:00:00.000Z");
    return { env: { LOCALAPPDATA: local } as NodeJS.ProcessEnv, dir };
  }
  const snapshot = (dir: string) => readdirSync(dir).sort().map((f) => [f, readFileSync(path.join(dir, f), "utf8"), statSync(path.join(dir, f)).mtimeMs]);

  it("clean tree -> ELIGIBLE; the directory is byte- and mtime-identical afterwards; no lock file is created", () => {
    const records = clean();
    const { env, dir } = scannerTree(records, checkpointBody(bar(2)));
    const before = snapshot(dir);
    const verdict = nativeExecutionIntegrityOf(alertFor(records, 1), fileSystemNativeScannerEvidence(env));
    expect(verdict.status).toBe("ELIGIBLE");
    expect(snapshot(dir)).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(["checkpoint.json", "events.jsonl"]);
  });

  it("an edited checkpoint on disk -> INELIGIBLE_CHECKPOINT_MISMATCH; a missing tree -> UNREADABLE; no LOCALAPPDATA -> UNREADABLE", () => {
    const records = clean();
    const { env, dir } = scannerTree(records, checkpointBody(bar(2)));
    const file = path.join(dir, "checkpoint.json");
    writeFileSync(file, readFileSync(file, "utf8").replace(STATE, "f".repeat(64)));
    expect(nativeExecutionIntegrityOf(alertFor(records, 1), fileSystemNativeScannerEvidence(env)).status).toBe("INELIGIBLE_CHECKPOINT_MISMATCH");

    const empty = mkdtempSync(path.join(tmpdir(), "native-integrity-empty-"));
    roots.push(empty);
    expect(nativeExecutionIntegrityOf(alertFor(records, 1), fileSystemNativeScannerEvidence({ LOCALAPPDATA: empty })).status).toBe("UNREADABLE");
    expect(nativeExecutionIntegrityOf(alertFor(records, 1), fileSystemNativeScannerEvidence({})).status).toBe("UNREADABLE");
  });

  it("the current generation comes from THIS code's profile: the alert's own fingerprint is never trusted on its own", () => {
    const records = clean();
    const { env } = scannerTree(records, checkpointBody(bar(2)));
    const alert = alertFor(records, 1);
    const payload = alert.rawPayload as Record<string, any>;
    const retired = { ...alert, rawPayload: { ...payload, profile: { ...payload.profile, profileId: "TEDDY_RETIRED_V1" } } };
    expect(nativeExecutionIntegrityOf(retired, fileSystemNativeScannerEvidence(env)).status).toBe("INELIGIBLE_STALE_GENERATION");
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

/**
 * NON-GATING, OFFLINE benchmark: LEGACY serial recovery vs FAST_RECOVERY_V1 for a synthetic universe.
 *
 *   pnpm -C apps/backend exec tsx scripts/native-recovery-benchmark.ts [symbols=525] [cpuMsPerSymbol=360] [latencyMs=150]
 *
 * Runs the REAL supervisor start-up (both policies) against a fake Binance and a manual clock, from the same trusted
 * checkpoint, for 6 h / 1 d / 3 d / 2 w / 30 d of downtime. No network, no machine-local scanner state: temp dirs only.
 *
 * Measured (exact, deterministic): requests, request weight, peak weight per minute, the governor's own waiting
 * (spacing + weight windows) on the virtual clock, and that both policies end byte-identical.
 * ESTIMATED (a model, labelled as such): wall time = max(REST, CPU), where REST = governor waiting + per-request
 * latency (serial for LEGACY, overlapped up to max-in-flight for FAST) and CPU = cpuMsPerSymbol x symbols
 * (default 360 ms: measured on the real 35f1a32d cache/checkpoints, rebuild + hash-fence verification per symbol).
 */
import { rmSync } from "node:fs";

import { FAST_RECOVERY_DEFAULTS } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import { TEDDY_7_ALL_ACTIVE_V1, dashboardTimeframes, engineTimeframes, futureExecutionTimeframes, type ScannerProfile } from "../src/modules/native-scanner/scanner-profile";
import { M15, cloneState, peakWeightPerMinute, startRun, symbolFacts, syntheticBars, tempDir, type MarketScript } from "../tests/helpers/native-recovery-harness";

const [symbolsArg, cpuArg, latencyArg] = process.argv.slice(2);
const SYMBOL_COUNT = Number(symbolsArg ?? 525);
const CPU_MS = Number(cpuArg ?? 360);
const LATENCY_MS = Number(latencyArg ?? 150);

const N = TEDDY_7_ALL_ACTIVE_V1;
const D = (d: number, h = 0, m = 0, s = 0) => Date.UTC(2025, 0, d, h, m, s);
const FIX: ScannerProfile = {
  ...N,
  engine: { ...N.engine, historyStart: "2025-01-06T00:00:00Z", switchover: "2025-01-10T12:00:00Z", engineSourceTimeframes: engineTimeframes("1D") },
  delivery: { ...N.delivery, dashboardSourceTimeframes: dashboardTimeframes("1D") },
  execution: { ...N.execution, futureExecutionSourceTimeframes: futureExecutionTimeframes("1D") },
} as ScannerProfile;
const T0 = D(12, 0, 0, 30);
const OLD = syntheticBars(7, D(6), (T0 - D(6)) / M15 + 3_000);
const NEW = OLD.filter((b) => b.openTimeMs >= D(8));
// About the real mix: ~11% of the universe listed after the profile's context start (SYMBOL_FIRST_CLOSED_BAR).
const symbols = Array.from({ length: SYMBOL_COUNT }, (_, i) => (i % 9 === 0 ? `N${String(i).padStart(4, "0")}USDT` : `S${String(i).padStart(4, "0")}USDT`));
const market: MarketScript = { bars: (s) => (s.startsWith("N") ? NEW : OLD), onboardDateMs: (s) => (s.startsWith("N") ? D(8) : D(5)) };

async function main() {
  const base = { root: tempDir("bench-root-"), cacheDir: tempDir("bench-cache-") };
  const first = await startRun({ mode: "FAST", profile: FIX, symbols, market, ...base, nowMs: T0 });
  first.supervisor.stop();
  console.log(`trusted state: ${first.recovery.liveReady} symbols bootstrapped (${first.recovery.restRequests} requests)\n`);
  const rows: string[][] = [["downtime", "policy", "requests", "weight", "peak w/min", "max in flight", "REST wait s", "est REST s", "est CPU s", "est wall min", "same-HWM symbols identical", "crossed a 15m boundary"]];
  for (const [label, gap] of [["6h", 24], ["1d", 96], ["3d", 288], ["2w", 1344], ["30d", 2880]] as const) {
    const facts: Record<string, ReturnType<typeof symbolFacts>> = {};
    for (const mode of ["LEGACY", "FAST"] as const) {
      const dirs = cloneState(base);
      const run = await startRun({ mode, profile: FIX, symbols, market, ...dirs, nowMs: T0 + gap * M15 });
      run.supervisor.stop();
      facts[mode] = symbolFacts(run);
      rmSync(dirs.root, { recursive: true, force: true });
      rmSync(dirs.cacheDir, { recursive: true, force: true });
      const waitS = run.recovery.elapsedMs / 1000;
      const inFlight = mode === "FAST" ? FAST_RECOVERY_DEFAULTS.maxInFlight : 1;
      // Spacing is measured between starts, so latency adds only where it exceeds what the governor waited anyway.
      const latencyS = (run.requests.length * LATENCY_MS) / inFlight / 1000;
      const restS = Math.max(waitS, latencyS);
      const cpuS = (SYMBOL_COUNT * CPU_MS) / 1000;
      const wallMin = Math.max(restS, cpuS) / 60;
      let compared = "";
      let crossed = "";
      if (mode === "FAST") {
        // A symbol prepared after the next 15m boundary rightly catches up one bar further: compare where both reached the same HWM.
        const legacy = new Map(facts.LEGACY.map((f) => [f.symbol, f]));
        const same = facts.FAST.filter((f) => legacy.get(f.symbol)?.hwm === f.hwm);
        const equal = same.filter((f) => JSON.stringify(f) === JSON.stringify(legacy.get(f.symbol)));
        compared = `${equal.length}/${same.length}`;
        crossed = `LEGACY ${facts.LEGACY.filter((f) => f.hwm !== facts.FAST.find((x) => x.symbol === f.symbol)?.hwm).length}`;
      }
      rows.push([label, mode, String(run.requests.length), String(run.metrics.weightUsed), String(peakWeightPerMinute(run.requests)), String(run.maxInFlight), waitS.toFixed(0), restS.toFixed(0), cpuS.toFixed(0), wallMin.toFixed(1), compared, crossed]);
    }
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  for (const r of rows) console.log(r.map((v, c) => v.padStart(widths[c])).join("  "));
  rmSync(base.root, { recursive: true, force: true });
  rmSync(base.cacheDir, { recursive: true, force: true });
}

void main();

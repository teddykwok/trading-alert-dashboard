import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assertOutsideRepository } from "../native-scanner/scanner-paths";
import { SoakMonitorUsageError, parseSoakMonitorArgs, soakReportOf, takeSoakSnapshot, type FetchedJson, type SoakSnapshot } from "./soak-monitor";

/**
 * Entry point: `pnpm --filter @trading-alert-dashboard/backend signal-quality:soak-monitor --out <dir> …`
 *
 * READ ONLY. It makes GET requests to the generic backend and writes snapshot
 * and report files under --out (refused inside the repository). It imports no
 * database client, no environment configuration and no exchange client.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const REQUEST_TIMEOUT_MS = 20_000;

async function getJson(url: string): Promise<FetchedJson> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: null, body: null, error: error instanceof Error ? error.message.slice(0, 200) : "request failed" };
  } finally {
    clearTimeout(timer);
  }
}

function writeAtomically(file: string, text: string): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, file);
}

function readSnapshots(dir: string): SoakSnapshot[] {
  try {
    return readdirSync(dir)
      .filter((name) => /^snapshot-.*\.json$/.test(name))
      .sort()
      .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as SoakSnapshot);
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = parseSoakMonitorArgs(process.argv.slice(2), Date.now());
  const root = assertOutsideRepository(args.outDir, REPO_ROOT);
  const dir = path.join(root, `soak-${new Date(args.soakStartMs).toISOString().replace(/[:.]/g, "-")}`);
  const snapshotsDir = path.join(dir, "snapshots");
  mkdirSync(snapshotsDir, { recursive: true });
  writeAtomically(path.join(dir, "manifest.json"), `${JSON.stringify({ ...args, notice: ["MONITORING ONLY", "NO EXECUTION AUTHORITY"] }, null, 2)}\n`);
  console.log("==============================================================");
  console.log("NATIVE SIGNAL QUALITY — 24H SOAK MONITOR");
  console.log("MONITORING ONLY · NO EXECUTION AUTHORITY · NO PRIVATE BINANCE · NO DATABASE WRITES");
  console.log("==============================================================");
  console.log(`  soak start      ${new Date(args.soakStartMs).toISOString()}`);
  console.log(`  expected end    ${new Date(args.soakStartMs + args.soakHours * 3_600_000).toISOString()}`);
  console.log(`  every           ${args.everyMinutes} min`);
  console.log(`  output          ${dir}`);

  const endMs = args.soakStartMs + args.soakHours * 3_600_000;
  for (;;) {
    const nowMs = Date.now();
    const snapshot = await takeSoakSnapshot(args, getJson, nowMs);
    writeAtomically(path.join(snapshotsDir, `snapshot-${snapshot.takenAt.replace(/[:.]/g, "-")}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    const report = soakReportOf(args, readSnapshots(snapshotsDir), Date.now());
    writeAtomically(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${snapshot.takenAt}  backend ${snapshot.health.ok ? "OK" : "DOWN"}  continuity ${report.continuity.verdict}  interruptions ${report.continuity.interruptions.length}`);
    if (args.once || Date.now() >= endMs) break;
    const next = Math.min(endMs, nowMs + args.everyMinutes * 60_000);
    await sleep(Math.max(1_000, next - Date.now()));
  }
  console.log(`Final report: ${path.join(dir, "report.json")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof SoakMonitorUsageError ? error.message : error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

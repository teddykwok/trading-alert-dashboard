// MUST be the first import: a GENERIC process that refuses to start with any account credential.
import "../../config/bootstrap-generic";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

import { KlineCacheStore } from "../native-scanner/kline-cache";
import { LiveCheckpointStore } from "../native-scanner/live-shadow-checkpoint";
import { LINEAGE_CONFIG_OPTIONS, LiveShadowCliUsageError, parseLineageConfig } from "../native-scanner/live-shadow-cli-args";
import { parseShadowEventLog, type ShadowLogIdentity } from "../native-alerts/shadow-log-reader";
import { parseUtcInstant } from "../native-scanner/replay-cli-args";
import { scannerKlineCacheDir, scannerRootDir } from "../native-scanner/scanner-paths";
import { auditNativeAlert, levelTimeline, type LevelSelector } from "./native-alert-audit";

/**
 * native-alerts:audit — READ-ONLY forensic audit of one NATIVE alert.
 *
 *   DOTENV_CONFIG_PATH=<generic env file> pnpm --filter @trading-alert-dashboard/backend native-alerts:audit \
 *     --alert-id <id> <the scanner's lineage flags> [--timeline-from ISO --timeline-to ISO --track-levels 1W:GREEN:0.0132,1D:GREEN:0.01296] [--json]
 *
 * Reads the database inside a READ ONLY transaction, and the local shadow log,
 * checkpoint and public kline cache. No network, no queue, no write.
 */

const VALUES = ["--alert-id", "--timeline-from", "--timeline-to", "--track-levels", ...LINEAGE_CONFIG_OPTIONS] as const;
const FLAGS = ["--json"] as const;

function usage(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

function databaseName(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "") || "(unnamed)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<number> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((FLAGS as readonly string[]).includes(token)) {
      flags.add(token);
      continue;
    }
    if (!(VALUES as readonly string[]).includes(token)) usage(`unexpected argument: ${token}`);
    if (values.has(token)) usage(`${token} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`${token} needs a value`);
    values.set(token, value);
    i += 1;
  }
  const alertId = values.get("--alert-id");
  if (alertId === undefined || !/^[a-z0-9]{20,40}$/.test(alertId)) usage("--alert-id is required (an alert id)");
  const missing = LINEAGE_CONFIG_OPTIONS.filter((n) => !values.has(n));
  if (missing.length > 0) usage(`the scanner's lineage flags are required to rebuild its state: missing ${missing.join(", ")}`);
  let lineage;
  try {
    lineage = parseLineageConfig((n) => values.get(n) as string);
  } catch (error) {
    if (error instanceof LiveShadowCliUsageError) usage(error.message);
    throw error;
  }
  const timeline = values.has("--timeline-from") || values.has("--timeline-to") || values.has("--track-levels");
  if (timeline && !(values.has("--timeline-from") && values.has("--timeline-to") && values.has("--track-levels"))) {
    usage("--timeline-from, --timeline-to and --track-levels go together");
  }

  const root = scannerRootDir(process.env);
  const shadowDir = (id: ShadowLogIdentity) => path.join(root, "live-shadow", id.marketType, id.symbol, id.chartInterval);
  const cache = new KlineCacheStore(scannerKlineCacheDir(process.env));
  const prisma = new PrismaClient();
  try {
    const report = await auditNativeAlert(prisma, {
      alertId,
      lineage,
      readShadowLog: (id) => {
        const file = path.join(shadowDir(id), "events.jsonl");
        return existsSync(file) ? readFileSync(file, "utf8") : null;
      },
      readCheckpointLineage: (id) => new LiveCheckpointStore(shadowDir(id)).load()?.body.lineageId ?? null,
      loadKlines: (symbol) => cache.load("USDM_PERPETUAL", symbol, lineage.chartInterval)?.klines ?? null,
    });

    let timelineRows = null;
    if (timeline) {
      const alert = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return tx.nativeAlertDelivery.findFirst({ where: { alertId }, select: { symbol: true, lineageId: true, marketType: true, chartInterval: true } });
      });
      if (alert === null) usage("no ledger row for this alert: nothing to build a timeline for");
      const selectors: LevelSelector[] = (values.get("--track-levels") as string).split(",").map((spec) => {
        const [sourceTf, color, price] = spec.split(":");
        if (!sourceTf || (color !== "GREEN" && color !== "RED") || !/^\d+(\.\d+)?$/.test(price ?? "")) usage(`--track-levels entry ${spec} must be TF:GREEN|RED:price`);
        return { sourceTf, color, price: Number(price) };
      });
      const identity: ShadowLogIdentity = { lineageId: alert.lineageId, marketType: "USDM_PERPETUAL", symbol: alert.symbol, chartInterval: lineage.chartInterval };
      const logFile = path.join(shadowDir(identity), "events.jsonl");
      const records = existsSync(logFile) ? parseShadowEventLog(readFileSync(logFile, "utf8"), identity) : [];
      const klines = cache.load("USDM_PERPETUAL", alert.symbol, lineage.chartInterval)?.klines ?? [];
      const built = levelTimeline(klines, lineage, alert.symbol, parseUtcInstant(values.get("--timeline-from") as string, "--timeline-from"), parseUtcInstant(values.get("--timeline-to") as string, "--timeline-to"), selectors, records);
      if (built.lineageId !== alert.lineageId) usage(`the timeline's rebuilt lineage ${built.lineageId} is not the alert's ${alert.lineageId}`);
      timelineRows = built.rows;
    }

    if (flags.has("--json")) {
      console.log(JSON.stringify({ schema: "teddy.native-alerts.forensic-audit.v1", readOnly: true, database: databaseName(), report, timeline: timelineRows }, null, 2));
      return report.overall === "PASS" ? 0 : 1;
    }
    const row = (label: string, value: string) => console.log(`${label.padEnd(27)}${value}`);
    console.log("NATIVE ALERT FORENSIC AUDIT (READ ONLY)");
    console.log(`database ${databaseName()}; alert ${alertId}`);
    for (const [label, section] of [
      ["ALERT MAPPING", report.alertMapping],
      ["LEDGER", report.ledger],
      ["SHADOW EVENT", report.shadowEvent],
      ["PROVENANCE", report.provenance],
      ["ENGINE READINESS", report.engineReadiness],
    ] as const) {
      row(label, section.verdict);
      for (const finding of section.findings) console.log(`    - ${finding}`);
    }
    row("PLAN COUNT", String(report.dbSafety.planCount ?? "UNKNOWN"));
    row("TRADE EXECUTION COUNT", String(report.dbSafety.tradeExecutionCount ?? "UNKNOWN"));
    row("ORDER/EXECUTION ARTIFACTS", String(report.dbSafety.executionArtifactCount ?? "UNKNOWN"));
    for (const finding of report.dbSafety.findings) console.log(`    - ${finding}`);
    for (const a of report.dbSafety.artifacts.filter((x) => x.count > 0)) console.log(`    rows: ${a.table} via ${a.via} = ${a.count} (${a.class})`);
    console.log(`    tables inspected: ${report.dbSafety.artifacts.length}`);
    console.log("PROVEN");
    for (const p of report.proofLimits.proven) console.log(`    + ${p}`);
    console.log("NOT PROVEN");
    for (const p of report.proofLimits.notProven) console.log(`    - ${p}`);
    if (timelineRows !== null) {
      console.log("TIMELINE (committed pre-bar gates; canonical engine)");
      for (const r of timelineRows) {
        console.log(
          `  ${r.barOpenTime} ${r.level.padEnd(18)} ${r.readiness.padEnd(18)} armed ${r.armed} ready ${r.armedReady} old ${r.oldEnough} cool ${r.cooledDown} side ${r.approachSide} inBand ${r.inBand} imm ${r.immediateCandidate} committed ${r.committedCandidate} lastTouch ${r.lastTouchBarIndex ?? "-"} | scanner: ${r.scannerBar}`
        );
      }
    }
    row("OVERALL", report.overall === "PASS" ? "PASS — consistent, dashboard-only, no execution artifacts" : "FAIL — see findings (never reported safe when anything is unproven)");
    return report.overall === "PASS" ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`AUDIT FAILED (${error instanceof Error ? error.name : "unknown"})${error instanceof Error && !/postgres|password/i.test(error.message) ? `: ${error.message}` : ""}`);
    process.exit(1);
  });

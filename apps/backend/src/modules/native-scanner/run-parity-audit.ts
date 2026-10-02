// MUST be the first import. A GENERIC process: refuses to start with any account credential.
import "../../config/bootstrap-generic";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { env } from "../../config/env";
import { ScannerDataError, assertPublicFuturesBaseUrl } from "./binance-public-futures";
import { CandidateRankHaltError, MAX_TOTAL_REQUESTS_CEILING } from "./candidate-rank-runner";
import { KlineCacheStore } from "./kline-cache";
import { CONSERVATIVE_REQUEST_POLICY, REQUEST_POLICY_LIMITS, type PublicHttpTransport } from "./kline-fetcher";
import { LINEAGE_CONFIG_OPTIONS, LiveShadowCliUsageError, parseLineageConfig } from "./live-shadow-cli-args";
import { PARITY_NOTICE } from "./parity-audit";
import { ParityAuditError, runParityAudit } from "./parity-audit-runner";
import { ScannerPathError, assertOutsideRepository, scannerKlineCacheDir, scannerRootDir } from "./scanner-paths";

/**
 * scanner:parity-audit — READ-ONLY TradingView ↔ native parity audit.
 *
 *   DOTENV_CONFIG_PATH=<generic env file> pnpm --filter @trading-alert-dashboard/backend scanner:parity-audit \
 *     --evidence <tv-alerts.jsonl> --expect-sha256 <sha> <lineage flags> [--max-symbols N | --symbols A,B] [--cache-only] [--json]
 *
 * Public market data and a local evidence file only. No database, no alert,
 * no account, no signed endpoint. Writes the public kline cache and one report
 * file under the machine-local scanner directory. This entrypoint is the only
 * place the audit uses the real network, clock or timers.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const VALUES = ["--evidence", "--expect-sha256", "--symbols", "--max-symbols", "--concurrency", "--sample-size", "--max-total-requests", "--request-spacing-ms", ...LINEAGE_CONFIG_OPTIONS] as const;
const FLAGS = ["--cache-only", "--json"] as const;

/** Public REST transport: GET only, the scanner's own headers only, no redirects followed. */
const publicTransport: PublicHttpTransport = async (url, init) => {
  const response = await fetch(url, {
    method: "GET",
    headers: init.headers,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, header: (name) => response.headers.get(name), text: () => response.text() };
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function usage(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

function bounded(value: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) usage(`${name} must be an integer ${min}..${max}`);
  return Number(value);
}

async function main(): Promise<void> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((FLAGS as readonly string[]).includes(token)) {
      if (flags.has(token)) usage(`${token} given twice`);
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
  for (const name of ["--evidence", "--expect-sha256", ...LINEAGE_CONFIG_OPTIONS]) if (!values.has(name)) usage(`missing required: ${name}`);
  if (!/^[0-9a-fA-F]{64}$/.test(values.get("--expect-sha256") as string)) usage("--expect-sha256 must be a SHA-256 hex digest");
  if (values.has("--symbols") && values.has("--max-symbols")) usage("give --symbols or --max-symbols, not both");
  let lineage;
  try {
    lineage = parseLineageConfig((n) => values.get(n) as string);
  } catch (error) {
    if (error instanceof LiveShadowCliUsageError) usage(error.message);
    throw error;
  }
  const symbols = values.has("--symbols") ? (values.get("--symbols") as string).split(",") : null;
  if (symbols !== null && symbols.some((s) => !/^[A-Z0-9]{3,30}$/.test(s))) usage("--symbols must be bare uppercase Binance symbols");
  const say = flags.has("--json") ? (line: string) => console.error(line) : (line: string) => console.log(line);
  for (const line of PARITY_NOTICE) say(line);

  const started = Date.now();
  const result = await runParityAudit(
    {
      lineage,
      minMovePercent: Number(values.get("--min-move-percent")),
      evidenceText: readFileSync(values.get("--evidence") as string, "utf8"),
      expectedEvidenceSha256: values.get("--expect-sha256") as string,
      symbols,
      maxSymbols: values.has("--max-symbols") ? bounded(values.get("--max-symbols"), "--max-symbols", 1, 10_000, 0) : null,
      concurrency: bounded(values.get("--concurrency"), "--concurrency", 1, 4, 2),
      cacheOnly: flags.has("--cache-only"),
      sampleSize: bounded(values.get("--sample-size"), "--sample-size", 1, 100, 5),
    },
    {
      transport: publicTransport,
      baseUrl: assertPublicFuturesBaseUrl(env.BINANCE_FUTURES_REST_BASE_URL),
      maxTotalRequests: bounded(values.get("--max-total-requests"), "--max-total-requests", 4, MAX_TOTAL_REQUESTS_CEILING, 2_000),
      minSpacingMs: bounded(values.get("--request-spacing-ms"), "--request-spacing-ms", REQUEST_POLICY_LIMITS.minSpacingFloorMs, 60_000, CONSERVATIVE_REQUEST_POLICY.minSpacingMs),
      cache: new KlineCacheStore(assertOutsideRepository(scannerKlineCacheDir(process.env), REPO_ROOT)),
      nowMs: () => Date.now(),
      nowIso: () => new Date().toISOString(),
      sleep,
      log: say,
    }
  );
  const elapsedSeconds = Number(((Date.now() - started) / 1000).toFixed(1));

  const dir = assertOutsideRepository(path.join(scannerRootDir(process.env), "parity-audits"), REPO_ROOT);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `parity-${result.generatedAt.replace(/[-:.]/g, "")}-${result.reportSha256.slice(0, 12)}.json`);
  writeFileSync(file, `${JSON.stringify({ ...result, elapsedSeconds }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  const { rows: _rows, ...summary } = result;
  if (flags.has("--json")) {
    console.log(JSON.stringify({ ...summary, elapsedSeconds, reportFile: file }, null, 2));
    return;
  }
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(2)}%`);
  const r = result.report;
  console.log("");
  console.log(`in-window: assessable ${r.inLineageWindow.assessable}, explained ${r.inLineageWindow.explained} (${pct(r.inLineageWindow.explainabilityRate)})`);
  console.log(`Binance-derivable: assessable ${r.binanceDerivable.assessable}, explained ${r.binanceDerivable.explained} (${pct(r.binanceDerivable.explainabilityRate)})`);
  console.log(`categories ${JSON.stringify(r.overall.byCategory)}`);
  console.log("unexplained diagnostics:");
  for (const [k, v] of Object.entries(r.unexplainedDiagnostics)) console.log(`  ${String(v).padStart(6)}  ${k}`);
  console.log(`explained by evidence ${JSON.stringify(r.explainedByEvidence)}`);
  for (const [tf, t] of Object.entries(r.bySourceTf)) console.log(`  ${tf.padEnd(4)} assessable ${String(t.assessable).padStart(6)} explained ${String(t.explained).padStart(6)} ${pct(t.explainabilityRate)}`);
  console.log(`TradingView alerts per (symbol, bar): ${JSON.stringify(result.tradingViewAlertsPerSymbolBar)}`);
  console.log(`native-only (NOT false positives): ${JSON.stringify(result.nativeOnly.withoutTradingViewAlert)}`);
  console.log(`skipped symbols ${result.skippedSymbols.length}; requests ${result.requests.made}/${result.requests.budget}; elapsed ${elapsedSeconds}s`);
  console.log(`report ${result.reportSha256} rows ${result.rowsSha256}`);
  console.log(`full report: ${file}`);
}

void main().catch((error: unknown) => {
  if (error instanceof ParityAuditError || error instanceof CandidateRankHaltError || error instanceof ScannerDataError || error instanceof ScannerPathError) {
    const code = "code" in error ? ` (${String((error as { code: unknown }).code)})` : "";
    console.error(`REFUSED${code}: ${error.message}`);
  } else {
    console.error(`PARITY AUDIT FAILED (${error instanceof Error ? error.name : "unknown"})`);
  }
  process.exitCode = 1;
});

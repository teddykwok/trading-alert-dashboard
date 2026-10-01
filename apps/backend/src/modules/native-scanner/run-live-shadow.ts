// MUST be the first import. The scanner is a GENERIC process: this refuses to
// start if the environment holds ANY account credential, so the live shadow
// scanner can never run with Account A/B keys in reach.
import "../../config/bootstrap-generic";

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { NativeKline } from "@trading-alert-dashboard/shared";

import { env } from "../../config/env";
import { assertPublicFuturesBaseUrl, intervalMsOf, ScannerDataError } from "./binance-public-futures";
import { CompatReplayError } from "./compat-replay";
import { KlineCacheError, KlineCacheStore, mergeClosedKlines } from "./kline-cache";
import { fetchClosedFuturesKlines, type PublicHttpTransport } from "./kline-fetcher";
import { LiveStreamError, buildPublicKlineStreamUrl } from "./live-kline-stream";
import { LiveCheckpointStore, LiveShadowError } from "./live-shadow-checkpoint";
import { LIVE_SHADOW_CLI_USAGE, LiveShadowCliUsageError, parseLiveShadowCliArgs } from "./live-shadow-cli-args";
import { LiveShadowRunner, type OpenPublicStream } from "./live-shadow-runner";
import { LiveShadowSession, prepareLiveShadowState } from "./live-shadow-session";
import { LiveShadowEventStore } from "./live-shadow-store";
import { REPLAY_PAGE_LIMIT, REPLAY_SETTLE_MS } from "./replay-cli-args";
import { ScannerLineageError, deriveHtfContextStartMs } from "./scanner-lineage";
import { ScannerPathError, assertOutsideRepository, scannerKlineCacheDir, scannerRootDir } from "./scanner-paths";

/**
 * LIVE SHADOW scanner for ONE symbol on Binance USD-M public 15m klines.
 *
 *   DOTENV_CONFIG_PATH=<generic env file> \
 *     pnpm --filter @trading-alert-dashboard/backend scanner:live-shadow --symbol LDOUSDT ... [--fetch]
 *
 * Rebuilds the fixed lineage's state, verifies and extends its checkpoint,
 * then listens to the PUBLIC kline stream and writes local, non-actionable
 * shadow evidence. It creates no Alert, places no order, touches no database,
 * queue, webhook or account, and holds no credential. This entrypoint is the
 * only place the live scanner uses the real network, clock or timers.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];

/** Public REST transport: GET only, the scanner's own headers only, no redirects followed. */
const publicTransport: PublicHttpTransport = async (url, init) => {
  const response = await fetch(url, {
    method: "GET",
    headers: init.headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, header: (name) => response.headers.get(name), text: () => response.text() };
};

/** Public WebSocket: no headers of ours at all, so no key can ever be sent. */
const openPublicStream: OpenPublicStream = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => handlers.onMessage(typeof event.data === "string" ? event.data : String(event.data)));
  socket.addEventListener("error", () => handlers.onError("websocket error event"));
  socket.addEventListener("close", (event) => handlers.onClose(`code ${event.code}${event.reason ? ` ${event.reason}` : ""}`));
  return { close: () => socket.close() };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const iso = (ms: number) => new Date(ms).toISOString();

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/** End (exclusive) of the contiguous run of cached bars starting exactly at `fromMs`, below `limitMs`. */
function contiguousEnd(klines: readonly NativeKline[], fromMs: number, limitMs: number, intervalMs: number): number {
  let expected = fromMs;
  for (const k of klines) {
    if (k.openTimeMs < expected) continue;
    if (k.openTimeMs !== expected || k.openTimeMs >= limitMs) break;
    expected += intervalMs;
  }
  return expected;
}

async function main(): Promise<void> {
  let options;
  try {
    options = parseLiveShadowCliArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof LiveShadowCliUsageError)) throw error;
    console.error(`REFUSED: ${error.message}\n\n${LIVE_SHADOW_CLI_USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { request, policy } = options;

  console.log("LIVE SHADOW ONLY");
  console.log("NO ALERT WILL BE CREATED");
  console.log("NO ORDER CAN BE PLACED");
  console.log(`git ${git(["rev-parse", "HEAD"])}${git(["status", "--porcelain"]) === "" ? "" : " (worktree NOT clean)"}`);

  const cacheDir = assertOutsideRepository(scannerKlineCacheDir(process.env), REPO_ROOT);
  const liveDir = assertOutsideRepository(
    path.join(scannerRootDir(process.env), "live-shadow", request.marketType, request.symbol, request.chartInterval),
    REPO_ROOT
  );
  const intervalMs = intervalMsOf(request.chartInterval);
  const baseUrl = assertPublicFuturesBaseUrl(env.BINANCE_FUTURES_REST_BASE_URL);
  const streamUrl = buildPublicKlineStreamUrl(request.symbol, request.chartInterval);
  const fetchDeps = { transport: publicTransport, baseUrl, policy, nowMs: () => Date.now(), sleep };
  const fetchClosedBars = async (fromMs: number, toMs: number): Promise<NativeKline[]> => {
    const result = await fetchClosedFuturesKlines(fetchDeps, {
      symbol: request.symbol,
      interval: request.chartInterval,
      startMs: fromMs,
      endMs: toMs,
      maxBars: Math.max(1, (toMs - fromMs) / intervalMs),
      pageLimit: REPLAY_PAGE_LIMIT,
      settleMs: REPLAY_SETTLE_MS,
    });
    return result.klines;
  };

  const cache = new KlineCacheStore(cacheDir);
  const contextStartMs = deriveHtfContextStartMs(request.historyStartMs, request.engine.enabledSourceTfs, request.engine.calendar);
  const currentBarOpenMs = Math.floor(Date.now() / intervalMs) * intervalMs;
  let klines = cache.load(request.marketType, request.symbol, request.chartInterval)?.klines ?? [];
  let trustedEndMs = contiguousEnd(klines, contextStartMs, currentBarOpenMs, intervalMs);
  if (trustedEndMs < currentBarOpenMs) {
    if (!options.fetch) {
      throw new LiveShadowError("CHECKPOINT_AHEAD_OF_DATA", `the cache holds closed bars only to ${iso(trustedEndMs)}; rerun with --fetch to fill to ${iso(currentBarOpenMs)}`);
    }
    const fetched = await fetchClosedBars(trustedEndMs, currentBarOpenMs);
    klines = mergeClosedKlines(klines, fetched);
    cache.save(request.marketType, request.symbol, request.chartInterval, klines, iso(Date.now()));
    klines = cache.load(request.marketType, request.symbol, request.chartInterval)?.klines ?? [];
    trustedEndMs = contiguousEnd(klines, contextStartMs, currentBarOpenMs, intervalMs);
  }

  const checkpoints = new LiveCheckpointStore(liveDir);
  const plan = prepareLiveShadowState(klines, request, trustedEndMs, checkpoints.load());
  checkpoints.save(plan.checkpointBody, iso(Date.now()));
  const events = new LiveShadowEventStore(liveDir);

  console.log(`  lineage                 ${plan.lineageId}`);
  console.log(`  symbol / interval       ${request.symbol} / ${request.chartInterval}`);
  console.log(`  history start           ${iso(request.historyStartMs)}   (HTF context from ${iso(contextStartMs)})`);
  console.log(`  switchover              ${iso(request.switchoverMs)}`);
  console.log(`  state sha256 at switch  ${plan.stateSha256AtSwitchover}`);
  console.log(`  causal catch-up         ${iso(plan.catchUp.fromMs)} -> ${iso(plan.catchUp.toMs)} (${plan.catchUp.bars} bar(s), REPLAYED_NON_ACTIONABLE)`);
  console.log(`  checkpoint              ${plan.checkpointStatus}; hwm ${iso(plan.hwmOpenTimeMs)}; state ${plan.checkpointBody.stateSha256}`);
  console.log(`  readiness               NOT READY — connecting to ${streamUrl}`);
  console.log(`  current bar             will be QUARANTINED_CURRENT_BAR; first LIVE_ELIGIBLE bar is the next fresh boundary`);
  console.log(`  shadow evidence         ${events.file}`);

  const session = new LiveShadowSession({
    plan,
    checkpoints,
    events,
    nowMs: () => Date.now(),
    nowIso: () => iso(Date.now()),
    persistClosedBar: (bar) => {
      const current = cache.load(request.marketType, request.symbol, request.chartInterval)?.klines ?? [];
      cache.save(request.marketType, request.symbol, request.chartInterval, mergeClosedKlines(current, [bar]), iso(Date.now()));
    },
  });
  const runner = new LiveShadowRunner({
    session,
    url: streamUrl,
    symbol: request.symbol,
    interval: request.chartInterval,
    openStream: openPublicStream,
    fetchClosedBars,
    nowMs: () => Date.now(),
    log: (line) => console.log(`[${iso(Date.now())}] ${line}`),
  });

  let attempt = 0;
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    runner.disconnect("operator stop");
    console.log("stopped by operator; checkpoint and shadow evidence are on disk");
    process.exit(0);
  });

  runner.connect();
  for (;;) {
    await sleep(1_000);
    if (stopping) return;
    // Bounded: no OPEN, no valid update after OPEN, or a stale ready stream all fail visibly.
    runner.checkTimeouts();
    if (runner.lifecycle === "READINESS_ESTABLISHED") attempt = 0;
    if (!runner.connected) {
      const delayMs = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      console.log(`[${iso(Date.now())}] STREAM_RECONNECT in ${delayMs / 1000}s (attempt ${attempt + 1}); recovering any closed gap first`);
      await sleep(delayMs);
      attempt += 1;
      try {
        await runner.recoverAndReconnect();
      } catch (error) {
        console.error(`recovery failed (${error instanceof Error ? error.name : "unknown"}): ${error instanceof Error ? error.message : ""}`);
        if (error instanceof LiveShadowError && error.code !== "RECOVERY_REQUIRED") throw error;
      }
    }
  }
}

void main().catch((error: unknown) => {
  if (
    error instanceof ScannerDataError ||
    error instanceof KlineCacheError ||
    error instanceof ScannerPathError ||
    error instanceof CompatReplayError ||
    error instanceof ScannerLineageError ||
    error instanceof LiveShadowError ||
    error instanceof LiveStreamError
  ) {
    const code = "code" in error ? ` (${String((error as { code: unknown }).code)})` : "";
    console.error(`REFUSED${code}: ${error.message}`);
  } else {
    console.error(`LIVE SHADOW FAILED (${error instanceof Error ? error.name : "unknown"})`);
  }
  process.exitCode = 1;
});

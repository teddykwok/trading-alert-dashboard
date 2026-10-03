import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Slice 2A guard: the scanner's data layer can read public market data and do
 * nothing else. It must never reach an account, a credential, a signed client,
 * a database, a queue, the webhook, alerts or execution — and only its one CLI
 * entrypoint may touch the real network, the real clock or the environment.
 */

const SCANNER_DIR = path.resolve(__dirname, "../src/modules/native-scanner");
/** The CLI entrypoints: causal replay (2A), compatibility replay (2B-2A), live shadow scanner (2B-2B), read-only candidate ranker, read-only parity audit, live shadow supervisor. */
const CLI_FILES = ["run-historical-replay.ts", "run-compat-replay.ts", "run-live-shadow.ts", "run-candidate-rank.ts", "run-parity-audit.ts", "run-live-shadow-supervisor.ts"];
const LIVE_CLI_FILE = "run-live-shadow.ts";
const SUPERVISOR_CLI_FILE = "run-live-shadow-supervisor.ts";
const PATHS_FILE = "scanner-paths.ts";

const sources = readdirSync(SCANNER_DIR)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, text: readFileSync(path.join(SCANNER_DIR, file), "utf8") }));

/** Comments removed, so prose cannot trip or hide from the scan. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const importsOf = (text: string) =>
  [...code(text).matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm)].map(
    (match) => match[1] ?? match[2]
  );

describe("the native scanner data layer", () => {
  it("consists of exactly the Slice 2A, 2B-2A, 2B-2B, candidate-ranker, parity-audit, supervisor and profile modules", () => {
    expect(sources.map((s) => s.file).sort()).toEqual([
      "binance-public-futures.ts",
      "candidate-rank-cli-args.ts",
      "candidate-rank-runner.ts",
      "candidate-ranker.ts",
      "canonical-json.ts",
      "compat-replay-cli-args.ts",
      "compat-replay-runner.ts",
      "compat-replay.ts",
      "historical-replay-runner.ts",
      "historical-replay.ts",
      "kline-cache.ts",
      "kline-fetcher.ts",
      "live-kline-stream.ts",
      "live-shadow-checkpoint.ts",
      "live-shadow-cli-args.ts",
      "live-shadow-runner.ts",
      "live-shadow-session.ts",
      "live-shadow-store.ts",
      "live-shadow-supervisor-cli-args.ts",
      "live-shadow-supervisor.ts",
      "parity-audit-runner.ts",
      "parity-audit.ts",
      "replay-cli-args.ts",
      "run-candidate-rank.ts",
      "run-compat-replay.ts",
      "run-historical-replay.ts",
      "run-live-shadow-supervisor.ts",
      "run-live-shadow.ts",
      "run-parity-audit.ts",
      "scanner-lineage.ts",
      "scanner-lock.ts",
      "scanner-paths.ts",
      "scanner-profile.ts",
      "supervisor-run-manifest.ts",
      "symbol-stream-channel.ts",
      "usdm-universe.ts",
    ]);
  });

  it("imports only node built-ins, the shared engine, its own modules, and (CLI only) the generic bootstrap and config", () => {
    for (const { file, text } of sources) {
      for (const specifier of importsOf(text)) {
        const allowed =
          specifier.startsWith("node:") ||
          specifier === "@trading-alert-dashboard/shared" ||
          /^\.\/[a-z-]+$/.test(specifier) ||
          (CLI_FILES.includes(file) && ["../../config/bootstrap-generic", "../../config/env"].includes(specifier));
        expect({ file, specifier, allowed }).toEqual({ file, specifier, allowed: true });
      }
    }
  });

  // 41.
  it.each([
    ["Prisma", /prisma/i],
    ["Redis", /redis/i],
    ["BullMQ", /bullmq/i],
    ["execution modules", /\/execution\//],
    ["signed Binance clients", /binance-execution|binance\.client|binance-read-only|binance-account|BinanceUsdMExecutionClient|BinanceReadOnlyClient/],
    ["exchange runtime binding", /exchange-runtime-binding|bindConfigured|exchangeClientOptionsOf/],
    ["webhook", /webhook/i],
    ["alerts service", /alerts\.service|AlertsService|alert\.create/],
    ["account bootstrap", /bootstrap-account|account-env/],
    ["credential names", /BINANCE_API_KEY|BINANCE_API_SECRET|apiSecret|OPERATOR_API_TOKEN|WEBHOOK_SECRET|DATABASE_URL|REDIS_URL/],
    ["signing", /createHmac|X-MBX|signature/i],
    // The analysis path's module and its exports (its mock fallback and its
    // TradingView interval table must never reach the scanner).
    [
      "the analysis market-data path",
      /modules\/market-data|market-data\.service|getRecentCandles|getClosedCandlesBefore|generateMockCandles|TIMEFRAME_TO_BINANCE_INTERVAL/,
    ],
    ["host-timezone accessors", /\.get(FullYear|Month|Date|Day|Hours|Minutes|Seconds|TimezoneOffset)\(|toLocale/],
  ])("never references %s", (_label, pattern) => {
    for (const { file, text } of sources) {
      expect({ file, hit: code(text).match(pattern)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  it("only the CLIs may use the real network, the real clock or timers", () => {
    for (const { file, text } of sources) {
      if (CLI_FILES.includes(file)) continue;
      const body = code(text);
      expect({ file, hit: body.match(/\bfetch\s*\(|Date\.now|setTimeout|setInterval/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  it("only the CLIs read process.env; the paths helper takes the environment as an argument", () => {
    for (const { file, text } of sources) {
      if (CLI_FILES.includes(file)) continue;
      expect({ file, hit: code(text).match(/process\.env/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
    expect(code(readFileSync(path.join(SCANNER_DIR, PATHS_FILE), "utf8"))).toMatch(/env: NodeJS\.ProcessEnv/);
  });

  it.each(CLI_FILES)("%s: its FIRST import is the generic, credential-free bootstrap", (cliFile) => {
    const cli = code(sources.find((s) => s.file === cliFile)!.text);
    expect(importsOf(cli)[0]).toBe("../../config/bootstrap-generic");
  });

  it.each(CLI_FILES)("%s: refuses redirects and sends only the controller's headers", (cliFile) => {
    const cli = code(sources.find((s) => s.file === cliFile)!.text);
    expect(cli).toContain('redirect: "error"');
    expect(cli).toContain("headers: init.headers");
    expect(cli).toContain('method: "GET"');
  });

  it("the package exposes exactly six scanner scripts: causal replay, compatibility replay, live shadow, candidate rank, parity audit, live shadow supervisor", () => {
    const scripts = (JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as { scripts: Record<string, string> })
      .scripts;
    expect(Object.entries(scripts).filter(([name, command]) => /scanner/.test(name) || /native-scanner/.test(command))).toEqual([
      ["scanner:replay", "tsx src/modules/native-scanner/run-historical-replay.ts"],
      ["scanner:compat-replay", "tsx src/modules/native-scanner/run-compat-replay.ts"],
      ["scanner:live-shadow", "tsx src/modules/native-scanner/run-live-shadow.ts"],
      ["scanner:live-shadow-supervisor", "tsx src/modules/native-scanner/run-live-shadow-supervisor.ts"],
      ["scanner:candidate-rank", "tsx src/modules/native-scanner/run-candidate-rank.ts"],
      ["scanner:parity-audit", "tsx src/modules/native-scanner/run-parity-audit.ts"],
    ]);
  });

  it("only the two live CLIs open a WebSocket, and only through the public kline stream builders", () => {
    for (const { file, text } of sources) {
      const opens = /new\s+WebSocket\s*\(/.test(code(text));
      expect({ file, opens }).toEqual({ file, opens: file === LIVE_CLI_FILE || file === SUPERVISOR_CLI_FILE });
    }
    const supervisorCli = code(sources.find((s) => s.file === SUPERVISOR_CLI_FILE)!.text);
    expect(supervisorCli.match(/new\s+WebSocket\s*\([^)]*\)/g)).toEqual(["new WebSocket(url)"]);
    // The supervisor's URL comes only from the combined public kline builder.
    const supervisor = code(sources.find((s) => s.file === "live-shadow-supervisor.ts")!.text);
    expect(supervisor).toContain("buildPublicCombinedKlineStreamUrl(symbols, this.config.lineage.chartInterval)");
    const live = code(sources.find((s) => s.file === LIVE_CLI_FILE)!.text);
    expect(live).toContain("buildPublicKlineStreamUrl(request.symbol, request.chartInterval)");
    // Exactly one argument: the URL. No sub-protocols, no options object, so no header can ride along.
    expect(live.match(/new\s+WebSocket\s*\([^)]*\)/g)).toEqual(["new WebSocket(url)"]);
  });

  it("the stream lives on the routed /market raw path; the decommissioned un-routed /ws/ path appears nowhere", () => {
    for (const { file, text } of sources) {
      expect({ file, hit: code(text).match(/fstream\.binance\.com\/ws\/|["'`]\/ws\//)?.[0] ?? null }).toEqual({ file, hit: null });
    }
    const stream = code(sources.find((s) => s.file === "live-kline-stream.ts")!.text);
    expect(stream).toContain('PUBLIC_FUTURES_MARKET_WS_PATH = "/market/ws/"');
  });

  it("the live CLI reports every socket lifecycle event and enforces the bounded timeouts", () => {
    const live = code(sources.find((s) => s.file === LIVE_CLI_FILE)!.text);
    expect(live).toContain('socket.addEventListener("open", () => handlers.onOpen())');
    expect(live).toMatch(/socket\.addEventListener\("error", \(\) => handlers\.onError\(/);
    expect(live).toMatch(/socket\.addEventListener\("close", \(event\) => handlers\.onClose\(/);
    expect(live).toContain("runner.checkTimeouts()");
  });

  it("no scanner module can express a listen key, a user-data stream or an actionable record", () => {
    for (const { file, text } of sources) {
      const body = code(text);
      expect({ file, hit: body.match(/listenKey|userData|user-data|\/fapi\/v\d\/listen/i)?.[0] ?? null }).toEqual({ file, hit: null });
      expect({ file, hit: body.match(/actionable:\s*true/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });
});

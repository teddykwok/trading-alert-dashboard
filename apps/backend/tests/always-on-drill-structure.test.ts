import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ALWAYS_ON_CLI_USAGE, AlwaysOnCliUsageError, parseAlwaysOnCliArgs } from "../src/modules/always-on/always-on-cli-args";
import { alwaysOnPaths } from "../src/modules/always-on/always-on-paths";
import { startupTaskXml } from "../src/modules/always-on/always-on-startup-task";
import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { SupervisorCliUsageError, parseSupervisorCliArgs } from "../src/modules/native-scanner/live-shadow-supervisor-cli-args";

/**
 * THE OPERATOR NETWORK DRILL — negative security and structure. The drill can
 * be started ONLY by the dedicated `monitoring:always-on drill start` command
 * against the running supervisor; nothing else in the program can express it:
 * no environment variable, no `run` / scanner / startup-task option, no route,
 * no frontend request, no launcher item, no network listener — and only the
 * Always-On module and the scanner's own entrypoint can even import it.
 */

const BACKEND = path.resolve(__dirname, "..");
const REPO = path.resolve(BACKEND, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const backendSources = sourceFiles(path.join(BACKEND, "src")).map((file) => ({ file: path.relative(BACKEND, file).split(path.sep).join("/"), text: readFileSync(file, "utf8") }));
const DRILL_MODULES = /(?:\.\/|\/)(?:always-on-drill|public-transport-drill)["']/;

describe("nothing outside the dedicated command can activate a drill", () => {
  it("no production module reads an environment variable naming a drill (or a fault, simulation, injection or proxy)", () => {
    const selector = /(?:process\.env|\benv|processEnv)(?:\.|\[\s*["'])\w*(?:DRILL|(?<!DE)FAULT|SIMULAT|CHAOS|INJECT|OFFLINE|PROXY)\w*/i;
    expect(selector.test("process.env.ALWAYS_ON_DRILL")).toBe(true);
    expect(selector.test('env["NETWORK_DRILL_MODE"]')).toBe(true);
    expect(backendSources.filter(({ text }) => selector.test(code(text))).map((s) => s.file)).toEqual([]);
  });

  it("only the Always-On module and the scanner's own entrypoint import the drill modules (never the backend, an account, execution, the emitter or the planner)", () => {
    const importers = backendSources.filter(({ text }) => DRILL_MODULES.test(text)).map((s) => s.file).sort();
    for (const file of importers) {
      expect({ file, allowed: file.startsWith("src/modules/always-on/") || file === "src/modules/native-scanner/run-live-shadow-supervisor.ts" }).toEqual({ file, allowed: true });
    }
    expect(importers).toContain("src/modules/native-scanner/run-live-shadow-supervisor.ts");
    expect(importers).toContain("src/modules/always-on/always-on-supervisor.ts");
    // The launcher (and through it Account A/B) reads only the status renderer, whose drill import is type-only.
    const status = readFileSync(path.join(BACKEND, "src/modules/always-on/always-on-status.ts"), "utf8");
    for (const line of status.split(/\r?\n/).filter((l) => DRILL_MODULES.test(l))) expect(line).toMatch(/^import type /);
  });

  it("the drill modules import exactly their contract and transport types — nothing that reaches a cursor, ledger, account, credential or execution path", () => {
    const importsOf = (rel: string) => [...code(readFileSync(path.join(BACKEND, rel), "utf8")).matchAll(/^\s*import\s[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
    expect(importsOf("src/modules/always-on/always-on-drill.ts")).toEqual(["../native-scanner/public-transport-drill", "./always-on-contract"]);
    expect(importsOf("src/modules/native-scanner/public-transport-drill.ts")).toEqual(["./kline-fetcher", "./live-shadow-runner"]);
    for (const rel of ["src/modules/always-on/always-on-drill.ts", "src/modules/native-scanner/public-transport-drill.ts"]) {
      expect({ rel, hit: code(readFileSync(path.join(BACKEND, rel), "utf8")).match(/cursor|ledger|rebaseline|scanner-lock|acquireLiveShadowLock|apiKey|apiSecret|API_KEY|placeOrder|newOrder|createOrder|execution-worker|native-canary|binance-execution|prisma/i)?.[0] ?? null }).toEqual({ rel, hit: null });
    }
  });

  it("the drill modules open no listener, no socket of their own and no HTTP surface, and never build or rewrite a URL", () => {
    for (const rel of ["src/modules/always-on/always-on-drill.ts", "src/modules/native-scanner/public-transport-drill.ts"]) {
      const body = code(readFileSync(path.join(BACKEND, rel), "utf8"));
      expect({ rel, hit: body.match(/node:net|node:http|node:https|createServer|\.listen\(|new WebSocket|\bfetch\s*\(|new URL\(|\.replace\([^)]*url|process\.env/i)?.[0] ?? null }).toEqual({ rel, hit: null });
    }
  });

  it("`run`, the scanner and the startup task accept no drill option; the startup task never mentions one", () => {
    for (const flag of ["--drill", "--drill-file", "--network-drill", "--drill-fault"]) {
      expect(() => parseAlwaysOnCliArgs(["run", flag])).toThrow(AlwaysOnCliUsageError);
      expect(() => parseSupervisorCliArgs(["--profile", "teddy-7-all-active", flag, "x"])).toThrow(SupervisorCliUsageError);
    }
    const run = parseAlwaysOnCliArgs(["run"]);
    expect(JSON.stringify(run)).not.toMatch(/drill/i);
    expect(startupTaskXml({ taskName: "TeddyAlwaysOnMonitoring", repoRoot: "C:\\repo", runArgs: [], userId: null })).not.toMatch(/drill/i);
  });

  it("the drill command parses strictly: a known fault, 10..900 seconds, the generation and the run it targets — nothing else", () => {
    expect(parseAlwaysOnCliArgs(["drill", "start", "--fault", "PUBLIC_REST_DOWN", "--duration-seconds", "120", "--generation", "3", "--run-id", "20261025T030000Z-0a1b2c3d"])).toEqual({
      command: "drill-start",
      fault: "PUBLIC_REST_DOWN",
      durationSeconds: 120,
      generation: 3,
      runId: "20261025T030000Z-0a1b2c3d",
    });
    expect(parseAlwaysOnCliArgs(["drill", "restore"])).toEqual({ command: "drill-restore" });
    expect(parseAlwaysOnCliArgs(["drill", "status"])).toEqual({ command: "drill-status" });
    for (const argv of [
      ["drill"],
      ["drill", "start"],
      ["drill", "start", "--fault", "PUBLIC_EVERYTHING", "--duration-seconds", "60", "--generation", "3", "--run-id", "20261025T030000Z-0a1b2c3d"],
      ["drill", "start", "--fault", "PUBLIC_REST_DOWN", "--duration-seconds", "901", "--generation", "3", "--run-id", "20261025T030000Z-0a1b2c3d"],
      ["drill", "start", "--fault", "PUBLIC_REST_DOWN", "--duration-seconds", "60", "--run-id", "20261025T030000Z-0a1b2c3d"],
      ["drill", "start", "--fault", "PUBLIC_REST_DOWN", "--duration-seconds", "60", "--generation", "3"],
      ["drill", "start", "--fault", "PUBLIC_REST_DOWN", "--duration-seconds", "60", "--generation", "3", "--run-id", "latest"],
      ["drill", "start", "--fault", "PUBLIC_REST_DOWN", "--duration-seconds", "60", "--generation", "3", "--run-id", "20261025T030000Z-0a1b2c3d", "--url", "https://x"],
      ["drill", "restore", "--force"],
      ["drill", "explode"],
    ]) {
      expect(() => parseAlwaysOnCliArgs(argv)).toThrow(AlwaysOnCliUsageError);
    }
    expect(ALWAYS_ON_CLI_USAGE).toContain("monitoring:always-on drill start");
  });

  it("the drill request file is written ONLY by the drill-start path of the CLI; no other command, the launcher or the supervisor writes one", () => {
    const entry = code(readFileSync(path.join(BACKEND, "src/modules/always-on/run-always-on-monitoring.ts"), "utf8"));
    expect((entry.match(/paths\.drillRequest/g) ?? []).length).toBeGreaterThan(0);
    const start = entry.indexOf("async function requestDrillStart(");
    expect(start).toBeGreaterThan(0);
    const end = entry.indexOf("\nasync function ", start + 1) === -1 ? entry.indexOf("\nfunction ", start + 1) : Math.min(...[entry.indexOf("\nasync function ", start + 1), entry.indexOf("\nfunction ", start + 1)].filter((i) => i > 0));
    const outside = entry.slice(0, start) + entry.slice(end);
    expect(outside).not.toMatch(/writeTextAtomic\(paths\.drillRequest/);
    for (const rel of ["src/modules/always-on/always-on-supervisor.ts", "src/modules/always-on/always-on-launch.ts", "src/modules/operator/always-on-launcher.ts", "src/modules/operator/run-runtime-launcher.ts"]) {
      expect({ rel, hit: code(readFileSync(path.join(BACKEND, rel), "utf8")).match(/writeTextAtomic\([^)]*drillRequest/)?.[0] ?? null }).toEqual({ rel, hit: null });
    }
  });

  it("the scanner entrypoint builds its drill gate ONLY for a supervisor-spawned run (a cooperative stop file), from that file's own path", () => {
    const scanner = code(readFileSync(path.join(BACKEND, "src/modules/native-scanner/run-live-shadow-supervisor.ts"), "utf8"));
    expect(scanner).toMatch(/const drillGate = stopFile === null \? null : new PublicTransportDrillGate\(\{\s*file: drillFileOf\(stopFile\),\s*runId,/);
    // The real transports are still exactly the real fetch and WebSocket; the gate only wraps them.
    expect(scanner).toMatch(/const publicTransport: PublicHttpTransport = async \(url, init\) => \{\r?\n\s+const response = await fetch\(url, \{/);
    expect(scanner).toMatch(/const openPublicStream: OpenPublicStream = \(url, handlers\) => \{\r?\n\s+const socket = new WebSocket\(url\);/);
  });

  it("no frontend source, backend route or server module names the drill", () => {
    const frontend = sourceFiles(path.join(REPO, "apps", "frontend", "src")).map((file) => ({ file, text: readFileSync(file, "utf8") }));
    expect(frontend.length).toBeGreaterThan(10);
    const pattern = /drill\.json|drill-restore|DRILL_START|always-on-drill|public-transport-drill|monitoring:always-on drill/;
    expect(frontend.filter(({ text }) => pattern.test(text)).map((f) => f.file)).toEqual([]);
    const surface = backendSources.filter(({ file }) => file.startsWith("src/routes/") || file.startsWith("src/plugins/") || file === "src/server.ts" || file === "src/app.ts");
    expect(surface.length).toBeGreaterThan(0);
    expect(surface.filter(({ text }) => pattern.test(text) || /always-on/.test(text)).map((s) => s.file)).toEqual([]);
  });

  it("the runtime launcher offers no drill item", () => {
    for (const rel of ["src/modules/operator/run-runtime-launcher.ts", "src/modules/operator/always-on-launcher.ts", "src/modules/always-on/always-on-launch.ts"]) {
      expect({ rel, hit: code(readFileSync(path.join(BACKEND, rel), "utf8")).match(/drill/i)?.[0] ?? null }).toEqual({ rel, hit: null });
    }
  });

  it("Native execution stays hard-disabled", () => {
    expect(NATIVE_EXECUTION_ENABLED).toBe(false);
  });
});

// ===========================================================================
// The real CLI, as a child process over a temp LOCALAPPDATA (no supervisor, no credentials, no network)
// ===========================================================================

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function cli(args: readonly string[], prepare: (paths: ReturnType<typeof alwaysOnPaths>) => void = () => undefined) {
  const local = mkdtempSync(path.join(tmpdir(), "aon-drill-"));
  dirs.push(local);
  const paths = alwaysOnPaths({ LOCALAPPDATA: local });
  prepare(paths);
  const run = spawnSync(process.execPath, [path.join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs"), "src/modules/always-on/run-always-on-monitoring.ts", ...args], {
    cwd: BACKEND,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { LOCALAPPDATA: local, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  return { run, paths, stdout: `${run.stdout ?? ""}`, stderr: `${run.stderr ?? ""}` };
}

describe("monitoring:always-on drill (the real CLI) without a running supervisor", () => {
  it("drill start refuses: nothing is requested, nothing is written", () => {
    const { run, paths, stdout } = cli(["drill", "start", "--fault", "PUBLIC_REST_DOWN", "--duration-seconds", "60", "--generation", "1", "--run-id", "20261025T030000Z-0a1b2c3d"]);
    expect(run.status).toBe(1);
    expect(stdout).toContain("NOT RUNNING");
    expect(existsSync(paths.drillRequest)).toBe(false);
  }, 90_000);

  it("drill restore still restores: a leftover drill file (a crashed supervisor) is removed, a stop file is not", () => {
    const leftover: string[] = [];
    const { run, stdout } = cli(["drill", "restore"], (paths) => {
      mkdirSync(paths.stopDir, { recursive: true });
      leftover.push(path.join(paths.stopDir, "scanner-g4-s2.drill"), path.join(paths.stopDir, "scanner-g4-s2.stop"));
      writeFileSync(leftover[0], "{}", "utf8");
      writeFileSync(leftover[1], "{}", "utf8");
    });
    expect(run.status).toBe(0);
    expect(stdout).toContain("scanner-g4-s2.drill");
    expect(existsSync(leftover[0])).toBe(false);
    expect(existsSync(leftover[1])).toBe(true);
  }, 90_000);

  it("drill status reads, writes nothing, and `run --drill` is refused before anything starts", () => {
    const status = cli(["drill", "status"]);
    expect(status.run.status).toBe(0);
    expect(existsSync(status.paths.dir)).toBe(false);
    const refused = cli(["run", "--drill", "PUBLIC_REST_DOWN"]);
    expect(refused.run.status).toBe(2);
    expect(refused.stderr).toContain("unexpected argument: --drill");
  }, 90_000);
});

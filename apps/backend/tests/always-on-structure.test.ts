import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { NATIVE_EXECUTION_ENABLED } from "../src/modules/native-canary/native-execution-switch";
import { NATIVE_RISK_CONTRACTS } from "../src/modules/native-canary/native-risk-contract";
import { MUTATION_ACTIONS } from "../src/modules/operator/mutation-lock";

/**
 * ALWAYS-ON MONITORING V1 — structural safety. The value-import closure comes
 * from the TypeScript AST (type-only imports are erased), so "the supervisor
 * cannot reach X" is a fact about the program, not about its comments.
 */

const BACKEND = path.resolve(__dirname, "..");
const AO = "src/modules/always-on";
const AO_FILES = readdirSync(path.join(BACKEND, AO)).map((f) => `${AO}/${f}`).sort();
const ENTRY = `${AO}/run-always-on-monitoring.ts`;
const SUPERVISOR = `${AO}/always-on-supervisor.ts`;

function sourceOf(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, readFileSync(path.join(BACKEND, rel), "utf8"), ts.ScriptTarget.Latest, true);
}

function valueSpecifiers(rel: string): string[] {
  const out: string[] = [];
  for (const s of sourceOf(rel).statements) {
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause;
      if (c?.isTypeOnly) continue;
      const n = c?.namedBindings;
      if (c && !c.name && n && ts.isNamedImports(n) && n.elements.length > 0 && n.elements.every((e) => e.isTypeOnly)) continue;
      out.push((s.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && !s.isTypeOnly) {
      out.push((s.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return out;
}

function resolveRelative(fromRel: string, spec: string): string {
  const base = path.resolve(path.dirname(path.join(BACKEND, fromRel)), spec);
  for (const c of [`${base}.ts`, path.join(base, "index.ts")]) if (existsSync(c)) return path.relative(BACKEND, c).split(path.sep).join("/");
  throw new Error(`unresolved ${spec} from ${fromRel}`);
}

function closure(root: string): { modules: string[]; packages: string[] } {
  const modules = new Set([root]);
  const packages = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    for (const spec of valueSpecifiers(rel)) {
      if (spec.startsWith(".")) {
        const r = resolveRelative(rel, spec);
        if (!modules.has(r)) {
          modules.add(r);
          queue.push(r);
        }
      } else packages.add(spec);
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

const codeOf = (rel: string) =>
  readFileSync(path.join(BACKEND, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const FORBIDDEN_MODULES = [
  /^src\/config\/env\.ts$/,
  /^src\/config\/bootstrap-/,
  /^src\/plugins\//,
  /^src\/modules\/execution\//,
  /^src\/modules\/binance\//,
  /^src\/modules\/native-canary\//,
  /^src\/modules\/native-planning\//,
  /^src\/modules\/runtime\//,
  /^src\/modules\/jobs\//,
  /^src\/routes\//,
];
const FORBIDDEN_PACKAGES = ["@prisma/client", "ioredis", "bullmq", "fastify", "socket.io", "@socket.io/redis-emitter", "@socket.io/redis-adapter", "pino"];

describe("the Always-On supervisor's reach", () => {
  it("the CLI's value-import closure holds no database, environment configuration, Redis, queue, exchange client or execution module", () => {
    const { modules, packages } = closure(ENTRY);
    for (const mod of modules) for (const pattern of FORBIDDEN_MODULES) expect({ mod, forbidden: pattern.test(mod) }).toEqual({ mod, forbidden: false });
    for (const pkg of FORBIDDEN_PACKAGES) expect(packages).not.toContain(pkg);
    expect(packages.filter((p) => !p.startsWith("node:"))).toEqual(["@trading-alert-dashboard/shared", "dotenv"]);
    // The only config module is the pure account-identity contract (dotenv `parse` of key NAMES; never an env load).
    expect(modules.filter((m) => m.startsWith("src/config/"))).toEqual(["src/config/account-env.ts"]);
  });

  it("the launcher's Always-On controls are equally lean", () => {
    for (const root of ["src/modules/operator/always-on-launcher.ts", `${AO}/always-on-launch.ts`]) {
      const { modules, packages } = closure(root);
      for (const mod of modules) for (const pattern of FORBIDDEN_MODULES) expect({ root, mod, forbidden: pattern.test(mod) }).toEqual({ root, mod, forbidden: false });
      for (const pkg of FORBIDDEN_PACKAGES) expect(packages).not.toContain(pkg);
    }
  });

  it("only the machine adapters and the launcher's spawner touch child_process, sockets or HTTP", () => {
    for (const file of AO_FILES) {
      const specs = valueSpecifiers(file);
      const machine = file.endsWith("always-on-machine.ts") || file.endsWith("always-on-launch.ts");
      if (!machine) expect({ file, childProcess: specs.includes("node:child_process"), net: specs.includes("node:net") }).toEqual({ file, childProcess: false, net: false });
      if (!file.endsWith("always-on-machine.ts")) expect({ file, fetch: /\bfetch\s*\(/.test(codeOf(file)) }).toEqual({ file, fetch: false });
    }
  });

  it("only the CLI reads process.env; every other module takes the environment as an argument", () => {
    for (const file of AO_FILES) {
      if (file === ENTRY) continue;
      expect({ file, hit: codeOf(file).match(/process\.env/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  it("the supervisor spawns ONLY inside the fenced start and terminates ONLY inside the fenced stop", () => {
    const code = codeOf(SUPERVISOR);
    expect((code.match(/this\.a\.spawn\(/g) ?? []).length).toBe(1);
    expect(code).toContain("spawnWorker: () => this.a.spawn(built),");
    expect((code.match(/this\.a\.terminate/g) ?? []).length).toBe(1);
    expect(code).toContain("executeFencedStop(child, this.config.repoRoot, { probe: this.a.probe, terminate: this.a.terminate,");
    expect(code).toContain("executeFencedStart(role, {");
    expect(code).not.toMatch(/taskkill|process\.kill|Stop-Process/);
  });

  it("every start and stop runs under the launcher's mutation lock, with the generation fence re-checked under it", () => {
    const code = codeOf(SUPERVISOR);
    expect((code.match(/this\.mutate\("ALWAYS_ON_ROLE_START"/g) ?? []).length).toBe(1);
    expect((code.match(/this\.mutate\("ALWAYS_ON_ROLE_STOP"/g) ?? []).length).toBe(2);
    // The fence is read again UNDER the lock and anything but CURRENT (superseded, or unreadable) runs nothing.
    expect(code).toMatch(/const held = await this\.a\.mutation\(action, async \(\)[^\n]* => \{\s*const fence = this\.fenceState\(\);\s*if \(fence !== "CURRENT"\) return \{ fence \};\s*return \{ fence, value: run\(\) \};/);
    expect([...MUTATION_ACTIONS]).toEqual(expect.arrayContaining(["ALWAYS_ON_START", "ALWAYS_ON_STOP", "ALWAYS_ON_ROLE_START", "ALWAYS_ON_ROLE_STOP"]));
  });

  it("the launcher's Always-On module writes exactly two things: one request file (temporary + rename) and the supervisor's log (append, rotated)", () => {
    // Launcher pin 22 counts only run-runtime-launcher.ts itself; each imported launcher module pins its own writes.
    const code = codeOf(`${AO}/always-on-launch.ts`);
    expect((code.match(/writeFileSync\(/g) ?? []).length).toBe(1);
    expect(code).toContain('writeFileSync(temporary, text, "utf8");');
    expect((code.match(/renameSync\(/g) ?? []).length).toBe(2);
    expect(code).toContain("renameSync(temporary, file);");
    expect(code).toContain("renameSync(file, `${file}.1`);");
    expect((code.match(/openSync\(/g) ?? []).length).toBe(1);
    expect(code).toContain('fd = openSync(file, "a");');
    expect(code).not.toMatch(/appendFileSync|unlinkSync|rmSync|copyFileSync|createWriteStream|writeSync\(/);
  });

  it("the real file system retries transient Windows sharing failures on every ownership open, replace, strict read and removal", () => {
    const code = codeOf(`${AO}/always-on-machine.ts`);
    expect(code).toContain('const fd = retryTransientFs(() => openSync(temporary, "w"));');
    expect(code).toContain("retryTransientFs(() => renameSync(temporary, file));");
    expect(code).toContain('return retryTransientFs(() => readFileSync(file, "utf8"));');
    expect(code).toContain("retryTransientFs(() => unlinkSync(file));");
  });

  it("the CLI never records a supervisor identity it could not read (an unverifiable identity could never be stopped or seen)", () => {
    const code = codeOf(ENTRY);
    expect(code).toMatch(/const selfStart = selfStartedAtMs\(\);\s*if \(selfStart === null\) \{\s*say\("REFUSED: [^"]*"\);\s*await lock\.held\.release\(\);\s*return 1;\s*\}/);
    expect(code).toContain("selfStartedAtMs: selfStart,");
  });

  it("the CLI's stop / status / clear-latch read the supervisor as RUNNING, NOT_RUNNING or UNKNOWN — only a PROVEN exit ends a stop's wait", () => {
    const code = codeOf(ENTRY);
    expect(code).toContain("supervisorLiveness(() => realFileSystem.readTextStrict(paths.ownership), probeProcess)");
    expect(code).toMatch(/if \(still\.kind === "NOT_RUNNING"\) \{\s*say\("The supervisor has exited\."\);\s*return 0;\s*\}/);
    expect((code.match(/The supervisor has exited\./g) ?? []).length).toBe(1);
    // Neither a stop nor a clear-latch is written for a supervisor that could not be observed.
    expect((code.match(/if \(live\.kind === "UNKNOWN"\) \{\s*say\(`The recorded supervisor could not be observed \(\$\{live\.reason\}\); nothing was requested\. Try again\.`\);\s*return 1;\s*\}/g) ?? []).length).toBe(2);
  });

  it("the supervisor deletes nothing but its own request files and stop files: no cursor, namespace, checkpoint or log", () => {
    const code = codeOf(SUPERVISOR);
    // Two helpers are the only direct removers (both tolerate a held file)...
    const removes = code.split("\n").filter((line) => /\.remove\(/.test(line));
    expect(removes.map((line) => line.trim())).toEqual(["this.a.fs.remove(file);", "this.a.fs.remove(file);"]);
    expect(code).toMatch(/private removeQuietly\(file: string\): void \{\s*try \{\s*this\.a\.fs\.remove\(file\);/);
    expect(code).toMatch(/private removeRequest\(file: string\): boolean \{\s*try \{\s*this\.a\.fs\.remove\(file\);/);
    // ...and every call of them names a request file or a child's own stop file.
    const calls = code.split("\n").filter((line) => /this\.(removeQuietly|removeRequest|removeStopFile)\(/.test(line));
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) {
      expect({ line: line.trim(), allowed: /paths\.stopRequest|paths\.clearLatchRequest|paths\.stopDir|child\.stopFile|removeStopFile\(child\)|removeStopFile\(\{ stopFile \} as ChildRecord\)/.test(line) }).toEqual({ line: line.trim(), allowed: true });
    }
    for (const file of AO_FILES) {
      const code = codeOf(file);
      // No path to the cursor rebaseline (its module or its CLI script), the cursor store, or any recursive delete.
      expect({ file, hit: code.match(/native-emitter-cursor-rebaseline|rebaseline-cursors|emitterCursorDir|FileEmitterCursorStore|native-emitter[\\/]+cursors|rmSync|rmdirSync|Remove-Item|deleteMany|\.delete\(\{/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  it("no Always-On module names an account role, a gate, arming or an order path", () => {
    for (const file of [...AO_FILES, "src/modules/operator/always-on-launcher.ts"]) {
      const code = codeOf(file);
      expect({ file, hit: code.match(/account-a|account-b|execution-worker|account-control|LIVE_READY|EXECUTION_LIVE_ENTRY|KILL_SWITCH|armCanary|placeOrder|newOrder|createOrder|signed|BinanceUsdM|BinanceReadOnlyClient/i)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  it("the public connectivity probe is ONE unsigned public server-time request (no header of ours, no credential)", () => {
    const code = codeOf(`${AO}/always-on-machine.ts`);
    const probe = code.slice(code.indexOf("export async function publicBinanceReachable"), code.indexOf("export function genericEnvKeyNames"));
    expect(probe).toContain('buildPublicFuturesUrl("https://fapi.binance.com", SERVER_TIME_PATH)');
    expect(probe).not.toMatch(/headers|X-MBX-APIKEY|signature|apiKey|secret/i);
    // The backend reads are loopback-only by construction.
    expect(code).toContain('!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)');
  });
});

describe("what did NOT change", () => {
  it("Native execution stays hard-disabled (literal false as const, no environment override) and both accounts' risk stays UNRESOLVED", () => {
    expect(NATIVE_EXECUTION_ENABLED).toBe(false);
    const switchSource = codeOf("src/modules/native-canary/native-execution-switch.ts");
    expect(switchSource).toContain("NATIVE_EXECUTION_ENABLED = false as const");
    expect(switchSource).not.toMatch(/process\.env/);
    expect(NATIVE_RISK_CONTRACTS.A.state).toBe("UNRESOLVED");
    expect(NATIVE_RISK_CONTRACTS.B.state).toBe("UNRESOLVED");
  });

  it("no route, endpoint or HTTP surface is added: the backend never imports Always-On", () => {
    for (const file of ["src/app.ts", ...readdirSync(path.join(BACKEND, "src/routes")).map((f) => `src/routes/${f}`)]) {
      expect({ file, hit: /always-on|alwaysOn/i.test(codeOf(file)) }).toEqual({ file, hit: false });
    }
  });

  it("no migration and no schema change", () => {
    const migrations = readdirSync(path.join(BACKEND, "prisma/migrations")).filter((d) => /^\d/.test(d)).sort();
    expect(migrations.at(-1)).toBe("20261002090000_add_native_alert_source_and_delivery");
  });

  it("the official entry point exists and adds no dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.scripts["monitoring:always-on"]).toBe("tsx src/modules/always-on/run-always-on-monitoring.ts");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      ["@fastify/cors", "@fastify/rate-limit", "@fastify/static", "@prisma/client", "@socket.io/redis-adapter", "@socket.io/redis-emitter", "@trading-alert-dashboard/shared", "bullmq", "dotenv", "fastify", "fastify-plugin", "ioredis", "lightweight-charts", "pino", "pino-pretty", "playwright", "socket.io", "zod"].sort()
    );
  });

  it("the scanner and emitter cooperative stops run their EXISTING graceful stop, nothing else", () => {
    const scanner = codeOf("src/modules/native-scanner/run-live-shadow-supervisor.ts");
    expect(scanner).toContain('onStop: () => stop("cooperative stop request"),');
    expect(scanner).toContain('process.on("SIGINT", () => stop("operator stop"));');
    const emitter = codeOf("src/modules/native-alerts/run-native-multi-emitter.ts");
    const from = emitter.indexOf("onStop: () => {");
    const block = emitter.slice(from, emitter.indexOf("exists: existsSync", from));
    expect(block).toContain("stopping = true;");
    expect(block).not.toMatch(/process\.exit|terminate|kill|\.stop\(/);
    // The same flag Ctrl+C sets: the existing loop then ends through emitter.stop(), persisting processed cursors.
    expect(emitter).toContain('process.once("SIGINT", () => (stopping = true));');
  });
});

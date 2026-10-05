import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DUAL_ROLES,
  OPTIONAL_GENERIC_ROLES,
  ROLE_CONTRACTS,
  censusOf,
  classifyEntrypoint,
  projectTopology,
  type ObservedListener,
  type TopologyStatus,
} from "../src/modules/operator/dual-account-topology";
import {
  NONWATCH_BUILD_INSTRUCTION,
  assessNonWatchBuild,
  createNonWatchBackendLauncher,
  decideNonWatchStart,
  judgeGenericBackend,
  nonWatchBackendSpawnPlan,
  type BuildFileSystem,
} from "../src/modules/operator/generic-backend-nonwatch-launcher";
import { MUTATION_ACTIONS } from "../src/modules/operator/mutation-lock";
import type { ObservedProcessNode } from "../src/modules/operator/runtime-launcher";

/**
 * The OFFICIAL NON-WATCH generic backend launcher path (21-35). The REAL
 * launcher module runs against a fake machine: a process tree with parent
 * links, :4000 listeners, a TCP probe and a build tree. Nothing real is
 * spawned, killed, built or installed.
 */

const BACKEND = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(BACKEND, rel), "utf8").replace(/\r\n/g, "\n");
const code = (text: string) => text.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

const node = (pid: number, parentPid: number, commandLine: string, startedAtMs = 1_000): ObservedProcessNode => ({ pid, parentPid, executable: "node.exe", startedAtMs, commandLine });
const cmd = (pid: number, parentPid: number, commandLine: string, startedAtMs = 1_000): ObservedProcessNode => ({ pid, parentPid, executable: "cmd.exe", startedAtMs, commandLine });
const VITE = node(77, 70, "node node_modules/vite/bin/vite.js");
const WATCH_RUNTIME = (pid: number) => node(pid, pid - 1, '"C:\\Program Files\\nodejs\\node.exe" --require preflight.cjs --import loader.mjs src/server.ts');
const status = (watchOwned = false): TopologyStatus => ({
  roles: [{ role: "generic-backend", label: "Generic Backend", presence: watchOwned ? "OWNED" : "OFF", port: 4000, portOpen: null, portLoopbackOk: null, attestation: "NOT_APPLICABLE" }],
  entrypointCounts: {},
  anyExternal: false,
});

/** A build tree: every source has its output, outputs newer than sources (unless told otherwise). */
function buildFs(repoRoot: string, over: { missing?: string[]; stale?: string[] } = {}): BuildFileSystem {
  const files = new Map<string, number>();
  const add = (src: string, out: string, rels: string[]) => {
    for (const rel of rels) {
      files.set(path.join(repoRoot, src, rel), 1_000);
      const output = path.join(repoRoot, out, rel.replace(/\.ts$/, ".js"));
      if (!(over.missing ?? []).includes(rel)) files.set(output, (over.stale ?? []).includes(rel) ? 500 : 2_000);
    }
  };
  add("apps/backend/src", "apps/backend/dist/src", ["server.ts", "app.ts", "modules/x/y.ts"]);
  add("packages/shared/src", "packages/shared/dist/cjs", ["index.ts", "extreme-rr.ts"]);
  return {
    listFiles: (dir) => [...files.keys()].filter((f) => f.startsWith(dir + path.sep)),
    mtimeMs: (file) => files.get(file) ?? null,
  };
}

/** A fake machine around the REAL module. */
function machine(options: { tree?: ObservedProcessNode[]; listeners?: ObservedListener[]; portOpen?: boolean; build?: { missing?: string[]; stale?: string[] }; exitsAtOnce?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "nonwatch-launcher-"));
  const envDir = path.join(dir, "trading-alert-dashboard", "env");
  mkdirSync(envDir, { recursive: true });
  writeFileSync(path.join(envDir, "generic.env"), "DATABASE_URL=postgresql://x\nREDIS_URL=redis://x\n");
  const repoRoot = path.join(dir, "repo");
  const tree = new Map<number, ObservedProcessNode>([[VITE.pid, VITE], ...(options.tree ?? []).map((n) => [n.pid, n] as const)]);
  let listeners: ObservedListener[] = [...(options.listeners ?? [])];
  let nextPid = 500;
  let treeOk = true;
  const spawns: { pid: number; plan: { command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } } }[] = [];
  const killed: number[] = [];
  const locks: string[] = [];
  const lines: string[] = [];
  const adapters = {
    repoRoot,
    statePath: path.join(dir, "state", "runtime-launcher-state.json.generic-backend-nonwatch.json"),
    env: { LOCALAPPDATA: dir, PATH: "p", ComSpec: "C:\\Windows\\system32\\cmd.exe" } as NodeJS.ProcessEnv,
    buildFileSystem: buildFs(repoRoot, options.build),
    observeProcessTree: () => (treeOk ? { ok: true as const, value: [...tree.values()] } : { ok: false as const, reason: "COMMAND_FAILED" as const }),
    observeListeners: () => listeners,
    portOpen: async () => options.portOpen ?? listeners.length > 0,
    probeProcesses: (pids: number[]) => ({ ok: true as const, value: new Map(pids.flatMap((pid) => (tree.has(pid) ? [[pid, { pid, commandLine: tree.get(pid)!.commandLine, startedAtMs: tree.get(pid)!.startedAtMs }] as const] : []))) }),
    terminate: (pid: number) => {
      killed.push(pid);
      // taskkill /T: the root and its descendants, nothing else.
      const doomed = new Set([pid]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const n of tree.values()) if (!doomed.has(n.pid) && doomed.has(n.parentPid)) (doomed.add(n.pid), (grew = true));
      }
      for (const p of doomed) tree.delete(p);
      listeners = listeners.filter((l) => !doomed.has(l.pid));
      return true;
    },
    spawnRole: (_role: string, plan: never) => {
      const root = nextPid;
      nextPid += 10;
      spawns.push({ pid: root, plan });
      if (options.exitsAtOnce) return root; // crashed before anything could be observed
      tree.set(root, cmd(root, 1, `C:\\Windows\\system32\\cmd.exe /d /s /c node ${path.join(repoRoot, "apps", "backend", "dist", "src", "server.js")}`, 2_000));
      tree.set(root + 1, node(root + 1, root, `node ${path.join(repoRoot, "apps", "backend", "dist", "src", "server.js")}`, 2_001));
      listeners.push({ port: 4000, address: "0.0.0.0", pid: root + 1 });
      return root;
    },
    gateAllows: () => true,
    lockAdapters: () => ({ authority: { acquire: async (action: string) => (locks.push(action), { ok: true as const, held: { action, release: async () => ({ released: true }) } }) }, log: () => undefined }) as never,
    log: (line: string) => void lines.push(line),
    sleep: async () => undefined,
  };
  const launcher = createNonWatchBackendLauncher(adapters as never);
  const state = () => JSON.parse(readFileSync(adapters.statePath, "utf8")) as { processes: Array<{ pid: number; role: string; startedAtMs: number }> };
  const crash = (root: number) => {
    tree.delete(root);
    tree.delete(root + 1);
    listeners = listeners.filter((l) => l.pid !== root + 1);
  };
  return { adapters, launcher, tree, spawns, killed, locks, lines, state, crash, setTreeOk: (ok: boolean) => (treeOk = ok), out: () => lines.join("\n"), repoRoot };
}

// ===========================================================================
// 21-23. One start, visible as NON-WATCH, never a second
// ===========================================================================

describe("21-23. a free :4000 and a current build: exactly one non-watch backend", () => {
  it("21. starts exactly one `node <repo>\\apps\\backend\\dist\\src\\server.js` under the lock, records it, and sees it listening", async () => {
    const m = machine();
    await m.launcher.start(status());
    expect(m.spawns).toHaveLength(1);
    const plan = m.spawns[0].plan;
    expect(plan.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(plan.args).toEqual(["/d", "/s", "/c", "node", path.join(m.repoRoot, "apps", "backend", "dist", "src", "server.js")]);
    expect(plan.options.cwd).toBe(path.join(m.repoRoot, "apps", "backend"));
    expect(plan.options.env.DOTENV_CONFIG_PATH).toBe(path.join(m.adapters.env.LOCALAPPDATA!, "trading-alert-dashboard", "env", "generic.env"));
    expect(m.locks).toEqual(["GENERIC_BACKEND_NONWATCH_START"]);
    expect(m.state().processes).toEqual([expect.objectContaining({ role: "generic-backend-nonwatch", pid: 500, startedAtMs: 2_000 })]);
    expect(m.out()).toContain("RUNNING — NON-WATCH on :4000");
  });

  it("22. the status line names the mode NON-WATCH and the owned pid", async () => {
    const m = machine();
    await m.launcher.start(status());
    expect(await m.launcher.statusLines(status())).toEqual(["Generic backend mode: RUNNING — NON-WATCH (launcher-owned, pid 500)"]);
  });

  it("23. a second start reports it already running and spawns nothing", async () => {
    const m = machine();
    await m.launcher.start(status());
    await m.launcher.start(status());
    expect(m.spawns).toHaveLength(1);
    expect(m.out()).toContain("the launcher-owned non-watch backend already holds :4000; nothing was started");
  });
});

// ===========================================================================
// 24-25. Port safety
// ===========================================================================

describe("24-25. :4000 held by anything else: refused, nothing spawned, nothing killed", () => {
  it("24. a WATCH backend (Start SAFE-owned or external) holds :4000 -> refused; status RUNNING — WATCH", async () => {
    for (const watchOwned of [true, false]) {
      const m = machine({ tree: [cmd(10, 1, "cmd /c pnpm dev"), WATCH_RUNTIME(11)], listeners: [{ port: 4000, address: "0.0.0.0", pid: 11 }] });
      await m.launcher.start(status(watchOwned));
      expect(m.spawns, String(watchOwned)).toHaveLength(0);
      expect(m.killed).toEqual([]);
      expect(m.out()).toMatch(/REFUSED — a WATCH backend holds :4000/);
      expect((await m.launcher.statusLines(status(watchOwned)))[0]).toBe(
        `Generic backend mode: RUNNING — WATCH (${watchOwned ? "Start SAFE (launcher-owned, tsx watch)" : "external tsx watch tree, not launcher-owned"})`
      );
    }
  });

  it("25. a foreign or unproven :4000 owner fails closed", async () => {
    const cases = {
      // Something that is not a generic backend at all.
      foreign: machine({ tree: [node(40, 1, "node C:\\other\\app.js")], listeners: [{ port: 4000, address: "0.0.0.0", pid: 40 }] }),
      // A holder the process table does not show (another executable).
      invisible: machine({ listeners: [{ port: 4000, address: "0.0.0.0", pid: 9999 }] }),
      // A manually started non-watch backend: right command line, NOT under a root this launcher owns.
      manualNonWatch: machine({ tree: [node(9476, 8000, "node dist/src/server.js")], listeners: [{ port: 4000, address: "0.0.0.0", pid: 9476 }] }),
      // The port answers but no listener could be observed.
      portOnly: machine({ portOpen: true }),
      // Two holders.
      two: machine({ tree: [node(41, 1, "node a.js"), node(42, 1, "node b.js")], listeners: [{ port: 4000, address: "0.0.0.0", pid: 41 }, { port: 4000, address: "::", pid: 42 }] }),
    };
    for (const [name, m] of Object.entries(cases)) {
      await m.launcher.start(status());
      expect(m.spawns, name).toHaveLength(0);
      expect(m.killed, name).toEqual([]);
      expect(m.out(), name).toMatch(/REFUSED — (CONFLICT|UNPROVEN)/);
    }
    expect((await cases.manualNonWatch.launcher.statusLines(status()))[0]).toMatch(/^Generic backend mode: UNPROVEN \(a non-watch backend this launcher did not start/);
    expect((await cases.foreign.launcher.statusLines(status()))[0]).toMatch(/^Generic backend mode: CONFLICT/);
  });

  it("an unobservable process table refuses the start (UNKNOWN is never OFF)", async () => {
    const m = machine();
    m.setTreeOk(false);
    await m.launcher.start(status());
    expect(m.spawns).toHaveLength(0);
    expect(m.out()).toContain("processes could not be observed (COMMAND_FAILED) — nothing was started");
    expect(await m.launcher.statusLines(status())).toEqual(["Generic backend mode: UNKNOWN (processes could not be observed: COMMAND_FAILED)"]);
  });

  it("a non-watch runtime appearing between the decision and the spawn is caught by the fresh pre-spawn census", async () => {
    const m = machine();
    let calls = 0;
    const original = m.adapters.observeProcessTree;
    m.adapters.observeProcessTree = () => {
      calls += 1;
      // Decision sees an empty machine; the census immediately before the spawn sees a watch runtime.
      return calls === 1 ? original() : { ok: true as const, value: [...m.tree.values(), WATCH_RUNTIME(61)] };
    };
    await m.launcher.start(status());
    expect(m.spawns).toHaveLength(0);
    expect(m.out()).toContain("DUPLICATE_PRESENT");
  });
});

// ===========================================================================
// 26-28, 31. Crash, stop, PID reuse, isolation
// ===========================================================================

describe("26-28, 31. it stays down after a crash; stop proves ownership; the rest of the machine is untouched", () => {
  it("26. an owned backend that exits reads OFF with an EXITED notice -- and nothing restarts it", async () => {
    const m = machine();
    await m.launcher.start(status());
    m.crash(500);
    const lines = await m.launcher.statusLines(status());
    expect(lines[0]).toBe("Generic backend mode: OFF (nothing holds :4000)");
    expect(lines[1]).toMatch(/pid 500\) has EXITED\. It is not restarted automatically/);
    // Status reads (and any number of them) never spawn.
    for (let i = 0; i < 5; i += 1) await m.launcher.statusLines(status());
    expect(m.spawns).toHaveLength(1);
    // There is no supervision surface at all.
    expect(Object.keys(m.launcher).sort()).toEqual(["start", "statusLines", "stop"]);
  });

  it("26b. a backend that dies before listening is reported EXITED and not restarted", async () => {
    const m = machine({ exitsAtOnce: true });
    await m.launcher.start(status());
    expect(m.spawns).toHaveLength(1);
    expect(m.out()).not.toContain("started, pid");
    expect(m.out()).toMatch(/OWNERSHIP_UNPROVEN|EXITED/);
  });

  it("27/31. stop proves ownership and terminates exactly the recorded root's tree; vite and anything else survive", async () => {
    const m = machine({ tree: [node(9476, 8000, "node dist/src/server.js")] });
    // (the unowned non-watch runtime has no listener here, so the machine is UNPROVEN; start it separately)
    const clean = machine();
    await clean.launcher.start(status());
    clean.locks.length = 0;
    await clean.launcher.stop(status());
    expect(clean.killed).toEqual([500]);
    expect(clean.locks).toEqual(["GENERIC_BACKEND_NONWATCH_STOP"]);
    expect(clean.tree.has(VITE.pid)).toBe(true);
    expect(clean.state().processes).toEqual([]);
    expect(clean.out()).toContain("Nothing else was terminated.");
    // A launcher that owns nothing kills nothing, whatever is running.
    await m.launcher.stop(status());
    expect(m.killed).toEqual([]);
    expect(m.out()).toContain("This launcher owns no Generic Backend (non-watch), so there is nothing for it to stop.");
  });

  it("28. a reused pid or a process from another checkout is NEVER killed, and the record is kept", async () => {
    const m = machine();
    await m.launcher.start(status());
    // The recorded root exits and the OS hands its pid to something else.
    m.crash(500);
    m.tree.set(500, cmd(500, 1, "cmd.exe /c something-else", 9_999_999));
    await m.launcher.stop(status());
    expect(m.killed).toEqual([]);
    expect(m.out()).toMatch(/NOT stopped \(OWNERSHIP_LOST: PID_REUSED\); its ownership record was kept/);
    expect(m.state().processes.map((p) => p.pid)).toEqual([500]);
    expect((await m.launcher.statusLines(status()))[1]).toMatch(/no longer provably ours \(PID_REUSED\); it will never be terminated/);

    const other = machine();
    await other.launcher.start(status());
    other.tree.set(500, cmd(500, 1, "cmd.exe /c node C:\\another-checkout\\apps\\backend\\dist\\src\\server.js", 2_000));
    await other.launcher.stop(status());
    expect(other.killed).toEqual([]);
    expect(other.out()).toContain("NOT_THIS_REPO");
  });

  it("an owned root alive but not listening is UNPROVEN, and a start does not add a second backend beside it", async () => {
    const m = machine();
    await m.launcher.start(status());
    // The runtime is gone (and so is its listener); the cmd root is still alive.
    m.tree.delete(501);
    m.adapters.observeListeners = () => [];
    m.adapters.portOpen = async () => false;
    await m.launcher.start(status());
    expect(m.spawns).toHaveLength(1);
    expect(m.out()).toMatch(/REFUSED — UNPROVEN: the launcher-owned non-watch tree is alive but not listening/);
  });
});

// ===========================================================================
// 29-30. Build prerequisite; nothing is built, installed or generated
// ===========================================================================

describe("29-30. missing or stale build output refuses; the launcher never builds, installs or generates", () => {
  it("29. missing backend or shared output, or a source newer than its build -> refused with the build command", async () => {
    for (const build of [{ missing: ["server.ts"] }, { missing: ["extreme-rr.ts"] }, { stale: ["modules/x/y.ts"] }, { stale: ["index.ts"] }]) {
      const m = machine({ build });
      await m.launcher.start(status());
      expect(m.spawns, JSON.stringify(build)).toHaveLength(0);
      expect(m.out()).toContain("BLOCKED — the build output is missing or stale, so nothing was started:");
      expect(m.out()).toContain(NONWATCH_BUILD_INSTRUCTION);
    }
    expect(assessNonWatchBuild("C:\\r", buildFs("C:\\r"))).toEqual({ ok: true });
    const stale = assessNonWatchBuild("C:\\r", buildFs("C:\\r", { stale: ["app.ts"] }));
    expect(stale.ok === false && stale.reasons).toEqual([`backend: 1 source file(s) are NEWER than their build (e.g. ${path.join("apps", "backend", "src", "app.ts")})`]);
    const nothing = assessNonWatchBuild("C:\\r", { listFiles: () => [], mtimeMs: () => null });
    expect(nothing.ok).toBe(false);
  });

  it("30. the spawn is the built server only: no pnpm, no install, no prisma, no tsx, no watch -- never a fallback to the watch backend", () => {
    const plan = nonWatchBackendSpawnPlan("C:\\repo", { ComSpec: "cmd.exe", LOCALAPPDATA: "C:\\L" });
    expect(plan.args.join(" ")).toBe("/d /s /c node C:\\repo\\apps\\backend\\dist\\src\\server.js");
    expect(plan.args.join(" ")).not.toMatch(/pnpm|install|prisma|generate|tsx|watch|dev\b|build/);
    const module = code(read("src/modules/operator/generic-backend-nonwatch-launcher.ts"));
    expect(module).not.toMatch(/child_process|spawnSync|execSync|exec\(|setInterval|setTimeout|supervise|Supervision|executeWorkerRestart|dualSpawnPlan/);
    // The only things it takes from the supervision module are the two fenced primitives and the probe type.
    expect(module).toContain('import { executeFencedStart, executeFencedStop, type ProbeOutcome } from "./worker-supervision";');
    // The only process creation is the CLI's durable-log spawner, through the fenced start, with this plan.
    expect((module.match(/adapters\.spawnRole\(/g) ?? []).length).toBe(1);
    expect(module).toContain("spawnWorker: () => adapters.spawnRole(role, nonWatchBackendSpawnPlan(adapters.repoRoot, env, () => parsed.keys)),");
    // The kill is reachable only through the reviewed fenced stop.
    expect((module.match(/adapters\.terminate/g) ?? []).length).toBe(1);
    expect(module).toContain("executeFencedStop(record, state!.repoRoot, { probe, terminate: adapters.terminate,");
    expect([...module.matchAll(/withMutationLock\("([A-Z_]+)"/g)].map((m) => m[1]).sort()).toEqual(["GENERIC_BACKEND_NONWATCH_START", "GENERIC_BACKEND_NONWATCH_STOP"]);
    expect(MUTATION_ACTIONS).toContain("GENERIC_BACKEND_NONWATCH_START");
    expect(MUTATION_ACTIONS).toContain("GENERIC_BACKEND_NONWATCH_STOP");
  });
});

// ===========================================================================
// Pure judgement
// ===========================================================================

describe("the mode judgement and the start decision", () => {
  const nw = (pid: number, parent: number) => node(pid, parent, "node C:\\repo\\apps\\backend\\dist\\src\\server.js");
  const L = (pid: number): ObservedListener => ({ port: 4000, address: "0.0.0.0", pid });

  it("ownership is ANCESTRY to the proved root; a matching command line alone is never ours", () => {
    const tree = [cmd(500, 1, "cmd"), nw(501, 500)];
    expect(judgeGenericBackend({ tree, listeners: [L(501)], portOpen: true, ownedRootPid: 500, watchLauncherOwned: false }).mode).toBe("RUNNING_NON_WATCH");
    expect(judgeGenericBackend({ tree, listeners: [L(501)], portOpen: true, ownedRootPid: null, watchLauncherOwned: false }).mode).toBe("UNPROVEN");
    expect(judgeGenericBackend({ tree, listeners: [L(501)], portOpen: true, ownedRootPid: 999, watchLauncherOwned: false }).mode).toBe("UNPROVEN");
    // A parent chain that leaves the observed set never reaches the root.
    expect(judgeGenericBackend({ tree: [nw(501, 444)], listeners: [L(501)], portOpen: true, ownedRootPid: 500, watchLauncherOwned: false }).mode).toBe("UNPROVEN");
  });

  it("duplicates and mixed modes are CONFLICT; only OFF starts", () => {
    const two = [cmd(500, 1, "cmd"), nw(501, 500), nw(601, 1)];
    expect(judgeGenericBackend({ tree: two, listeners: [L(501)], portOpen: true, ownedRootPid: 500, watchLauncherOwned: false }).mode).toBe("CONFLICT");
    const mixed = [cmd(500, 1, "cmd"), nw(501, 500), WATCH_RUNTIME(11)];
    expect(judgeGenericBackend({ tree: mixed, listeners: [L(501)], portOpen: true, ownedRootPid: 500, watchLauncherOwned: true }).mode).toBe("CONFLICT");
    expect(decideNonWatchStart({ mode: "OFF", detail: "" })).toEqual({ act: "START" });
    for (const mode of ["RUNNING_WATCH", "UNPROVEN", "CONFLICT"] as const) expect(decideNonWatchStart({ mode, detail: "x" }).act).toBe("REFUSE");
    expect(decideNonWatchStart({ mode: "RUNNING_NON_WATCH", detail: "x" }).act).toBe("ALREADY_RUNNING");
  });
});

// ===========================================================================
// 32-35. The SAFE runtime, account workers and planner supervision are untouched
// ===========================================================================

describe("32-35. Start SAFE, Stop Runtime, account-worker and planner supervision are unchanged", () => {
  const cli = code(read("src/modules/operator/run-runtime-launcher.ts"));

  it("the census tells the two modes apart by entrypoint, and wrappers are not runtimes", () => {
    expect(classifyEntrypoint("node C:\\repo\\apps\\backend\\dist\\src\\server.js")).toBe("dist/src/server.js");
    expect(classifyEntrypoint("node dist/src/server.js")).toBe("dist/src/server.js");
    expect(classifyEntrypoint('"node.exe" --require preflight.cjs --import loader.mjs src/server.ts')).toBe("src/server.ts");
    expect(classifyEntrypoint("node C:\\r\\node_modules\\pnpm\\bin\\pnpm.cjs start")).toBeNull();
  });

  it("32. Start SAFE still starts the six roles with the WATCH backend, and never the non-watch role", () => {
    expect([...DUAL_ROLES]).toEqual(["generic-backend", "generic-analysis", "account-a-control", "account-a-worker", "account-b-control", "account-b-worker"]);
    expect([...OPTIONAL_GENERIC_ROLES]).toEqual(["native-planner"]);
    expect(ROLE_CONTRACTS["generic-backend"]).toMatchObject({ script: "dev", entrypoint: "src/server.ts", port: 4000 });
    const startSafe = cli.slice(cli.indexOf("async function startSafe()"), cli.indexOf("async function stopRuntime()"));
    expect(startSafe).toContain("for (const role of DUAL_ROLES) {");
    expect(startSafe).not.toMatch(/nonWatch|NONWATCH|non-watch/i);
    // While a non-watch backend holds :4000, Start SAFE sees an external generic backend and refuses (unchanged behaviour).
    const census = censusOf([{ pid: 501, startedAtMs: 1, commandLine: "node C:\\repo\\apps\\backend\\dist\\src\\server.js" }], [{ port: 4000, address: "0.0.0.0", pid: 501 }]);
    const topology = projectTopology({ census, ownedRoles: [], attestation: {} });
    expect(topology.roles.map((r) => r.role)).toEqual([...DUAL_ROLES]);
    expect(topology.roles.find((r) => r.role === "generic-backend")!.presence).toBe("DETECTED");
    expect(topology.anyExternal).toBe(true);
  });

  it("33. Stop Runtime never reaches the non-watch backend (its own state file, its own stop)", () => {
    const stop = cli.slice(cli.indexOf("async function stopRuntime()"), cli.indexOf("function unaccountedLeavesFor"));
    expect(stop).not.toMatch(/nonWatch|NONWATCH|non-watch/i);
    expect(cli).toContain("statePath: `${defaultStatePath()}.generic-backend-nonwatch.json`,");
  });

  it("34/35. account-worker and Native planner supervision are untouched; the non-watch role is supervised by nothing", () => {
    for (const fn of ["async function superviseAccountWorker", "async function superviseGenericAnalysis"]) {
      const body = cli.slice(cli.indexOf(fn), cli.indexOf("\n}\n", cli.indexOf(fn)));
      expect(body, fn).not.toMatch(/nonWatch|NONWATCH|non-watch/i);
    }
    expect(code(read("src/modules/operator/native-planner-launcher.ts"))).not.toMatch(/nonWatch|NONWATCH|non-watch/i);
    expect(code(read("src/modules/operator/worker-supervision.ts"))).not.toMatch(/nonWatch|NONWATCH|non-watch/i);
  });

  it("the menu adds two explicit actions and keeps every existing entry", () => {
    for (const line of [
      'console.log("2. Start SAFE (six-role dual-account topology)");',
      'console.log("4. Stop Runtime (requires SAFE)");',
      'console.log("11. Start Native Planner (optional, generic, planning only)");',
      'console.log("13. Stop Native Planner");',
      'console.log("14. Start Generic Backend — Non-Watch (built server, no auto-restart, not Start SAFE)");',
      'console.log("15. Stop Generic Backend — Non-Watch (launcher-owned only)");',
      'else if (choice === "14") await nonWatchBackend().start(status);',
      'else if (choice === "15") await nonWatchBackend().stop(status);',
      'await underMutationLock("START_SAFE", startSafe)',
      'await underMutationLock("STOP_RUNTIME", stopRuntime)',
    ]) {
      expect(cli).toContain(line);
    }
    for (const wiring of ["terminate: terminateTree,", "gateAllows: transitionGateAllows,", "spawnRole: spawnRoleWithDurableLog,", "observeProcessTree,", "portOpen,"]) expect(cli).toContain(wiring);
  });
});

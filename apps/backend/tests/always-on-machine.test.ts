import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { spawnAlwaysOnSupervisor } from "../src/modules/always-on/always-on-launch";
import { createSpawner, observeProcessRows, realFileSystem, retryTransientFs, selfStartedAtMs } from "../src/modules/always-on/always-on-machine";
import { alwaysOnPaths, alwaysOnRoleLog } from "../src/modules/always-on/always-on-paths";
import { plannerSpawnPlan } from "../src/modules/always-on/always-on-roles";
import { OWNERSHIP_PROOF_ATTEMPTS, type ProbeOutcome } from "../src/modules/operator/worker-supervision";
import { fsError } from "./helpers/always-on-fake-machine";

/**
 * ALWAYS-ON MONITORING V1 — the real machine adapters that can be exercised
 * without starting anything: file operations on a private temporary
 * directory. (Process, socket and HTTP adapters are covered through the
 * supervisor's fakes and the structure pins.)
 */

const dir = mkdtempSync(path.join(tmpdir(), "aon-machine-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("transient Windows sharing failures are retried, bounded", () => {
  it("retries EPERM / EBUSY / EACCES on a growing delay and returns the operation's result", () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = retryTransientFs(
      () => {
        calls += 1;
        if (calls === 1) throw fsError("EPERM", "rename", "x");
        if (calls === 2) throw fsError("EBUSY", "rename", "x");
        if (calls === 3) throw fsError("EACCES", "rename", "x");
        return "replaced";
      },
      { sleep: (ms) => sleeps.push(ms) }
    );
    expect(result).toBe("replaced");
    expect(calls).toBe(4);
    expect(sleeps).toEqual([25, 50, 100]);
  });

  it("never retries any other error, and gives up after its attempts with the last transient error", () => {
    let calls = 0;
    expect(() =>
      retryTransientFs(
        () => {
          calls += 1;
          throw fsError("ENOENT", "rename", "x");
        },
        { sleep: () => undefined }
      )
    ).toThrow(/ENOENT/);
    expect(calls).toBe(1);
    calls = 0;
    const sleeps: number[] = [];
    expect(() =>
      retryTransientFs(
        () => {
          calls += 1;
          throw fsError("EPERM", "rename", "x");
        },
        { attempts: 8, sleep: (ms) => sleeps.push(ms) }
      )
    ).toThrow(/EPERM/);
    expect(calls).toBe(8);
    // Bounded: at most ~1.8 s of waiting in all.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_800);
  });
});

describe("process-tree observation survives any command line on the machine", () => {
  // A process object exactly as the CIM query yields one, through the REAL row format and the REAL parser.
  const processObject = (commandLine: string) =>
    `[pscustomobject]@{ ProcessId = 4242; ParentProcessId = 7; Name = 'node.exe'; CreationDate = [datetime]::UtcNow; CommandLine = (${commandLine}) }`;

  it.runIf(process.platform === "win32")(
    "a CR/LF inside one unrelated command line (node -e with a multi-line script) stays inside its own row — it no longer makes the whole table UNPARSEABLE",
    () => {
      const observed = observeProcessRows(processObject("'node -e a' + [char]13 + [char]10 + 'b' + [char]10 + 'c|d'"));
      expect(observed).toMatchObject({ ok: true });
      if (!observed.ok) return;
      expect(observed.value).toHaveLength(1);
      expect(observed.value[0]).toMatchObject({ pid: 4242, parentPid: 7, executable: "node.exe" });
      expect(observed.value[0].commandLine).toBe("node -e a  b c d");
    },
    60_000
  );

  it.runIf(process.platform === "win32")(
    "an ordinary command line is observed unchanged",
    () => {
      const observed = observeProcessRows(processObject("'cmd.exe /d /s /c pnpm -C C:\\repo --filter backend run'"));
      expect(observed.ok && observed.value[0].commandLine).toBe("cmd.exe /d /s /c pnpm -C C:\\repo --filter backend run");
    },
    60_000
  );
});

describe("a spawn that fails at run time is a refused start, never an uncaught exception", () => {
  // libuv reports ENOENT / EACCES / EMFILE … through the child's 'error' event on the NEXT tick.
  const missing = path.join(dir, "no-such-dir", "no-such-program.exe");

  async function uncaughtDuring(action: () => void): Promise<unknown[]> {
    const caught: unknown[] = [];
    const listener = (error: unknown) => void caught.push(error);
    process.on("uncaughtException", listener);
    try {
      action();
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      process.off("uncaughtException", listener);
    }
    return caught;
  }

  it("the role spawner returns null (SPAWN_FAILED, backoff) and handles the late 'error' event", async () => {
    const spawner = createSpawner(alwaysOnPaths({ LOCALAPPDATA: dir }), () => undefined);
    let pid: number | null | undefined;
    const caught = await uncaughtDuring(() => {
      pid = spawner.spawn({ role: "planner", command: missing, args: [], cwd: dir, env: {}, commandIdentity: "a program that does not exist" });
    });
    expect(pid).toBeNull();
    expect(caught).toEqual([]);
  });

  it("the launcher's supervisor spawner returns null ('could not be started') and handles the late 'error' event", async () => {
    let pid: number | null | undefined;
    const caught = await uncaughtDuring(() => {
      pid = spawnAlwaysOnSupervisor(alwaysOnPaths({ LOCALAPPDATA: dir }), dir, {}, missing);
    });
    expect(pid).toBeNull();
    expect(caught).toEqual([]);
  });
});

describe("the supervisor's own identity is its OS creation time, or it does not start", () => {
  const row = (startedAtMs: number) => ({ observed: true as const, process: { pid: 77, commandLine: "node run-always-on-monitoring.ts", startedAtMs } });
  const unobserved = { observed: false as const };

  it("a transient probe failure is retried (as the fenced start retries a fresh child's) before giving up", () => {
    const answers: ProbeOutcome[] = [unobserved, { observed: true, process: null }, row(1_700_000_000_000)];
    expect(selfStartedAtMs(() => answers.shift() ?? unobserved, 77)).toBe(1_700_000_000_000);
  });

  it("an unreadable creation time is null — never 'now', which no later verification (±1 s of the real one) could ever match", () => {
    let probes = 0;
    const always = () => {
      probes += 1;
      return unobserved;
    };
    expect(selfStartedAtMs(always, 77)).toBeNull();
    expect(probes).toBe(OWNERSHIP_PROOF_ATTEMPTS);
  });
});

describe("the real file system adapter", () => {
  it("readTextStrict is null ONLY for a missing file; any other read failure throws (the lenient read says null)", () => {
    expect(realFileSystem.readTextStrict(path.join(dir, "absent.json"))).toBeNull();
    expect(realFileSystem.readTextStrict(path.join(dir, "absent-dir", "x.json"))).toBeNull();
    const directory = path.join(dir, "a-directory");
    mkdirSync(directory);
    // Reading a directory fails with EISDIR: unknown, never "absent".
    expect(() => realFileSystem.readTextStrict(directory)).toThrow();
    expect(realFileSystem.readText(directory)).toBeNull();
  });

  it("writeTextAtomic writes and replaces through a temporary file, leaving no temporary behind", () => {
    const file = path.join(dir, "ownership.json");
    realFileSystem.writeTextAtomic(file, "one\n");
    realFileSystem.writeTextAtomic(file, "two\n");
    expect(readFileSync(file, "utf8")).toBe("two\n");
    expect(realFileSystem.readTextStrict(file)).toBe("two\n");
    expect(realFileSystem.exists(`${file}.tmp`)).toBe(false);
    realFileSystem.remove(file);
    realFileSystem.remove(file);
    expect(realFileSystem.readTextStrict(file)).toBeNull();
  });
});

describe("every role's output reaches its durable log", () => {
  // The worktree this test runs in: its own tsx CLI, exactly as a role plan names it.
  const repoRoot = path.resolve(__dirname, "..", "..", "..");

  it.runIf(process.platform === "win32")(
    "a role started detached as the plan says writes stdout AND stderr into its log (it was empty on the real machine: a detached cmd.exe gave its children a hidden console)",
    async () => {
      const fixture = path.join(dir, "role-output.ts");
      writeFileSync(fixture, ['console.log("role stdout line");', 'console.error("role stderr line");', ""].join("\n"));
      const plan = plannerSpawnPlan(repoRoot, process.env, []);
      const paths = alwaysOnPaths({ LOCALAPPDATA: path.join(dir, "role-log") });
      // The real plan's command and tsx CLI; only the entry is a harmless fixture (no role is ever started here).
      const pid = createSpawner(paths, () => undefined).spawn({ ...plan, args: [plan.args[0] as string, fixture], env: process.env });
      expect(pid).not.toBeNull();
      let text = "";
      for (let i = 0; i < 100 && !(text.includes("role stdout line") && text.includes("role stderr line")); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        text = readFileSync(alwaysOnRoleLog(paths, "planner"), "utf8");
      }
      expect(text).toContain("role stdout line");
      expect(text).toContain("role stderr line");
    },
    30_000
  );
});

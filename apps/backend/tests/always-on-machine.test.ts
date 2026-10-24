import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { observeProcessRows, realFileSystem, retryTransientFs } from "../src/modules/always-on/always-on-machine";
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

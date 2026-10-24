import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { LIVE_SHADOW_LOCK_FILE, LIVE_SHADOW_LOCK_SCHEMA, ScannerLockError, acquireLiveShadowLock } from "../src/modules/native-scanner/scanner-lock";

/**
 * One live-shadow writer per symbol — and a pid that Windows has handed to
 * another process is not that writer. Always-On acceptance run 1 (2026-10-24)
 * failed 296 symbols "owned by live process 19488": the scanner that wrote
 * those locks (started 2026-10-23T05:01:11Z) had been killed without
 * releasing them, and an unrelated process held its pid.
 */

const root = mkdtempSync(path.join(tmpdir(), "scanner-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const symbolDir = () => path.join(root, `S${(n += 1)}`);

function staleLock(dir: string, holder: { pid: number; startedAt?: string }) {
  acquireLiveShadowLock(dir, { pid: 1, owner: "seed", startedAt: "x", isProcessAlive: () => false }); // creates the directory
  writeFileSync(path.join(dir, LIVE_SHADOW_LOCK_FILE), `${JSON.stringify({ schema: LIVE_SHADOW_LOCK_SCHEMA, pid: holder.pid, owner: "scanner:live-shadow-supervisor", ...(holder.startedAt === undefined ? {} : { startedAt: holder.startedAt }) })}\n`);
}
const me = { pid: 4242, owner: "scanner:live-shadow-supervisor", startedAt: "2026-10-24T15:52:54.189Z" };
const heldBy = (dir: string) => (JSON.parse(readFileSync(path.join(dir, LIVE_SHADOW_LOCK_FILE), "utf8")) as { pid: number }).pid;

describe("the live-shadow symbol lock survives PID reuse", () => {
  it("acceptance run 1: a live pid whose process was created AFTER the lock's owner started is not that owner — the stale lock is reclaimed", () => {
    const dir = symbolDir();
    staleLock(dir, { pid: 19488, startedAt: "2026-10-23T05:01:11.364Z" });
    const lock = acquireLiveShadowLock(dir, { ...me, isProcessAlive: () => true, processCreatedAtMs: () => Date.parse("2026-10-24T15:52:30.000Z") });
    expect(heldBy(dir)).toBe(4242);
    lock.release();
  });

  it("the genuine owner (created before it started and wrote the lock) is never overridden", () => {
    const dir = symbolDir();
    staleLock(dir, { pid: 19488, startedAt: "2026-10-23T05:01:11.364Z" });
    expect(() => acquireLiveShadowLock(dir, { ...me, isProcessAlive: () => true, processCreatedAtMs: () => Date.parse("2026-10-23T05:01:08.000Z") })).toThrow(ScannerLockError);
    expect(heldBy(dir)).toBe(19488);
  });

  it("fail-closed: an unknown creation time, no probe at all, or a lock that names no start time is still a refusal while the pid is alive", () => {
    for (const [holder, deps] of [
      [{ pid: 19488, startedAt: "2026-10-23T05:01:11.364Z" }, { processCreatedAtMs: () => null }],
      [{ pid: 19488, startedAt: "2026-10-23T05:01:11.364Z" }, {}],
      [{ pid: 19488 }, { processCreatedAtMs: () => Date.parse("2026-10-24T15:52:30.000Z") }],
      [{ pid: 19488, startedAt: "not a time" }, { processCreatedAtMs: () => Date.parse("2026-10-24T15:52:30.000Z") }],
    ] as const) {
      const dir = symbolDir();
      staleLock(dir, holder);
      expect(() => acquireLiveShadowLock(dir, { ...me, isProcessAlive: () => true, ...deps })).toThrow(/owned by live process 19488/);
      expect(heldBy(dir)).toBe(19488);
    }
  });

  it("a lock whose owner is gone is reclaimed exactly as before (no creation time needed)", () => {
    const dir = symbolDir();
    staleLock(dir, { pid: 19488, startedAt: "2026-10-23T05:01:11.364Z" });
    let probed = 0;
    acquireLiveShadowLock(dir, { ...me, isProcessAlive: () => false, processCreatedAtMs: () => (probed += 1) });
    expect(heldBy(dir)).toBe(4242);
    expect(probed).toBe(0);
  });
});

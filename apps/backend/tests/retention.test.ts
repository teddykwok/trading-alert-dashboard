import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  FINAL_REVIEW_STATUSES,
  TERMINAL_ALERT_STATUSES,
  deletableAlertWhere,
  expiredScreenshotWhere,
  resolveScreenshotFile,
  retentionCutoff,
  runRetentionCleanup,
} from "../src/modules/retention/retention.service";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("retentionCutoff", () => {
  it("returns exactly N days before 'now'", () => {
    const now = new Date("2026-07-17T03:00:00.000Z");
    expect(retentionCutoff(3, now).toISOString()).toBe("2026-07-14T03:00:00.000Z");
    expect(retentionCutoff(7, now).toISOString()).toBe("2026-07-10T03:00:00.000Z");
  });
});

describe("resolveScreenshotFile", () => {
  const root = path.resolve(os.tmpdir(), "screenshots-root");

  it("maps a normal screenshot URL to a file directly inside the dir", () => {
    const resolved = resolveScreenshotFile(root, "/screenshots/alert-123.png");
    expect(resolved).toBe(path.join(root, "alert-123.png"));
  });

  it("rejects URLs that reduce to no usable file name", () => {
    expect(resolveScreenshotFile(root, "")).toBeNull();
    expect(resolveScreenshotFile(root, "   ")).toBeNull();
    expect(resolveScreenshotFile(root, "/screenshots/..")).toBeNull();
    expect(resolveScreenshotFile(root, ".")).toBeNull();
  });

  it("can never resolve outside the screenshot dir, whatever the input", () => {
    const hostile = [
      "../../etc/passwd",
      "/etc/passwd",
      "/screenshots/../../../secret.png",
      "..\\..\\windows\\system32\\config",
      "C:\\Windows\\system32\\evil.png",
      "////../..//x.png",
    ];
    for (const url of hostile) {
      const resolved = resolveScreenshotFile(root, url);
      if (resolved !== null) {
        // basename() strips any directory part, so the worst a hostile URL can
        // do is name a file directly inside the screenshot root.
        expect(path.dirname(resolved)).toBe(root);
      }
    }
  });
});

describe("retention where-clauses", () => {
  const cutoff = new Date("2026-07-10T03:00:00.000Z");

  it("screenshot expiry targets only terminal alerts with a screenshot past the cutoff", () => {
    expect(expiredScreenshotWhere(cutoff)).toEqual({
      screenshotUrl: { not: null },
      createdAt: { lt: cutoff },
      status: { in: ["ANALYZED", "FAILED"] },
    });
  });

  it("alert deletion targets only terminal statuses — RECEIVED/PROCESSING can never match", () => {
    const where = deletableAlertWhere(cutoff);
    expect(where.status).toEqual({ in: ["ANALYZED", "FAILED"] });
    expect(TERMINAL_ALERT_STATUSES).toEqual(["ANALYZED", "FAILED"]);
  });

  it("keeps alerts with open user-entered state (review OPEN/UNREVIEWED, or journal without finalized review)", () => {
    const where = deletableAlertWhere(cutoff);
    expect(where.OR).toEqual([
      { AND: [{ tradeReview: { is: null } }, { tradeJournal: { is: null } }] },
      { tradeReview: { is: { status: { in: [...FINAL_REVIEW_STATUSES] } } } },
    ]);
    expect(FINAL_REVIEW_STATUSES).not.toContain("OPEN");
    expect(FINAL_REVIEW_STATUSES).not.toContain("UNREVIEWED");
  });
});

// ---------------------------------------------------------------------------
// runRetentionCleanup — mocked Prisma transaction + real files in a temp dir
// ---------------------------------------------------------------------------

interface TxMockInput {
  locked?: boolean;
  expiredShots?: Array<{ id: string; screenshotUrl: string | null }>;
  deletable?: Array<{ id: string; screenshotUrl: string | null }>;
  agedNonTerminal?: number;
  agedTerminal?: number;
}

function createTx(input: TxMockInput) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: input.locked ?? true }]),
    alert: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(input.expiredShots ?? [])
        .mockResolvedValueOnce(input.deletable ?? []),
      count: vi
        .fn()
        .mockResolvedValueOnce(input.agedNonTerminal ?? 0)
        .mockResolvedValueOnce(input.agedTerminal ?? 0),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve({ count: where.id.in.length })
      ),
    },
  };
}

function createPrisma(tx: ReturnType<typeof createTx>): PrismaClient {
  return {
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaClient;
}

describe("runRetentionCleanup", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "retention-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const baseOptions = (dryRun: boolean) => ({
    dryRun,
    screenshotDir: dir,
    screenshotRetentionDays: 3,
    alertRetentionDays: 7,
    now: new Date("2026-07-17T03:00:00.000Z"),
  });

  it("dry-run reports what WOULD happen without touching files or rows", async () => {
    const existing = path.join(dir, "a1.png");
    await writeFile(existing, "png");

    const tx = createTx({
      expiredShots: [
        { id: "a1", screenshotUrl: "/screenshots/a1.png" },
        { id: "a2", screenshotUrl: "/screenshots/missing.png" },
      ],
      deletable: [{ id: "a1", screenshotUrl: "/screenshots/a1.png" }],
      agedNonTerminal: 2,
      agedTerminal: 3,
    });

    const report = await runRetentionCleanup(createPrisma(tx), baseOptions(true));

    expect(report.dryRun).toBe(true);
    expect(report.lockAcquired).toBe(true);
    expect(report.screenshotsSelected).toBe(2);
    expect(report.screenshotFilesDeleted).toBe(1); // only the file that exists
    expect(report.screenshotRefsCleared).toBe(2);
    expect(report.alertsSelected).toBe(1);
    expect(report.alertsDeleted).toBe(0);
    expect(report.skippedNonTerminal).toBe(2);
    expect(report.skippedOpenUserState).toBe(2); // 3 aged terminal - 1 deletable
    expect(report.failures).toBe(0);

    // Nothing was modified.
    expect(existsSync(existing)).toBe(true);
    expect(tx.alert.update).not.toHaveBeenCalled();
    expect(tx.alert.deleteMany).not.toHaveBeenCalled();
  });

  it("real run deletes expired files, clears references, tolerates missing files, deletes alerts", async () => {
    const shot1 = path.join(dir, "a1.png");
    const orphan = path.join(dir, "old.png");
    await writeFile(shot1, "png");
    await writeFile(orphan, "png");

    const tx = createTx({
      expiredShots: [
        { id: "a1", screenshotUrl: "/screenshots/a1.png" },
        { id: "a2", screenshotUrl: "/screenshots/missing.png" }, // file gone already
      ],
      deletable: [
        { id: "old1", screenshotUrl: "/screenshots/old.png" },
        { id: "old2", screenshotUrl: null },
      ],
      agedNonTerminal: 0,
      agedTerminal: 2,
    });

    const report = await runRetentionCleanup(createPrisma(tx), baseOptions(false));

    expect(report.screenshotFilesDeleted).toBe(1);
    expect(report.screenshotRefsCleared).toBe(2); // missing file still clears the ref
    expect(report.failures).toBe(0);
    expect(report.alertsSelected).toBe(2);
    expect(report.alertsDeleted).toBe(2);
    expect(report.skippedOpenUserState).toBe(0);

    expect(existsSync(shot1)).toBe(false);
    expect(existsSync(orphan)).toBe(false); // deleted alert's file removed too
    expect(tx.alert.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { screenshotUrl: null } });
    expect(tx.alert.update).toHaveBeenCalledWith({ where: { id: "a2" }, data: { screenshotUrl: null } });
    expect(tx.alert.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old1", "old2"] } } });
  });

  it("skips everything when the advisory lock is held by another run", async () => {
    const tx = createTx({ locked: false });

    const report = await runRetentionCleanup(createPrisma(tx), baseOptions(false));

    expect(report.lockAcquired).toBe(false);
    expect(tx.alert.findMany).not.toHaveBeenCalled();
    expect(tx.alert.update).not.toHaveBeenCalled();
    expect(tx.alert.deleteMany).not.toHaveBeenCalled();
  });

  it("counts an unsafe screenshot path as a failure and never clears its reference", async () => {
    const tx = createTx({
      expiredShots: [{ id: "bad", screenshotUrl: "/screenshots/.." }],
      agedTerminal: 0,
    });

    const report = await runRetentionCleanup(createPrisma(tx), baseOptions(false));

    expect(report.failures).toBe(1);
    expect(report.screenshotRefsCleared).toBe(0);
    expect(tx.alert.update).not.toHaveBeenCalled();
  });

  it("queries deletable alerts with the exact eligibility where-clause", async () => {
    const tx = createTx({});
    const options = baseOptions(true);

    await runRetentionCleanup(createPrisma(tx), options);

    const alertCutoff = retentionCutoff(options.alertRetentionDays, options.now);
    expect(tx.alert.findMany).toHaveBeenNthCalledWith(2, {
      where: deletableAlertWhere(alertCutoff),
      select: { id: true, screenshotUrl: true },
    });
    // Skip accounting distinguishes non-terminal (never deletable) from
    // terminal-but-open-user-state.
    expect(tx.alert.count).toHaveBeenNthCalledWith(1, {
      where: { createdAt: { lt: alertCutoff }, status: { notIn: ["ANALYZED", "FAILED"] } },
    });
  });
});

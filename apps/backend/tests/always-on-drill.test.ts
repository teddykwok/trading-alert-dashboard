import { describe, expect, it } from "vitest";

import {
  ALWAYS_ON_DRILL_FAULTS,
  ALWAYS_ON_DRILL_MAX_SECONDS,
  ALWAYS_ON_DRILL_REQUEST_TTL_MS,
  commandLineInRepository,
  controllerIsDrillCli,
  drillStartRequestText,
  drilledProbeFetch,
  drilledProbeOpen,
  judgeDirectoryAcl,
  judgeDrillStart,
  parseDrillStartRequest,
  type DrillStartContext,
  type DrillStartRequest,
} from "../src/modules/always-on/always-on-drill";
import { publicBinanceReachable, publicStreamReachable } from "../src/modules/always-on/always-on-machine";
import { PUBLIC_TRANSPORT_DRILL_MAX_MS } from "../src/modules/native-scanner/public-transport-drill";

/**
 * THE OPERATOR NETWORK DRILL — the supervisor's pure contract: which faults
 * exist and what each one does to which transport, how a drill request is
 * judged, how the supervisor's own probes see a drill, and how the Windows ACL
 * of the drill's directories is judged. Every refusal has a machine-readable
 * reason; anything uncertain refuses.
 */

const NOW = Date.UTC(2026, 9, 25, 3, 0, 0);
const RUN = "20261025T025500Z-0a1b2c3d";
const OWNER = "S-1-5-21-1-2-3-1001";

function request(over: Partial<DrillStartRequest> = {}): DrillStartRequest {
  return {
    requestId: "0123456789abcdef0123456789abcdef",
    generation: 3,
    runId: RUN,
    fault: "PUBLIC_STREAMS_DOWN",
    durationSeconds: 300,
    requestedAtMs: NOW - 2_000,
    controller: { pid: 4242, startedAtMs: NOW - 5_000, user: "operator" },
    ...over,
  };
}

function context(over: Partial<DrillStartContext> = {}): DrillStartContext {
  return {
    nowMs: NOW,
    generation: 3,
    scanner: { owned: true, runId: RUN, healthy: true },
    recoveryActive: false,
    shuttingDown: false,
    drillActive: false,
    seenRequestIds: new Set(),
    controller: "VERIFIED",
    directories: { private: true },
    ...over,
  };
}

describe("the fault catalogue", () => {
  it("names exactly the supported scenarios, each a fixed, bounded combination of transport faults", () => {
    expect(Object.keys(ALWAYS_ON_DRILL_FAULTS).sort()).toEqual([
      "PUBLIC_ALL_DOWN",
      "PUBLIC_REST_DOWN",
      "PUBLIC_STREAMS_DISCONNECT",
      "PUBLIC_STREAMS_DOWN",
      "PUBLIC_STREAMS_HALF_OPEN",
      "PUBLIC_STREAMS_NEW_REFUSED",
      "SCANNER_LOCAL_STREAMS",
    ]);
    expect(ALWAYS_ON_DRILL_MAX_SECONDS * 1000).toBe(PUBLIC_TRANSPORT_DRILL_MAX_MS);
    expect(ALWAYS_ON_DRILL_MAX_SECONDS).toBe(900);
    expect(ALWAYS_ON_DRILL_REQUEST_TTL_MS).toBe(60_000);
  });

  it.each([
    ["PUBLIC_REST_DOWN", { rest: "REFUSED", openStreams: null, newStreams: null }, { rest: "REFUSED", stream: null }],
    ["PUBLIC_STREAMS_DISCONNECT", { rest: null, openStreams: "DROP", newStreams: null }, { rest: null, stream: null }],
    ["PUBLIC_STREAMS_NEW_REFUSED", { rest: null, openStreams: null, newStreams: "REFUSED" }, { rest: null, stream: "REFUSED" }],
    ["PUBLIC_STREAMS_DOWN", { rest: null, openStreams: "DROP", newStreams: "REFUSED" }, { rest: null, stream: "REFUSED" }],
    ["PUBLIC_ALL_DOWN", { rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED" }, { rest: "REFUSED", stream: "REFUSED" }],
    ["PUBLIC_STREAMS_HALF_OPEN", { rest: null, openStreams: "SILENT", newStreams: null }, { rest: null, stream: "SILENT" }],
    // A scanner-LOCAL fault: the scanner's streams fail, the public network (both probes) is fine.
    ["SCANNER_LOCAL_STREAMS", { rest: null, openStreams: "DROP", newStreams: "REFUSED" }, { rest: null, stream: null }],
  ] as const)("%s", (name, scanner, probes) => {
    expect(ALWAYS_ON_DRILL_FAULTS[name].scanner).toEqual(scanner);
    expect(ALWAYS_ON_DRILL_FAULTS[name].probes).toEqual(probes);
  });
});

describe("a drill request: parsed strictly", () => {
  it("round-trips through the CLI's serializer", () => {
    expect(parseDrillStartRequest(drillStartRequestText(request()))).toEqual({ ok: true, request: request() });
  });

  it.each([
    ["not JSON", "{", "SCHEMA_INVALID"],
    ["another kind", drillStartRequestText(request()).replace('"DRILL_START"', '"STOP"'), "SCHEMA_INVALID"],
    ["an unknown fault", drillStartRequestText(request()).replace("PUBLIC_STREAMS_DOWN", "PUBLIC_EVERYTHING"), "FAULT_UNKNOWN"],
    ["a duration above the maximum", drillStartRequestText(request({ durationSeconds: 901 })), "DURATION_OUT_OF_BOUNDS"],
    ["a duration below the minimum", drillStartRequestText(request({ durationSeconds: 5 })), "DURATION_OUT_OF_BOUNDS"],
    ["a malformed run id", drillStartRequestText(request({ runId: "latest" })), "FIELD_INVALID"],
    ["a malformed request id", drillStartRequestText(request({ requestId: "x" })), "FIELD_INVALID"],
  ])("refuses %s", (_label, text, reason) => {
    const parsed = parseDrillStartRequest(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? null : parsed.reason).toBe(reason);
  });

  it("refuses any field it does not know (no URL, host, header, endpoint, role or account can ride along)", () => {
    const base = JSON.parse(drillStartRequestText(request())) as Record<string, unknown>;
    for (const extra of [{ url: "https://x" }, { host: "x" }, { headers: {} }, { role: "account-a" }, { endpoint: "/fapi/v1/order" }]) {
      const parsed = parseDrillStartRequest(JSON.stringify({ ...base, ...extra }));
      expect(parsed.ok ? null : parsed.reason).toBe("FIELD_INVALID");
    }
  });

  it("reports the request id of a refused request when it can be read, for the operator's controller to match", () => {
    const parsed = parseDrillStartRequest(drillStartRequestText(request({ durationSeconds: 99_999 })));
    expect(parsed).toMatchObject({ ok: false, requestId: request().requestId });
  });
});

describe("a drill request: judged against the running supervisor (first failing rule wins, in a fixed order)", () => {
  it("accepts a fresh, verified request for the current generation's healthy owned scanner run", () => {
    expect(judgeDrillStart(request(), context())).toEqual({ accept: true });
  });

  it.each([
    ["an authorization older than its 60 s lifetime", request({ requestedAtMs: NOW - 60_001 }), context(), "REQUEST_EXPIRED"],
    ["a request from the future", request({ requestedAtMs: NOW + 10_000 }), context(), "REQUEST_FROM_FUTURE"],
    ["a replayed request id", request(), context({ seenRequestIds: new Set([request().requestId]) }), "REQUEST_REPLAYED"],
    ["another generation", request({ generation: 2 }), context(), "GENERATION_MISMATCH"],
    ["a supervisor that is stopping", request(), context({ shuttingDown: true }), "SHUTTING_DOWN"],
    ["a drill already active", request(), context({ drillActive: true }), "DRILL_ALREADY_ACTIVE"],
    ["a scanner recovery in progress", request(), context({ recoveryActive: true }), "RECOVERY_IN_PROGRESS"],
    ["no owned scanner", request(), context({ scanner: { owned: false, runId: null, healthy: false } }), "NO_OWNED_SCANNER"],
    ["another scanner run", request({ runId: "20261025T020000Z-ffffffff" }), context(), "RUN_MISMATCH"],
    ["an unhealthy scanner", request(), context({ scanner: { owned: true, runId: RUN, healthy: false } }), "SCANNER_NOT_HEALTHY"],
    ["a controller that is not this repository's drill CLI", request(), context({ controller: "NOT_VERIFIED" }), "CONTROLLER_NOT_VERIFIED"],
    ["a controller that could not be observed", request(), context({ controller: "UNOBSERVABLE" }), "CONTROLLER_UNOBSERVABLE"],
    ["directories other users could write", request(), context({ directories: { private: false, reason: "S-1-1-0 may write" } }), "DIRECTORY_NOT_PRIVATE"],
  ])("refuses %s", (_label, req, ctx, reasonCode) => {
    const verdict = judgeDrillStart(req, ctx);
    expect(verdict.accept).toBe(false);
    expect(verdict.accept ? null : verdict.reasonCode).toBe(reasonCode);
  });
});

describe("the controller: only this repository's own `monitoring:always-on drill start`", () => {
  it.each([
    ['"C:\\Program Files\\nodejs\\node.exe" --require C:\\repo\\node_modules\\tsx\\dist\\preflight.cjs src/modules/always-on/run-always-on-monitoring.ts drill start --fault PUBLIC_REST_DOWN', true],
    ["node C:\\repo\\apps\\backend\\src\\modules\\always-on\\run-always-on-monitoring.ts drill start", true],
    ["node src/modules/always-on/run-always-on-monitoring.ts run", false],
    ["node src/modules/always-on/run-always-on-monitoring.ts drill restore", false],
    ["node C:\\elsewhere\\drill.js drill start", false],
    ["powershell.exe -Command echo src/modules/always-on/run-always-on-monitoring.ts drill start", false],
  ])("%s → %s", (commandLine, expected) => {
    expect(controllerIsDrillCli(commandLine)).toBe(expected);
  });
});

describe("the controller's repository: this checkout itself, never a sibling whose path merely starts the same", () => {
  it.each([
    ["node --require C:\\Projects\\trading-alert-dashboard\\node_modules\\tsx\\dist\\preflight.cjs src/x.ts", "C:\\Projects\\trading-alert-dashboard", true],
    ["node --require C:/Projects/trading-alert-dashboard/node_modules/tsx/dist/preflight.cjs src/x.ts", "C:\\Projects\\trading-alert-dashboard\\", true],
    ["node --require c:\\projects\\TRADING-alert-dashboard\\node_modules\\x.cjs", "C:\\Projects\\trading-alert-dashboard", true],
    // A worktree beside the main checkout shares the prefix: it is NOT this repository.
    ["node --require C:\\Projects\\trading-alert-dashboard-wt\\always-on-x\\node_modules\\tsx\\dist\\preflight.cjs src/x.ts", "C:\\Projects\\trading-alert-dashboard", false],
    ["node C:\\Projects\\trading-alert-dashboard.old\\x.ts", "C:\\Projects\\trading-alert-dashboard", false],
    ["node C:\\elsewhere\\x.ts", "C:\\Projects\\trading-alert-dashboard", false],
    ["node C:\\x.ts", "", false],
  ])("%s in %s → %s", (commandLine, repoRoot, expected) => {
    expect(commandLineInRepository(commandLine, repoRoot)).toBe(expected);
  });
});

describe("the Windows ACL of the drill's directories: private to the operator, SYSTEM and Administrators", () => {
  const dirs = ["C:\\a", "C:\\a\\requests"];
  const row = (dir: string, sid: string, type: string, rights: number) => `${dir}|${sid}|${type}|${rights}`;
  const FULL = 0x1f01ff;

  it("the default LocalAppData ACL (as read on the operator's machine) is private", () => {
    const rows = dirs.flatMap((d) => [row(d, "S-1-5-18", "Allow", FULL), row(d, "S-1-5-32-544", "Allow", FULL), row(d, OWNER, "Allow", FULL)]);
    expect(judgeDirectoryAcl(rows.join("\n"), dirs, OWNER)).toEqual({ private: true });
  });

  it.each([
    ["Everyone may write", row("C:\\a", "S-1-1-0", "Allow", 0x2)],
    ["Users may modify", row("C:\\a", "S-1-5-32-545", "Allow", 0x1301bf)],
    ["Authenticated Users have full control", row("C:\\a", "S-1-5-11", "Allow", FULL)],
    ["another account may append", row("C:\\a", "S-1-5-21-9-9-9-1002", "Allow", 0x4)],
    ["CREATOR OWNER (uncertain) may write", row("C:\\a", "S-1-3-0", "Allow", 0x10000000)],
  ])("is NOT private when %s", (_label, extra) => {
    const rows = [...dirs.flatMap((d) => [row(d, OWNER, "Allow", FULL)]), extra];
    expect(judgeDirectoryAcl(rows.join("\n"), dirs, OWNER).private).toBe(false);
  });

  it("read-only access for others, or a Deny rule, is still private", () => {
    const rows = [...dirs.map((d) => row(d, OWNER, "Allow", FULL)), row("C:\\a", "S-1-5-32-545", "Allow", 0x1200a9), row("C:\\a", "S-1-1-0", "Deny", FULL)];
    expect(judgeDirectoryAcl(rows.join("\n"), dirs, OWNER)).toEqual({ private: true });
  });

  it("anything uncertain is NOT private: a directory with no rows, a malformed row, an empty answer, no owner SID", () => {
    expect(judgeDirectoryAcl(row("C:\\a", OWNER, "Allow", FULL), dirs, OWNER).private).toBe(false);
    expect(judgeDirectoryAcl([row("C:\\a", OWNER, "Allow", FULL), "C:\\a\\requests|garbage"].join("\n"), dirs, OWNER).private).toBe(false);
    expect(judgeDirectoryAcl("", dirs, OWNER).private).toBe(false);
    expect(judgeDirectoryAcl(dirs.map((d) => row(d, OWNER, "Allow", FULL)).join("\n"), dirs, "").private).toBe(false);
  });
});

// ===========================================================================
// The supervisor's probes during a drill: the REAL probe code, a gated transport
// ===========================================================================

const okFetch = (async () => new Response(JSON.stringify({ serverTime: NOW }), { status: 200 })) as typeof fetch;

describe("the REST connectivity probe under a drill", () => {
  it("no drill: the inner transport itself is used (identity — production behaviour is unchanged)", () => {
    expect(drilledProbeFetch(okFetch, null)).toBe(okFetch);
    expect(drilledProbeFetch(okFetch, { rest: null, stream: "REFUSED" })).toBe(okFetch);
  });

  it("a REST fault: the real probe runs and reports unreachable, and the network is never asked", async () => {
    let calls = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return okFetch(...args);
    }) as typeof fetch;
    expect(await publicBinanceReachable(5_000, drilledProbeFetch(counting, null))).toBe(true);
    expect(await publicBinanceReachable(5_000, drilledProbeFetch(counting, { rest: "REFUSED", stream: null }))).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("the public stream probe under a drill", () => {
  const immediate = { set: (fn: () => void) => setImmediate(fn), clear: (h: unknown) => clearImmediate(h as NodeJS.Immediate) };

  it("no stream fault: the inner opener itself (undefined → the probe's own real WebSocket default)", () => {
    const open = () => {
      throw new Error("unused");
    };
    expect(drilledProbeOpen(open, null)).toBe(open);
    expect(drilledProbeOpen(undefined, { rest: "REFUSED", stream: null })).toBeUndefined();
  });

  it("REFUSED: the real probe sees an error and a close before any message → UNREACHABLE; nothing is opened", async () => {
    let opened = 0;
    const open = () => {
      opened += 1;
      throw new Error("never");
    };
    expect(await publicStreamReachable({ open: drilledProbeOpen(open, { rest: null, stream: "REFUSED" }), timers: immediate })).toBe("UNREACHABLE");
    expect(opened).toBe(0);
  });

  it("SILENT: the real probe sees a socket that opens and says nothing → UNKNOWN (which never suppresses a recovery)", async () => {
    expect(await publicStreamReachable({ open: drilledProbeOpen(undefined, { rest: null, stream: "SILENT" }), timers: immediate })).toBe("UNKNOWN");
  });
});

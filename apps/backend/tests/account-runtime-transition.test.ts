import { describe, expect, it } from "vitest";

import type { PreShutdownCounts } from "../src/modules/binance/pre-shutdown-exchange-check";
import {
  BLOCKING_WARNINGS,
  TRANSITION_PHASES,
  envAliasForAccount,
  evaluateTransitionPreconditions,
  decideModeTransition,
  describePendingTransition,
  effectiveModeFromWire,
  evaluateSecondProof,
  evaluateTransitionGate,
  executeAccountTransition,
  judgeRoleMode,
  judgeSupervisedRestart,
  executeTransitionRecovery,
  parseTransitionMarker,
  phaseAtLeast,
  proveCurrentMode,
  selectedAccountStateFromWire,
  UNREAD_ACCOUNT_STATE,
  warningCodesFromWire,
  type GatheredAccountFacts,
  type ObservedMode,
  recoveryPlanFor,
  rolesForAccount,
  type PendingTransition,
  type RuntimeMode,
  type SelectedAccountState,
  type TransitionAdapters,
  type TransitionPhase,
} from "../src/modules/operator/account-runtime-transition";
import type { DualRole } from "../src/modules/operator/dual-account-topology";
import { expectedGateSnapshotFor, type ProcessProbe } from "../src/modules/operator/runtime-launcher";
import {
  RUNTIME_ATTESTATION_SCHEMA_VERSION,
  readRuntimeDeploymentAttestationStatus,
  runtimeAttestationKey,
  type RuntimeAttestationRedis,
  type RuntimeGateSnapshot,
} from "../src/modules/runtime/runtime-attestation";
import { executeFencedStart, executeFencedStop } from "../src/modules/operator/worker-supervision";

/**
 * Account-scoped SAFE <-> LIVE-READY transition: the decisions.
 *
 * Everything here is pure. No process, no file, no socket, no Binance client
 * and no database is touched by any case below.
 */

const FLAT: PreShutdownCounts = {
  nonZeroPositions: { known: true, count: 0 },
  standardOpenOrders: { known: true, count: 0 },
  openAlgoOrders: { known: true, count: 0 },
};

const SAFE_ACCOUNT: SelectedAccountState = {
  systemState: "SAFE_OFF",
  profileEnabled: false,
  profileKillSwitchActive: true,
  totalActive: 0,
  pending: 0,
  open: 0,
  manualIntervention: 0,
  warnings: [],
};

const OWNED = { ok: true, value: { controlOwned: true, workerOwned: true } } as const;

function check(over: Partial<Parameters<typeof evaluateTransitionPreconditions>[0]> = {}) {
  return evaluateTransitionPreconditions({
    account: "ACCOUNT_A",
    targetMode: "LIVE_READY",
    selected: SAFE_ACCOUNT,
    exchange: FLAT,
    ownership: OWNED,
    pending: null,
    ...over,
  });
}

const reasonsOf = (verdict: ReturnType<typeof check>) => (verdict.ok ? [] : verdict.reasons);

// ===========================================================================
// Role and file scoping
// ===========================================================================

describe("a transition can only ever name two roles and one file", () => {
  it("selects exactly the chosen account's control and worker", () => {
    expect(rolesForAccount("ACCOUNT_A")).toEqual({
      control: "account-a-control",
      worker: "account-a-worker",
    });
    expect(rolesForAccount("ACCOUNT_B")).toEqual({
      control: "account-b-control",
      worker: "account-b-worker",
    });
  });

  it("never names a generic role or the other account", () => {
    for (const account of ["ACCOUNT_A", "ACCOUNT_B"] as const) {
      const { control, worker } = rolesForAccount(account);
      const other = account === "ACCOUNT_A" ? "account-b" : "account-a";
      for (const role of [control, worker]) {
        expect(`${account}:${role}`).not.toContain("generic");
        expect(`${account}:${role}`).not.toContain(other);
      }
    }
  });

  it("derives the env alias from the ROLE contract, so file and process agree", () => {
    expect(envAliasForAccount("ACCOUNT_A")).toBe("account-a");
    expect(envAliasForAccount("ACCOUNT_B")).toBe("account-b");
    // Never the generic file.
    expect(envAliasForAccount("ACCOUNT_A")).not.toBe("generic");
    expect(envAliasForAccount("ACCOUNT_B")).not.toBe("generic");
  });
});

// ===========================================================================
// Preconditions
// ===========================================================================

describe("transition preconditions", () => {
  it("a SAFE, flat, launcher-owned account may transition", () => {
    expect(check()).toEqual({ ok: true });
  });

  it("refuses when process observation is UNAVAILABLE — UNKNOWN is not ABSENT", () => {
    for (const reason of ["COMMAND_FAILED", "EXIT_STATUS", "UNPARSEABLE"] as const) {
      const verdict = check({ ownership: { ok: false, reason } });
      expect(verdict.ok).toBe(false);
      expect(reasonsOf(verdict).join(" ")).toContain("could not be observed");
      expect(reasonsOf(verdict).join(" ")).toContain(reason);
    }
  });

  it("refuses when either selected role is not launcher-owned", () => {
    const noControl = check({ ownership: { ok: true, value: { controlOwned: false, workerOwned: true } } });
    expect(reasonsOf(noControl).join(" ")).toContain("control plane is not launcher-owned");
    const noWorker = check({ ownership: { ok: true, value: { controlOwned: true, workerOwned: false } } });
    expect(reasonsOf(noWorker).join(" ")).toContain("execution worker is not launcher-owned");
  });

  it("refuses a non-SAFE_OFF account", () => {
    for (const state of ["ARMED", "SAFE_RECOVERY", "INVALID", "UNKNOWN"]) {
      const verdict = check({ selected: { ...SAFE_ACCOUNT, systemState: state } });
      expect(`${state}:${verdict.ok}`).toBe(`${state}:false`);
      expect(reasonsOf(verdict).join(" ")).toContain("requires SAFE_OFF");
    }
  });

  it("refuses an enabled profile or a released profile kill switch", () => {
    expect(reasonsOf(check({ selected: { ...SAFE_ACCOUNT, profileEnabled: true } })).join(" ")).toContain("is ENABLED");
    expect(
      reasonsOf(check({ selected: { ...SAFE_ACCOUNT, profileKillSwitchActive: false } })).join(" ")
    ).toContain("kill switch is released");
  });

  it("refuses ANY non-zero exposure count", () => {
    for (const field of ["totalActive", "pending", "open", "manualIntervention"] as const) {
      const verdict = check({ selected: { ...SAFE_ACCOUNT, [field]: 1 } });
      expect(`${field}:${verdict.ok}`).toBe(`${field}:false`);
      expect(reasonsOf(verdict).join(" ")).toContain("must be zero");
    }
  });

  it("refuses an UNREADABLE exposure count — null is never a zero", () => {
    for (const field of ["totalActive", "pending", "open", "manualIntervention"] as const) {
      const verdict = check({ selected: { ...SAFE_ACCOUNT, [field]: null } });
      expect(`${field}:${verdict.ok}`).toBe(`${field}:false`);
      expect(reasonsOf(verdict).join(" ")).toContain("could not be read");
    }
  });

  it("refuses an unread control plane outright", () => {
    const verdict = check({ selected: { ...SAFE_ACCOUNT, systemState: null } });
    expect(reasonsOf(verdict).join(" ")).toContain("never assumed safe");
  });

  it("refuses every blocking warning, and ignores informational ones", () => {
    for (const code of BLOCKING_WARNINGS) {
      const verdict = check({ selected: { ...SAFE_ACCOUNT, warnings: [code] } });
      expect(`${code}:${verdict.ok}`).toBe(`${code}:false`);
      expect(reasonsOf(verdict).join(" ")).toContain(code);
    }
    expect(check({ selected: { ...SAFE_ACCOUNT, warnings: ["CAPACITY_EXHAUSTED"] } })).toEqual({ ok: true });
  });

  it("refuses when warnings could not be read at all", () => {
    expect(reasonsOf(check({ selected: { ...SAFE_ACCOUNT, warnings: null } })).join(" ")).toContain(
      "warnings could not be read"
    );
  });

  it("refuses while another transition is still pending", () => {
    const pending: PendingTransition = {
      account: "ACCOUNT_B",
      fromMode: "SAFE",
      targetMode: "LIVE_READY",
      phase: "ENV_WRITTEN",
      startedAtMs: 1,
      updatedAtMs: 2,
    };
    const verdict = check({ pending });
    expect(reasonsOf(verdict).join(" ")).toContain("incomplete ACCOUNT_B transition");
    expect(reasonsOf(verdict).join(" ")).toContain("ENV_WRITTEN");
  });
});

// ===========================================================================
// Positive exchange proof
// ===========================================================================

describe("the exchange flatness proof is positive, not assumed", () => {
  it("refuses when the exchange could not be read at all", () => {
    const verdict = check({ exchange: null });
    expect(verdict.ok).toBe(false);
    expect(reasonsOf(verdict).join(" ")).toContain("not assumed flat");
  });

  it("refuses a non-zero position, standard order or ALGO order", () => {
    const cases: [string, PreShutdownCounts][] = [
      ["positions", { ...FLAT, nonZeroPositions: { known: true, count: 1 } }],
      ["standard", { ...FLAT, standardOpenOrders: { known: true, count: 2 } }],
      ["algo", { ...FLAT, openAlgoOrders: { known: true, count: 3 } }],
    ];
    for (const [label, exchange] of cases) {
      const verdict = check({ exchange });
      expect(`${label}:${verdict.ok}`).toBe(`${label}:false`);
      expect(reasonsOf(verdict).join(" ")).toContain("Exchange:");
    }
  });

  it("refuses an UNKNOWN count on any of the three reads", () => {
    for (const field of ["nonZeroPositions", "standardOpenOrders", "openAlgoOrders"] as const) {
      const verdict = check({ exchange: { ...FLAT, [field]: { known: false } } });
      expect(`${field}:${verdict.ok}`).toBe(`${field}:false`);
      expect(reasonsOf(verdict).join(" ")).toContain("not assumed to be zero");
    }
  });

  it("requires the proof for the return to SAFE as well", () => {
    // Restarting a runtime that still holds exposure is the one thing neither
    // direction may do.
    const verdict = check({
      targetMode: "SAFE",
      exchange: { ...FLAT, openAlgoOrders: { known: true, count: 1 } },
    });
    expect(verdict.ok).toBe(false);
  });

  it("names no symbol, order id or balance in any refusal", () => {
    const verdict = check({
      exchange: {
        nonZeroPositions: { known: true, count: 2 },
        standardOpenOrders: { known: false },
        openAlgoOrders: { known: true, count: 5 },
      },
    });
    const text = reasonsOf(verdict).join(" ");
    expect(text).not.toMatch(/USDT|BTC|orderId|clientOrderId|balance|\$\d/i);
  });
});

// ===========================================================================
// Crash recovery: what each interruption point still owes
// ===========================================================================

describe("recovery from an interrupted transition always targets SAFE", () => {
  const pendingAt = (phase: TransitionPhase): PendingTransition => ({
    account: "ACCOUNT_A",
    fromMode: "SAFE",
    targetMode: "LIVE_READY",
    phase,
    startedAtMs: 1_000,
    updatedAtMs: 2_000,
  });

  it("phases are ordered, and ENV_WRITTEN is the boundary", () => {
    expect(TRANSITION_PHASES.indexOf("ENV_WRITTEN")).toBeGreaterThan(TRANSITION_PHASES.indexOf("CONTROL_STOPPED"));
    expect(phaseAtLeast("CONTROL_STARTED", "ENV_WRITTEN")).toBe(true);
    expect(phaseAtLeast("CONTROL_STOPPED", "ENV_WRITTEN")).toBe(false);
  });

  it("interrupted BEFORE the env write leaves the file alone", () => {
    for (const phase of ["PRECHECKED", "WORKER_STOPPED", "CONTROL_STOPPED"] as const) {
      const plan = recoveryPlanFor(pendingAt(phase));
      expect(`${phase}:${plan.rewriteEnvToSafe}`).toBe(`${phase}:false`);
    }
  });

  it("interrupted AFTER the env write rewrites the gates back to SAFE", () => {
    for (const phase of ["ENV_WRITTEN", "CONTROL_STARTED", "CONTROL_HEALTHY", "WORKER_STARTED"] as const) {
      const plan = recoveryPlanFor(pendingAt(phase));
      expect(`${phase}:${plan.rewriteEnvToSafe}`).toBe(`${phase}:true`);
    }
  });

  it("restores exactly the roles each phase disturbed", () => {
    expect(recoveryPlanFor(pendingAt("PRECHECKED")).restartRoles).toEqual([]);
    expect(recoveryPlanFor(pendingAt("WORKER_STOPPED")).restartRoles).toEqual(["account-a-worker"]);
    expect(recoveryPlanFor(pendingAt("CONTROL_STOPPED")).restartRoles).toEqual([
      "account-a-control",
      "account-a-worker",
    ]);
    expect(recoveryPlanFor(pendingAt("WORKER_STARTED")).restartRoles).toEqual([
      "account-a-control",
      "account-a-worker",
    ]);
  });

  it("never plans to restart a generic role or the other account", () => {
    for (const phase of TRANSITION_PHASES) {
      for (const account of ["ACCOUNT_A", "ACCOUNT_B"] as const) {
        const plan = recoveryPlanFor({ ...pendingAt(phase), account });
        const other = account === "ACCOUNT_A" ? "account-b" : "account-a";
        for (const role of plan.restartRoles) {
          expect(`${account}/${phase}:${role}`).not.toContain("generic");
          expect(`${account}/${phase}:${role}`).not.toContain(other);
        }
      }
    }
  });

  it("recovers to SAFE even when the interrupted transition was heading to SAFE", () => {
    // The target is always SAFE, whichever direction was interrupted: finishing
    // an activation nobody is watching is never the safe completion.
    const plan = recoveryPlanFor({ ...pendingAt("ENV_WRITTEN"), fromMode: "LIVE_READY", targetMode: "SAFE" });
    expect(plan.rewriteEnvToSafe).toBe(true);
    expect(plan.restartRoles).toEqual(["account-a-control", "account-a-worker"]);
  });

  it("carries no credential or environment contents in the durable marker", () => {
    const marker = pendingAt("ENV_WRITTEN");
    const keys = Object.keys(marker).sort();
    expect(keys).toEqual(["account", "fromMode", "phase", "startedAtMs", "targetMode", "updatedAtMs"]);
    const serialized = JSON.stringify(marker);
    expect(serialized).not.toMatch(/TOKEN|SECRET|KEY|PASSWORD|postgres|redis|BINANCE/i);
  });
});


// ===========================================================================
// The sequence: order, isolation, durability, rollback
//
// The account's control plane judges attestation against its OWN loaded gates,
// so a control plane on LIVE-READY beside a worker still on SAFE reports a
// mismatch. Both roles must move, and the worker must be DOWN while the gates
// are rewritten -- which is what this order exists to guarantee.
//
// The harness below is a small machine rather than a set of stubs: processes
// live in a map, a kill removes one, and a probe reports what is actually
// there. Nothing here asserts on the sequence's source text; every case drives
// it and watches what it does to that machine.
// ===========================================================================

const REPO = "C:\\Projects\\trading-alert-dashboard";
const NOW = 1_800_000_000_000;

interface HarnessOptions {
  /** Roles whose tree survives a kill. */
  readonly unstoppable?: readonly DualRole[];
  /** Roles whose tree survives a kill, but only once the gates are rewritten. */
  readonly unstoppableOnceLive?: readonly DualRole[];
  /** Roles whose every start refuses: the census sees an unexplained leaf. */
  readonly unstartable?: readonly DualRole[];
  /** Roles whose FIRST start refuses, as a transient duplicate would. */
  readonly unstartableOnce?: readonly DualRole[];
  /** Roles that never attest to the target mode. */
  readonly unverifiable?: readonly DualRole[];
  /** Roles that never attest to SAFE either, so recovery cannot finish. */
  readonly safeUnverifiable?: readonly DualRole[];
  /** Gate writes fail for this mode. */
  readonly writeFailsFor?: RuntimeMode;
  /** The durable marker throws once this phase is reached. */
  readonly journalFailsAt?: TransitionPhase;
  /** Roles whose ownership can never be freshly proven (machine unobservable). */
  readonly ownershipUnobservable?: readonly DualRole[];
  /** Roles that are running but no longer provably ours. */
  readonly ownershipLost?: readonly DualRole[];
  /** Roles with no durable record at all. */
  readonly unrecorded?: readonly DualRole[];
  /** Roles whose stop can never be observed. */
  readonly stopUnobservable?: readonly DualRole[];
  /** Roles the stop probe finds alive but under a different identity. */
  readonly stopOwnershipLost?: readonly DualRole[];
  /** Roles whose freshly spawned tree has no readable creation time. */
  readonly creationTimeUnreadable?: readonly DualRole[];
  /** Clearing the marker throws, as an unwritable state file would. */
  readonly clearFails?: boolean;
}

interface Harness {
  /** Every externally visible act, in order. */
  readonly events: string[];
  readonly journal: TransitionPhase[];
  readonly gateWrites: RuntimeMode[];
  readonly terminated: number[];
  readonly spawned: DualRole[];
  readonly alive: Map<number, ProcessProbe>;
  readonly records: Map<string, { role: string; pid: number; startedAtMs: number }>;
  readonly adapters: TransitionAdapters;
  cleared: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const journal: TransitionPhase[] = [];
  const gateWrites: RuntimeMode[] = [];
  const terminated: number[] = [];
  const spawned: DualRole[] = [];
  const alive = new Map<number, ProcessProbe>();
  const records = new Map<string, { role: string; pid: number; startedAtMs: number }>();
  const pidRole = new Map<number, DualRole>();
  const startAttempts = new Map<DualRole, number>();
  let nextPid = 9000;

  const bring = (role: DualRole, pid: number, startedAtMs: number): void => {
    alive.set(pid, { pid, startedAtMs, commandLine: `cmd.exe /c pnpm -C ${REPO} run start:${role}` });
    pidRole.set(pid, role);
  };

  // Every account role begins up and owned, as a live SAFE runtime is.
  for (const account of ["ACCOUNT_A", "ACCOUNT_B"] as const) {
    const { control, worker } = rolesForAccount(account);
    for (const role of [control, worker]) {
      const pid = 4000 + records.size * 7;
      bring(role, pid, NOW - 60_000);
      records.set(role, { role, pid, startedAtMs: NOW - 60_000 });
    }
  }
  // And so do the generic roles, which this must never touch.
  for (const role of ["generic-backend", "generic-analysis"] as const) {
    records.set(role, { role, pid: 3000 + role.length, startedAtMs: NOW - 60_000 });
  }

  const box: Harness = {
    events,
    journal,
    gateWrites,
    terminated,
    spawned,
    alive,
    records,
    cleared: false,
    adapters: {
      repoRoot: REPO,
      recordFor: (role) => ((options.unrecorded ?? []).includes(role) ? null : records.get(role) ?? null),
      proveOwned: (role) => {
        if ((options.ownershipUnobservable ?? []).includes(role)) {
          return { ok: false, reason: "COMMAND_FAILED" };
        }
        if ((options.ownershipLost ?? []).includes(role)) return { ok: true, value: false };
        const record = records.get(role);
        return { ok: true, value: record !== undefined && alive.has(record.pid) };
      },
      stop: {
        probe: (pid) => {
          const role = pidRole.get(pid);
          if (role !== undefined && (options.stopUnobservable ?? []).includes(role)) {
            return { observed: false };
          }
          const process = alive.get(pid) ?? null;
          if (process !== null && role !== undefined && (options.stopOwnershipLost ?? []).includes(role)) {
            // A live tree whose creation time does not match the record: the
            // pid was reused, so it is emphatically not ours to kill.
            return { observed: true, process: { ...process, startedAtMs: NOW + 5_000_000 } };
          }
          return { observed: true, process };
        },
        terminate: (pid) => {
          terminated.push(pid);
          events.push(`terminate:${pidRole.get(pid) ?? pid}`);
          const role = pidRole.get(pid);
          // An unstoppable tree is signalled and stays up, so the post-kill
          // observation still finds it.
          const survives =
            role !== undefined &&
            ((options.unstoppable ?? []).includes(role) ||
              ((options.unstoppableOnceLive ?? []).includes(role) && gateWrites.length > 0));
          if (survives) return true;
          alive.delete(pid);
          return true;
        },
        log: () => undefined,
      },
      startFor: (role) => {
        const attempt = (startAttempts.get(role) ?? 0) + 1;
        return {
          probe: (pid: number) => {
            if ((options.creationTimeUnreadable ?? []).includes(role)) return { observed: false };
            return { observed: true, process: alive.get(pid) ?? null };
          },
          unaccountedLeaves: () => {
            startAttempts.set(role, attempt);
            if ((options.unstartable ?? []).includes(role)) return 1;
            if ((options.unstartableOnce ?? []).includes(role) && attempt === 1) return 1;
            return 0;
          },
          spawnWorker: () => {
            const pid = nextPid++;
            bring(role, pid, NOW);
            spawned.push(role);
            events.push(`spawn:${role}`);
            return pid;
          },
          recordOwnership: (pid: number, startedAtMs: number) => {
            records.set(role, { role, pid, startedAtMs });
            events.push(`record:${role}`);
          },
          log: () => undefined,
        };
      },
      journal: (phase) => {
        if (options.journalFailsAt === phase) throw new Error("the marker could not be written");
        journal.push(phase);
        events.push(`journal:${phase}`);
      },
      clearJournal: () => {
        if (options.clearFails) throw new Error("the marker could not be cleared");
        box.cleared = true;
      },
      writeGates: (mode) => {
        if (options.writeFailsFor === mode) return { ok: false, reason: "the file could not be replaced" };
        gateWrites.push(mode);
        events.push(`write:${mode}`);
        return { ok: true };
      },
      verify: async (role, mode) => {
        const blocked =
          mode === "SAFE"
            ? (options.safeUnverifiable ?? []).includes(role)
            : (options.unverifiable ?? []).includes(role);
        return blocked ? { ok: false, reasons: [`${role} did not attest to ${mode}`] } : { ok: true };
      },
      log: () => undefined,
    },
  };
  return box;
}

/** Only the acts that touch a process or a file, with the marker filtered out. */
const mutations = (box: Harness): string[] => box.events.filter((e) => !e.startsWith("journal:"));

/** A forward run from a PROVEN SAFE, which is what the launcher proves first. */
const liveReady = (account: "ACCOUNT_A" | "ACCOUNT_B", box: Harness) =>
  executeAccountTransition(
    { account, fromMode: "SAFE", targetMode: "LIVE_READY", startedAtMs: NOW },
    box.adapters
  );

describe("the transition sequence, when everything works", () => {
  it("stops both roles, rewrites the gates, then starts control before worker", async () => {
    const box = harness();
    const result = await liveReady("ACCOUNT_A", box);

    expect(result).toEqual({ ok: true, mode: "LIVE_READY" });
    expect(mutations(box)).toEqual([
      "terminate:account-a-worker",
      "terminate:account-a-control",
      // The gates are rewritten with BOTH roles down.
      "write:LIVE_READY",
      "spawn:account-a-control",
      "record:account-a-control",
      "spawn:account-a-worker",
      "record:account-a-worker",
    ]);
  });

  it("records ownership of each new tree immediately after spawning it", async () => {
    const box = harness();
    await liveReady("ACCOUNT_A", box);

    for (const role of ["account-a-control", "account-a-worker"] as const) {
      const spawnAt = box.events.indexOf(`spawn:${role}`);
      const recordAt = box.events.indexOf(`record:${role}`);
      expect(recordAt).toBe(spawnAt + 1);
      // And the durable record names the tree that is actually running.
      const record = box.records.get(role);
      expect(box.alive.has(record?.pid ?? -1)).toBe(true);
    }
  });

  it("writes the durable marker BEFORE the first process is touched", async () => {
    const box = harness();
    await liveReady("ACCOUNT_A", box);

    expect(box.events[0]).toBe("journal:PRECHECKED");
    expect(box.terminated.length).toBeGreaterThan(0);
  });

  it("persists each step BEFORE performing it, never after", async () => {
    const box = harness();
    await liveReady("ACCOUNT_A", box);

    // A marker behind reality would leave a stopped role nothing would restart.
    expect(box.events.indexOf("journal:WORKER_STOPPED")).toBeLessThan(
      box.events.indexOf("terminate:account-a-worker")
    );
    expect(box.events.indexOf("journal:CONTROL_STOPPED")).toBeLessThan(
      box.events.indexOf("terminate:account-a-control")
    );
    expect(box.events.indexOf("journal:ENV_WRITTEN")).toBeLessThan(box.events.indexOf("write:LIVE_READY"));
    expect(box.events.indexOf("journal:CONTROL_STARTED")).toBeLessThan(
      box.events.indexOf("spawn:account-a-control")
    );
    expect(box.events.indexOf("journal:WORKER_STARTED")).toBeLessThan(
      box.events.indexOf("spawn:account-a-worker")
    );
  });

  it("journals every boundary in phase order, and clears the marker only at the end", async () => {
    const box = harness();
    await liveReady("ACCOUNT_A", box);

    expect(box.journal).toEqual([...TRANSITION_PHASES]);
    expect(box.cleared).toBe(true);
  });

  it("writes the gates once, for the selected mode only", async () => {
    const box = harness();
    await liveReady("ACCOUNT_B", box);
    expect(box.gateWrites).toEqual(["LIVE_READY"]);
  });

  it("the return path is the same engine aimed at SAFE", async () => {
    const box = harness();
    const result = await executeAccountTransition(
      { account: "ACCOUNT_A", fromMode: "LIVE_READY", targetMode: "SAFE", startedAtMs: NOW },
      box.adapters
    );
    expect(result).toEqual({ ok: true, mode: "SAFE" });
    expect(box.gateWrites).toEqual(["SAFE"]);
    expect(box.spawned).toEqual(["account-a-control", "account-a-worker"]);
  });
});

describe("the sequence touches ONLY the selected account", () => {
  it("leaves the other account's and the generic roles' trees running", async () => {
    for (const account of ["ACCOUNT_A", "ACCOUNT_B"] as const) {
      const box = harness();
      const other = account === "ACCOUNT_A" ? "ACCOUNT_B" : "ACCOUNT_A";
      const otherRoles = rolesForAccount(other);
      const untouched = [otherRoles.control, otherRoles.worker];
      const before = untouched.map((role) => box.records.get(role)?.pid ?? -1);
      const genericBefore = ["generic-backend", "generic-analysis"].map(
        (role) => box.records.get(role)?.pid ?? -1
      );

      await liveReady(account, box);

      // Their pids are unchanged and their trees are still alive.
      expect(untouched.map((role) => box.records.get(role)?.pid ?? -1)).toEqual(before);
      for (const pid of before) {
        expect(`${account}:${pid}:${box.alive.has(pid)}`).toBe(`${account}:${pid}:true`);
      }
      expect(box.terminated.filter((pid) => before.includes(pid))).toEqual([]);
      expect(
        ["generic-backend", "generic-analysis"].map((role) => box.records.get(role)?.pid ?? -1)
      ).toEqual(genericBefore);

      // And nothing it did names them.
      for (const event of mutations(box)) {
        expect(`${account}:${event}`).not.toContain("generic");
        expect(`${account}:${event}`).not.toContain(account === "ACCOUNT_A" ? "account-b" : "account-a");
      }
    }
  });
});

// ===========================================================================
// Once PRECHECKED is durable, only a PROVEN state may clear it
//
// An earlier version asked whether THIS run had terminated anything, and
// cleared the journal when it had not. That read a worker which died on its
// own as "nothing happened": the marker went in, the worker exited by itself,
// the fenced stop reported it already GONE, a later step failed, and the
// journal was cleared -- leaving a missing worker and no record that anything
// had been in flight.
//
// The question was wrong. Once the marker is durable, the account can move for
// reasons this process did not cause, and every later failure is a
// contradiction found after the transition began.
// ===========================================================================

describe("the only clean refusals happen BEFORE the marker exists", () => {
  it("an unwritable FIRST marker refuses, and claims no durable record", async () => {
    // Reporting INCOMPLETE here would send an operator to recover a marker
    // that was never written.
    const box = harness({ journalFailsAt: "PRECHECKED" });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("REFUSED");
    expect(box.journal).toEqual([]);
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
    expect(box.gateWrites).toEqual([]);
    // And it does NOT clear: there may be an older marker it knows nothing
    // about, and clearing that would erase someone else's record.
    expect(box.cleared).toBe(false);
  });
});

describe("after PRECHECKED, no failure clears the marker unaided", () => {
  it("a worker that ignores the kill does NOT clear it", async () => {
    const box = harness({ unstoppable: ["account-a-worker"] });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
    expect(box.gateWrites).toEqual([]);
    expect(box.spawned).toEqual([]);
  });

  it("a worker that was ALREADY GONE, then a later failure, does not clear it", async () => {
    // The exact hole: nothing this run did caused the worker to be missing, so
    // the old logic called it a clean refusal and dropped the marker.
    const box = harness({ unrecorded: [], writeFailsFor: "LIVE_READY" });
    box.alive.delete(box.records.get("account-a-worker")?.pid ?? -1);

    const result = await liveReady("ACCOUNT_A", box);
    expect(result.ok).toBe(false);
    // Either it got back to a proven SAFE, or it kept the marker. What it may
    // NOT do is clear the marker without proving one of them.
    if (result.ok === false && result.state === "RECOVERED") {
      expect(box.cleared).toBe(true);
      expect(box.spawned).toContain("account-a-worker");
    } else {
      expect(result.ok === false && result.state).toBe("INCOMPLETE");
      expect(box.cleared).toBe(false);
    }
  });

  it("already GONE worker plus a control plane that is no longer ours", async () => {
    const box = harness({ stopOwnershipLost: ["account-a-control"] });
    box.alive.delete(box.records.get("account-a-worker")?.pid ?? -1);

    const result = await liveReady("ACCOUNT_A", box);
    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
    expect(box.gateWrites).toEqual([]);
  });

  it("already GONE worker plus a gate write that fails", async () => {
    const box = harness({ writeFailsFor: "LIVE_READY" });
    box.alive.delete(box.records.get("account-a-worker")?.pid ?? -1);

    const result = await liveReady("ACCOUNT_A", box);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.state === "RECOVERED" ? box.cleared : !box.cleared).toBe(true);
  });

  it("BOTH roles already gone, then a later failure", async () => {
    const box = harness({ unstartable: ["account-a-control"] });
    for (const role of ["account-a-worker", "account-a-control"] as const) {
      box.alive.delete(box.records.get(role)?.pid ?? -1);
    }

    const result = await liveReady("ACCOUNT_A", box);
    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
  });

  it("an observation that goes UNKNOWN does not clear it", async () => {
    const box = harness({ stopUnobservable: ["account-a-worker"] });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
  });

  it("a role with NO RECORD after the second proof does not clear it", async () => {
    const box = harness({ unrecorded: ["account-a-worker"] });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.state).not.toBe("REFUSED");
  });

  it("a marker that cannot be updated mid-run still proves SAFE before clearing", async () => {
    // Nothing was touched, but the marker IS durable -- so the way out is a
    // proof, not an assumption.
    const box = harness({ journalFailsAt: "WORKER_STOPPED" });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("RECOVERED");
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
    expect(box.gateWrites).toEqual([]);
    // Cleared, but only after `proveAccountAt` said SAFE.
    expect(box.cleared).toBe(true);
  });

  it("the same case does NOT clear when SAFE cannot be proven", async () => {
    const box = harness({ journalFailsAt: "WORKER_STOPPED", ownershipLost: ["account-a-worker"] });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
  });

  it("a proven target still clears it", async () => {
    const box = harness();
    const result = await liveReady("ACCOUNT_A", box);
    expect(result).toEqual({ ok: true, mode: "LIVE_READY" });
    expect(box.cleared).toBe(true);
  });

  it("a proven SAFE recovery still clears it", async () => {
    const box = harness({ unverifiable: ["account-a-control"] });
    const result = await liveReady("ACCOUNT_A", box);
    expect(result.ok === false && result.state).toBe("RECOVERED");
    expect(box.cleared).toBe(true);
  });

  it("reaching the target but failing to CLEAR is reported, not called success", async () => {
    const box = harness({ clearFails: true });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(result.ok === false && result.reasons.join(" ")).toContain("could not be cleared");
  });
});

describe("a failure after something HAS been touched returns the account to SAFE", () => {
  it("a gate write that fails restarts the two roles it stopped", async () => {
    const box = harness({ writeFailsFor: "LIVE_READY" });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("RECOVERED");
    // The target gates were never written; SAFE is rewritten regardless,
    // because the marker deliberately over-states and a SAFE write is a no-op.
    expect(box.gateWrites).toEqual(["SAFE"]);
    expect(box.spawned).toEqual(["account-a-control", "account-a-worker"]);
    expect(box.cleared).toBe(true);
  });

  it("a control plane that will not attest rolls the gates back", async () => {
    const box = harness({ unverifiable: ["account-a-control"] });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("RECOVERED");
    expect(box.gateWrites).toEqual(["LIVE_READY", "SAFE"]);
    // The control plane it started on LIVE-READY gates was stopped and
    // replaced by one on SAFE gates.
    expect(box.spawned).toEqual(["account-a-control", "account-a-control", "account-a-worker"]);
    expect(box.cleared).toBe(true);
  });

  it("a worker that cannot be started rolls the gates back", async () => {
    const box = harness({ unstartableOnce: ["account-a-worker"] });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("RECOVERED");
    expect(box.gateWrites).toEqual(["LIVE_READY", "SAFE"]);
    expect(box.cleared).toBe(true);
  });

  it("an unwritable marker after the gate write never starts a role on them", async () => {
    const box = harness({ journalFailsAt: "CONTROL_STARTED" });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("RECOVERED");
    expect(box.gateWrites).toEqual(["LIVE_READY", "SAFE"]);
    // Write-ahead: the control plane was never spawned on the LIVE-READY
    // gates, so the only spawns are recovery's own.
    expect(box.spawned).toEqual(["account-a-control", "account-a-worker"]);
  });
});

describe("recovery that cannot PROVE SAFE keeps the marker", () => {
  it("a control plane that will not attest to SAFE either", async () => {
    // Claiming success here would be the one unrecoverable lie: the operator
    // would be told the account is SAFE with nothing having proven it.
    const box = harness({
      unverifiable: ["account-a-control"],
      safeUnverifiable: ["account-a-control"],
    });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
  });

  it("a SAFE gate write that fails during recovery", async () => {
    const box = harness({ unverifiable: ["account-a-control"], writeFailsFor: "SAFE" });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
    expect(box.gateWrites).toEqual(["LIVE_READY"]);
  });

  it("a role that will not stop during recovery, so it may still be on live gates", async () => {
    const box = harness({
      unverifiable: ["account-a-control"],
      unstoppableOnceLive: ["account-a-control"],
    });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
  });

  it("a control plane that ignores the kill, once the worker is already down", async () => {
    const box = harness({ unstoppable: ["account-a-control"] });
    const result = await liveReady("ACCOUNT_A", box);

    // The worker WAS killed, so this is not a clean refusal -- and the control
    // plane cannot be stopped, so recovery cannot re-prove the pair.
    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
    expect(box.gateWrites).toEqual([]);
  });
});

// ===========================================================================
// The crash gap: spawned, but not yet recorded
//
// `executeFencedStart` records ownership on the line after the spawn returns,
// but a crash can still land between them. Recovery then meets a runtime that
// IS ours and that we cannot prove is ours -- the definition of UNKNOWN. What
// follows proves recovery neither kills it nor spawns beside it.
// ===========================================================================

describe("a crash between spawning a role and recording it", () => {
  const orphan = (role: DualRole, pid: number): ProcessProbe => ({
    pid,
    startedAtMs: NOW,
    commandLine: `cmd.exe /c pnpm -C ${REPO} run start:${role}`,
  });

  for (const role of ["account-a-control", "account-a-worker"] as const) {
    it(`leaves an unrecorded ${role} running rather than killing it`, () => {
      const alive = new Map<number, ProcessProbe>([[7777, orphan(role, 7777)]]);
      const terminated: number[] = [];
      // The durable record still names the OLD pid, which is already gone.
      const staleRecord = { role, pid: 4242, startedAtMs: NOW - 60_000 };

      const stop = executeFencedStop(staleRecord, REPO, {
        probe: (pid: number) => ({ observed: true, process: alive.get(pid) ?? null }),
        terminate: (pid: number) => {
          terminated.push(pid);
          return true;
        },
        log: () => undefined,
      });

      // The recorded tree is gone, so the stop succeeds -- and the orphan is
      // untouched, because nothing ever claimed it.
      expect(stop).toEqual({ stopped: true, alreadyGone: true });
      expect(terminated).toEqual([]);
      expect(alive.has(7777)).toBe(true);
    });

    it(`refuses to start a second ${role} beside the unrecorded one`, () => {
      const spawned: number[] = [];
      const started = executeFencedStart(role, {
        // The census sees a matching leaf that no record explains.
        unaccountedLeaves: () => 1,
        probe: () => ({ observed: true, process: null }),
        spawnWorker: () => {
          spawned.push(1);
          return 8888;
        },
        log: () => undefined,
      });

      expect(started.started).toBe(false);
      expect(started.started === false && started.outcome).toBe("DUPLICATE_PRESENT");
      expect(spawned).toEqual([]);
    });
  }

  it("so an account whose replacement cannot be started stays INCOMPLETE", () => {
    // End to end, with the census permanently seeing the unexplained leaf.
    const box = harness({ unstartable: ["account-a-control"] });
    return liveReady("ACCOUNT_A", box).then((result) => {
      expect(result.ok === false && result.state).toBe("INCOMPLETE");
      expect(box.cleared).toBe(false);
      expect(box.spawned).toEqual([]);
    });
  });
});


// ===========================================================================
// The durable marker: reading it, and what it fences
//
// "There is no marker" and "there is a marker I cannot understand" are
// opposite facts. A reader that returns null for both -- which is what a
// try/catch around JSON.parse does -- hands an interrupted transition straight
// back to Start SAFE. Everything below exists to keep them apart.
// ===========================================================================

const MARKER = {
  account: "ACCOUNT_A",
  fromMode: "SAFE",
  targetMode: "LIVE_READY",
  phase: "ENV_WRITTEN",
  startedAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_060_000,
};

describe("reading the transition marker", () => {
  it("a state file written before this feature existed has no marker", () => {
    // The field is absent, which is a PROVEN absence, not a corrupt record.
    expect(parseTransitionMarker(undefined)).toEqual({ status: "NONE" });
  });

  it("an explicitly cleared marker is an absence too", () => {
    expect(parseTransitionMarker(null)).toEqual({ status: "NONE" });
  });

  it("a complete marker parses to exactly its six fields", () => {
    const read = parseTransitionMarker({ ...MARKER, somethingElse: "ignored" });
    expect(read.status).toBe("PENDING");
    expect(read.status === "PENDING" && read.transition).toEqual(MARKER);
    // The stray field is dropped rather than carried into a safety record.
    expect(read.status === "PENDING" && Object.keys(read.transition).sort()).toEqual([
      "account",
      "fromMode",
      "phase",
      "startedAtMs",
      "targetMode",
      "updatedAtMs",
    ]);
  });

  it.each([
    ["a string", "PENDING"],
    ["a number", 3],
    ["an array", [MARKER]],
    ["a boolean", true],
  ])("%s is UNREADABLE, never an absence", (_label, raw) => {
    const read = parseTransitionMarker(raw);
    expect(read.status).toBe("UNREADABLE");
  });

  it.each([
    "account",
    "fromMode",
    "targetMode",
    "phase",
    "startedAtMs",
    "updatedAtMs",
  ])("a marker missing %s is UNREADABLE and says so", (field) => {
    const partial: Record<string, unknown> = { ...MARKER };
    delete partial[field];
    const read = parseTransitionMarker(partial);

    expect(read.status).toBe("UNREADABLE");
    expect(read.status === "UNREADABLE" && read.reason).toContain(field);
  });

  it.each([
    ["an unknown phase", { phase: "ALMOST_DONE" }],
    ["a phase from another vocabulary", { phase: "RUNNING" }],
    ["an account this cannot move", { account: "GENERIC" }],
    ["an invented account", { account: "ACCOUNT_C" }],
    ["an unknown mode", { targetMode: "LIVE" }],
    ["a negative instant", { startedAtMs: -1 }],
    ["an instant that is not a number", { updatedAtMs: "2026-09-28" }],
    ["a NaN instant", { startedAtMs: Number.NaN }],
  ])("%s is UNREADABLE rather than repaired", (_label, override) => {
    const read = parseTransitionMarker({ ...MARKER, ...override });
    expect(read.status).toBe("UNREADABLE");
  });

  it("every phase in the vocabulary is accepted", () => {
    for (const phase of TRANSITION_PHASES) {
      const read = parseTransitionMarker({ ...MARKER, phase });
      expect(`${phase}:${read.status}`).toBe(`${phase}:PENDING`);
    }
  });
});

describe("what a marker fences", () => {
  const A = rolesForAccount("ACCOUNT_A");
  const B = rolesForAccount("ACCOUNT_B");
  const ALL = [A.control, A.worker, B.control, B.worker, "generic-backend", "generic-analysis"] as const;

  it("no marker fences nothing", () => {
    expect(evaluateTransitionGate({ status: "NONE" }, [...ALL])).toEqual({ ok: true });
  });

  it("a PENDING marker fences its OWN account's two roles", () => {
    const read = parseTransitionMarker(MARKER);
    const verdict = evaluateTransitionGate(read, [A.control, A.worker]);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("ACCOUNT_A");
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("ENV_WRITTEN");
  });

  it("and fences an action that touches even one of them", () => {
    for (const role of [A.control, A.worker]) {
      const verdict = evaluateTransitionGate(parseTransitionMarker(MARKER), [role]);
      expect(`${role}:${verdict.ok}`).toBe(`${role}:false`);
    }
  });

  it("but leaves the OTHER account alone", () => {
    // Account B is not made unsafe by Account A being mid-transition, and
    // blocking it would punish the account that is fine.
    const verdict = evaluateTransitionGate(parseTransitionMarker(MARKER), [B.control, B.worker]);
    expect(verdict).toEqual({ ok: true });
  });

  it("and leaves the generic roles alone", () => {
    const verdict = evaluateTransitionGate(parseTransitionMarker(MARKER), [
      "generic-backend",
      "generic-analysis",
    ]);
    expect(verdict).toEqual({ ok: true });
  });

  it("a whole-topology action is fenced, because it includes the fenced pair", () => {
    const verdict = evaluateTransitionGate(parseTransitionMarker(MARKER), [...ALL]);
    expect(verdict.ok).toBe(false);
  });

  it("an UNREADABLE marker fences EVERYTHING, including the generic roles", () => {
    // It is the one marker that cannot say which account it was about.
    const read = parseTransitionMarker({ nonsense: true });
    for (const roles of [[A.worker], [B.worker], ["generic-analysis"], [...ALL]] as const) {
      const verdict = evaluateTransitionGate(read, [...roles]);
      expect(`${roles.join("+")}:${verdict.ok}`).toBe(`${roles.join("+")}:false`);
    }
  });

  it("fencing an account for a PENDING marker works for ACCOUNT_B too", () => {
    const read = parseTransitionMarker({ ...MARKER, account: "ACCOUNT_B" });
    expect(evaluateTransitionGate(read, [B.worker]).ok).toBe(false);
    expect(evaluateTransitionGate(read, [A.worker])).toEqual({ ok: true });
  });
});

describe("what the operator is told about a pending transition", () => {
  it("phase, direction and age — and nothing that could be a secret", () => {
    const lines = describePendingTransition(
      { ...MARKER, account: "ACCOUNT_B", phase: "CONTROL_STARTED" } as PendingTransition,
      MARKER.updatedAtMs + 125_000
    );
    const text = lines.join("\n");

    expect(text).toContain("ACCOUNT_B");
    expect(text).toContain("SAFE -> LIVE_READY");
    expect(text).toContain("CONTROL_STARTED");
    expect(text).toContain("125s ago");
    expect(text).not.toMatch(/TOKEN|SECRET|KEY|PASSWORD|postgres|redis|BINANCE|127\.0\.0\.1|pid/i);
  });

  it("a marker from the future reads as zero seconds rather than a negative age", () => {
    const lines = describePendingTransition(MARKER as PendingTransition, MARKER.updatedAtMs - 5_000);
    expect(lines.join("\n")).toContain("0s ago");
  });
});


// ===========================================================================
// Recovery may only clear a marker it has PROVEN safe
//
// A recovery runs against an account that is ALREADY half-moved. The forward
// engine's clean-refusal path clears the marker when it can prove IT changed
// nothing -- correct for a brand-new transition, catastrophic here, because
// the record it would clear is not its own. Every ending short of proven SAFE
// must leave the marker exactly where it found it.
// ===========================================================================

const EXISTING: PendingTransition = {
  account: "ACCOUNT_A",
  fromMode: "SAFE",
  targetMode: "LIVE_READY",
  phase: "CONTROL_STOPPED",
  startedAtMs: NOW - 600_000,
  updatedAtMs: NOW - 540_000,
};

const untouchedElsewhere = (box: Harness): void => {
  const b = rolesForAccount("ACCOUNT_B");
  for (const role of [b.control, b.worker, "generic-backend", "generic-analysis"] as const) {
    const pid = box.records.get(role)?.pid ?? -1;
    expect(`${role}:${box.terminated.includes(pid)}`).toBe(`${role}:false`);
    expect(`${role}:${box.spawned.includes(role as DualRole)}`).toBe(`${role}:false`);
  }
};

describe("recovery of an EXISTING incomplete transition", () => {
  it("a first stop with NO RECORD keeps the marker and claims nothing", async () => {
    const box = harness({ unrecorded: ["account-a-worker"] });
    const result = await executeTransitionRecovery(EXISTING, box.adapters);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    // The account was KNOWN to be mid-transition, so a role with no record is
    // missing evidence -- not a proven absence.
    expect(box.cleared).toBe(false);
    expect(box.spawned).toEqual([]);
    untouchedElsewhere(box);
  });

  it("a first stop that LOST OWNERSHIP keeps the marker", async () => {
    const box = harness({ stopOwnershipLost: ["account-a-worker"] });
    const result = await executeTransitionRecovery(EXISTING, box.adapters);

    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
    untouchedElsewhere(box);
  });

  it("a first stop that could not be OBSERVED keeps the marker", async () => {
    const box = harness({ stopUnobservable: ["account-a-worker"] });
    const result = await executeTransitionRecovery(EXISTING, box.adapters);

    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
    untouchedElsewhere(box);
  });

  it("an unreadable census during recovery keeps the marker", async () => {
    const box = harness({ unstartable: ["account-a-control"] });
    const result = await executeTransitionRecovery(EXISTING, box.adapters);
    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
  });

  it("a failed SAFE attestation during recovery keeps the marker", async () => {
    const box = harness({ safeUnverifiable: ["account-a-worker"] });
    const result = await executeTransitionRecovery(EXISTING, box.adapters);
    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
  });

  it("a successful recovery DOES clear it, and only then", async () => {
    const box = harness();
    const result = await executeTransitionRecovery(EXISTING, box.adapters);

    expect(result.ok === false && result.state).toBe("RECOVERED");
    expect(box.cleared).toBe(true);
    expect(box.spawned).toEqual(["account-a-control", "account-a-worker"]);
    untouchedElsewhere(box);
  });

  it("recovery NEVER reports REFUSED, however early it fails", async () => {
    // REFUSED means "nothing to undo", which cannot be true of an account that
    // already has a marker. Every recovery ending is RECOVERED or INCOMPLETE.
    for (const options of [
      { unrecorded: ["account-a-worker"] as DualRole[] },
      { stopUnobservable: ["account-a-control"] as DualRole[] },
      { writeFailsFor: "SAFE" as RuntimeMode },
      { unstartable: ["account-a-worker"] as DualRole[] },
      { ownershipUnobservable: ["account-a-control"] as DualRole[] },
    ]) {
      const box = harness(options);
      const result = await executeTransitionRecovery(
        { ...EXISTING, phase: "ENV_WRITTEN" },
        box.adapters
      );
      expect(result.ok === false && result.state).not.toBe("REFUSED");
    }
  });

  it("a recovery that needs to do nothing still PROVES safe before clearing", async () => {
    // fromMode SAFE at PRECHECKED: the plan is empty. "Nothing needed undoing"
    // is still a conclusion that has to be checked.
    const box = harness({ ownershipLost: ["account-a-worker"] });
    const result = await executeTransitionRecovery(
      { ...EXISTING, phase: "PRECHECKED" },
      box.adapters
    );

    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
    expect(box.terminated).toEqual([]);
    expect(box.spawned).toEqual([]);
  });
});

// ===========================================================================
// The recovery plan asks where the FILE is, not only how far the run got
// ===========================================================================

describe("the recovery plan over every direction and phase", () => {
  const planFor = (fromMode: RuntimeMode, phase: TransitionPhase) =>
    recoveryPlanFor({ ...EXISTING, fromMode, targetMode: fromMode === "SAFE" ? "LIVE_READY" : "SAFE", phase });

  it.each([...TRANSITION_PHASES])(
    "a LIVE-READY -> SAFE run interrupted at %s still rewrites SAFE",
    (phase) => {
      // The file says LIVE-READY until ENV_WRITTEN, and SAFE after it. Both
      // are handled by rewriting SAFE, which is a no-op in the second case.
      const plan = planFor("LIVE_READY", phase);
      expect(`${phase}:${plan.rewriteEnvToSafe}`).toBe(`${phase}:true`);
      expect(plan.restartRoles).toEqual(["account-a-control", "account-a-worker"]);
    }
  );

  it.each([
    ["PRECHECKED", false, []],
    ["WORKER_STOPPED", false, ["account-a-worker"]],
    ["CONTROL_STOPPED", false, ["account-a-control", "account-a-worker"]],
    ["ENV_WRITTEN", true, ["account-a-control", "account-a-worker"]],
    ["CONTROL_STARTED", true, ["account-a-control", "account-a-worker"]],
    ["CONTROL_HEALTHY", true, ["account-a-control", "account-a-worker"]],
    ["WORKER_STARTED", true, ["account-a-control", "account-a-worker"]],
  ] as const)("a SAFE -> LIVE-READY run interrupted at %s", (phase, rewrite, roles) => {
    const plan = planFor("SAFE", phase);
    expect(`${phase}:${plan.rewriteEnvToSafe}`).toBe(`${phase}:${rewrite}`);
    expect(plan.restartRoles).toEqual(roles);
  });

  it("the whole matrix: SAFE is rewritten whenever the file may not already be SAFE", () => {
    for (const fromMode of ["SAFE", "LIVE_READY"] as const) {
      for (const phase of TRANSITION_PHASES) {
        const mayNotBeSafe = fromMode !== "SAFE" || phaseAtLeast(phase, "ENV_WRITTEN");
        expect(`${fromMode}/${phase}:${planFor(fromMode, phase).rewriteEnvToSafe}`).toBe(
          `${fromMode}/${phase}:${mayNotBeSafe}`
        );
      }
    }
  });

  it("end to end: an interrupted RETURN-to-SAFE rewrites the gates it never reached", async () => {
    const box = harness();
    const result = await executeTransitionRecovery(
      {
        account: "ACCOUNT_A",
        fromMode: "LIVE_READY",
        targetMode: "SAFE",
        phase: "PRECHECKED",
        startedAtMs: NOW - 1_000,
        updatedAtMs: NOW - 1_000,
      },
      box.adapters
    );

    expect(result.ok === false && result.state).toBe("RECOVERED");
    // The old plan read the phase alone and would have written nothing here,
    // leaving both roles restarted onto LIVE-READY gates.
    expect(box.gateWrites).toEqual(["SAFE"]);
    expect(box.spawned).toEqual(["account-a-control", "account-a-worker"]);
  });
});

// ===========================================================================
// Success means both roles are still provably OURS
// ===========================================================================

describe("the final ownership proof", () => {
  it("a transition whose control ownership cannot be OBSERVED does not succeed", async () => {
    const box = harness({ ownershipUnobservable: ["account-a-control"] });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok).toBe(false);
    expect(box.cleared).toBe(false);
  });

  it("a transition whose worker ownership is LOST after attestation does not succeed", async () => {
    const box = harness({ ownershipLost: ["account-a-worker"] });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok).toBe(false);
    // It got all the way past attestation and still did not clear the marker.
    expect(box.journal).toEqual([...TRANSITION_PHASES]);
    expect(box.cleared).toBe(false);
  });

  it("a spawned role whose creation time cannot be read is NOT a started role", async () => {
    const box = harness({ creationTimeUnreadable: ["account-a-control"] });
    const result = await liveReady("ACCOUNT_A", box);

    expect(result.ok).toBe(false);
    // Spawned, so it exists -- and deliberately not killed, because an
    // unproven process is unproven in both directions.
    expect(box.spawned).toContain("account-a-control");
    expect(box.cleared).toBe(false);
  });

  it("the same is true of the worker leg", async () => {
    const box = harness({ creationTimeUnreadable: ["account-a-worker"] });
    const result = await liveReady("ACCOUNT_A", box);
    expect(result.ok).toBe(false);
    expect(box.cleared).toBe(false);
  });

  it("recovery ends on the SAME proof, so RECOVERED is as strong as success", async () => {
    const box = harness({ ownershipUnobservable: ["account-a-worker"] });
    const result = await executeTransitionRecovery(EXISTING, box.adapters);
    expect(result.ok === false && result.state).toBe("INCOMPLETE");
    expect(box.cleared).toBe(false);
  });
});

// ===========================================================================
// The mode an account is in is PROVEN, never inferred from the target
// ===========================================================================

describe("proving the current mode", () => {
  it("agreeing readings prove that mode", () => {
    expect(proveCurrentMode({ disk: "SAFE", effective: "SAFE" })).toEqual({ ok: true, mode: "SAFE" });
    expect(proveCurrentMode({ disk: "LIVE_READY", effective: "LIVE_READY" })).toEqual({
      ok: true,
      mode: "LIVE_READY",
    });
  });

  it.each([
    ["the file is unreadable", null, "SAFE"],
    ["the control plane did not answer", "SAFE", null],
    ["neither could be read", null, null],
    ["the file is half-open", "INVALID", "SAFE"],
    ["the running gates are half-open", "SAFE", "INVALID"],
    ["the file says SAFE but the runtime loaded LIVE-READY", "SAFE", "LIVE_READY"],
    ["the file says LIVE-READY but the runtime loaded SAFE", "LIVE_READY", "SAFE"],
  ] as const)("%s refuses", (_label, disk, effective) => {
    const proven = proveCurrentMode({
      disk: disk as ObservedMode | null,
      effective: effective as ObservedMode | null,
    });
    expect(proven.ok).toBe(false);
    expect(proven.ok === false && proven.reasons.length).toBeGreaterThan(0);
  });

  it("a mismatch says which side said what, without guessing a winner", () => {
    const proven = proveCurrentMode({ disk: "SAFE", effective: "LIVE_READY" });
    const text = proven.ok === false ? proven.reasons.join(" ") : "";
    expect(text).toContain("SAFE");
    expect(text).toContain("LIVE_READY");
  });

  it("being already in the target is a no-op, not a transition", () => {
    expect(decideModeTransition("SAFE", "SAFE")).toEqual({ kind: "ALREADY", mode: "SAFE" });
    expect(decideModeTransition("LIVE_READY", "LIVE_READY")).toEqual({
      kind: "ALREADY",
      mode: "LIVE_READY",
    });
  });

  it("a real move carries the PROVEN mode as its origin", () => {
    expect(decideModeTransition("SAFE", "LIVE_READY")).toEqual({ kind: "PROCEED", fromMode: "SAFE" });
    expect(decideModeTransition("LIVE_READY", "SAFE")).toEqual({
      kind: "PROCEED",
      fromMode: "LIVE_READY",
    });
  });

  it("the proven mode is what reaches the marker, and therefore recovery", async () => {
    const box = harness();
    await executeAccountTransition(
      { account: "ACCOUNT_A", fromMode: "LIVE_READY", targetMode: "SAFE", startedAtMs: NOW },
      box.adapters
    );
    // The harness journals phases; the launcher composes the rest. What this
    // fixes is that the engine is TOLD the direction rather than deducing it.
    expect(box.journal).toEqual([...TRANSITION_PHASES]);
  });
});

describe("classifying the gates a control plane reports", () => {
  const gates = (globalKillSwitch: unknown, liveEntryEnabled: unknown, protectionReady: unknown) => ({
    environmentGates: { globalKillSwitch, liveEntryEnabled, protectionReady },
  });

  it("reads the two coherent triples", () => {
    expect(effectiveModeFromWire(gates(true, false, false))).toBe("SAFE");
    expect(effectiveModeFromWire(gates(false, true, true))).toBe("LIVE_READY");
  });

  it("a half-open triple is INVALID, never rounded to the nearest mode", () => {
    expect(effectiveModeFromWire(gates(false, false, false))).toBe("INVALID");
    expect(effectiveModeFromWire(gates(false, true, false))).toBe("INVALID");
    expect(effectiveModeFromWire(gates(true, true, true))).toBe("INVALID");
  });

  it.each([
    ["no body", null],
    ["no gates", {}],
    ["gates that are not an object", { environmentGates: "SAFE" }],
    ["a missing gate", { environmentGates: { globalKillSwitch: true, liveEntryEnabled: false } }],
    ["a gate that is not a boolean", gates(true, false, "false")],
  ])("%s is unreadable, which is not a mode", (_label, body) => {
    expect(effectiveModeFromWire(body)).toBeNull();
  });
});

// ===========================================================================
// One control plane's report, read fail-closed
// ===========================================================================

describe("warning codes from a status body", () => {
  it("a list of coded warnings reads as those codes", () => {
    expect(warningCodesFromWire([{ code: "A" }, { code: "B" }])).toEqual(["A", "B"]);
  });

  it("an empty list really is no warnings", () => {
    expect(warningCodesFromWire([])).toEqual([]);
  });

  it.each([
    ["a missing field", undefined],
    ["null", null],
    ["not an array", { code: "A" }],
    ["an entry that is not an object", ["MANUAL_INTERVENTION_REQUIRED"]],
    ["an entry with no code", [{ message: "something" }]],
    ["an entry whose code is not a string", [{ code: 7 }]],
    ["an entry whose code is blank", [{ code: "  " }]],
    ["one good entry and one bad", [{ code: "A" }, { code: null }]],
  ])("%s is UNREAD, never an empty list", (_label, raw) => {
    // `(warnings ?? []).map(...)` turned every one of these into "no warnings",
    // which reads as a clean account.
    expect(warningCodesFromWire(raw)).toBeNull();
  });

  it("an unread warning list blocks the transition", () => {
    const verdict = evaluateTransitionPreconditions({
      account: "ACCOUNT_A",
      targetMode: "LIVE_READY",
      selected: { ...SAFE_ACCOUNT, warnings: warningCodesFromWire(undefined) },
      exchange: FLAT,
      ownership: { ok: true, value: { controlOwned: true, workerOwned: true } },
      pending: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("warnings could not be read");
  });
});

describe("a whole status body, mapped fail-closed", () => {
  const FULL = {
    systemState: "SAFE_OFF",
    profile: { isEnabled: false, killSwitchActive: true },
    capacity: { totalActive: 0, pending: 0, open: 0 },
    manualIntervention: { count: 0 },
    warnings: [],
  };

  it("a complete body maps to a complete state", () => {
    expect(selectedAccountStateFromWire(FULL)).toEqual({
      systemState: "SAFE_OFF",
      profileEnabled: false,
      profileKillSwitchActive: true,
      totalActive: 0,
      pending: 0,
      open: 0,
      manualIntervention: 0,
      warnings: [],
    });
  });

  it.each([
    ["no body", null],
    ["a string", "SAFE_OFF"],
    ["an array", []],
  ])("%s reads as entirely unread", (_label, body) => {
    expect(selectedAccountStateFromWire(body)).toEqual(UNREAD_ACCOUNT_STATE);
  });

  it.each([
    ["systemState", "systemState"],
    ["profile", "profile"],
    ["capacity", "capacity"],
    ["manualIntervention", "manualIntervention"],
    ["warnings", "warnings"],
  ])("a body missing %s leaves those fields null, never zero or false", (_label, field) => {
    const partial: Record<string, unknown> = { ...FULL };
    delete partial[field];
    const state = selectedAccountStateFromWire(partial);
    const verdict = evaluateTransitionPreconditions({
      account: "ACCOUNT_A",
      targetMode: "LIVE_READY",
      selected: state,
      exchange: FLAT,
      ownership: { ok: true, value: { controlOwned: true, workerOwned: true } },
      pending: null,
    });
    expect(`${field}:${verdict.ok}`).toBe(`${field}:false`);
  });

  it("a kill switch reported as null is unread, not released", () => {
    const state = selectedAccountStateFromWire({
      ...FULL,
      profile: { isEnabled: false, killSwitchActive: null },
    });
    expect(state.profileKillSwitchActive).toBeNull();
  });

  it("a count that is not a number is unread, not zero", () => {
    const state = selectedAccountStateFromWire({ ...FULL, capacity: { totalActive: "0", pending: 0, open: 0 } });
    expect(state.totalActive).toBeNull();
    expect(state.pending).toBe(0);
  });
});

// ===========================================================================
// The second proof, taken after the human has confirmed
// ===========================================================================

describe("re-proving after the operator confirms", () => {
  const OWNED = { ok: true as const, value: { controlOwned: true, workerOwned: true } };
  const facts = (over: Partial<GatheredAccountFacts> = {}): GatheredAccountFacts => ({
    mode: { ok: true, mode: "SAFE" },
    selected: SAFE_ACCOUNT,
    exchange: FLAT,
    ownership: OWNED,
    marker: { status: "NONE" },
    ...over,
  });

  const proof = (second: GatheredAccountFacts, first: GatheredAccountFacts = facts()) =>
    evaluateSecondProof({ account: "ACCOUNT_A", targetMode: "LIVE_READY", first, second });

  it("an unchanged account passes", () => {
    expect(proof(facts())).toEqual({ ok: true });
  });

  it("a position opened during the confirmation refuses", () => {
    const second = facts({
      exchange: { ...FLAT, nonZeroPositions: { known: true, count: 1 } },
    });
    expect(proof(second).ok).toBe(false);
  });

  it("an algo order that triggered during the confirmation refuses", () => {
    const second = facts({ exchange: { ...FLAT, openAlgoOrders: { known: true, count: 2 } } });
    expect(proof(second).ok).toBe(false);
  });

  it("an exchange read that stopped working refuses", () => {
    expect(proof(facts({ exchange: null })).ok).toBe(false);
  });

  it("a profile enabled during the confirmation refuses", () => {
    expect(proof(facts({ selected: { ...SAFE_ACCOUNT, profileEnabled: true } })).ok).toBe(false);
  });

  it("a blocking warning that appeared refuses", () => {
    const second = facts({
      selected: { ...SAFE_ACCOUNT, warnings: ["MANUAL_INTERVENTION_REQUIRED"] },
    });
    expect(proof(second).ok).toBe(false);
  });

  it("ownership that became unknown refuses", () => {
    expect(proof(facts({ ownership: { ok: false, reason: "COMMAND_FAILED" } })).ok).toBe(false);
  });

  it("ownership that CHANGED refuses even though both readings are legible", () => {
    const second = facts({ ownership: { ok: true, value: { controlOwned: true, workerOwned: false } } });
    const verdict = proof(second);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("ownership");
  });

  it("another transition marker that appeared refuses", () => {
    const second = facts({ marker: { status: "PENDING", transition: EXISTING } });
    expect(proof(second).ok).toBe(false);
  });

  it("a marker that became UNREADABLE refuses", () => {
    const second = facts({ marker: { status: "UNREADABLE", reason: "the file is gone" } });
    const verdict = proof(second);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("unreadable");
  });

  it("a runtime whose mode moved underneath the plan refuses", () => {
    const second = facts({ mode: { ok: true, mode: "LIVE_READY" } });
    const verdict = proof(second);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("Something else changed it");
  });

  it("a runtime whose mode can no longer be proven refuses", () => {
    const second = facts({ mode: { ok: false, reasons: ["the file could not be read"] } });
    expect(proof(second).ok).toBe(false);
  });
});


// ===========================================================================
// A long-running supervisor re-reads the marker UNDER the lock
//
// The check when an operator starts a supervisor is hours old by the time it
// matters. In between, another launcher can begin a transition on the very
// account being watched and crash half-way -- and the OS releases the mutation
// mutex on its death, so nothing else stands in the way of this supervisor
// restarting a role that belongs to an unfinished transition.
// ===========================================================================

describe("whether a supervision tick may restart", () => {
  const A = rolesForAccount("ACCOUNT_A");
  const B = rolesForAccount("ACCOUNT_B");
  const pendingFor = (account: "ACCOUNT_A" | "ACCOUNT_B"): TransitionMarkerRead =>
    parseTransitionMarker({ ...MARKER, account });

  it("no marker: the restart may proceed", () => {
    expect(judgeSupervisedRestart({ status: "NONE" }, [A.control, A.worker])).toEqual({ act: "RESTART" });
  });

  it("a PENDING marker for THIS account refuses, and spends no attempt", () => {
    const gate = judgeSupervisedRestart(pendingFor("ACCOUNT_A"), [A.control, A.worker]);

    expect(gate.act).toBe("REFUSE");
    // Charging the budget for a refusal would walk a healthy account towards
    // WORKER_RECOVERY_FAILED while a transition was simply in flight.
    expect(gate.act === "REFUSE" && gate.spendAttempt).toBe(false);
    expect(gate.act === "REFUSE" && gate.reasons.join(" ")).toContain("no restart attempt was spent");
  });

  it("a PENDING marker for the OTHER account leaves this one supervising", () => {
    expect(judgeSupervisedRestart(pendingFor("ACCOUNT_B"), [A.control, A.worker])).toEqual({
      act: "RESTART",
    });
    expect(judgeSupervisedRestart(pendingFor("ACCOUNT_A"), [B.control, B.worker])).toEqual({
      act: "RESTART",
    });
  });

  it("an UNREADABLE marker blocks BOTH account supervisors", () => {
    const unreadable = parseTransitionMarker({ nonsense: true });
    for (const roles of [[A.control, A.worker], [B.control, B.worker]]) {
      expect(judgeSupervisedRestart(unreadable, roles).act).toBe("REFUSE");
    }
  });

  it("the generic supervisor keeps running while an ACCOUNT is mid-transition", () => {
    // The generic role belongs to neither account, and stopping its
    // supervision because Account A is moving would take vision analysis down
    // for a reason that has nothing to do with it.
    for (const account of ["ACCOUNT_A", "ACCOUNT_B"] as const) {
      expect(judgeSupervisedRestart(pendingFor(account), ["generic-analysis"])).toEqual({
        act: "RESTART",
      });
    }
  });

  it("but an UNREADABLE marker blocks the generic supervisor too", () => {
    // It is the one marker that cannot say which account it was about.
    const gate = judgeSupervisedRestart(parseTransitionMarker("not a marker"), ["generic-analysis"]);
    expect(gate.act).toBe("REFUSE");
    expect(gate.act === "REFUSE" && gate.spendAttempt).toBe(false);
  });

  it("a marker that appears AFTER the tick began still blocks it", () => {
    // The supervisor observed health, found a restart necessary, and only then
    // took the mutex. This is the reading taken at that point.
    let marker: TransitionMarkerRead = { status: "NONE" };
    expect(judgeSupervisedRestart(marker, [A.worker]).act).toBe("RESTART");

    marker = pendingFor("ACCOUNT_A");
    expect(judgeSupervisedRestart(marker, [A.worker]).act).toBe("REFUSE");
  });

  it("a marker that appears after MANY ticks still blocks, because it is read every time", () => {
    const readings: TransitionMarkerRead[] = [
      { status: "NONE" },
      { status: "NONE" },
      { status: "NONE" },
      pendingFor("ACCOUNT_A"),
    ];
    const acts = readings.map((read) => judgeSupervisedRestart(read, [A.control, A.worker]).act);
    expect(acts).toEqual(["RESTART", "RESTART", "RESTART", "REFUSE"]);
  });

  it("every phase of a PENDING transition blocks its own account", () => {
    for (const phase of TRANSITION_PHASES) {
      const read = parseTransitionMarker({ ...MARKER, phase });
      expect(`${phase}:${judgeSupervisedRestart(read, [A.worker]).act}`).toBe(`${phase}:REFUSE`);
    }
  });
});

// ---------------------------------------------------------------------------
// The SAFE-transition attestation defect, end to end
// ---------------------------------------------------------------------------

describe("a return to SAFE verifies the DEPLOYMENT, end to end", () => {
  const IDENTITY = { accountIdentifier: "acct-a-e2e", environment: "MAINNET" };
  const AT = new Date(NOW);

  function attestationStore(roles: Array<"BACKEND" | "WORKER">, gates: RuntimeGateSnapshot): RuntimeAttestationRedis {
    const store = new Map<string, string>();
    roles.forEach((role, index) => {
      const instanceId = `${role.toLowerCase()}-${index}`;
      store.set(
        runtimeAttestationKey(IDENTITY, role, instanceId),
        JSON.stringify({
          schemaVersion: RUNTIME_ATTESTATION_SCHEMA_VERSION, role, instanceId, startedAt: AT.toISOString(), lastSeenAt: AT.toISOString(),
          accountIdentifier: IDENTITY.accountIdentifier, environment: IDENTITY.environment, gates,
        })
      );
    });
    return {
      set: async () => "OK",
      del: async () => 1,
      get: async (key) => store.get(key) ?? null,
      scan: async (_c, _m, pattern) => ["0", [...store.keys()].filter((k) => k.startsWith(pattern.replace(/\*$/, "")))],
    };
  }

  /** The control plane's status body once it runs `mode`: SAFE_OFF, and the ARMING verdict BLOCKED for SAFE. */
  const statusFor = (mode: RuntimeMode) => {
    const g = expectedGateSnapshotFor(mode);
    return {
      systemState: "SAFE_OFF",
      environmentGates: { globalKillSwitch: g.globalKillSwitch, liveEntryEnabled: g.liveEntryEnabled, protectionReady: g.protectionReady },
      runtimeAttestation: { status: mode === "SAFE" ? "BLOCKED" : "PASS" },
    };
  };

  /** The production verifier's decision, over a real deployment read of `redis`. */
  const deploymentVerify = (redis: RuntimeAttestationRedis): TransitionAdapters["verify"] => async (role, mode) => {
    const deployment = await readRuntimeDeploymentAttestationStatus({ redis, identity: IDENTITY, expected: expectedGateSnapshotFor(mode), now: AT });
    const verdict = judgeRoleMode("ACCOUNT_A", role, mode, { controlStatus: statusFor(mode), deployment });
    return verdict.ok ? { ok: true } : { ok: false, reasons: [verdict.reason] };
  };

  /** What the launcher USED to do: require the arming verdict to be PASS on the worker leg. */
  const armingVerify: TransitionAdapters["verify"] = async (role, mode) =>
    role === "account-a-worker" && statusFor(mode).runtimeAttestation.status !== "PASS"
      ? { ok: false, reasons: [`the execution worker has not attested to the ${mode} gates`] }
      : { ok: true };

  const toSafe = (box: ReturnType<typeof harness>, verify: TransitionAdapters["verify"]) =>
    executeAccountTransition({ account: "ACCOUNT_A", fromMode: "LIVE_READY", targetMode: "SAFE", startedAtMs: NOW }, { ...box.adapters, verify });

  it("LIVE_READY -> SAFE with a healthy SAFE pair now completes and clears the marker", async () => {
    const box = harness();
    const result = await toSafe(box, deploymentVerify(attestationStore(["BACKEND", "WORKER"], expectedGateSnapshotFor("SAFE"))));
    expect(result).toEqual({ ok: true, mode: "SAFE" });
    expect(box.cleared).toBe(true);
  });

  it("the OLD arming-verdict verifier reproduces the historical defect on the very same healthy pair (WORKER_STARTED, then refused)", async () => {
    const box = harness();
    const result = await toSafe(box, armingVerify);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.reasons.join(" ")).toMatch(/has not attested to the SAFE gates/);
    expect(box.cleared).toBe(false);
  });

  it("a SAFE transition whose worker never attests still fails closed and keeps its marker", async () => {
    const box = harness();
    const result = await toSafe(box, deploymentVerify(attestationStore(["BACKEND"], expectedGateSnapshotFor("SAFE"))));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.state).toBe("INCOMPLETE");
    expect(result.ok ? [] : result.reasons.join(" ")).toMatch(/has not attested to the SAFE deployment/);
    expect(box.cleared).toBe(false);
  });

  it("a SAFE transition whose processes still run LIVE_READY gates fails closed", async () => {
    const box = harness();
    const result = await toSafe(box, deploymentVerify(attestationStore(["BACKEND", "WORKER"], expectedGateSnapshotFor("LIVE_READY"))));
    expect(result.ok).toBe(false);
    expect(box.cleared).toBe(false);
  });
});


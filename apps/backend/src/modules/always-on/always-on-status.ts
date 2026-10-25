import {
  ALWAYS_ON_NOTICE,
  ALWAYS_ON_ROLE_LABELS,
  ALWAYS_ON_ROLES,
  ALWAYS_ON_STATUS_SCHEMA,
  type AlwaysOnRole,
  type AlwaysOnRoleState,
  type AlwaysOnSupervisorState,
  type PublicStreamProbeOutcome,
} from "./always-on-contract";
import type { EmitterHealth, PlannerBaseline, PlannerHealth, ScannerHealth } from "./always-on-health";
import type { IncidentRecord } from "./always-on-journal";

/**
 * THE ALWAYS-ON STATUS ARTIFACT — teddy.native-monitoring.always-on-status.v1.
 *
 * One file, rewritten atomically every supervisor tick: a concise
 * machine-readable state and reason code, an operator-readable reason, and the
 * evidence behind it per role. It names pids, run ids, counts and instants —
 * never an environment value, a credential or a connection string.
 */

export interface AlwaysOnOwnedChildView {
  readonly rootPid: number;
  readonly runtimePids: readonly number[];
  readonly startedAt: string;
  readonly spawnedByGeneration: number;
  readonly commandIdentity: string;
}

export interface AlwaysOnRoleView {
  readonly role: AlwaysOnRole;
  readonly label: string;
  readonly state: AlwaysOnRoleState;
  readonly reasonCode: string;
  readonly reason: string;
  readonly owned: AlwaysOnOwnedChildView | null;
  /** Restarts this supervisor generation performed for the role. */
  readonly restarts: number;
  /** Recovery attempts since the last forgiveness, and when the next one is allowed. */
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly latched: boolean;
  readonly lastExit: { readonly at: string; readonly code: number | null } | null;
  /** Runtimes doing this role's job that the supervisor does NOT own (reported, never killed). */
  readonly externalPids: readonly number[];
}

export interface AlwaysOnStatusDto {
  readonly schema: typeof ALWAYS_ON_STATUS_SCHEMA;
  readonly notice: readonly string[];
  readonly authority: "NONE";
  readonly nativeExecutionEnabled: false;
  readonly accountExecution: "NONE";
  readonly state: AlwaysOnSupervisorState;
  readonly reasonCode: string;
  readonly reason: string;
  readonly generation: number;
  readonly supervisor: { readonly pid: number; readonly startedAt: string; readonly instancePort: number; readonly profile: string; readonly roles: readonly AlwaysOnRole[] };
  readonly startedAt: string;
  readonly writtenAt: string;
  readonly lastEndToEndHealthyAt: string | null;
  readonly lastRecovery: { readonly at: string; readonly role: AlwaysOnRole; readonly reasonCode: string; readonly reason: string; readonly outcome: string } | null;
  readonly backoff: { readonly role: AlwaysOnRole; readonly attempt: number; readonly until: string } | null;
  readonly dataStore: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
  readonly network: {
    readonly reachable: boolean | null;
    readonly lastProbeAt: string | null;
    readonly unavailableSince: string | null;
    /** The public stream path: probed only when the scanner's own status points at its streams. */
    readonly stream: { readonly unreachableSince: string | null; readonly lastProbeAt: string | null; readonly lastProbeOutcome: PublicStreamProbeOutcome | null };
  };
  readonly roles: {
    readonly backend: AlwaysOnRoleView & { readonly healthOk: boolean | null };
    readonly scanner: AlwaysOnRoleView & { readonly runId: string | null; readonly engineFingerprint: string | null; readonly runBindable: boolean; readonly health: ScannerHealth | null };
    readonly emitter: AlwaysOnRoleView & { readonly pinnedRunId: string | null; readonly health: EmitterHealth | null };
    readonly planner: AlwaysOnRoleView & { readonly baseline: PlannerBaseline | null; readonly health: PlannerHealth | null };
  };
  readonly external: { readonly soakMonitorPids: readonly number[]; readonly otherSupervisorPids: readonly number[] };
  readonly counters: { readonly ticks: number; readonly scannerRecoveries: number; readonly restarts: Readonly<Record<AlwaysOnRole, number>> };
  readonly recentIncidents: readonly IncidentRecord[];
}

const age = (iso: string | null, nowMs: number) => (iso === null ? "-" : `${Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000))}s ago`);

/** Operator-facing lines for `monitoring:always-on status` and the runtime launcher. */
export function renderAlwaysOnStatus(status: AlwaysOnStatusDto, nowMs: number): string[] {
  const lines: string[] = [];
  lines.push(`ALWAYS-ON MONITORING — ${ALWAYS_ON_NOTICE.join(" · ")}`);
  lines.push(`  state        ${status.state} (${status.reasonCode}) — ${status.reason}`);
  lines.push(`  generation   ${status.generation}, supervisor pid ${status.supervisor.pid}, profile ${status.supervisor.profile}, written ${age(status.writtenAt, nowMs)}`);
  lines.push(`  end-to-end   last healthy ${status.lastEndToEndHealthyAt ?? "never"}`);
  if (status.backoff !== null) lines.push(`  backoff      ${status.backoff.role} attempt ${status.backoff.attempt} not before ${status.backoff.until}`);
  if (status.lastRecovery !== null) lines.push(`  last recovery ${status.lastRecovery.at} ${status.lastRecovery.role} ${status.lastRecovery.reasonCode}: ${status.lastRecovery.outcome}`);
  lines.push(
    `  data store   ${status.dataStore}; public network ${status.network.reachable === null ? "not probed" : status.network.reachable ? "reachable" : `UNREACHABLE since ${status.network.unavailableSince ?? "?"}`}` +
      (status.network.stream.unreachableSince !== null ? `; public streams UNREACHABLE since ${status.network.stream.unreachableSince}` : "")
  );
  for (const role of ALWAYS_ON_ROLES) {
    const view = status.roles[role];
    const owned = view.owned === null ? "not owned" : `root pid ${view.owned.rootPid}${view.owned.runtimePids.length > 0 ? ` (runtime ${view.owned.runtimePids.join(",")})` : ""}`;
    lines.push(`  ${ALWAYS_ON_ROLE_LABELS[role]}`);
    lines.push(`    ${view.state} (${view.reasonCode}) — ${view.reason}`);
    lines.push(`    ${owned}; restarts ${view.restarts}; attempts ${view.attempts}${view.latched ? "; LATCHED" : ""}${view.externalPids.length > 0 ? `; EXTERNAL pids ${view.externalPids.join(",")}` : ""}`);
  }
  const s = status.roles.scanner.health;
  if (s !== null && s.ours) {
    const u = s.universe;
    lines.push(
      `  scanner run  ${status.roles.scanner.runId ?? "-"}: selected ${u.selected ?? "?"} | live ${u.liveEligible ?? "?"} | quarantined ${u.quarantined ?? "?"} | failed ${u.failed ?? "?"} | recovering ${u.recovering ?? "?"} | awaiting ${u.awaitingStream ?? "?"} | stale ${u.stale ?? "?"} | capacityExceeded ${u.capacityExceeded ?? "?"}`
    );
    lines.push(`               market data ${s.lastMarketDataAt ?? "-"} | reconnects ${s.reconnects ?? "?"} | backpressure ${s.backpressureEvents ?? "?"} | status ${age(s.writtenAt, nowMs)}`);
  }
  const e = status.roles.emitter.health;
  if (e !== null && e.ours) {
    lines.push(
      `  emitter      pinned ${status.roles.emitter.pinnedRunId ?? "-"}: lanes ${e.lanesHealthy ?? "?"}/${e.lanesTracked ?? "?"} healthy (${e.lanesFailed ?? "?"} failed; ${e.laneNote}) | queue ${e.queueDepth ?? "?"}/${e.queueCapacity ?? "?"} (max ${e.maxQueueDepth ?? "?"}) | behind ${e.backlogLanes ?? "?"} | created ${e.created ?? "?"} | duplicates ${e.ledgerDuplicates ?? "?"}`
    );
  }
  const p = status.roles.planner.health;
  if (p !== null) {
    lines.push(
      `  planner      ${p.readiness ?? "?"} | worker ${p.workerState ?? "?"} | pending ${p.pending ?? "?"} | failed jobs ${p.jobsFailed ?? "?"} (Δ ${p.delta.jobsFailed ?? "?"}) | ERROR plans ${p.plansError ?? "?"} (Δ ${p.delta.plansError ?? "?"})`
    );
  }
  if (status.external.soakMonitorPids.length > 0) lines.push(`  external     soak monitor pid(s) ${status.external.soakMonitorPids.join(",")} (not owned; never stopped by Always-On)`);
  if (status.external.otherSupervisorPids.length > 0) lines.push(`  external     other Always-On supervisor pid(s) ${status.external.otherSupervisorPids.join(",")}`);
  return lines;
}

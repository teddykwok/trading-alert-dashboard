import path from "node:path";

import type { BuildVerdict } from "../operator/generic-backend-nonwatch-launcher";
import type { MutationAction, WithAuthorityResult } from "../operator/mutation-lock";
import { verifyOwnership, type Observation, type ObservedProcessNode } from "../operator/runtime-launcher";
import { executeFencedStart, executeFencedStop, type ProbeOutcome } from "../operator/worker-supervision";
import {
  ALWAYS_ON_NOTICE,
  ALWAYS_ON_OWNERSHIP_SCHEMA,
  ALWAYS_ON_REQUEST_SCHEMA,
  ALWAYS_ON_ROLE_LABELS,
  ALWAYS_ON_ROLES,
  ALWAYS_ON_STATUS_SCHEMA,
  backoffDelayMs,
  type AlwaysOnPolicy,
  type AlwaysOnRole,
  type AlwaysOnRoleState,
  type AlwaysOnSupervisorState,
  type PublicStreamProbeOutcome,
} from "./always-on-contract";
import {
  judgeEmitterHealth,
  judgePlannerHealth,
  judgeScannerHealth,
  nextPlannerBaseline,
  type EmitterHealth,
  type PlannerBaseline,
  type PlannerHealth,
  type ScannerHealth,
} from "./always-on-health";
import { IncidentJournal, type IncidentEvent } from "./always-on-journal";
import { decideAdoption, generationIsCurrent, nextGeneration, parseOwnership, serializeOwnership, type ChildRecord, type OwnershipFile } from "./always-on-ownership";
import { childStopFile, emitterCommitStatus, scannerRunManifest, type AlwaysOnPaths } from "./always-on-paths";
import {
  MonitoringPlanError,
  backendSpawnPlan,
  emitterSpawnPlan,
  monitoringCensus,
  plannerSpawnPlan,
  scannerSpawnPlan,
  type MonitoringCensus,
  type MonitoringSpawnPlan,
} from "./always-on-roles";
import type { AlwaysOnRoleView, AlwaysOnStatusDto } from "./always-on-status";

/**
 * THE ALWAYS-ON MONITORING SUPERVISOR.
 *
 * MONITORING ONLY · NO ACCOUNT EXECUTION · NATIVE EXECUTION HARD-DISABLED.
 *
 * It owns the monitoring data plane — generic backend (non-watch), Native
 * live-shadow scanner, Native multi-symbol emitter (COMMIT + follow) and Native
 * planner — and keeps it running across crashes, network loss and large
 * catch-up backlogs, without an operator watching.
 *
 * ## What it understands
 *
 *  - DEPENDENCIES, not "restart everything". Market connectivity loss degrades
 *    the scanner only; the backend and planner keep running. The emitter is
 *    PINNED to one scanner run: when that run is replaced the old emitter is
 *    stopped, and only once the fresh run reports healthy is an emitter started
 *    on it. The planner needs a healthy backend before it is (re)started.
 *  - HEALTH, not liveness (always-on-health.ts). A scanner whose process is
 *    alive but whose universe is failed, recovering, stale or silent is
 *    DEGRADED — and given a grace period before anything is done.
 *  - NETWORK OUTAGES. Past the grace period it asks a public, unsigned Binance
 *    endpoint whether the network is there at all. While it is not, nothing is
 *    restarted and no attempt is spent; when it returns, the scanner gets time
 *    to heal itself before a fresh run is started.
 *  - BOUNDED RECOVERY. Restarts back off (30 s, 1 min, 2 min, 5 min, 10 min,
 *    15 min) and a role that fails its attempts LATCHES: no further automatic
 *    restart until an operator clears it. Sustained health forgives attempts.
 *
 * ## Scanner recovery (one fenced path)
 *
 *   stop the owned emitter (cooperative stop file; it persists its cursors)
 *   → stop the owned scanner (cooperative; its status and checkpoints persist)
 *   → start a fresh scanner run (its default FAST_RECOVERY_V1 path)
 *   → wait until OUR new run reports healthy (status pid in our tree, manifest
 *     present, engine fingerprint = the profile's)
 *   → start an emitter pinned to that run id and fingerprint.
 *
 * No cursor is rebaselined, no namespace or cursor is deleted, no strategy,
 * threshold, planning or execution path is touched.
 *
 * ## Ownership and fencing
 *
 * One supervisor (an exclusive loopback listener, taken by the CLI). A
 * GENERATION number in ownership.json, re-checked under the launcher's
 * mutation lock before every start, stop or record change: a stale supervisor
 * can never control a newer generation's children. Children are recorded by
 * owned root (pid + OS creation time + this repository) and terminated only
 * through the reviewed fenced stop, which re-proves all three first. Processes
 * it does not own — manual scanners, emitters, planners, backends, old soak
 * monitors — are reported as CONFLICT / EXTERNAL and never killed.
 *
 * Every machine call is injected, so the behaviour is tested with fake clocks,
 * process tables and file systems.
 */

export interface AlwaysOnConfig {
  readonly repoRoot: string;
  readonly profileName: string;
  /** The profile's engine fingerprint, from code: the only fingerprint an emitter is ever pinned to. */
  readonly engineFingerprint: string;
  readonly roles: readonly AlwaysOnRole[];
  /** The local generic backend (loopback), read for /health, planner status and soak health. */
  readonly backendUrl: string;
  readonly emitterQueueCapacity: number;
  readonly emitterActivateAtEof: boolean;
  readonly scannerExtraArgs: readonly string[];
  readonly policy: AlwaysOnPolicy;
  readonly commandIdentity: string;
  readonly instancePort: number;
}

export interface AlwaysOnFileSystem {
  /** Evidence (status files, manifests): null when absent OR unreadable. */
  readText(file: string): string | null;
  /** The ownership record: null ONLY when the file does not exist; any other failure throws (unknown is never absent). */
  readTextStrict(file: string): string | null;
  writeTextAtomic(file: string, text: string): void;
  appendLine(file: string, line: string): void;
  exists(file: string): boolean;
  remove(file: string): void;
  ensureDir(dir: string): void;
  listDir(dir: string): string[];
}

export interface AlwaysOnHttp {
  getJson(url: string, timeoutMs: number): Promise<{ readonly ok: boolean; readonly status: number | null; readonly body: unknown }>;
}

export interface AlwaysOnAdapters {
  readonly now: () => number;
  /** This supervisor's own pid and OS creation time. */
  readonly selfPid: number;
  readonly selfStartedAtMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly paths: AlwaysOnPaths;
  readonly observeTree: () => Observation<ObservedProcessNode[]>;
  readonly probe: (pid: number) => ProbeOutcome;
  /** Opens the role's durable log and spawns the plan detached. Returns the root pid. */
  readonly spawn: (plan: MonitoringSpawnPlan) => number | null;
  /** taskkill /T /F on ONE root — reached only through the fenced stop, after ownership is re-proven. */
  readonly terminate: (pid: number) => boolean;
  /** The exit code of a child this process spawned, when known (diagnostic only). */
  readonly exitCodeOf?: (pid: number) => number | null;
  readonly fs: AlwaysOnFileSystem;
  readonly http: AlwaysOnHttp;
  /** One unsigned public Binance request (server time); true when it answered. Never a credential. */
  readonly publicConnectivity: () => Promise<boolean>;
  /**
   * One unsigned public stream subscription: REACHABLE, UNREACHABLE (positive evidence of failure) or UNKNOWN.
   * Never a credential. Asked only when the scanner's own status points at its streams (streamOutageConfirmed).
   */
  readonly publicStreamConnectivity: () => Promise<PublicStreamProbeOutcome>;
  readonly buildVerdict: () => BuildVerdict;
  /** The KEY NAMES the generic env file declares (never a value), or why it could not be read. */
  readonly genericEnvKeyNames: () => { readonly ok: true; readonly keys: string[] } | { readonly ok: false; readonly reason: string };
  readonly mutation: <T>(action: MutationAction, run: () => Promise<T>) => Promise<WithAuthorityResult<T>>;
  readonly log: (line: string) => void;
}

type StopPurpose = "RESTART" | "SUPERSEDED" | "RECOVERY" | "SHUTDOWN";

/** The generation fence as read from disk. UNKNOWN (the file could not be read) pauses mutations; it never fences. */
type FenceState = "CURRENT" | "SUPERSEDED" | "UNKNOWN";

/**
 * The public stream path. A probe answer is kept for one probe cadence, and only for the run whose evidence asked for
 * it (null: no running scanner), so a stale or another run's answer never decides anything.
 */
interface StreamPathState {
  unavailableSinceMs: number | null;
  lastProbe: { readonly atMs: number; readonly runId: string | null; readonly outcome: PublicStreamProbeOutcome } | null;
  probing: boolean;
}
const freshStreamPath = (): StreamPathState => ({ unavailableSinceMs: null, lastProbe: null, probing: false });

/** The only scanner issues a public stream outage explains. Any other issue keeps the normal recovery path. */
const STREAM_EXPLAINED_ISSUES: ReadonlySet<string> = new Set(["AWAITING_STREAM", "MARKET_DATA_STALE", "SYMBOLS_RECOVERING"]);

/** An error's code for the journal (an fs code such as EPERM, or the error's name) — never its message. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
  return error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : "UNKNOWN_ERROR";
}

interface StopRequest {
  readonly purpose: StopPurpose;
  readonly cooperative: boolean;
  readonly requestedAtMs: number;
  deadlineMs: number;
  readonly reasonCode: string;
  forcedAttempted: boolean;
}

interface RoleRuntime {
  state: AlwaysOnRoleState;
  reasonCode: string;
  reason: string;
  attempts: number;
  nextAttemptAtMs: number;
  latched: boolean;
  /** The first start of a role in a generation is free; every later start is a recovery attempt. */
  everStarted: boolean;
  /**
   * The last child was stopped by the supervisor for ANOTHER role's sake (a
   * scanner recovery) or because its pinned run was superseded: it did not
   * fail, so its next start spends no attempt and waits for no backoff.
   */
  freeRestart: boolean;
  unhealthySinceMs: number | null;
  healthySinceMs: number | null;
  warmingSinceMs: number | null;
  /**
   * The last tick the current child's status was judged its OWN (null: none yet since it started or was adopted).
   * Once it has reported, a status that is missing or unreadable is degraded evidence — never a failed start-up.
   */
  lastOwnStatusAtMs: number | null;
  restarts: number;
  lastExit: { atMs: number; code: number | null } | null;
  startedAtMs: number | null;
  stopping: StopRequest | null;
  externalPids: number[];
  journaled: string;
}

interface ScannerRecovery {
  readonly reasonCode: string;
  readonly reason: string;
  readonly requestedAtMs: number;
  phase: "STOPPING_EMITTER" | "STOPPING_SCANNER" | "STARTING_SCANNER" | "AWAITING_RUN";
  readonly previousRunId: string | null;
  awaitingSinceMs: number | null;
  degradedSinceMs: number | null;
}

export type AlwaysOnStartOutcome = { readonly ok: true; readonly generation: number } | { readonly ok: false; readonly reason: string };
export type AlwaysOnTickOutcome = "CONTINUE" | "STOPPED" | "FENCED";

const STOP_ORDER: readonly AlwaysOnRole[] = ["emitter", "scanner", "planner", "backend"];
const fresh = (): RoleRuntime => ({
  state: "OFF",
  reasonCode: "NOT_STARTED",
  reason: "not started yet",
  attempts: 0,
  nextAttemptAtMs: 0,
  latched: false,
  everStarted: false,
  freeRestart: false,
  unhealthySinceMs: null,
  healthySinceMs: null,
  warmingSinceMs: null,
  lastOwnStatusAtMs: null,
  restarts: 0,
  lastExit: null,
  startedAtMs: null,
  stopping: null,
  externalPids: [],
  journaled: "",
});

export class AlwaysOnSupervisor {
  private generation = 0;
  private readonly startedAtMs: number;
  private state: AlwaysOnSupervisorState = "STARTING";
  private reasonCode = "STARTING";
  private reason = "taking ownership of the monitoring stack";
  private readonly rt: Record<AlwaysOnRole, RoleRuntime> = { backend: fresh(), scanner: fresh(), emitter: fresh(), planner: fresh() };
  private readonly children: Record<AlwaysOnRole, ChildRecord | null> = { backend: null, scanner: null, emitter: null, planner: null };
  private spawnSequence = 0;
  private scannerRun: { runId: string; engineFingerprint: string | null; bindable: boolean } | null = null;
  private recovery: ScannerRecovery | null = null;
  private shutdown: { reasonCode: string; requestedAtMs: number; done: boolean } | null = null;
  private detached = false;
  private fenced = false;
  private plannerBaseline: PlannerBaseline | null = null;
  private plannerDeltaJournaled = { jobsFailed: 0, plansError: 0 };
  private pendingSinceMs: number | null = null;
  private network: { reachable: boolean | null; lastProbeAtMs: number | null; unavailableSinceMs: number | null; restoredAtMs: number | null } = {
    reachable: null,
    lastProbeAtMs: null,
    unavailableSinceMs: null,
    restoredAtMs: null,
  };
  private stream: StreamPathState = freshStreamPath();
  private dataStore: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN" = "UNKNOWN";
  private lastTickAtMs: number | null = null;
  /** When supervision last resumed after a clock gap (sleep / hibernate): no status older than this proves a hang. */
  private resumedAtMs: number | null = null;
  private lastEndToEndHealthyAtMs: number | null = null;
  private lastRecovery: AlwaysOnStatusDto["lastRecovery"] = null;
  private readonly counters = { ticks: 0, scannerRecoveries: 0, restarts: { backend: 0, scanner: 0, emitter: 0, planner: 0 } as Record<AlwaysOnRole, number> };
  private largeBacklog = false;
  private observationFailing = false;
  /** ownership.json does not match memory yet (a write failed): retried every tick; no role starts meanwhile. */
  private ownershipDirty = false;
  private ownershipWriteFailing = false;
  private ownershipReadFailing = false;
  private tickFailing = false;
  private readonly reportedExternal = new Set<string>();
  private latest: {
    census: MonitoringCensus | null;
    backendOk: boolean | null;
    scanner: ScannerHealth | null;
    emitter: EmitterHealth | null;
    planner: PlannerHealth | null;
  } = { census: null, backendOk: null, scanner: null, emitter: null, planner: null };
  private readonly journal: IncidentJournal;

  constructor(
    private readonly config: AlwaysOnConfig,
    private readonly a: AlwaysOnAdapters
  ) {
    this.startedAtMs = a.now();
    this.journal = new IncidentJournal({ file: a.paths.incidents, append: (file, line) => a.fs.appendLine(file, line), now: a.now, generation: () => this.generation, log: a.log });
    for (const role of ALWAYS_ON_ROLES) {
      if (!config.roles.includes(role)) this.setRole(role, "DISABLED", "EXCLUDED_BY_CONFIGURATION", "excluded from this supervisor by --roles", false);
    }
  }

  get currentGeneration(): number {
    return this.generation;
  }

  // ---------------------------------------------------------------------------
  // Start: take the next generation, adopt what is provably ours
  // ---------------------------------------------------------------------------

  async start(input: { readonly strippedCredentialNames: readonly string[] } = { strippedCredentialNames: [] }): Promise<AlwaysOnStartOutcome> {
    const now = this.a.now();
    this.a.fs.ensureDir(this.a.paths.dir);
    this.a.fs.ensureDir(this.a.paths.requestsDir);
    this.a.fs.ensureDir(this.a.paths.stopDir);
    let previousText: string | null;
    try {
      previousText = this.a.fs.readTextStrict(this.a.paths.ownership);
    } catch (error) {
      // A file that exists but cannot be read is not "nothing owned": taking generation 1 would orphan its children.
      return { ok: false, reason: `the ownership file could not be read (${errorCode(error)}); refusing to take ownership blind — nothing was adopted, started or stopped` };
    }
    const previous = parseOwnership(previousText);
    if (previous.kind === "UNREADABLE") {
      return { ok: false, reason: `the ownership file is unreadable (${previous.reason}); refusing to take ownership blind — inspect ${this.a.paths.ownership}` };
    }
    const previousChildren = previous.kind === "VALID" ? previous.file.children : [];
    const decisions = decideAdoption(previousChildren, this.a.probe, this.config.repoRoot, previous.kind === "VALID" ? previous.file.repoRoot : this.config.repoRoot);
    if (decisions === null) return { ok: false, reason: "the previous generation's children could not be observed; nothing was adopted, started or stopped" };

    this.generation = nextGeneration(previous);
    const adopted: ChildRecord[] = [];
    const dropped: { child: ChildRecord; reason: string }[] = [];
    for (const decision of decisions) {
      if (decision.decision === "DROP") dropped.push({ child: decision.child, reason: decision.reason });
      else if (this.children[decision.child.role] !== null) dropped.push({ child: decision.child, reason: "DUPLICATE_ROLE_RECORD" });
      else {
        this.children[decision.child.role] = decision.child;
        adopted.push(decision.child);
      }
    }
    if (!this.writeOwnership()) {
      return { ok: false, reason: `the ownership file could not be written (${this.a.paths.ownership}); nothing was adopted, started or stopped` };
    }
    this.record({
      kind: "SUPERVISOR_STARTED",
      reasonCode: previous.kind === "VALID" ? "NEXT_GENERATION" : "FIRST_GENERATION",
      detail: `${ALWAYS_ON_NOTICE.join(" · ")}; generation ${this.generation}; roles ${this.config.roles.join(",")}; profile ${this.config.profileName}`,
      facts: { generation: this.generation, previousGeneration: previous.kind === "VALID" ? previous.file.generation : null, adopted: adopted.length, dropped: dropped.length },
    });
    if (input.strippedCredentialNames.length > 0) {
      this.record({ kind: "CREDENTIALS_STRIPPED", reasonCode: "SUPERVISOR_ENVIRONMENT", detail: `removed from the supervisor's own environment (names only): ${input.strippedCredentialNames.join(", ")}` });
    }
    for (const child of adopted) {
      const rt = this.rt[child.role];
      rt.everStarted = true;
      rt.startedAtMs = now;
      this.record({ kind: "CHILD_ADOPTED", role: child.role, detail: `root pid ${child.pid} (spawned by generation ${child.spawnedByGeneration})`, facts: { pid: child.pid, pinnedRunId: child.pinnedRunId } });
    }
    for (const { child, reason } of dropped) {
      this.record({ kind: "CHILD_RECORD_DROPPED", role: child.role, reasonCode: reason, detail: `root pid ${child.pid} is not provably ours any more; it was NOT terminated`, facts: { pid: child.pid } });
    }
    // Stop files nobody adopted can never be honoured by anyone: tidy them (a child only ever watches its own path).
    const keep = new Set(adopted.map((c) => c.stopFile).filter((f): f is string => f !== null).map((f) => path.basename(f)));
    for (const name of this.a.fs.listDir(this.a.paths.stopDir)) {
      if (name.endsWith(".stop") && !keep.has(name)) this.removeQuietly(path.join(this.a.paths.stopDir, name));
    }
    this.lastTickAtMs = now;
    this.writeStatus();
    return { ok: true, generation: this.generation };
  }

  // ---------------------------------------------------------------------------
  // One pass: observe, judge, act
  // ---------------------------------------------------------------------------

  /**
   * One supervision pass. Never rejects: an unexpected error is journaled (once
   * per streak) and the next pass runs as usual — a supervisor that died here
   * would leave every child running with nobody watching it.
   */
  async tick(): Promise<AlwaysOnTickOutcome> {
    try {
      const outcome = await this.tickOnce();
      this.tickFailing = false;
      return outcome;
    } catch (error) {
      if (!this.tickFailing) {
        this.tickFailing = true;
        this.record({ kind: "SUPERVISOR_TICK_FAILED", reasonCode: errorCode(error), detail: "an unexpected error interrupted one supervision pass; supervision continues with the next one" });
      }
      if (this.fenced) return "FENCED";
      this.state = this.shutdown ? "STOPPING" : "DEGRADED";
      this.reasonCode = "SUPERVISION_ERROR";
      this.reason = `an unexpected error interrupted the last supervision pass (${errorCode(error)}); supervision continues`;
      this.writeStatus();
      return "CONTINUE";
    }
  }

  private async tickOnce(): Promise<AlwaysOnTickOutcome> {
    if (this.fenced) return "FENCED";
    if (this.detached || this.shutdown?.done) return "STOPPED";
    const now = this.a.now();
    this.counters.ticks += 1;
    const p = this.config.policy;
    if (this.lastTickAtMs !== null && now - this.lastTickAtMs > p.pollMs * p.resumeGapPolls) {
      // A sleep or hibernate: every grace period starts again, nothing is judged on pre-sleep timers.
      this.record({ kind: "SUPERVISOR_RESUMED_AFTER_GAP", reasonCode: "CLOCK_GAP", detail: `no supervision for ${Math.round((now - this.lastTickAtMs) / 1000)}s (sleep, hibernate or a stalled process)` });
      for (const role of ALWAYS_ON_ROLES) {
        this.rt[role].unhealthySinceMs = null;
        this.rt[role].warmingSinceMs = null;
        // Time asleep is not healthy time either: forgiveness needs an observed streak.
        this.rt[role].healthySinceMs = null;
        if (this.rt[role].startedAtMs !== null) this.rt[role].startedAtMs = now;
      }
      if (this.recovery !== null) {
        if (this.recovery.awaitingSinceMs !== null) this.recovery.awaitingSinceMs = now;
        this.recovery.degradedSinceMs = null;
      }
      this.resumedAtMs = now;
      this.network = { reachable: null, lastProbeAtMs: null, unavailableSinceMs: null, restoredAtMs: null };
      this.stream = freshStreamPath();
    }
    this.lastTickAtMs = now;
    this.consumeRequests(now);

    const tree = this.a.observeTree();
    if (!tree.ok) {
      if (!this.observationFailing) this.record({ kind: "OBSERVATION_FAILED", reasonCode: tree.reason, detail: "the process table could not be read; nothing is started or stopped until it can" });
      this.observationFailing = true;
      this.state = this.shutdown ? "STOPPING" : "DEGRADED";
      this.reasonCode = "OBSERVATION_FAILED";
      this.reason = `the process table could not be read (${tree.reason}); nothing is started or stopped until it can`;
      this.writeStatus();
      return "CONTINUE";
    }
    this.observationFailing = false;
    const fence = this.fenceState();
    if (fence === "SUPERSEDED") return this.becomeFenced();
    if (fence === "UNKNOWN") {
      this.state = this.shutdown ? "STOPPING" : "DEGRADED";
      this.reasonCode = "OWNERSHIP_UNREADABLE";
      this.reason = "ownership.json could not be read; nothing is started, stopped or recorded until it can (this generation is not given up)";
      this.writeStatus();
      return "CONTINUE";
    }
    // A record that could not be made durable earlier is retried before anything else changes.
    this.flushOwnership();
    if (this.fenced) return "FENCED";

    this.reconcileChildren(tree.value, now);
    if (this.fenced) return "FENCED";
    const census = monitoringCensus(tree.value, this.ownedRoots(), this.a.selfPid);
    this.latest.census = census;
    this.reportExternal(census);

    if (this.shutdown) {
      await this.advanceShutdown(now);
      this.writeStatus();
      return this.shutdown.done ? "STOPPED" : this.fenced ? "FENCED" : "CONTINUE";
    }

    // ---- evidence ----
    const backendOk = await this.readBackendHealth();
    this.latest.backendOk = backendOk;
    let plannerStatus: unknown = null;
    let plans: unknown = null;
    if (backendOk) {
      const [planner, soak] = await Promise.all([
        this.a.http.getJson(`${this.config.backendUrl}/api/native-planner/status`, p.httpTimeoutMs),
        this.a.http.getJson(`${this.config.backendUrl}/api/signal-quality/soak-health`, p.httpTimeoutMs),
      ]);
      plannerStatus = planner.ok ? planner.body : null;
      const soakBody = soak.ok && soak.body !== null && typeof soak.body === "object" ? (soak.body as Record<string, unknown>) : null;
      plans = soakBody?.plans ?? null;
      this.updateDataStore(soak.ok ? "AVAILABLE" : soak.status !== null && soak.status >= 500 ? "UNAVAILABLE" : "UNKNOWN");
    } else {
      this.updateDataStore("UNKNOWN");
    }
    const scanner = judgeScannerHealth({ statusText: this.a.fs.readText(this.a.paths.scannerStatus), nowMs: now, ownedRuntimePids: census.owned.scanner, policy: p });
    this.latest.scanner = scanner;
    this.identifyScannerRun(scanner);
    const pinned = this.children.emitter?.pinnedRunId ?? null;
    const emitter =
      pinned === null
        ? null
        : judgeEmitterHealth({
            statusText: this.a.fs.readText(emitterCommitStatus(this.a.paths, pinned)),
            nowMs: now,
            ownedRuntimePids: census.owned.emitter,
            expectedRunId: pinned,
            scannerSelected: scanner.ours ? scanner.universe.selected : null,
            policy: p,
          });
    this.latest.emitter = emitter;
    const planner = this.judgePlanner(plannerStatus, plans, now);
    this.latest.planner = planner;

    // ---- decisions, in dependency order ----
    await this.superviseBackend(backendOk, census, now);
    if (this.fenced) return "FENCED";
    await this.superviseScanner(scanner, census, now);
    if (this.fenced) return "FENCED";
    await this.superviseEmitter(emitter, scanner, census, now);
    if (this.fenced) return "FENCED";
    await this.supervisePlanner(planner, backendOk, census, now);
    if (this.fenced) return "FENCED";

    this.computeOverallState(now);
    this.writeStatus();
    return "CONTINUE";
  }

  /** The delay until the next tick: faster while a stop or restart is being carried out. */
  nextDelayMs(): number {
    const busy = this.shutdown !== null || this.recovery !== null || ALWAYS_ON_ROLES.some((role) => this.rt[role].stopping !== null);
    return busy ? this.config.policy.transitionPollMs : this.config.policy.pollMs;
  }

  /** Begin a graceful stop of everything this generation owns (emitter → scanner → planner → backend). */
  requestShutdown(reasonCode: string): void {
    if (this.shutdown !== null || this.fenced || this.detached) return;
    this.shutdown = { reasonCode, requestedAtMs: this.a.now(), done: false };
    this.recovery = null;
    this.state = "STOPPING";
    this.reasonCode = reasonCode;
    this.reason = "stopping the owned monitoring stack gracefully";
    this.record({ kind: "SUPERVISOR_STOPPING", reasonCode, detail: "graceful stop of the owned roles: emitter, scanner, planner, backend" });
    this.writeStatus();
  }

  /**
   * Leave WITHOUT touching any child (the console was closed): the children
   * keep running and the next generation adopts what is still provably ours.
   */
  detach(reasonCode: string): void {
    if (this.detached || this.fenced || this.shutdown?.done) return;
    this.detached = true;
    this.state = "STOPPED";
    this.reasonCode = reasonCode;
    this.reason = "the supervisor exited without stopping its children; the next Always-On start adopts the ones still provably owned";
    this.record({ kind: "SUPERVISOR_DETACHED", reasonCode, detail: this.reason });
    this.writeStatus();
  }

  // ---------------------------------------------------------------------------
  // Fencing and ownership records
  // ---------------------------------------------------------------------------

  /**
   * The generation on disk. A file that cannot be READ is UNKNOWN — a reader,
   * an indexer or antivirus can hold it for a moment — and only pauses
   * mutations; anything readable that is not this generation fences it.
   */
  private fenceState(): FenceState {
    let text: string | null;
    try {
      text = this.a.fs.readTextStrict(this.a.paths.ownership);
    } catch (error) {
      if (!this.ownershipReadFailing) {
        this.ownershipReadFailing = true;
        this.record({ kind: "OWNERSHIP_READ_FAILED", reasonCode: errorCode(error), detail: "ownership.json could not be read: nothing is started, stopped or recorded until it can; the generation is not given up" });
      }
      return "UNKNOWN";
    }
    if (this.ownershipReadFailing) {
      this.ownershipReadFailing = false;
      this.record({ kind: "OWNERSHIP_READ_RESTORED", reasonCode: "OWNERSHIP_READABLE", detail: "ownership.json can be read again" });
    }
    return generationIsCurrent(parseOwnership(text), this.generation) ? "CURRENT" : "SUPERSEDED";
  }

  private becomeFenced(): AlwaysOnTickOutcome {
    if (!this.fenced) {
      this.fenced = true;
      this.state = "STOPPED";
      this.reasonCode = "FENCED_BY_NEWER_GENERATION";
      this.reason = "a newer Always-On generation owns the monitoring stack; this supervisor controls nothing and exits";
      this.record({ kind: "SUPERVISOR_FENCED", reasonCode: this.reasonCode, detail: this.reason });
    }
    return "FENCED";
  }

  private ownedRoots(): Partial<Record<AlwaysOnRole, number>> {
    const roots: Partial<Record<AlwaysOnRole, number>> = {};
    for (const role of ALWAYS_ON_ROLES) {
      const child = this.children[role];
      if (child !== null) roots[role] = child.pid;
    }
    return roots;
  }

  /**
   * The ONLY writer of ownership.json (atomic replace). Callers have passed the
   * generation fence. Never throws: a write that fails right after a spawn must
   * not end the supervisor and strand the child. The record stays in memory,
   * is retried every tick, and no role is started until it is durable.
   */
  private writeOwnership(): boolean {
    const file: OwnershipFile = {
      schema: ALWAYS_ON_OWNERSHIP_SCHEMA,
      generation: this.generation,
      repoRoot: this.config.repoRoot,
      supervisor:
        this.shutdown?.done === true
          ? null
          : { pid: this.a.selfPid, startedAtMs: this.a.selfStartedAtMs, startedAt: new Date(this.startedAtMs).toISOString(), commandIdentity: this.config.commandIdentity, instancePort: this.config.instancePort },
      children: ALWAYS_ON_ROLES.map((role) => this.children[role]).filter((c): c is ChildRecord => c !== null),
      writtenAt: new Date(this.a.now()).toISOString(),
    };
    try {
      this.a.fs.writeTextAtomic(this.a.paths.ownership, serializeOwnership(file));
    } catch (error) {
      this.ownershipDirty = true;
      if (!this.ownershipWriteFailing) {
        this.ownershipWriteFailing = true;
        this.record({
          kind: "OWNERSHIP_WRITE_FAILED",
          reasonCode: errorCode(error),
          detail: "ownership.json could not be written: every owned child stays recorded in memory, the write is retried every tick, and no role is started until the record is durable",
        });
      }
      return false;
    }
    this.ownershipDirty = false;
    if (this.ownershipWriteFailing) {
      this.ownershipWriteFailing = false;
      this.record({ kind: "OWNERSHIP_WRITE_RESTORED", reasonCode: "OWNERSHIP_DURABLE", detail: "ownership.json is written again: every owned child is durably recorded" });
    }
    return true;
  }

  /**
   * Records a change of children after re-checking the fence; a fenced
   * supervisor writes nothing. False only when fenced. While the fence cannot
   * be read the change is kept in memory and written once it can.
   */
  private persistChildren(): boolean {
    const fence = this.fenceState();
    if (fence === "SUPERSEDED") {
      this.becomeFenced();
      return false;
    }
    if (fence === "UNKNOWN") {
      this.ownershipDirty = true;
      return true;
    }
    this.writeOwnership();
    return true;
  }

  /** Retries a record that could not be made durable. True when ownership.json matches memory. */
  private flushOwnership(): boolean {
    if (!this.ownershipDirty) return true;
    return this.persistChildren() && !this.ownershipDirty;
  }

  /**
   * Every start and stop runs here: under the launcher's machine-wide mutation
   * lock (so no launcher action can interleave), and only after the generation
   * fence is re-proven UNDER that lock.
   */
  private async mutate<T>(action: MutationAction, run: () => T): Promise<{ ran: true; result: T } | { ran: false; reason: string }> {
    const held = await this.a.mutation(action, async (): Promise<{ fence: "CURRENT"; value: T } | { fence: "SUPERSEDED" } | { fence: "UNKNOWN" }> => {
      const fence = this.fenceState();
      if (fence !== "CURRENT") return { fence };
      return { fence, value: run() };
    });
    if (!held.ran) return { ran: false, reason: held.reasons.join("; ") || held.outcome };
    if (held.result.fence === "SUPERSEDED") {
      this.becomeFenced();
      return { ran: false, reason: "FENCED_BY_NEWER_GENERATION" };
    }
    if (held.result.fence === "UNKNOWN") return { ran: false, reason: "OWNERSHIP_UNREADABLE" };
    return { ran: true, result: held.result.value };
  }

  /** Owned roots that are gone (or no longer provably ours) leave the record — they are never killed. */
  private reconcileChildren(tree: readonly ObservedProcessNode[], now: number): void {
    for (const role of ALWAYS_ON_ROLES) {
      const child = this.children[role];
      if (child === null) continue;
      const node = tree.find((n) => n.pid === child.pid) ?? null;
      const verdict = verifyOwnership(child, node === null ? null : { pid: node.pid, commandLine: node.commandLine, startedAtMs: node.startedAtMs }, this.config.repoRoot);
      if (verdict.owned) continue;
      this.children[role] = null;
      if (!this.persistChildren()) return;
      const rt = this.rt[role];
      rt.lastExit = { atMs: now, code: this.a.exitCodeOf?.(child.pid) ?? null };
      rt.startedAtMs = null;
      this.removeStopFile(child);
      if (rt.stopping !== null) {
        this.record({ kind: "ROLE_STOPPED", role, reasonCode: rt.stopping.reasonCode, detail: `${ALWAYS_ON_ROLE_LABELS[role]} stopped (${rt.stopping.purpose.toLowerCase()})`, facts: { pid: child.pid, exitCode: rt.lastExit.code } });
        this.noteStopCompleted(role, rt.stopping);
        rt.stopping = null;
        continue;
      }
      this.record({
        kind: "ROLE_EXITED",
        role,
        reasonCode: verdict.reason,
        detail: `${ALWAYS_ON_ROLE_LABELS[role]} root pid ${child.pid} ended unexpectedly${rt.lastExit.code === null ? "" : ` (exit ${rt.lastExit.code})`}; see its always-on log`,
        facts: { pid: child.pid, exitCode: rt.lastExit.code },
      });
      // Only a supervised scanner is recovered: an adopted child of a role excluded by --roles just leaves the record.
      if (role === "scanner" && this.recovery === null && this.shutdown === null && this.config.roles.includes("scanner")) {
        this.requestRecovery("SCANNER_EXITED", "the owned scanner exited", now);
      }
    }
  }

  /** A stop the supervisor asked for because of ANOTHER role (a scanner recovery) or a superseded run is not this role's failure. */
  private noteStopCompleted(role: AlwaysOnRole, stopping: StopRequest): void {
    if (stopping.purpose === "SUPERSEDED" || (stopping.purpose === "RECOVERY" && role !== "scanner")) this.rt[role].freeRestart = true;
  }

  private removeStopFile(child: ChildRecord): void {
    if (child.stopFile !== null) this.removeQuietly(child.stopFile);
  }

  private removeQuietly(file: string): void {
    try {
      this.a.fs.remove(file);
    } catch {
      // A stale stop file names a child that no longer exists; harmless.
    }
  }

  // ---------------------------------------------------------------------------
  // Starting and stopping, always fenced
  // ---------------------------------------------------------------------------

  private gateOpen(role: AlwaysOnRole, now: number): boolean {
    const rt = this.rt[role];
    return !rt.everStarted || rt.freeRestart || now >= rt.nextAttemptAtMs;
  }

  private spendAttempt(role: AlwaysOnRole, now: number): void {
    const rt = this.rt[role];
    rt.attempts += 1;
    rt.nextAttemptAtMs = now + backoffDelayMs(this.config.policy, rt.attempts);
  }

  private latch(role: AlwaysOnRole, reasonCode: string, now: number): void {
    const rt = this.rt[role];
    if (rt.latched) return;
    rt.latched = true;
    this.setRole(role, "LATCHED", reasonCode, `automatic recovery stopped after ${rt.attempts} failed attempt(s); clear it with: monitoring:always-on clear-latch --role ${role}`);
    this.record({ kind: "ROLE_LATCHED", role, reasonCode, detail: `${ALWAYS_ON_ROLE_LABELS[role]}: no further automatic restarts until an operator clears the latch`, facts: { attempts: rt.attempts } });
    if (role === "scanner" && this.recovery !== null) {
      this.record({ kind: "SCANNER_RECOVERY_FAILED", role, reasonCode, detail: `scanner recovery (${this.recovery.reasonCode}) gave up` });
      this.lastRecovery = { at: new Date(now).toISOString(), role, reasonCode: this.recovery.reasonCode, reason: this.recovery.reason, outcome: "FAILED_LATCHED" };
      this.recovery = null;
    }
  }

  /** The unaccounted runtimes of a role, counted FRESH immediately before a spawn (null: not observable). */
  private freshUnaccounted(role: AlwaysOnRole): number | null {
    const tree = this.a.observeTree();
    if (!tree.ok) return null;
    const census = monitoringCensus(tree.value, this.ownedRoots(), this.a.selfPid);
    return census.external[role].length + census.owned[role].length;
  }

  private async startRole(role: AlwaysOnRole, now: number, plan: (stopFile: string | null) => MonitoringSpawnPlan, meta: { readonly pinnedRunId: string | null; readonly engineFingerprint: string | null; readonly cooperative: boolean }): Promise<"STARTED" | "REFUSED" | "FAILED"> {
    const rt = this.rt[role];
    // Never a second child while an earlier one is recorded only in memory: a crash now would orphan both.
    if (!this.flushOwnership()) {
      if (!this.fenced) this.setRole(role, rt.state === "OFF" ? "BLOCKED" : rt.state, "OWNERSHIP_NOT_DURABLE", "ownership.json cannot be written yet; nothing is started until every owned child is durably recorded");
      return "REFUSED";
    }
    const restart = rt.everStarted;
    // A restart after a stop the supervisor made for another role's sake is not a recovery attempt.
    const counted = restart && !rt.freeRestart;
    if (counted && rt.attempts >= this.config.policy.maxRecoveryAttempts) {
      this.latch(role, "RECOVERY_ATTEMPTS_EXHAUSTED", now);
      return "REFUSED";
    }
    const sequence = this.spawnSequence + 1;
    const stopFile = meta.cooperative ? childStopFile(this.a.paths, role, this.generation, sequence) : null;
    let built: MonitoringSpawnPlan;
    try {
      built = plan(stopFile);
    } catch (error) {
      if (!(error instanceof MonitoringPlanError)) throw error;
      this.setRole(role, "BLOCKED", "SPAWN_PLAN_REFUSED", error.message);
      return "REFUSED";
    }
    this.spawnSequence = sequence;
    if (stopFile !== null) this.removeStopFile({ stopFile } as ChildRecord);
    const outcome = await this.mutate("ALWAYS_ON_ROLE_START", () =>
      executeFencedStart(role, {
        probe: this.a.probe,
        unaccountedLeaves: () => this.freshUnaccounted(role),
        spawnWorker: () => this.a.spawn(built),
        recordOwnership: (pid, startedAtMs) => {
          this.children[role] = {
            role,
            pid,
            startedAtMs,
            spawnedAt: new Date(now).toISOString(),
            spawnedByGeneration: this.generation,
            sequence,
            commandIdentity: built.commandIdentity,
            stopFile,
            pinnedRunId: meta.pinnedRunId,
            engineFingerprint: meta.engineFingerprint,
          };
          this.writeOwnership();
        },
        log: (line) => this.a.log(`  ${role}: ${line}`),
      })
    );
    if (!outcome.ran) {
      if (this.fenced) return "REFUSED";
      if (outcome.reason === "OWNERSHIP_UNREADABLE") this.setRole(role, rt.state === "OFF" ? "BLOCKED" : rt.state, "OWNERSHIP_UNREADABLE", "the start waits until ownership.json can be read under the mutation lock");
      else this.setRole(role, rt.state === "OFF" ? "BLOCKED" : rt.state, "MUTATION_AUTHORITY_BUSY", `the start waits for the launcher's mutation lock (${outcome.reason})`);
      return "REFUSED";
    }
    const result = outcome.result;
    if (result.started) {
      if (counted) this.spendAttempt(role, now);
      if (restart) {
        rt.restarts += 1;
        this.counters.restarts[role] += 1;
      }
      rt.everStarted = true;
      rt.freeRestart = false;
      rt.startedAtMs = now;
      rt.unhealthySinceMs = null;
      rt.healthySinceMs = null;
      rt.warmingSinceMs = null;
      rt.lastOwnStatusAtMs = null;
      this.setRole(role, "STARTING", restart ? "RESTARTED" : "STARTED", `started (root pid ${result.pid}); waiting for its first evidence of health`);
      this.record({
        kind: "ROLE_STARTED",
        role,
        reasonCode: !restart ? "INITIAL_START" : counted ? "RESTART" : "RESTART_NOT_A_FAILURE",
        detail: `${ALWAYS_ON_ROLE_LABELS[role]} started: ${built.commandIdentity}`,
        facts: { pid: result.pid, attempt: counted ? rt.attempts : 0, pinnedRunId: meta.pinnedRunId },
      });
      return "STARTED";
    }
    if (result.outcome === "DUPLICATE_PRESENT") {
      this.setRole(role, "CONFLICT", "RUNTIME_ALREADY_RUNNING", `${result.reason}: a process this supervisor does not own is doing this job; it is not killed and nothing is started beside it`);
      return "REFUSED";
    }
    if (result.outcome === "CENSUS_UNAVAILABLE") {
      this.setRole(role, rt.state, "CENSUS_UNAVAILABLE", "the pre-spawn census could not be read; nothing was started");
      return "REFUSED";
    }
    // A spawn that failed, or one whose identity cannot be proven, is a spent attempt (never a hot loop).
    rt.everStarted = true;
    rt.freeRestart = false;
    this.spendAttempt(role, now);
    this.record({ kind: "ROLE_START_FAILED", role, reasonCode: result.outcome, detail: `${ALWAYS_ON_ROLE_LABELS[role]} did not start (${result.reason})`, facts: { attempt: rt.attempts } });
    this.setRole(role, "BACKOFF", result.outcome, `the start failed (${result.reason}); the next attempt waits for its backoff`);
    return "FAILED";
  }

  private stopWaitMs(role: AlwaysOnRole): number {
    return role === "scanner" ? this.config.policy.scannerStopWaitMs : this.config.policy.emitterStopWaitMs;
  }

  /** Asks ONE owned child to stop: cooperatively (scanner, emitter) or through the fenced stop (planner, backend). */
  private async requestStop(role: AlwaysOnRole, purpose: StopPurpose, reasonCode: string, now: number): Promise<void> {
    const rt = this.rt[role];
    const child = this.children[role];
    if (child === null || rt.stopping !== null) return;
    if (child.stopFile !== null) {
      const stopFile = child.stopFile;
      const wrote = await this.mutate("ALWAYS_ON_ROLE_STOP", (): string | null => {
        try {
          this.a.fs.ensureDir(path.dirname(stopFile));
          this.a.fs.writeTextAtomic(
            stopFile,
            `${JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "COOPERATIVE_STOP", role, generation: this.generation, reasonCode, requestedAt: new Date(now).toISOString() })}\n`
          );
          return null;
        } catch (error) {
          return errorCode(error);
        }
      });
      if (!wrote.ran) return;
      if (wrote.result !== null) {
        // Not requested yet: the next tick asks again.
        this.a.log(`  ${role}: its cooperative stop file could not be written (${wrote.result}); retried on the next tick`);
        return;
      }
      rt.stopping = { purpose, cooperative: true, requestedAtMs: now, deadlineMs: now + this.stopWaitMs(role), reasonCode, forcedAttempted: false };
      this.record({ kind: "ROLE_STOP_REQUESTED", role, reasonCode, detail: `${ALWAYS_ON_ROLE_LABELS[role]}: cooperative stop requested (${purpose.toLowerCase()}); forced only if it has not exited in ${Math.round(this.stopWaitMs(role) / 1000)}s`, facts: { pid: child.pid } });
      return;
    }
    rt.stopping = { purpose, cooperative: false, requestedAtMs: now, deadlineMs: now, reasonCode, forcedAttempted: false };
    this.record({ kind: "ROLE_STOP_REQUESTED", role, reasonCode, detail: `${ALWAYS_ON_ROLE_LABELS[role]}: fenced stop (${purpose.toLowerCase()})`, facts: { pid: child.pid } });
    await this.forceStop(role, now);
  }

  private async advanceStop(role: AlwaysOnRole, now: number): Promise<void> {
    const rt = this.rt[role];
    if (rt.stopping === null) return;
    if (this.children[role] === null) {
      rt.stopping = null;
      return;
    }
    if (now >= rt.stopping.deadlineMs && !rt.stopping.forcedAttempted) await this.forceStop(role, now);
  }

  /** The reviewed fenced stop: ownership re-proven, terminate ONE root, exit confirmed by a second probe. */
  private async forceStop(role: AlwaysOnRole, now: number): Promise<void> {
    const rt = this.rt[role];
    const child = this.children[role];
    if (child === null || rt.stopping === null) return;
    rt.stopping.forcedAttempted = true;
    const outcome = await this.mutate("ALWAYS_ON_ROLE_STOP", () =>
      executeFencedStop(child, this.config.repoRoot, { probe: this.a.probe, terminate: this.a.terminate, log: (line) => this.a.log(`  ${role}: ${line}`) })
    );
    if (!outcome.ran) {
      if (rt.stopping !== null) rt.stopping.forcedAttempted = false;
      return;
    }
    const result = outcome.result;
    if (result.stopped || result.outcome === "OWNERSHIP_LOST" || result.outcome === "NOT_RECORDED") {
      const stopping = rt.stopping;
      this.children[role] = null;
      if (!this.persistChildren()) return;
      this.removeStopFile(child);
      rt.lastExit = { atMs: now, code: this.a.exitCodeOf?.(child.pid) ?? null };
      rt.startedAtMs = null;
      this.noteStopCompleted(role, stopping);
      rt.stopping = null;
      if (result.stopped) {
        this.record({
          kind: stopping.cooperative && !result.alreadyGone ? "ROLE_FORCE_STOPPED" : "ROLE_STOPPED",
          role,
          reasonCode: stopping.reasonCode,
          detail:
            stopping.cooperative && !result.alreadyGone
              ? `${ALWAYS_ON_ROLE_LABELS[role]} did not exit within its cooperative stop window and was stopped by the fenced stop`
              : `${ALWAYS_ON_ROLE_LABELS[role]} stopped (${stopping.purpose.toLowerCase()})`,
          facts: { pid: child.pid, alreadyGone: result.alreadyGone },
        });
      } else {
        this.record({ kind: "CHILD_RECORD_DROPPED", role, reasonCode: result.outcome, detail: `root pid ${child.pid} is no longer provably ours (${result.reason}); it was NOT terminated` });
      }
      return;
    }
    // Unobservable or still running: keep the record (unknown is never gone) and try again later.
    this.record({ kind: "ROLE_STOP_FAILED", role, reasonCode: result.outcome, detail: `${ALWAYS_ON_ROLE_LABELS[role]} could not be stopped yet (${result.reason}); its record is kept`, facts: { pid: child.pid } });
    rt.stopping.forcedAttempted = false;
    rt.stopping.deadlineMs = now + this.config.policy.transitionPollMs * 5;
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  private async readBackendHealth(): Promise<boolean> {
    const answer = await this.a.http.getJson(`${this.config.backendUrl}/health`, this.config.policy.httpTimeoutMs);
    return answer.ok && answer.body !== null && typeof answer.body === "object" && (answer.body as { status?: unknown }).status === "ok";
  }

  private updateDataStore(next: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN"): void {
    if (next === this.dataStore) return;
    if (next === "UNAVAILABLE") this.record({ kind: "DATA_STORE_UNAVAILABLE", reasonCode: "SOAK_HEALTH_5XX", detail: "the backend answers but its database reads fail; emitter and planner (re)starts wait" });
    if (next === "AVAILABLE" && this.dataStore === "UNAVAILABLE") this.record({ kind: "DATA_STORE_RESTORED", reasonCode: "SOAK_HEALTH_OK", detail: "the backend's database reads succeed again" });
    this.dataStore = next;
  }

  private async networkReachable(now: number): Promise<boolean> {
    const n = this.network;
    if (n.reachable !== null && n.lastProbeAtMs !== null && now - n.lastProbeAtMs < this.config.policy.connectivityProbeEveryMs) return n.reachable;
    let ok = false;
    try {
      ok = await this.a.publicConnectivity();
    } catch {
      ok = false;
    }
    if (!ok && n.reachable !== false) {
      n.unavailableSinceMs = now;
      this.record({ kind: "NETWORK_UNAVAILABLE", role: "scanner", reasonCode: "PUBLIC_BINANCE_UNREACHABLE", detail: "public Binance is unreachable: no scanner restart is attempted (and no attempt is spent) until it returns" });
    }
    if (ok && n.reachable === false) {
      n.restoredAtMs = now;
      this.record({ kind: "NETWORK_RESTORED", role: "scanner", reasonCode: "PUBLIC_BINANCE_REACHABLE", detail: `public Binance answers again after ${n.unavailableSinceMs === null ? "?" : Math.round((now - n.unavailableSinceMs) / 1000)}s`, facts: { downSeconds: n.unavailableSinceMs === null ? null : Math.round((now - n.unavailableSinceMs) / 1000) } });
      n.unavailableSinceMs = null;
    }
    n.reachable = ok;
    n.lastProbeAtMs = now;
    return ok;
  }

  /**
   * The scanner's OWN current evidence that its streams, and nothing else, are failing: a fresh status of our run in
   * which no connection is delivering anything, and every issue is one a stream outage explains (awaiting streams,
   * stale market data, symbols recovering). A stale or missing status, or any other issue, is never such evidence.
   */
  private streamFailureEvidence(scanner: ScannerHealth): boolean {
    if (!scanner.ours || scanner.verdict !== "DEGRADED" || scanner.stream === null) return false;
    if (scanner.stream.connections === 0 || scanner.stream.delivering > 0) return false;
    const codes = scanner.issues.map((i) => i.code as string);
    return codes.length > 0 && codes.every((code) => STREAM_EXPLAINED_ISSUES.has(code)) && (codes.includes("AWAITING_STREAM") || codes.includes("MARKET_DATA_STALE"));
  }

  /**
   * True only when the public stream probe positively confirms a stream outage (UNREACHABLE). The probe runs at most
   * once per probe cadence, never concurrently, and its answer is reused only within that cadence for the same run
   * (`runId`; null when no scanner runs). UNKNOWN, a failing probe, or a busy one is never a confirmation: the caller
   * then takes its existing recovery path. A REACHABLE answer after a confirmed outage records its end and opens the
   * post-network heal window.
   */
  private async streamOutageConfirmed(runId: string | null, now: number): Promise<boolean> {
    const s = this.stream;
    let outcome: PublicStreamProbeOutcome;
    const last = s.lastProbe;
    if (last !== null && last.runId === runId && now - last.atMs < this.config.policy.connectivityProbeEveryMs) {
      outcome = last.outcome;
    } else {
      if (s.probing) return false;
      s.probing = true;
      try {
        outcome = await this.a.publicStreamConnectivity();
      } catch {
        outcome = "UNKNOWN";
      } finally {
        s.probing = false;
      }
      s.lastProbe = { atMs: now, runId, outcome };
    }
    if (outcome === "UNREACHABLE") {
      if (s.unavailableSinceMs === null) {
        s.unavailableSinceMs = now;
        this.record({
          kind: "NETWORK_UNAVAILABLE",
          role: "scanner",
          reasonCode: "PUBLIC_STREAM_UNREACHABLE",
          detail: "public Binance streams are unreachable while REST answers: no scanner restart is attempted (and no attempt is spent) until they return",
        });
      }
      return true;
    }
    if (outcome === "REACHABLE") this.endStreamOutage(now, "the public stream probe connects again");
    return false;
  }

  /** A confirmed stream outage is over: journaled once, and the scanner gets the post-network heal window. */
  private endStreamOutage(now: number, why: string): void {
    const since = this.stream.unavailableSinceMs;
    if (since === null) return;
    this.stream.unavailableSinceMs = null;
    this.network.restoredAtMs = now;
    const downSeconds = Math.round((now - since) / 1000);
    this.record({ kind: "NETWORK_RESTORED", role: "scanner", reasonCode: "PUBLIC_STREAM_REACHABLE", detail: `public Binance streams are back after ${downSeconds}s (${why})`, facts: { downSeconds } });
  }

  /** Our scanner reports a run whose engine is not the profile's: no emitter may ever be pinned to it. */
  private runOfAnotherEngine(scanner: ScannerHealth): boolean {
    return scanner.ours && scanner.runId !== null && scanner.engineFingerprint !== this.config.engineFingerprint;
  }

  /** Our scanner's run, once its own status names it: the only run an emitter may be pinned to. */
  private identifyScannerRun(scanner: ScannerHealth): void {
    if (!scanner.ours || scanner.runId === null || this.recovery?.phase === "STOPPING_EMITTER" || this.recovery?.phase === "STOPPING_SCANNER") return;
    const manifest = this.a.fs.exists(scannerRunManifest(this.a.paths, scanner.runId));
    const fingerprintOk = scanner.engineFingerprint === this.config.engineFingerprint;
    if (this.scannerRun?.runId !== scanner.runId) {
      this.record({
        kind: "SCANNER_RUN_IDENTIFIED",
        role: "scanner",
        reasonCode: fingerprintOk ? "RUN_OF_THE_PROFILE_ENGINE" : "ENGINE_FINGERPRINT_MISMATCH",
        detail: `run ${scanner.runId}${manifest ? "" : " (manifest not yet written)"}${fingerprintOk ? "" : " — its engine is not the profile's: no emitter will be pinned to it"}`,
        facts: { runId: scanner.runId, manifest, fingerprintOk },
      });
    }
    this.scannerRun = { runId: scanner.runId, engineFingerprint: scanner.engineFingerprint, bindable: manifest && fingerprintOk };
  }

  private judgePlanner(plannerStatus: unknown, plans: unknown, now: number): PlannerHealth {
    const probe = judgePlannerHealth({ plannerStatus, plans, baseline: this.plannerBaseline, nowMs: now, pendingSinceMs: this.pendingSinceMs, policy: this.config.policy });
    const next = nextPlannerBaseline(this.plannerBaseline, { jobsFailed: probe.jobsFailed, plansError: probe.plansError }, new Date(now).toISOString());
    if (next.event === "ESTABLISHED") {
      this.record({ kind: "PLANNER_BASELINE_ESTABLISHED", role: "planner", reasonCode: "OBSERVATION_BEGAN", detail: `historical counters accepted as the baseline: failed jobs ${probe.jobsFailed}, ERROR plans ${probe.plansError} (health judges NEW failures only)`, facts: { jobsFailed: probe.jobsFailed, plansError: probe.plansError } });
      this.plannerDeltaJournaled = { jobsFailed: 0, plansError: 0 };
    } else if (next.event === "RESET_COUNTERS_WENT_BACKWARDS") {
      this.record({ kind: "PLANNER_BASELINE_RESET", role: "planner", reasonCode: next.event, detail: "a cumulative planner counter went backwards (retention or a cleared queue); the baseline follows it down, never up", facts: { jobsFailed: probe.jobsFailed, plansError: probe.plansError } });
      this.plannerDeltaJournaled = { jobsFailed: 0, plansError: 0 };
    }
    this.plannerBaseline = next.baseline;
    if (probe.pending !== null) this.pendingSinceMs = probe.pending > 0 ? (this.pendingSinceMs ?? now) : null;
    const health = judgePlannerHealth({ plannerStatus, plans, baseline: this.plannerBaseline, nowMs: now, pendingSinceMs: this.pendingSinceMs, policy: this.config.policy });
    const jobs = health.delta.jobsFailed ?? 0;
    const errs = health.delta.plansError ?? 0;
    if (jobs > this.plannerDeltaJournaled.jobsFailed || errs > this.plannerDeltaJournaled.plansError) {
      this.record({ kind: "PLANNER_FAILURE_DELTA_INCREASED", role: "planner", reasonCode: "NEW_PLANNER_FAILURES", detail: `since observation began: +${jobs} failed planning job(s), +${errs} ERROR plan(s)`, facts: { jobsFailedDelta: jobs, plansErrorDelta: errs } });
      this.plannerDeltaJournaled = { jobsFailed: Math.max(jobs, this.plannerDeltaJournaled.jobsFailed), plansError: Math.max(errs, this.plannerDeltaJournaled.plansError) };
    }
    return health;
  }

  private reportExternal(census: MonitoringCensus): void {
    const report = (key: string, event: IncidentEvent) => {
      if (this.reportedExternal.has(key)) return;
      this.reportedExternal.add(key);
      this.record(event);
    };
    for (const pid of census.soakMonitors) {
      report(`soak:${pid}`, { kind: "EXTERNAL_MONITORING_PROCESS", reasonCode: "SOAK_MONITOR_NOT_OWNED", detail: `signal-quality soak monitor pid ${pid} is not owned by Always-On; it is reported and never stopped`, facts: { pid } });
    }
    for (const pid of census.otherSupervisors) {
      report(`sup:${pid}`, { kind: "EXTERNAL_MONITORING_PROCESS", reasonCode: "OTHER_SUPERVISOR_RUNTIME", detail: `another Always-On supervisor runtime (pid ${pid}) is visible; it controls nothing this generation owns`, facts: { pid } });
    }
  }

  // ---------------------------------------------------------------------------
  // Backend
  // ---------------------------------------------------------------------------

  private async superviseBackend(backendOk: boolean, census: MonitoringCensus, now: number): Promise<void> {
    const role: AlwaysOnRole = "backend";
    if (!this.config.roles.includes(role)) return;
    const rt = this.rt[role];
    const p = this.config.policy;
    rt.externalPids = [...census.external.backend];
    const child = this.children[role];
    if (child !== null) {
      if (rt.stopping !== null) {
        await this.advanceStop(role, now);
        this.setRole(role, "RECOVERING", rt.stopping?.reasonCode ?? "STOPPING", "being stopped for a restart");
        return;
      }
      if (backendOk) {
        rt.unhealthySinceMs = null;
        this.markHealthy(role, now, "HEALTH_OK", "answers /health");
        return;
      }
      if (rt.startedAtMs !== null && now - rt.startedAtMs < p.backendStartupTimeoutMs) {
        this.setRole(role, "STARTING", "WAITING_FOR_HEALTH", "started; waiting for /health to answer");
        return;
      }
      rt.unhealthySinceMs ??= now;
      if (now - rt.unhealthySinceMs < p.backendGraceMs) {
        this.setRole(role, "DEGRADED", "HEALTH_FAILING", `its process is alive but /health has not answered for ${Math.round((now - rt.unhealthySinceMs) / 1000)}s`);
        return;
      }
      await this.requestStop(role, "RESTART", "HEALTH_FAILING_BEYOND_GRACE", now);
      this.setRole(role, "RECOVERING", "HEALTH_FAILING_BEYOND_GRACE", "alive but not answering /health beyond its grace period: restarting it");
      return;
    }
    if (census.external.backend.length > 0 || backendOk) {
      this.setRole(role, "CONFLICT", "EXTERNAL_BACKEND", `a generic backend this supervisor does not own serves :4000${rt.externalPids.length > 0 ? ` (pid ${rt.externalPids.join(",")})` : ""}; it is read, never stopped, and no second backend is started`);
      return;
    }
    if (rt.latched) return;
    const build = this.a.buildVerdict();
    if (!build.ok) {
      this.setRole(role, "BLOCKED", "BUILD_STALE", `the built backend is missing or stale (${build.reasons[0] ?? "see the build check"}); run the build — Always-On never builds`);
      return;
    }
    if (!this.gateOpen(role, now)) {
      this.setRole(role, "BACKOFF", "RESTART_BACKOFF", `the next start is allowed at ${new Date(rt.nextAttemptAtMs).toISOString()}`);
      return;
    }
    const keys = this.genericKeys(role);
    if (keys === null) return;
    await this.startRole(role, now, () => backendSpawnPlan(this.config.repoRoot, this.a.env, keys), { pinnedRunId: null, engineFingerprint: null, cooperative: false });
  }

  private genericKeys(role: AlwaysOnRole): string[] | null {
    const keys = this.a.genericEnvKeyNames();
    if (keys.ok) return keys.keys;
    this.setRole(role, "BLOCKED", "GENERIC_ENV_UNREADABLE", `the generic environment file cannot be read (${keys.reason}); nothing is started without it`);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Scanner
  // ---------------------------------------------------------------------------

  private requestRecovery(reasonCode: string, reason: string, now: number): void {
    if (this.recovery !== null || this.shutdown !== null) return;
    this.recovery = { reasonCode, reason, requestedAtMs: now, phase: "STOPPING_EMITTER", previousRunId: this.scannerRun?.runId ?? null, awaitingSinceMs: null, degradedSinceMs: null };
    this.counters.scannerRecoveries += 1;
    this.scannerRun = null;
    this.record({
      kind: "SCANNER_RECOVERY_REQUESTED",
      role: "scanner",
      reasonCode,
      detail: `${reason}: stopping the pinned emitter, then the scanner, then starting a fresh run (FAST_RECOVERY_V1); no cursor is rebaselined or deleted`,
      facts: { previousRunId: this.recovery.previousRunId },
    });
  }

  private startScanner(now: number): Promise<"STARTED" | "REFUSED" | "FAILED"> {
    const keys = this.genericKeys("scanner");
    if (keys === null) return Promise.resolve("REFUSED");
    return this.startRole(
      "scanner",
      now,
      (stopFile) => scannerSpawnPlan(this.config.repoRoot, this.a.env, keys, { profileName: this.config.profileName, stopFile: stopFile as string, extraArgs: this.config.scannerExtraArgs }),
      { pinnedRunId: null, engineFingerprint: this.config.engineFingerprint, cooperative: true }
    );
  }

  private async advanceRecovery(scanner: ScannerHealth, now: number): Promise<void> {
    const rec = this.recovery as ScannerRecovery;
    const role: AlwaysOnRole = "scanner";
    const rt = this.rt[role];
    if (rec.phase === "STOPPING_EMITTER") {
      if (this.children.emitter !== null) {
        if (this.rt.emitter.stopping === null) await this.requestStop("emitter", "RECOVERY", rec.reasonCode, now);
        else await this.advanceStop("emitter", now);
        if (this.children.emitter !== null) {
          this.setRole(role, "RECOVERING", rec.reasonCode, "recovery: stopping the emitter pinned to the old run first");
          return;
        }
      }
      rec.phase = "STOPPING_SCANNER";
    }
    if (rec.phase === "STOPPING_SCANNER") {
      if (this.children.scanner !== null) {
        if (rt.stopping === null) await this.requestStop(role, "RECOVERY", rec.reasonCode, now);
        else await this.advanceStop(role, now);
        if (this.children.scanner !== null) {
          this.setRole(role, "RECOVERING", rec.reasonCode, "recovery: stopping the owned scanner (its status and checkpoints persist)");
          return;
        }
      }
      rec.phase = "STARTING_SCANNER";
    }
    if (rec.phase === "STARTING_SCANNER") {
      if (rt.latched) {
        this.recovery = null;
        return;
      }
      if (!(await this.networkReachable(now))) {
        this.setRole(role, "DEGRADED", "NETWORK_UNAVAILABLE", "recovery waits: public Binance is unreachable, so a fresh run could not start (no attempt is spent)");
        return;
      }
      // Only while an outage the probe confirmed is still confirmed: a fresh run could not connect (no attempt spent).
      if (this.stream.unavailableSinceMs !== null && (await this.streamOutageConfirmed(null, now))) {
        this.setRole(role, "DEGRADED", "PUBLIC_STREAM_UNREACHABLE", "recovery waits: public Binance streams are unreachable while REST answers, so a fresh run could not connect (no attempt is spent)");
        return;
      }
      if (!this.gateOpen(role, now)) {
        this.setRole(role, "BACKOFF", "RESTART_BACKOFF", `recovery: the next scanner start is allowed at ${new Date(rt.nextAttemptAtMs).toISOString()}`);
        return;
      }
      if (rt.everStarted && rt.attempts >= this.config.policy.maxRecoveryAttempts) {
        this.latch(role, "RECOVERY_ATTEMPTS_EXHAUSTED", now);
        return;
      }
      const started = await this.startScanner(now);
      if (started === "STARTED") {
        rec.phase = "AWAITING_RUN";
        rec.awaitingSinceMs = now;
        rec.degradedSinceMs = null;
        this.setRole(role, "RECOVERING", rec.reasonCode, "recovery: a fresh run is starting (FAST_RECOVERY_V1 replay, then its manifest and first status)");
      }
      return;
    }
    // AWAITING_RUN
    if (this.children.scanner === null) {
      this.record({ kind: "SCANNER_RECOVERY_FAILED", role, reasonCode: "FRESH_RUN_EXITED", detail: `the fresh scanner exited during start-up (attempt ${rt.attempts}); the next attempt waits for its backoff` });
      rec.phase = "STARTING_SCANNER";
      return;
    }
    if (this.runOfAnotherEngine(scanner)) {
      // The fresh run is the code on disk: another run of the same code cannot help (restart Always-On after a code change).
      this.latch(role, "ENGINE_FINGERPRINT_MISMATCH", now);
      return;
    }
    const healthy = scanner.ours && (scanner.verdict === "HEALTHY" || scanner.verdict === "WARMING");
    if (healthy && this.scannerRun !== null && this.scannerRun.bindable) {
      this.record({
        kind: "SCANNER_RECOVERY_SUCCEEDED",
        role,
        reasonCode: rec.reasonCode,
        detail: `fresh run ${this.scannerRun.runId} reports ${scanner.verdict}; the emitter is now started pinned to it`,
        facts: { runId: this.scannerRun.runId, previousRunId: rec.previousRunId, seconds: Math.round((now - rec.requestedAtMs) / 1000) },
      });
      this.lastRecovery = { at: new Date(now).toISOString(), role, reasonCode: rec.reasonCode, reason: rec.reason, outcome: `SUCCEEDED (run ${this.scannerRun.runId})` };
      this.recovery = null;
      this.endStreamOutage(now, "the fresh run's streams deliver");
      this.markHealthy(role, now, scanner.verdict === "WARMING" ? "WARMING" : "HEALTHY", "fresh run healthy");
      return;
    }
    const awaitedMs = now - (rec.awaitingSinceMs ?? now);
    if (scanner.ours && scanner.verdict === "DEGRADED") {
      rec.degradedSinceMs ??= now;
      if (now - rec.degradedSinceMs >= this.config.policy.degradedGraceMs && (await this.networkReachable(now))) {
        if (this.streamFailureEvidence(scanner) && (await this.streamOutageConfirmed(scanner.runId, now))) {
          // The fresh run is kept: it cannot connect because the public streams are down, not because it failed.
          this.setRole(role, "RECOVERING", "PUBLIC_STREAM_UNREACHABLE", "recovery: the fresh run cannot connect because public Binance streams are unreachable while REST answers; it is kept and no attempt is spent");
          return;
        }
        const restoredAtMs = this.network.restoredAtMs;
        if (restoredAtMs !== null && now - restoredAtMs < this.config.policy.postNetworkGraceMs) {
          // As on the normal path: connectivity just returned, so the fresh run gets time to reconnect first.
          this.setRole(role, "RECOVERING", "NETWORK_RESTORED_SCANNER_HEALING", `recovery: the network returned ${Math.round((now - restoredAtMs) / 1000)}s ago; the fresh run gets ${Math.round(this.config.policy.postNetworkGraceMs / 1000)}s to heal itself`);
          return;
        }
        this.record({ kind: "SCANNER_RECOVERY_FAILED", role, reasonCode: "FRESH_RUN_DEGRADED", detail: `the fresh run stayed degraded (${scanner.issues.map((i) => i.code).join(", ")}); trying another run after its backoff` });
        rec.phase = "STOPPING_SCANNER";
        return;
      }
    } else rec.degradedSinceMs = null;
    if (awaitedMs > this.config.policy.scannerStartupTimeoutMs) {
      this.record({ kind: "SCANNER_RECOVERY_FAILED", role, reasonCode: "STARTUP_TIMEOUT", detail: `the fresh run did not report healthy within ${Math.round(this.config.policy.scannerStartupTimeoutMs / 60_000)} min` });
      rec.phase = "STOPPING_SCANNER";
      return;
    }
    this.setRole(role, "RECOVERING", rec.reasonCode, scanner.ours ? `recovery: the fresh run reports ${scanner.verdict}; waiting for it to be healthy` : "recovery: waiting for the fresh run's first status (start-up replay in progress)");
  }

  private async superviseScanner(scanner: ScannerHealth, census: MonitoringCensus, now: number): Promise<void> {
    const role: AlwaysOnRole = "scanner";
    if (!this.config.roles.includes(role)) return;
    const rt = this.rt[role];
    const p = this.config.policy;
    rt.externalPids = [...census.external.scanner];
    if (this.recovery !== null) {
      await this.advanceRecovery(scanner, now);
      return;
    }
    const child = this.children[role];
    if (child === null) {
      if (census.external.scanner.length > 0) {
        this.setRole(role, "CONFLICT", "EXTERNAL_SCANNER", `a scanner this supervisor does not own is running (pid ${rt.externalPids.join(",")}); it is never stopped, and no emitter is pinned to it`);
        return;
      }
      if (rt.latched) return;
      if (rt.everStarted) {
        this.requestRecovery("SCANNER_NOT_RUNNING", "the owned scanner is not running", now);
        await this.advanceRecovery(scanner, now);
        return;
      }
      if (!(await this.networkReachable(now))) {
        this.setRole(role, "BLOCKED", "NETWORK_UNAVAILABLE", "public Binance is unreachable; the scanner starts when it returns");
        return;
      }
      await this.startScanner(now);
      return;
    }
    if (rt.stopping !== null) {
      await this.advanceStop(role, now);
      return;
    }
    if (scanner.ours) rt.lastOwnStatusAtMs = now;
    // Before its first status: a start-up, with its own deadline. After it: a status that is missing or unreadable
    // (one failed read is enough for that) is judged below like a stale one — grace first, never acted on at once.
    if (scanner.verdict === "AWAITING_STATUS" && rt.lastOwnStatusAtMs === null) {
      if (rt.startedAtMs !== null && now - rt.startedAtMs > p.scannerStartupTimeoutMs) {
        this.requestRecovery("SCANNER_STARTUP_TIMEOUT", `the scanner wrote no status of its own within ${Math.round(p.scannerStartupTimeoutMs / 60_000)} min`, now);
        await this.advanceRecovery(scanner, now);
        return;
      }
      this.setRole(role, "STARTING", "AWAITING_FIRST_STATUS", "running its start-up (FAST_RECOVERY_V1 replay); waiting for its first status");
      return;
    }
    if (scanner.verdict === "STOPPED") {
      this.requestRecovery("SCANNER_RUN_STOPPED", "the owned scanner reported its run STOPPED", now);
      await this.advanceRecovery(scanner, now);
      return;
    }
    if (this.runOfAnotherEngine(scanner)) {
      // No emitter can ever be pinned to it (e.g. adopted after a code change): replace it once, emitter first.
      if (rt.latched) {
        this.setRole(role, "LATCHED", "ENGINE_FINGERPRINT_MISMATCH", `run ${scanner.runId} reports engine ${scanner.engineFingerprint ?? "(none)"}, not this profile's ${this.config.engineFingerprint}: restart Always-On after a code change, then clear the latch`);
        return;
      }
      this.requestRecovery("ENGINE_FINGERPRINT_MISMATCH", `the owned scanner's run ${scanner.runId} is not the profile's engine`, now);
      await this.advanceRecovery(scanner, now);
      return;
    }
    let issues = scanner.verdict === "AWAITING_STATUS" ? ["STATUS_MISSING"] : scanner.issues.map((i) => i.code as string);
    const quiet = scanner.universe.awaitingStreamQuiet ?? 0;
    if (scanner.verdict === "WARMING") {
      // Bounded: longer than the scanner's own per-symbol stale timeout, so a quiet symbol it failed to detach is caught too.
      rt.warmingSinceMs ??= now;
      if (now - rt.warmingSinceMs >= p.quarantinePersistentMs) {
        issues = [...((scanner.universe.quarantined ?? 0) > 0 ? ["QUARANTINE_PERSISTENT"] : []), ...(quiet > 0 ? ["AWAITING_STREAM_PERSISTENT"] : [])];
      }
    } else rt.warmingSinceMs = null;
    if (issues.length === 0) {
      rt.unhealthySinceMs = null;
      this.endStreamOutage(now, "the scanner's streams deliver again");
      this.network.restoredAtMs = null;
      this.markHealthy(
        role,
        now,
        scanner.verdict === "WARMING" ? "WARMING" : "HEALTHY",
        scanner.verdict === "WARMING"
          ? `coherent and fresh; ${scanner.universe.quarantined} symbol(s) quarantined for the current bar${quiet > 0 ? `, ${quiet} quiet symbol(s) awaiting their first update on a delivering connection` : ""}`
          : "coherent, fresh, every selected symbol live"
      );
      return;
    }
    // DEGRADED: grace, then the network gate, then one fenced recovery.
    const summary = issues.join(", ");
    if (rt.unhealthySinceMs === null) {
      rt.unhealthySinceMs = now;
      this.record({ kind: "SCANNER_DEGRADED", role, reasonCode: issues[0], detail: `scanner degraded: ${scanner.issues.map((i) => i.detail).join("; ") || summary}`, facts: { failed: scanner.universe.failed, recovering: scanner.universe.recovering, reconnects: scanner.reconnects } });
    }
    rt.healthySinceMs = null;
    const unhealthyMs = now - rt.unhealthySinceMs;
    if (unhealthyMs < p.degradedGraceMs) {
      this.setRole(role, "DEGRADED", issues[0], `degraded for ${Math.round(unhealthyMs / 1000)}s (${summary}); inside the ${Math.round(p.degradedGraceMs / 1000)}s grace period — no action`);
      return;
    }
    if (!(await this.networkReachable(now))) {
      this.setRole(role, "DEGRADED", "NETWORK_UNAVAILABLE", `degraded (${summary}) and public Binance is unreachable: waiting for the network (no restart, no attempt spent)`);
      return;
    }
    if (this.streamFailureEvidence(scanner) && (await this.streamOutageConfirmed(scanner.runId, now))) {
      this.setRole(role, "DEGRADED", "PUBLIC_STREAM_UNREACHABLE", `degraded (${summary}) and public Binance streams are unreachable while REST answers: waiting for them (no restart, no attempt spent)`);
      return;
    }
    if (this.network.restoredAtMs !== null && now - this.network.restoredAtMs < p.postNetworkGraceMs) {
      this.setRole(role, "DEGRADED", "NETWORK_RESTORED_SCANNER_HEALING", `the network returned ${Math.round((now - this.network.restoredAtMs) / 1000)}s ago; the scanner gets ${Math.round(p.postNetworkGraceMs / 1000)}s to heal itself`);
      return;
    }
    if (rt.latched) return;
    this.requestRecovery("SCANNER_DEGRADED_BEYOND_GRACE", `scanner degraded beyond its grace period (${summary})`, now);
    await this.advanceRecovery(scanner, now);
  }

  // ---------------------------------------------------------------------------
  // Emitter
  // ---------------------------------------------------------------------------

  private async superviseEmitter(emitter: EmitterHealth | null, scanner: ScannerHealth, census: MonitoringCensus, now: number): Promise<void> {
    const role: AlwaysOnRole = "emitter";
    if (!this.config.roles.includes(role)) return;
    const rt = this.rt[role];
    const p = this.config.policy;
    rt.externalPids = [...census.external.emitter];
    const child = this.children[role];
    if (this.recovery !== null) {
      if (child === null) this.setRole(role, "BLOCKED", "SCANNER_RECOVERING", "waits for the scanner recovery; it is started pinned to the fresh run once that run is healthy");
      else this.setRole(role, "STOPPING", "SCANNER_RECOVERING", "being stopped: its pinned scanner run is being replaced");
      return;
    }
    const target = this.scannerRun;
    if (child !== null) {
      if (rt.stopping !== null) {
        await this.advanceStop(role, now);
        this.setRole(role, rt.stopping?.purpose === "SUPERSEDED" ? "STOPPING" : "RECOVERING", rt.stopping?.reasonCode ?? "STOPPING", "being stopped");
        return;
      }
      if (target !== null && child.pinnedRunId !== target.runId) {
        this.record({ kind: "EMITTER_STOPPED_RUN_SUPERSEDED", role, reasonCode: "PINNED_RUN_SUPERSEDED", detail: `pinned to run ${child.pinnedRunId}, but the owned scanner now runs ${target.runId}`, facts: { pinnedRunId: child.pinnedRunId, currentRunId: target.runId } });
        await this.requestStop(role, "SUPERSEDED", "PINNED_RUN_SUPERSEDED", now);
        this.setRole(role, "STOPPING", "PINNED_RUN_SUPERSEDED", "its pinned run was superseded; stopping it before an emitter is pinned to the current run");
        return;
      }
      this.watchBacklog(emitter);
      if (emitter === null || child.pinnedRunId === null) {
        // Every emitter this supervisor starts is pinned; an unpinned record is never trusted to be healthy.
        await this.requestStop(role, "RESTART", "UNPINNED_EMITTER_RECORD", now);
        this.setRole(role, "RECOVERING", "UNPINNED_EMITTER_RECORD", "an owned emitter record names no pinned run: stopping it so a pinned one can start");
        return;
      }
      const health = emitter;
      if (health.ours) rt.lastOwnStatusAtMs = now;
      if (health.verdict === "AWAITING_STATUS" && rt.lastOwnStatusAtMs !== null) {
        // It has reported since it started: a missing or unreadable status is judged like a stale one — hung only
        // once the hung window has passed since its last own status (or the resume), never on one failed read.
        if (now - Math.max(rt.lastOwnStatusAtMs, this.resumedAtMs ?? 0) > p.emitterHungMs) {
          await this.requestStop(role, "RESTART", "STATUS_HUNG", now);
          this.setRole(role, "RECOVERING", "STATUS_HUNG", "its status has been missing or unreadable beyond the hung window: restarting it");
          return;
        }
        this.setRole(role, "DEGRADED", "STATUS_MISSING", "its status file is missing or unreadable");
        return;
      }
      if (health.verdict === "AWAITING_STATUS") {
        if (rt.startedAtMs !== null && now - rt.startedAtMs > p.emitterStartupTimeoutMs) {
          await this.requestStop(role, "RESTART", "NO_STATUS_AFTER_START", now);
          this.setRole(role, "RECOVERING", "NO_STATUS_AFTER_START", "wrote no status of its own after starting: restarting it");
          return;
        }
        this.setRole(role, "STARTING", "AWAITING_FIRST_STATUS", `pinned to run ${child.pinnedRunId}; waiting for its first status`);
        return;
      }
      if (health.verdict === "INITIALIZING") {
        // Alive (fresh status of its own), not yet healthy: re-validating every lane up to its cursor grows with
        // the run's logs, so no fixed first-status deadline applies — a status that stops refreshing is STALE.
        const init = health.initialization;
        this.setRole(role, "STARTING", "INITIALIZING", `pinned to run ${child.pinnedRunId}; re-validating its lanes before delivering (${init?.lanesBaselined ?? "?"}/${init?.lanesTotal ?? "?"})`);
        return;
      }
      if (health.verdict === "STALE") {
        const writtenMs = health.writtenAt === null ? 0 : Date.parse(health.writtenAt);
        // After a sleep the emitter gets a whole hung window to write again: its pre-sleep status proves no hang.
        if (now - Math.max(writtenMs, this.resumedAtMs ?? 0) > p.emitterHungMs) {
          await this.requestStop(role, "RESTART", "STATUS_HUNG", now);
          this.setRole(role, "RECOVERING", "STATUS_HUNG", `alive but its status is ${health.ageSeconds ?? "?"}s old: restarting it`);
          return;
        }
        this.setRole(role, "DEGRADED", "STATUS_STALE", `its status is ${health.ageSeconds ?? "?"}s old`);
        return;
      }
      if (health.verdict === "DEGRADED") {
        rt.healthySinceMs = null;
        this.setRole(role, "DEGRADED", health.issues[0]?.code ?? "DEGRADED", health.issues.map((i) => i.detail).join("; "));
        return;
      }
      this.markHealthy(
        role,
        now,
        health.verdict,
        health.verdict === "CATCHING_UP"
          ? `catching up a backlog in bounded rounds: queue ${health.queueDepth}/${health.queueCapacity}, ${health.backlogLanes ?? 0} lane(s) behind`
          : `pinned to run ${child.pinnedRunId}; ${health.lanesHealthy}/${health.lanesTracked} lanes healthy${health.laneNote === "HISTORICAL_LANES_BEYOND_CURRENT_SELECTION" ? " (includes historical lanes beyond the current selection — expected after removals)" : ""}`
      );
      return;
    }
    if (census.external.emitter.length > 0) {
      this.setRole(role, "CONFLICT", "EXTERNAL_EMITTER", `an emitter this supervisor does not own is running (pid ${rt.externalPids.join(",")}); it is never stopped and no second emitter is started`);
      return;
    }
    if (rt.latched) return;
    if (target === null) {
      this.setRole(role, "BLOCKED", "WAITING_FOR_SCANNER_RUN", "waits for the owned scanner to identify its run");
      return;
    }
    if (!(scanner.ours && (scanner.verdict === "HEALTHY" || scanner.verdict === "WARMING"))) {
      this.setRole(role, "BLOCKED", "WAITING_FOR_SCANNER_HEALTH", `waits for run ${target.runId} to report healthy before an emitter is pinned to it`);
      return;
    }
    if (!target.bindable) {
      this.setRole(role, "BLOCKED", "RUN_NOT_BINDABLE", `run ${target.runId} has no manifest yet or is not the profile's engine`);
      return;
    }
    if (this.dataStore === "UNAVAILABLE") {
      this.setRole(role, "BLOCKED", "DATA_STORE_UNAVAILABLE", "the database is unavailable; a COMMIT emitter would refuse to start");
      return;
    }
    if (!this.gateOpen(role, now)) {
      this.setRole(role, "BACKOFF", "RESTART_BACKOFF", `the next start is allowed at ${new Date(rt.nextAttemptAtMs).toISOString()}`);
      return;
    }
    const keys = this.genericKeys(role);
    if (keys === null) return;
    const runId = target.runId;
    const started = await this.startRole(
      role,
      now,
      (stopFile) =>
        emitterSpawnPlan(this.config.repoRoot, this.a.env, keys, {
          profileName: this.config.profileName,
          runId,
          engineFingerprint: this.config.engineFingerprint,
          queueCapacity: this.config.emitterQueueCapacity,
          activateAtEof: this.config.emitterActivateAtEof,
          stopFile: stopFile as string,
        }),
      { pinnedRunId: runId, engineFingerprint: this.config.engineFingerprint, cooperative: true }
    );
    if (started === "STARTED") this.record({ kind: "EMITTER_STARTED_ON_RUN", role, reasonCode: "PINNED", detail: `emitter (COMMIT, follow) pinned to run ${runId}`, facts: { runId } });
  }

  private watchBacklog(emitter: EmitterHealth | null): void {
    if (emitter === null || !emitter.ours) return;
    if (emitter.largeBacklog && !this.largeBacklog) {
      this.largeBacklog = true;
      this.record({
        kind: "LARGE_BACKLOG_DETECTED",
        role: "emitter",
        reasonCode: "BOUNDED_CATCH_UP",
        detail: `queue ${emitter.queueDepth}/${emitter.queueCapacity} (max ${emitter.maxQueueDepth}), ${emitter.backlogLanes ?? 0} lane(s) behind their logs: draining in bounded rounds`,
        facts: { queueDepth: emitter.queueDepth, queueCapacity: emitter.queueCapacity, backlogLanes: emitter.backlogLanes },
      });
    } else if (!emitter.largeBacklog && this.largeBacklog && emitter.queueDepth === 0) {
      this.largeBacklog = false;
      this.record({ kind: "BACKLOG_DRAINED", role: "emitter", reasonCode: "QUEUE_EMPTY", detail: `backlog drained; queue 0/${emitter.queueCapacity}, max ${emitter.maxQueueDepth}`, facts: { maxQueueDepth: emitter.maxQueueDepth, created: emitter.created, ledgerDuplicates: emitter.ledgerDuplicates } });
    }
  }

  // ---------------------------------------------------------------------------
  // Planner
  // ---------------------------------------------------------------------------

  private async supervisePlanner(planner: PlannerHealth, backendOk: boolean, census: MonitoringCensus, now: number): Promise<void> {
    const role: AlwaysOnRole = "planner";
    if (!this.config.roles.includes(role)) return;
    const rt = this.rt[role];
    const p = this.config.policy;
    rt.externalPids = [...census.external.planner];
    const child = this.children[role];
    if (child !== null) {
      if (rt.stopping !== null) {
        await this.advanceStop(role, now);
        this.setRole(role, "RECOVERING", rt.stopping?.reasonCode ?? "STOPPING", "being stopped for a restart");
        return;
      }
      if (!backendOk || planner.verdict === "UNKNOWN") {
        this.setRole(role, "DEGRADED", "HEALTH_UNREADABLE", "running, but its health cannot be read while the backend is unavailable; it is left running");
        return;
      }
      // Only a heartbeat that says OFF/STALE (not UNREADABLE: Redis trouble) is evidence of a dead consumer.
      const consumerDead = planner.workerState === "OFF" || planner.workerState === "STALE";
      if (consumerDead) {
        if (rt.startedAtMs !== null && now - rt.startedAtMs < p.plannerGraceMs) {
          this.setRole(role, "STARTING", "AWAITING_HEARTBEAT", "started; waiting for its heartbeat");
          return;
        }
        rt.unhealthySinceMs ??= now;
        if (now - rt.unhealthySinceMs >= p.plannerGraceMs) {
          await this.requestStop(role, "RESTART", "HEARTBEAT_MISSING_BEYOND_GRACE", now);
          this.setRole(role, "RECOVERING", "HEARTBEAT_MISSING_BEYOND_GRACE", "alive but its heartbeat reads " + planner.workerState + " beyond its grace period: restarting it");
          return;
        }
        this.setRole(role, "DEGRADED", "HEARTBEAT_MISSING", `its heartbeat reads ${planner.workerState}`);
        return;
      }
      rt.unhealthySinceMs = null;
      if (planner.verdict === "DEGRADED") {
        rt.healthySinceMs = null;
        this.setRole(role, "DEGRADED", planner.issues[0]?.code ?? "DEGRADED", planner.issues.map((i) => i.detail).join("; "));
        return;
      }
      this.markHealthy(role, now, "HEALTHY", `ready; pending ${planner.pending ?? "?"}; failure delta 0 (baseline: failed jobs ${this.plannerBaseline?.jobsFailed ?? "?"}, ERROR plans ${this.plannerBaseline?.plansError ?? "?"})`);
      return;
    }
    if (census.external.planner.length > 0) {
      this.setRole(role, "CONFLICT", "EXTERNAL_PLANNER", `a planner this supervisor does not own is running (pid ${rt.externalPids.join(",")}); no second consumer is started`);
      return;
    }
    if (rt.latched) return;
    if (!backendOk) {
      this.setRole(role, "BLOCKED", "BACKEND_NOT_HEALTHY", "waits for a healthy backend before it is (re)started");
      return;
    }
    if (this.dataStore === "UNAVAILABLE") {
      this.setRole(role, "BLOCKED", "DATA_STORE_UNAVAILABLE", "the database is unavailable; the planner would fail to start");
      return;
    }
    if (!this.gateOpen(role, now)) {
      this.setRole(role, "BACKOFF", "RESTART_BACKOFF", `the next start is allowed at ${new Date(rt.nextAttemptAtMs).toISOString()}`);
      return;
    }
    const keys = this.genericKeys(role);
    if (keys === null) return;
    await this.startRole(role, now, () => plannerSpawnPlan(this.config.repoRoot, this.a.env, keys), { pinnedRunId: null, engineFingerprint: null, cooperative: false });
  }

  // ---------------------------------------------------------------------------
  // Shutdown and requests
  // ---------------------------------------------------------------------------

  private async advanceShutdown(now: number): Promise<void> {
    const shutdown = this.shutdown as { reasonCode: string; requestedAtMs: number; done: boolean };
    for (const role of STOP_ORDER) {
      if (this.children[role] === null) {
        if (this.config.roles.includes(role)) this.setRole(role, "OFF", "STOPPED", "stopped by the graceful stop", false);
        continue;
      }
      const rt = this.rt[role];
      if (rt.stopping === null) await this.requestStop(role, "SHUTDOWN", shutdown.reasonCode, now);
      else await this.advanceStop(role, now);
      if (this.fenced) return;
      if (this.children[role] !== null) {
        this.setRole(role, "STOPPING", shutdown.reasonCode, rt.stopping?.cooperative ? "cooperative stop requested; waiting for it to exit" : "being stopped", false);
        this.state = "STOPPING";
        this.reasonCode = shutdown.reasonCode;
        this.reason = `stopping ${ALWAYS_ON_ROLE_LABELS[role]}`;
        return;
      }
      this.setRole(role, "OFF", "STOPPED", "stopped by the graceful stop", false);
    }
    shutdown.done = true;
    this.state = "STOPPED";
    this.reasonCode = shutdown.reasonCode;
    this.reason = "every owned role was stopped; nothing is owned";
    if (this.fenceState() === "CURRENT") this.writeOwnership();
    this.record({ kind: "SUPERVISOR_STOPPED", reasonCode: shutdown.reasonCode, detail: `graceful stop finished in ${Math.round((now - shutdown.requestedAtMs) / 1000)}s` });
  }

  private consumeRequests(now: number): void {
    const stopText = this.a.fs.readText(this.a.paths.stopRequest);
    if (stopText !== null) {
      const removed = this.removeRequest(this.a.paths.stopRequest);
      const target = requestGeneration(stopText);
      // Honoured even when its file could not be removed: a shutdown is requested once (idempotent).
      if (target === null || target === this.generation) this.requestShutdown("OPERATOR_STOP_REQUEST");
      else if (removed) this.a.log(`a stop request for generation ${target} was ignored (this is generation ${this.generation})`);
    }
    const clearText = this.a.fs.readText(this.a.paths.clearLatchRequest);
    // Applied once, and only after its file is gone: re-applying it every tick would defeat latching.
    if (clearText !== null && this.removeRequest(this.a.paths.clearLatchRequest)) {
      const roleNamed = requestRole(clearText);
      for (const role of ALWAYS_ON_ROLES) {
        const rt = this.rt[role];
        if ((roleNamed === null || roleNamed === role) && (rt.latched || rt.attempts > 0)) {
          const wasLatched = rt.latched;
          rt.latched = false;
          rt.attempts = 0;
          rt.nextAttemptAtMs = now;
          if (wasLatched) this.setRole(role, "OFF", "LATCH_CLEARED", "latch cleared by the operator; supervision resumes");
          this.record({ kind: "LATCH_CLEARED", role, reasonCode: "OPERATOR_REQUEST", detail: `${ALWAYS_ON_ROLE_LABELS[role]}: attempts reset${wasLatched ? " and latch cleared" : ""}` });
        }
      }
    }
  }

  private removeRequest(file: string): boolean {
    try {
      this.a.fs.remove(file);
      return true;
    } catch (error) {
      this.a.log(`request file not removed (${errorCode(error)}); retried on the next tick`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // States and the status artifact
  // ---------------------------------------------------------------------------

  private markHealthy(role: AlwaysOnRole, now: number, reasonCode: string, reason: string): void {
    const rt = this.rt[role];
    rt.healthySinceMs ??= now;
    if (rt.attempts > 0 && now - rt.healthySinceMs >= this.config.policy.healthyForgivenessMs) {
      rt.attempts = 0;
      rt.nextAttemptAtMs = 0;
    }
    this.setRole(role, "RUNNING", reasonCode, reason);
  }

  /** Sets a role's state, journaling meaningful transitions only (never one line per poll). */
  private setRole(role: AlwaysOnRole, state: AlwaysOnRoleState, reasonCode: string, reason: string, journal = true): void {
    const rt = this.rt[role];
    const previous = rt.state;
    rt.state = state;
    rt.reasonCode = reasonCode;
    rt.reason = reason;
    // Only an UNINTERRUPTED healthy streak forgives attempts: anything else breaks it.
    if (state !== "RUNNING") rt.healthySinceMs = null;
    const key = `${state}:${state === "RUNNING" ? "" : reasonCode}`;
    if (!journal || key === rt.journaled) return;
    const wasConflict = rt.journaled.startsWith("CONFLICT:");
    rt.journaled = key;
    if (state === "CONFLICT") this.record({ kind: "ROLE_CONFLICT", role, reasonCode, detail: reason, facts: { externalPids: rt.externalPids.join(",") } });
    else if (wasConflict) this.record({ kind: "ROLE_CONFLICT_CLEARED", role, reasonCode, detail: `${ALWAYS_ON_ROLE_LABELS[role]}: the external process is gone` });
    if (state === "BLOCKED") this.record({ kind: "ROLE_BLOCKED", role, reasonCode, detail: reason });
    else if (state === "BACKOFF") this.record({ kind: "BACKOFF_ENTERED", role, reasonCode, detail: reason, facts: { attempt: rt.attempts + 1, until: new Date(rt.nextAttemptAtMs).toISOString() } });
    else if (state === "DEGRADED" && role !== "scanner") this.record({ kind: "ROLE_DEGRADED", role, reasonCode, detail: reason });
    else if (state === "RUNNING" && previous !== "RUNNING") this.record({ kind: "ROLE_HEALTHY", role, reasonCode, detail: reason });
  }

  private computeOverallState(now: number): void {
    const owned = this.config.roles;
    const states = owned.map((role) => this.rt[role].state);
    const previous = this.state;
    let next: AlwaysOnSupervisorState;
    let code: string;
    let reason: string;
    const first = (pred: (s: AlwaysOnRoleState) => boolean) => owned.find((role) => pred(this.rt[role].state));
    const describe = (role: AlwaysOnRole) => `${ALWAYS_ON_ROLE_LABELS[role]}: ${this.rt[role].reason}`;
    if (owned.some((role) => this.rt[role].latched)) {
      const role = owned.find((r) => this.rt[r].latched) as AlwaysOnRole;
      next = "LATCHED";
      code = `${role.toUpperCase()}_LATCHED`;
      reason = describe(role);
    } else if (this.recovery !== null || states.some((s) => s === "RECOVERING" || s === "STOPPING")) {
      const role = first((s) => s === "RECOVERING" || s === "STOPPING") ?? "scanner";
      next = "RECOVERING";
      code = this.recovery?.reasonCode ?? `${role.toUpperCase()}_${this.rt[role].reasonCode}`;
      reason = this.recovery !== null ? `scanner recovery (${this.recovery.phase.toLowerCase().replace(/_/g, " ")}): ${this.recovery.reason}` : describe(role);
    } else if (states.some((s) => s === "BACKOFF")) {
      const role = first((s) => s === "BACKOFF") as AlwaysOnRole;
      next = "BACKOFF";
      code = `${role.toUpperCase()}_BACKOFF`;
      reason = describe(role);
    } else if (states.every((s) => s === "RUNNING")) {
      next = "RUNNING";
      code = "ALL_ROLES_HEALTHY";
      reason = "every owned role is healthy";
      this.lastEndToEndHealthyAtMs = now;
    } else if (this.lastEndToEndHealthyAtMs === null && states.every((s) => s === "RUNNING" || s === "STARTING" || s === "BLOCKED" || s === "OFF")) {
      const role = first((s) => s !== "RUNNING") as AlwaysOnRole;
      next = "STARTING";
      code = `${role.toUpperCase()}_${this.rt[role].reasonCode}`;
      reason = describe(role);
    } else {
      const role = first((s) => s !== "RUNNING") as AlwaysOnRole;
      next = "DEGRADED";
      code = `${role.toUpperCase()}_${this.rt[role].reasonCode}`;
      reason = describe(role);
    }
    this.state = next;
    this.reasonCode = code;
    this.reason = reason;
    if (next === previous) return;
    if (next === "RUNNING") this.record({ kind: "SUPERVISOR_RETURNED_HEALTHY", reasonCode: previous === "STARTING" ? "FIRST_HEALTHY" : "RETURNED_HEALTHY", detail: "every owned role is healthy" });
    else if (next === "DEGRADED" && previous !== "STARTING") this.record({ kind: "SUPERVISOR_DEGRADED", reasonCode: code, detail: reason });
    else if (next === "BACKOFF") this.record({ kind: "SUPERVISOR_ENTERED_BACKOFF", reasonCode: code, detail: reason });
    else if (next === "LATCHED") this.record({ kind: "SUPERVISOR_LATCHED", reasonCode: code, detail: reason });
  }

  private record(event: IncidentEvent): void {
    this.journal.record(event);
  }

  private roleView(role: AlwaysOnRole): AlwaysOnRoleView {
    const rt = this.rt[role];
    const child = this.children[role];
    const census = this.latest.census;
    return {
      role,
      label: ALWAYS_ON_ROLE_LABELS[role],
      state: rt.state,
      reasonCode: rt.reasonCode,
      reason: rt.reason,
      owned:
        child === null
          ? null
          : { rootPid: child.pid, runtimePids: census?.owned[role] ?? [], startedAt: child.spawnedAt, spawnedByGeneration: child.spawnedByGeneration, commandIdentity: child.commandIdentity },
      restarts: rt.restarts,
      attempts: rt.attempts,
      nextAttemptAt: rt.everStarted && rt.nextAttemptAtMs > this.a.now() ? new Date(rt.nextAttemptAtMs).toISOString() : null,
      latched: rt.latched,
      lastExit: rt.lastExit === null ? null : { at: new Date(rt.lastExit.atMs).toISOString(), code: rt.lastExit.code },
      externalPids: rt.externalPids,
    };
  }

  status(): AlwaysOnStatusDto {
    const now = this.a.now();
    const backoffRole = ALWAYS_ON_ROLES.find((role) => this.rt[role].state === "BACKOFF");
    return {
      schema: ALWAYS_ON_STATUS_SCHEMA,
      notice: [...ALWAYS_ON_NOTICE],
      authority: "NONE",
      nativeExecutionEnabled: false,
      accountExecution: "NONE",
      state: this.state,
      reasonCode: this.reasonCode,
      reason: this.reason,
      generation: this.generation,
      supervisor: { pid: this.a.selfPid, startedAt: new Date(this.startedAtMs).toISOString(), instancePort: this.config.instancePort, profile: this.config.profileName, roles: [...this.config.roles] },
      startedAt: new Date(this.startedAtMs).toISOString(),
      writtenAt: new Date(now).toISOString(),
      lastEndToEndHealthyAt: this.lastEndToEndHealthyAtMs === null ? null : new Date(this.lastEndToEndHealthyAtMs).toISOString(),
      lastRecovery: this.lastRecovery,
      backoff: backoffRole === undefined ? null : { role: backoffRole, attempt: this.rt[backoffRole].attempts + 1, until: new Date(this.rt[backoffRole].nextAttemptAtMs).toISOString() },
      dataStore: this.dataStore,
      network: {
        reachable: this.network.reachable,
        lastProbeAt: this.network.lastProbeAtMs === null ? null : new Date(this.network.lastProbeAtMs).toISOString(),
        unavailableSince: this.network.unavailableSinceMs === null ? null : new Date(this.network.unavailableSinceMs).toISOString(),
        stream: {
          unreachableSince: this.stream.unavailableSinceMs === null ? null : new Date(this.stream.unavailableSinceMs).toISOString(),
          lastProbeAt: this.stream.lastProbe === null ? null : new Date(this.stream.lastProbe.atMs).toISOString(),
          lastProbeOutcome: this.stream.lastProbe?.outcome ?? null,
        },
      },
      roles: {
        backend: { ...this.roleView("backend"), healthOk: this.latest.backendOk },
        scanner: {
          ...this.roleView("scanner"),
          runId: this.scannerRun?.runId ?? null,
          engineFingerprint: this.scannerRun?.engineFingerprint ?? null,
          runBindable: this.scannerRun?.bindable ?? false,
          health: this.latest.scanner,
        },
        emitter: { ...this.roleView("emitter"), pinnedRunId: this.children.emitter?.pinnedRunId ?? null, health: this.latest.emitter },
        planner: { ...this.roleView("planner"), baseline: this.plannerBaseline, health: this.latest.planner },
      },
      external: { soakMonitorPids: this.latest.census?.soakMonitors ?? [], otherSupervisorPids: this.latest.census?.otherSupervisors ?? [] },
      counters: { ticks: this.counters.ticks, scannerRecoveries: this.counters.scannerRecoveries, restarts: { ...this.counters.restarts } },
      recentIncidents: this.journal.latest(10),
    };
  }

  private writeStatus(): void {
    // The status artifact belongs to the generation on disk: a stale supervisor never overwrites a newer one's.
    if (this.fenced || this.fenceState() === "SUPERSEDED") return;
    try {
      this.a.fs.writeTextAtomic(this.a.paths.status, `${JSON.stringify(this.status(), null, 2)}\n`);
    } catch (error) {
      this.a.log(`status file not written (${error instanceof Error ? error.name : "unknown"}); supervision continues`);
    }
  }
}

function parseRequest(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { schema?: unknown }).schema === ALWAYS_ON_REQUEST_SCHEMA ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The generation a stop request names (null: any / unparseable — a stop request is honoured by the current generation). */
function requestGeneration(text: string): number | null {
  const parsed = parseRequest(text);
  return parsed !== null && Number.isSafeInteger(parsed.generation) ? (parsed.generation as number) : null;
}

function requestRole(text: string): AlwaysOnRole | null {
  const parsed = parseRequest(text);
  return parsed !== null && (ALWAYS_ON_ROLES as readonly unknown[]).includes(parsed.role) ? (parsed.role as AlwaysOnRole) : null;
}

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  GENERIC_BACKEND_NONWATCH_ROLE,
  ROLE_CONTRACTS,
  classifyEntrypoint,
  describeEnvFileFailure,
  envFilePathFor,
  parseEnvFileStrict,
  roleLogPath,
  sanitizedChildEnv,
  type DualRole,
  type DualSpawnPlan,
  type EnvKeyNameReader,
  type ObservedListener,
  type TopologyStatus,
} from "./dual-account-topology";
import { withMutationLock, type MutationLockAdapters } from "./mutation-lock";
import { observed, verifyOwnership, type Observation, type ObservedProcessNode, type OwnershipVerdict, type ProcessProbe } from "./runtime-launcher";
import { executeFencedStart, executeFencedStop, type ProbeOutcome } from "./worker-supervision";

/**
 * The OFFICIAL NON-WATCH generic backend: explicit start and stop of the BUILT
 * backend (`node dist/src/server.js`, what the package `start` script runs).
 *
 * ## Why it exists
 *
 * Start SAFE runs the generic backend under `tsx watch src/server.ts`. A
 * watcher relaunches its child on a watched-file event, with no crash at all,
 * so a live backend can silently restart under an operator. The built backend
 * has no watcher: it runs until it exits.
 *
 * ## What it deliberately does NOT do
 *
 *  - It does NOT change Start SAFE, Stop Runtime or the six-role topology. Start
 *    SAFE still starts the watch backend; while a non-watch backend holds :4000,
 *    Start SAFE sees that port taken by a backend it does not own and refuses,
 *    exactly as it does for any external backend today.
 *  - It does NOT build. Missing or stale build output refuses the start with the
 *    build command to run. It never runs `pnpm install` or `prisma generate`.
 *  - It does NOT restart. If the non-watch backend crashes it stays down, and the
 *    status line says so: a hidden restart would mask a real backend crash.
 *  - It never kills what it cannot prove it started: ownership (recorded root,
 *    creation time, this repository) is proved by the reviewed fenced stop, and
 *    :4000 is attributed to a runtime only by process ancestry, never by "some
 *    node.exe exists".
 *
 * It holds its own state file (atomic temp + rename), so Start SAFE, its
 * rollback and Stop Runtime can never erase, block on or stop it, and it uses
 * the CLI's own primitives (gate printer, probes, mutation lock, durable-log
 * spawner) handed in by reference.
 */

export const NONWATCH_ROLE = GENERIC_BACKEND_NONWATCH_ROLE;
const NONWATCH_ENTRYPOINT = ROLE_CONTRACTS[NONWATCH_ROLE].entrypoint;
const WATCH_ENTRYPOINT = ROLE_CONTRACTS["generic-backend"].entrypoint;
export const GENERIC_BACKEND_PORT = 4000;

/** Seconds a fresh start waits to SEE its listener before reporting (it never restarts anything). */
export const NONWATCH_LISTEN_WAIT_MS = 30_000;

/** The build commands an operator runs, in order; the launcher never runs them. */
export const NONWATCH_BUILD_INSTRUCTION =
  "pnpm --filter @trading-alert-dashboard/shared build && pnpm --filter @trading-alert-dashboard/backend build";

// ---------------------------------------------------------------------------
// Spawn plan
// ---------------------------------------------------------------------------

export const nonWatchServerPath = (repoRoot: string) => path.join(repoRoot, "apps", "backend", "dist", "src", "server.js");

/**
 * `cmd /d /s /c node <repo>\apps\backend\dist\src\server.js`, from apps/backend,
 * with the generic env file authoritative (the same sanitiser every role uses).
 * The absolute path puts this repository on the root's command line, which is
 * what later lets ownership be PROVED. No pnpm, no watcher, no build.
 */
export function nonWatchBackendSpawnPlan(repoRoot: string, env: NodeJS.ProcessEnv = process.env, readKeyNames?: EnvKeyNameReader): DualSpawnPlan {
  return {
    command: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", "node", nonWatchServerPath(repoRoot)],
    options: {
      cwd: path.join(repoRoot, "apps", "backend"),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: sanitizedChildEnv(NONWATCH_ROLE, env, readKeyNames),
    },
  };
}

// ---------------------------------------------------------------------------
// Build prerequisite
// ---------------------------------------------------------------------------

export interface BuildFileSystem {
  /** Every file under `dir`, recursively, as absolute paths; [] when the directory does not exist. */
  listFiles(dir: string): string[];
  /** The file's mtime, or null when it does not exist. */
  mtimeMs(file: string): number | null;
}

export const realBuildFileSystem: BuildFileSystem = {
  listFiles(dir) {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (at: string) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(full);
      }
    };
    walk(dir);
    return out;
  },
  mtimeMs(file) {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  },
};

export type BuildVerdict = { readonly ok: true } | { readonly ok: false; readonly reasons: string[] };

/**
 * Whether the BUILT shared and backend output corresponds to the current source.
 *
 * Each TypeScript source must have its compiled `.js` and that output must not
 * be older than the source (tsc rewrites every output on each build). Shared is
 * checked through its CommonJS output, which is what the built backend loads.
 * Pure over the file-system adapter; it never builds anything.
 */
export function assessNonWatchBuild(repoRoot: string, fs: BuildFileSystem = realBuildFileSystem): BuildVerdict {
  const reasons: string[] = [];
  const trees = [
    { label: "backend", src: path.join(repoRoot, "apps", "backend", "src"), out: path.join(repoRoot, "apps", "backend", "dist", "src") },
    { label: "shared", src: path.join(repoRoot, "packages", "shared", "src"), out: path.join(repoRoot, "packages", "shared", "dist", "cjs") },
  ];
  for (const tree of trees) {
    const sources = fs.listFiles(tree.src).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
    if (sources.length === 0) {
      reasons.push(`${tree.label}: no source files were found under ${tree.src}`);
      continue;
    }
    let missing = 0;
    let stale = 0;
    let example: string | null = null;
    for (const source of sources) {
      const output = path.join(tree.out, path.relative(tree.src, source)).replace(/\.ts$/, ".js");
      const outMs = fs.mtimeMs(output);
      const srcMs = fs.mtimeMs(source);
      if (outMs === null) {
        missing += 1;
        example ??= path.relative(repoRoot, output);
      } else if (srcMs === null || outMs < srcMs) {
        stale += 1;
        example ??= path.relative(repoRoot, source);
      }
    }
    if (missing > 0) reasons.push(`${tree.label}: ${missing} built file(s) are MISSING (e.g. ${example})`);
    else if (stale > 0) reasons.push(`${tree.label}: ${stale} source file(s) are NEWER than their build (e.g. ${example})`);
  }
  if (fs.mtimeMs(nonWatchServerPath(repoRoot)) === null) reasons.push("backend: dist/src/server.js does not exist");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons: [...new Set(reasons)] };
}

// ---------------------------------------------------------------------------
// What holds :4000 (pure)
// ---------------------------------------------------------------------------

export type GenericBackendMode = "RUNNING_NON_WATCH" | "RUNNING_WATCH" | "OFF" | "UNPROVEN" | "CONFLICT";

export interface GenericBackendView {
  readonly mode: GenericBackendMode;
  readonly detail: string;
}

export interface GenericBackendFacts {
  /** Every node.exe / cmd.exe with its parent; the only source of ancestry. */
  readonly tree: readonly ObservedProcessNode[];
  /** Listeners observed on :4000. */
  readonly listeners: readonly ObservedListener[];
  /** A TCP connect to :4000 succeeded: catches a holder the listener query could not see. */
  readonly portOpen: boolean;
  /** Our recorded root, when it is PROVABLY ours and alive; otherwise null. */
  readonly ownedRootPid: number | null;
  /** The six-role launcher owns its (watch) generic backend. */
  readonly watchLauncherOwned: boolean;
}

const isRuntime = (node: ObservedProcessNode, entrypoint: string) => node.executable.toLowerCase() === "node.exe" && classifyEntrypoint(node.commandLine) === entrypoint;

/** True only when the chain of parents from `pid` reaches `rootPid` inside the observed set. */
export function descendsFrom(tree: readonly ObservedProcessNode[], pid: number, rootPid: number): boolean {
  const byPid = new Map(tree.map((node) => [node.pid, node]));
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current !== undefined && !seen.has(current.pid)) {
    if (current.pid === rootPid) return true;
    seen.add(current.pid);
    current = byPid.get(current.parentPid);
  }
  return false;
}

/**
 * The generic backend's mode, from what the machine shows. Ownership comes
 * from ancestry to the PROVED root only; a recognised command line alone never
 * makes a process ours.
 */
export function judgeGenericBackend(facts: GenericBackendFacts): GenericBackendView {
  const nonWatch = facts.tree.filter((node) => isRuntime(node, NONWATCH_ENTRYPOINT));
  const watch = facts.tree.filter((node) => isRuntime(node, WATCH_ENTRYPOINT));
  const ours = facts.ownedRootPid === null ? [] : nonWatch.filter((node) => descendsFrom(facts.tree, node.pid, facts.ownedRootPid!));
  const holders = [...new Set(facts.listeners.filter((l) => l.port === GENERIC_BACKEND_PORT).map((l) => l.pid))];

  if (holders.length > 1) return { mode: "CONFLICT", detail: `${holders.length} different processes listen on :${GENERIC_BACKEND_PORT}` };
  if (nonWatch.length > 1) return { mode: "CONFLICT", detail: `${nonWatch.length} non-watch backend runtimes are running` };
  if (nonWatch.length > 0 && watch.length > 0) return { mode: "CONFLICT", detail: "a non-watch AND a watch backend runtime are both running" };

  if (holders.length === 1) {
    const holder = facts.tree.find((node) => node.pid === holders[0]);
    if (holder !== undefined && isRuntime(holder, NONWATCH_ENTRYPOINT)) {
      return ours.some((node) => node.pid === holder.pid)
        ? { mode: "RUNNING_NON_WATCH", detail: "launcher-owned" }
        : { mode: "UNPROVEN", detail: `a non-watch backend this launcher did not start (or cannot prove) holds :${GENERIC_BACKEND_PORT}` };
    }
    if (holder !== undefined && isRuntime(holder, WATCH_ENTRYPOINT)) {
      return { mode: "RUNNING_WATCH", detail: facts.watchLauncherOwned ? "Start SAFE (launcher-owned, tsx watch)" : "external tsx watch tree, not launcher-owned" };
    }
    return { mode: "CONFLICT", detail: `:${GENERIC_BACKEND_PORT} is held by a process that is not a recognised generic backend` };
  }
  if (facts.portOpen) return { mode: "UNPROVEN", detail: `:${GENERIC_BACKEND_PORT} accepts connections but its owner could not be observed` };
  if (ours.length > 0 || facts.ownedRootPid !== null) return { mode: "UNPROVEN", detail: "the launcher-owned non-watch tree is alive but not listening (starting, or failing)" };
  if (nonWatch.length > 0) return { mode: "UNPROVEN", detail: "a non-watch backend runtime this launcher did not start is running without a listener" };
  if (watch.length > 0) return { mode: "UNPROVEN", detail: "a watch backend runtime is running without a listener" };
  return { mode: "OFF", detail: "nothing holds :4000" };
}

export const GENERIC_BACKEND_MODE_LABEL: Readonly<Record<GenericBackendMode, string>> = Object.freeze({
  RUNNING_NON_WATCH: "RUNNING — NON-WATCH",
  RUNNING_WATCH: "RUNNING — WATCH",
  OFF: "OFF",
  UNPROVEN: "UNPROVEN",
  CONFLICT: "CONFLICT",
});

export type NonWatchStartDecision =
  | { readonly act: "START" }
  | { readonly act: "ALREADY_RUNNING"; readonly reason: string }
  | { readonly act: "REFUSE"; readonly reason: string };

/** Start only on a provably empty :4000; report an already-running owned one; refuse everything else. */
export function decideNonWatchStart(view: GenericBackendView): NonWatchStartDecision {
  switch (view.mode) {
    case "OFF":
      return { act: "START" };
    case "RUNNING_NON_WATCH":
      return { act: "ALREADY_RUNNING", reason: "the launcher-owned non-watch backend already holds :4000; nothing was started" };
    case "RUNNING_WATCH":
      return {
        act: "REFUSE",
        reason: `a WATCH backend holds :4000 (${view.detail}). The non-watch backend never replaces it: stop it first (Stop Runtime for a Start SAFE runtime), then start non-watch.`,
      };
    default:
      return { act: "REFUSE", reason: `${GENERIC_BACKEND_MODE_LABEL[view.mode]}: ${view.detail}. Nothing is started over a backend whose owner is not proved.` };
  }
}

// ---------------------------------------------------------------------------
// The launcher actions
// ---------------------------------------------------------------------------

export interface NonWatchBackendLauncherAdapters {
  readonly repoRoot: string;
  readonly statePath: string;
  readonly observeProcessTree: () => Observation<ObservedProcessNode[]>;
  readonly observeListeners: () => ObservedListener[];
  readonly portOpen: (port: number) => Promise<boolean>;
  readonly probeProcesses: (pids: number[]) => Observation<Map<number, ProcessProbe>>;
  /** taskkill /PID /T on ONE root; reached only through the fenced stop. */
  readonly terminate: (pid: number) => boolean;
  readonly spawnRole: (role: DualRole, plan: DualSpawnPlan) => number | null;
  /** The CLI's ONE transition-gate printer. */
  readonly gateAllows: (roles: readonly DualRole[]) => boolean;
  readonly lockAdapters: () => MutationLockAdapters;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<unknown>;
  readonly buildFileSystem?: BuildFileSystem;
  readonly env?: NodeJS.ProcessEnv;
}

interface NonWatchRecord {
  role: typeof NONWATCH_ROLE;
  pid: number;
  startedAtMs: number;
  envAlias: "generic";
  port: typeof GENERIC_BACKEND_PORT;
}

interface NonWatchState {
  repoRoot: string;
  startedAtMs: number;
  processes: NonWatchRecord[];
}

export interface NonWatchBackendLauncher {
  start(status: TopologyStatus): Promise<void>;
  stop(status: TopologyStatus): Promise<void>;
  statusLines(status: TopologyStatus): Promise<string[]>;
}

export function createNonWatchBackendLauncher(adapters: NonWatchBackendLauncherAdapters): NonWatchBackendLauncher {
  const role = NONWATCH_ROLE;
  const label = ROLE_CONTRACTS[role].label;
  const say = (line: string) => adapters.log(line);
  const env = adapters.env ?? process.env;

  const readState = (): NonWatchState | null => {
    try {
      const parsed = JSON.parse(readFileSync(adapters.statePath, "utf8")) as NonWatchState;
      if (!Array.isArray(parsed.processes)) return null;
      // Only this role may ever be recorded here.
      return { ...parsed, processes: parsed.processes.filter((entry) => entry.role === role) };
    } catch {
      return null;
    }
  };

  /** The ONLY writer of this role's state file. Atomic: write a temp, then rename. */
  const writeState = (record: NonWatchRecord | null): void => {
    mkdirSync(path.dirname(adapters.statePath), { recursive: true });
    const temporary = `${adapters.statePath}.tmp`;
    const state: NonWatchState = { repoRoot: adapters.repoRoot, startedAtMs: Date.now(), processes: record === null ? [] : [record] };
    writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
    renameSync(temporary, adapters.statePath);
  };

  const recordOf = (pid: number, startedAtMs: number): NonWatchRecord => ({ role, pid, startedAtMs, envAlias: "generic", port: GENERIC_BACKEND_PORT });

  const probe = (pid: number): ProbeOutcome => {
    const probed = adapters.probeProcesses([pid]);
    return probed.ok ? { observed: true, process: probed.value.get(pid) ?? null } : { observed: false };
  };

  /** The durable record and a FRESH ownership verdict for it (GONE / PID_REUSED / NOT_THIS_REPO are never "ours"). */
  const ownership = (state: NonWatchState | null): Observation<{ durable: NonWatchRecord | null; verdict: OwnershipVerdict | null }> => {
    const durable = state?.processes[0] ?? null;
    if (durable === null) return observed({ durable: null, verdict: null });
    const probed = adapters.probeProcesses([durable.pid]);
    if (!probed.ok) return probed;
    return observed({ durable, verdict: verifyOwnership(durable, probed.value.get(durable.pid) ?? null, state!.repoRoot) });
  };

  const observe = async (status: TopologyStatus): Promise<Observation<{ view: GenericBackendView; durable: NonWatchRecord | null; verdict: OwnershipVerdict | null }>> => {
    const state = readState();
    const owned = ownership(state);
    if (!owned.ok) return owned;
    const tree = adapters.observeProcessTree();
    if (!tree.ok) return tree;
    const { durable, verdict } = owned.value;
    const view = judgeGenericBackend({
      tree: tree.value,
      listeners: adapters.observeListeners().filter((l) => l.port === GENERIC_BACKEND_PORT),
      portOpen: await adapters.portOpen(GENERIC_BACKEND_PORT),
      ownedRootPid: verdict?.owned === true && durable !== null ? durable.pid : null,
      watchLauncherOwned: status.roles.some((r) => r.role === "generic-backend" && r.presence === "OWNED"),
    });
    return observed({ view, durable, verdict });
  };

  /** Any generic backend runtime, watch OR non-watch, counted fresh immediately before the spawn. */
  const unaccountedLeaves = (): number | null => {
    const tree = adapters.observeProcessTree();
    if (!tree.ok) return null;
    return tree.value.filter((node) => isRuntime(node, NONWATCH_ENTRYPOINT) || isRuntime(node, WATCH_ENTRYPOINT)).length;
  };

  const start = async (status: TopologyStatus): Promise<void> => {
    say("");
    say(`Starting the ${label}: the BUILT backend (node dist/src/server.js), generic.env only, NOT part of Start SAFE.`);
    say("It is never restarted automatically: if it crashes it stays down and the status line shows it.");
    if (!adapters.gateAllows([role])) return;
    const held = await withMutationLock("GENERIC_BACKEND_NONWATCH_START", adapters.lockAdapters(), async () => {
      const build = assessNonWatchBuild(adapters.repoRoot, adapters.buildFileSystem);
      if (!build.ok) {
        say("BLOCKED — the build output is missing or stale, so nothing was started:");
        for (const reason of build.reasons) say(`  - ${reason}`);
        say(`  Build first (the launcher never builds, installs or generates anything): ${NONWATCH_BUILD_INSTRUCTION}`);
        return;
      }
      const parsed = parseEnvFileStrict(envFilePathFor(role, env));
      if (!parsed.ok) {
        say("BLOCKED — nothing was started:");
        say(`  - ${describeEnvFileFailure({ alias: "generic", reasonCode: parsed.reasonCode, detail: parsed.detail })}`);
        return;
      }
      const seen = await observe(status);
      if (!seen.ok) {
        say(`  ${label}: processes could not be observed (${seen.reason}) — nothing was started.`);
        return;
      }
      const decision = decideNonWatchStart(seen.value.view);
      if (decision.act === "ALREADY_RUNNING") {
        say(`  ${label}: ${decision.reason}.`);
        return;
      }
      if (decision.act === "REFUSE") {
        say(`  ${label}: REFUSED — ${decision.reason}`);
        return;
      }
      const outcome = executeFencedStart(role, {
        probe,
        unaccountedLeaves,
        spawnWorker: () => adapters.spawnRole(role, nonWatchBackendSpawnPlan(adapters.repoRoot, env, () => parsed.keys)),
        recordOwnership: (pid, startedAtMs) => writeState(recordOf(pid, startedAtMs)),
        log: (line) => say(`  ${line}`),
      });
      if (!outcome.started) {
        say(`  ${label}: not started (${outcome.outcome}: ${outcome.reason}).`);
        return;
      }
      writeState(recordOf(outcome.pid, outcome.startedAtMs));
      say(`  ${label}: started, pid ${outcome.pid}. Log: ${roleLogPath(role, env)}`);
      // Observe only: wait (bounded) to SEE it listening. Nothing here can start anything again.
      for (let waited = 0; waited < NONWATCH_LISTEN_WAIT_MS; waited += 1_000) {
        await adapters.sleep(1_000);
        const now = await observe(status);
        if (now.ok && now.value.view.mode === "RUNNING_NON_WATCH") {
          say(`  ${label}: ${GENERIC_BACKEND_MODE_LABEL.RUNNING_NON_WATCH} on :${GENERIC_BACKEND_PORT}.`);
          return;
        }
        if (now.ok && now.value.verdict !== null && now.value.verdict.owned === false) {
          say(`  ${label}: it EXITED before listening (${now.value.verdict.reason}). It was NOT restarted. Read its log.`);
          return;
        }
      }
      say(`  ${label}: started but not yet listening on :${GENERIC_BACKEND_PORT}; check its log. Nothing will be restarted.`);
    });
    if (!held.ran) for (const reason of held.reasons) say(`  ${label}: ${reason}`);
  };

  const stop = async (status: TopologyStatus): Promise<void> => {
    const held = await withMutationLock("GENERIC_BACKEND_NONWATCH_STOP", adapters.lockAdapters(), async () => {
      const state = readState();
      const record = state?.processes[0] ?? null;
      if (record === null) {
        say("");
        say(`This launcher owns no ${label}, so there is nothing for it to stop.`);
        const seen = await observe(status);
        if (seen.ok && seen.value.view.mode !== "OFF") {
          say(`Generic backend is ${GENERIC_BACKEND_MODE_LABEL[seen.value.view.mode]} (${seen.value.view.detail}). It will not be terminated by this action.`);
        }
        return;
      }
      // Ownership is proved inside the reviewed fenced stop before any kill; only the recorded root's own tree is signalled.
      const outcome = executeFencedStop(record, state!.repoRoot, { probe, terminate: adapters.terminate, log: (line) => say(`  ${line}`) });
      if (outcome.stopped) {
        writeState(null);
        say(`  ${label}: stopped${outcome.alreadyGone ? " (it had already exited)" : ""}. Nothing else was terminated.`);
      } else {
        say(`  ${label}: NOT stopped (${outcome.outcome}: ${outcome.reason}); its ownership record was kept.`);
      }
    });
    if (!held.ran) for (const reason of held.reasons) say(`  ${label}: ${reason}`);
  };

  const statusLines = async (status: TopologyStatus): Promise<string[]> => {
    const seen = await observe(status);
    if (!seen.ok) return [`Generic backend mode: UNKNOWN (processes could not be observed: ${seen.reason})`];
    const { view, durable, verdict } = seen.value;
    const pid = view.mode === "RUNNING_NON_WATCH" && durable !== null ? `, pid ${durable.pid}` : "";
    const lines = [`Generic backend mode: ${GENERIC_BACKEND_MODE_LABEL[view.mode]} (${view.detail}${pid})`];
    if (durable !== null && verdict !== null && verdict.owned === false) {
      lines.push(
        verdict.reason === "GONE"
          ? `  The launcher-started non-watch backend (pid ${durable.pid}) has EXITED. It is not restarted automatically; read ${roleLogPath(role, env)}.`
          : `  The recorded non-watch pid ${durable.pid} is no longer provably ours (${verdict.reason}); it will never be terminated by this launcher.`
      );
    }
    return lines;
  };

  return { start, stop, statusLines };
}

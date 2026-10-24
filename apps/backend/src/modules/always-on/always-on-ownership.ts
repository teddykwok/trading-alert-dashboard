import path from "node:path";

import { classifyBindFailure, type AuthorityRefusal, type ListenerHandle } from "../operator/mutation-lock";
import { verifyOwnership } from "../operator/runtime-launcher";
import type { ProbeOutcome } from "../operator/worker-supervision";
import { ALWAYS_ON_INSTANCE_HOST, ALWAYS_ON_INSTANCE_PORT, ALWAYS_ON_OWNERSHIP_SCHEMA, ALWAYS_ON_ROLES, type AlwaysOnRole } from "./always-on-contract";

/**
 * OWNERSHIP AND FENCING for the Always-On supervisor.
 *
 * ## One supervisor
 *
 * A supervisor holds an exclusive loopback listener (127.0.0.1:4019) for its
 * whole life — the launcher's proven mutex primitive, held instead of taken
 * per action. The OS releases it when the process dies, for any reason, so a
 * second supervisor can never run beside a live one and there is no stale
 * owner to infer.
 *
 * ## Generations
 *
 * Every supervisor start takes the next GENERATION and writes it, with its own
 * identity (pid, OS creation time, command identity), to ownership.json. Every
 * mutation re-reads that file first and refuses unless the generation on disk
 * is still its own. So even a supervisor that somehow kept running after a
 * newer one took over (it cannot hold the listener, but this is the second
 * fence) can never stop, start or adopt a child of the newer generation.
 *
 * ## Children
 *
 * A child is recorded by its OWNED ROOT: the pid `spawn` returned, the OS
 * creation time of that pid (PID-reuse fence) and the repository path its
 * command line carries — exactly the three facts `verifyOwnership` checks
 * before anything is ever terminated. A record whose root is gone, reused or
 * not this repository is dropped (never killed). A new generation ADOPTS the
 * previous generation's children that are still provably its own, so a
 * supervisor restart does not restart a healthy scanner.
 *
 * Pure: the file is handed in as text and probes are injected.
 */

export interface ChildRecord {
  readonly role: AlwaysOnRole;
  /** The owned root: the pid `spawn` returned (cmd.exe heading the role's tree). */
  readonly pid: number;
  /** The root's OS creation time; a recycled pid starts later and is never ours. */
  readonly startedAtMs: number;
  readonly spawnedAt: string;
  readonly spawnedByGeneration: number;
  /** Spawn sequence within its generation: makes each child's stop file unique. */
  readonly sequence: number;
  /** What it runs, for operators (repo-controlled text; never an environment value). */
  readonly commandIdentity: string;
  /** The cooperative stop file handed to it (scanner and emitter only). */
  readonly stopFile: string | null;
  /** Emitter only: the scanner run it is pinned to. */
  readonly pinnedRunId: string | null;
  /** Emitter only: the engine fingerprint it was told to expect. */
  readonly engineFingerprint: string | null;
}

export interface SupervisorIdentity {
  readonly pid: number;
  /** OS creation time of the supervisor process (or its start instant when it could not be read). */
  readonly startedAtMs: number;
  readonly startedAt: string;
  readonly commandIdentity: string;
  readonly instancePort: number;
}

export interface OwnershipFile {
  readonly schema: typeof ALWAYS_ON_OWNERSHIP_SCHEMA;
  readonly generation: number;
  readonly repoRoot: string;
  /** The owning supervisor; null once it stopped cleanly. */
  readonly supervisor: SupervisorIdentity | null;
  readonly children: readonly ChildRecord[];
  readonly writtenAt: string;
}

export type OwnershipRead =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "VALID"; readonly file: OwnershipFile }
  | { readonly kind: "UNREADABLE"; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isMs = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const strOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

function parseChild(value: unknown): ChildRecord | null {
  if (!isRecord(value)) return null;
  if (!(ALWAYS_ON_ROLES as readonly unknown[]).includes(value.role)) return null;
  if (!isPid(value.pid) || !isMs(value.startedAtMs) || !isMs(value.spawnedByGeneration) || !isMs(value.sequence)) return null;
  if (typeof value.spawnedAt !== "string" || typeof value.commandIdentity !== "string") return null;
  if (!strOrNull(value.stopFile) || !strOrNull(value.pinnedRunId) || !strOrNull(value.engineFingerprint)) return null;
  return {
    role: value.role as AlwaysOnRole,
    pid: value.pid,
    startedAtMs: value.startedAtMs,
    spawnedAt: value.spawnedAt,
    spawnedByGeneration: value.spawnedByGeneration,
    sequence: value.sequence,
    commandIdentity: value.commandIdentity,
    stopFile: value.stopFile,
    pinnedRunId: value.pinnedRunId,
    engineFingerprint: value.engineFingerprint,
  };
}

/**
 * The ownership file, strictly: an unreadable file is never read as "nothing
 * owned" (that would make its children look external — safe, but it must be
 * said), and never as anything else either.
 */
export function parseOwnership(text: string | null): OwnershipRead {
  if (text === null) return { kind: "ABSENT" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "UNREADABLE", reason: "the ownership file is not JSON" };
  }
  if (!isRecord(parsed) || parsed.schema !== ALWAYS_ON_OWNERSHIP_SCHEMA) return { kind: "UNREADABLE", reason: "the ownership file has an unknown schema" };
  if (!isMs(parsed.generation) || typeof parsed.repoRoot !== "string" || typeof parsed.writtenAt !== "string" || !Array.isArray(parsed.children)) {
    return { kind: "UNREADABLE", reason: "the ownership file is missing required fields" };
  }
  let supervisor: SupervisorIdentity | null = null;
  if (parsed.supervisor !== null) {
    const s = parsed.supervisor;
    if (!isRecord(s) || !isPid(s.pid) || !isMs(s.startedAtMs) || typeof s.startedAt !== "string" || typeof s.commandIdentity !== "string" || !isPid(s.instancePort)) {
      return { kind: "UNREADABLE", reason: "the ownership file's supervisor identity is malformed" };
    }
    supervisor = { pid: s.pid, startedAtMs: s.startedAtMs, startedAt: s.startedAt, commandIdentity: s.commandIdentity, instancePort: s.instancePort };
  }
  const children: ChildRecord[] = [];
  for (const entry of parsed.children) {
    const child = parseChild(entry);
    if (child === null) return { kind: "UNREADABLE", reason: "the ownership file has a malformed child record" };
    children.push(child);
  }
  return { kind: "VALID", file: { schema: ALWAYS_ON_OWNERSHIP_SCHEMA, generation: parsed.generation, repoRoot: parsed.repoRoot, supervisor, children, writtenAt: parsed.writtenAt } };
}

export const serializeOwnership = (file: OwnershipFile) => `${JSON.stringify(file, null, 2)}\n`;

/** The generation a new supervisor takes: strictly greater than any it can read. */
export function nextGeneration(previous: OwnershipRead): number {
  return previous.kind === "VALID" ? previous.file.generation + 1 : 1;
}

/**
 * The fence every mutation passes: the generation on disk must still be ours.
 * ABSENT or UNREADABLE is not "ours" either — a file somebody removed or broke
 * is exactly the situation in which nothing should be stopped or started.
 */
export function generationIsCurrent(onDisk: OwnershipRead, generation: number): boolean {
  return onDisk.kind === "VALID" && onDisk.file.generation === generation;
}

export type AdoptionDecision =
  | { readonly child: ChildRecord; readonly decision: "ADOPT" }
  | { readonly child: ChildRecord; readonly decision: "DROP"; readonly reason: "GONE" | "PID_REUSED" | "NOT_THIS_REPO" | "OTHER_REPOSITORY" };

/** One repository however it is spelled (case, separators, a trailing separator). */
export function sameRepository(a: string, b: string): boolean {
  const normal = (p: string) => path.resolve(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return normal(a) === normal(b);
}

/**
 * What a new generation does with the previous generation's children:
 * provably ours (alive, same creation time, this repository) is adopted;
 * anything else is dropped from the record — and NOT terminated. Null when a
 * probe could not be made: unknown is never gone, so nothing is decided.
 *
 * Every checkout (the main one and each worktree) shares one ownership file
 * under %LOCALAPPDATA%, and the command-line check is a containment test — so
 * `C:\…\trading-alert-dashboard` would accept a child of
 * `C:\…\trading-alert-dashboard-wt\…`. A record written by ANOTHER
 * repository's supervisor (`recordedRepoRoot`) is therefore never adopted.
 */
export function decideAdoption(children: readonly ChildRecord[], probe: (pid: number) => ProbeOutcome, repoRoot: string, recordedRepoRoot: string = repoRoot): AdoptionDecision[] | null {
  if (!sameRepository(recordedRepoRoot, repoRoot)) return children.map((child) => ({ child, decision: "DROP", reason: "OTHER_REPOSITORY" }));
  const decisions: AdoptionDecision[] = [];
  for (const child of children) {
    const probed = probe(child.pid);
    if (!probed.observed) return null;
    const verdict = verifyOwnership(child, probed.process, repoRoot);
    decisions.push(verdict.owned ? { child, decision: "ADOPT" } : { child, decision: "DROP", reason: verdict.reason });
  }
  return decisions;
}

export type SupervisorLiveness =
  | { readonly kind: "RUNNING"; readonly generation: number; readonly pid: number }
  | { readonly kind: "NOT_RUNNING" }
  | { readonly kind: "UNKNOWN"; readonly reason: string };

/**
 * Whether the recorded supervisor is provably alive (pid + OS creation time +
 * this repository), for stop / status / clear-latch. A file that could not be
 * read, or a probe that could not be made, is UNKNOWN — never "not running":
 * a stop must not report "exited" because one PowerShell probe failed.
 */
export function supervisorLiveness(readOwnershipText: () => string | null, probe: (pid: number) => ProbeOutcome): SupervisorLiveness {
  let text: string | null;
  try {
    text = readOwnershipText();
  } catch {
    return { kind: "UNKNOWN", reason: "the ownership file could not be read" };
  }
  const read = parseOwnership(text);
  if (read.kind === "UNREADABLE") return { kind: "UNKNOWN", reason: read.reason };
  if (read.kind === "ABSENT" || read.file.supervisor === null) return { kind: "NOT_RUNNING" };
  const supervisor = read.file.supervisor;
  const probed = probe(supervisor.pid);
  if (!probed.observed) return { kind: "UNKNOWN", reason: "the recorded supervisor process could not be observed" };
  return verifyOwnership(supervisor, probed.process, read.file.repoRoot).owned ? { kind: "RUNNING", generation: read.file.generation, pid: supervisor.pid } : { kind: "NOT_RUNNING" };
}

// ---------------------------------------------------------------------------
// The single-instance authority
// ---------------------------------------------------------------------------

export interface InstanceHeld {
  /** Gives the authority back (idempotent). The OS does it anyway when the process exits. */
  release(): Promise<void>;
}

export type InstanceAcquire = { readonly ok: true; readonly held: InstanceHeld } | { readonly ok: false; readonly outcome: AuthorityRefusal; readonly reason: string };

export interface InstanceLock {
  acquire(): Promise<InstanceAcquire>;
}

/** The real authority: an exclusive loopback binding held for the supervisor's life. */
export function listenerInstanceLock(openListener: () => ListenerHandle, options: { readonly host?: string; readonly port?: number } = {}): InstanceLock {
  const host = options.host ?? ALWAYS_ON_INSTANCE_HOST;
  const port = options.port ?? ALWAYS_ON_INSTANCE_PORT;
  return {
    acquire: async () => {
      const handle = openListener();
      try {
        await handle.listen(host, port);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const outcome = classifyBindFailure(code);
        try {
          await handle.close();
        } catch {
          // Nothing was bound.
        }
        return {
          ok: false,
          outcome,
          reason:
            outcome === "BUSY"
              ? `another Always-On supervisor (or another program) holds ${host}:${port}; only one supervisor may own the monitoring stack`
              : `the Always-On instance authority could not be taken on ${host}:${port} (${code ?? "unknown"})`,
        };
      }
      let released = false;
      return {
        ok: true,
        held: {
          release: async () => {
            if (released) return;
            released = true;
            try {
              await handle.close();
            } catch {
              // Released by the OS at exit regardless.
            }
          },
        },
      };
    },
  };
}

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TESTNET_VERIFIER_VERSION, isValidRunId } from "./testnet-identities";

/**
 * Crash-recovery state for one verifier run.
 *
 * Written BEFORE the first mutation and updated after each phase, so an
 * interrupted run can be resumed against the SAME deterministic identities
 * rather than minting new ones. It contains no credentials, no signatures and
 * no signed URLs — only the identities and the phase.
 */

export type VerifierPhase =
  | "PLANNED"
  | "ENTRY_SUBMITTED"
  | "ENTRY_FILLED"
  | "STOP_SUBMITTED"
  | "STOP_CONFIRMED"
  | "TP_SUBMITTED"
  | "TP_CONFIRMED"
  | "CANCELLING"
  | "CLOSING"
  | "COMPLETE";

export interface VerifierState {
  readonly verifierVersion: string;
  readonly runId: string;
  /** Recorded so a resume against a DIFFERENT host is refused. */
  readonly origin: string;
  readonly symbol: string;
  readonly direction: "LONG";
  readonly entryClientOrderId: string;
  readonly stopClientAlgoId: string;
  readonly takeProfitClientAlgoId: string;
  readonly emergencyClientOrderId: string;
  readonly phase: VerifierPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StateStore {
  read(): VerifierState | null;
  write(state: VerifierState): void;
  clear(): void;
}

/** Every field that must be present and a non-empty string to trust a resume. */
const REQUIRED_TEXT_FIELDS = [
  "verifierVersion",
  "runId",
  "origin",
  "symbol",
  "entryClientOrderId",
  "stopClientAlgoId",
  "takeProfitClientAlgoId",
  "emergencyClientOrderId",
  "phase",
] as const;

/**
 * Parses persisted state, returning null for anything unusable.
 *
 * A partially written, hand-edited or version-mismatched file must NOT be
 * treated as "no previous run" by the caller — the caller distinguishes
 * "absent" from "unreadable" and refuses to mutate on the latter, because an
 * unreadable file may still describe live orders.
 */
export function parseVerifierState(raw: string): VerifierState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const row = parsed as Record<string, unknown>;
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof row[field] !== "string" || (row[field] as string).length === 0) return null;
  }
  if (!isValidRunId(row.runId as string)) return null;
  // A file from an older identity derivation would resume against ids this
  // build no longer computes, which is exactly the "new identity" hazard the
  // state file exists to prevent.
  if (row.verifierVersion !== TESTNET_VERIFIER_VERSION) return null;
  if (row.direction !== "LONG") return null;

  return {
    verifierVersion: row.verifierVersion as string,
    runId: row.runId as string,
    origin: row.origin as string,
    symbol: row.symbol as string,
    direction: "LONG",
    entryClientOrderId: row.entryClientOrderId as string,
    stopClientAlgoId: row.stopClientAlgoId as string,
    takeProfitClientAlgoId: row.takeProfitClientAlgoId as string,
    emergencyClientOrderId: row.emergencyClientOrderId as string,
    phase: row.phase as VerifierPhase,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  };
}

/** Distinguishes "no file" from "file present but unusable". */
export type StateReadResult =
  | { readonly status: "ABSENT" }
  | { readonly status: "LOADED"; readonly state: VerifierState }
  | { readonly status: "UNREADABLE" };

export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  get filePath(): string {
    return this.path;
  }

  readDetailed(): StateReadResult {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "ABSENT" };
      return { status: "UNREADABLE" };
    }
    const state = parseVerifierState(raw);
    return state ? { status: "LOADED", state } : { status: "UNREADABLE" };
  }

  read(): VerifierState | null {
    const result = this.readDetailed();
    return result.status === "LOADED" ? result.state : null;
  }

  /**
   * Atomic replace: a crash mid-write leaves either the previous state or the
   * new one, never a truncated file that would parse as "no previous run".
   */
  write(state: VerifierState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

/** In-memory store for tests — no filesystem, same semantics. */
export class MemoryStateStore implements StateStore {
  private state: VerifierState | null = null;
  /** Set to simulate a corrupt/partial file. */
  unreadable = false;

  constructor(initial: VerifierState | null = null) {
    this.state = initial;
  }

  readDetailed(): StateReadResult {
    if (this.unreadable) return { status: "UNREADABLE" };
    return this.state ? { status: "LOADED", state: this.state } : { status: "ABSENT" };
  }

  read(): VerifierState | null {
    return this.unreadable ? null : this.state;
  }

  write(state: VerifierState): void {
    this.state = state;
  }

  clear(): void {
    this.state = null;
  }
}

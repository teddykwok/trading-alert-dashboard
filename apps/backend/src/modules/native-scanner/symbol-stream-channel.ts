import type { LiveKlineUpdate, LiveStreamError } from "./live-kline-stream";
import type { BarCloseCommitRecord } from "./live-shadow-store";
import type { LiveBarStatus, LiveSessionPhase, LiveShadowSession, LiveUpdateOutcome } from "./live-shadow-session";

/**
 * The per-symbol half of a live shadow stream: everything between "a valid
 * kline update for THIS symbol arrived" and the session.
 *
 * Shared by the single-symbol runner (one socket, one channel) and the
 * multi-symbol supervisor (one socket, many channels), so readiness gating,
 * quarantine and recovery detection can never fork between them. It owns no
 * socket and decides nothing about connections: when the session needs
 * recovery it says so, and the owner decides what to drop.
 */

export interface ChannelResult {
  /** The session's outcome, when the update reached it. */
  readonly outcome: LiveUpdateOutcome | null;
  /** Set when this update put (or found) the session in RECOVERY_REQUIRED. */
  readonly recoveryReason: string | null;
  /** Set on the update that established readiness: the bar status it got. */
  readonly readinessEstablished: LiveBarStatus | null;
}

export interface SymbolStreamChannelDeps {
  readonly session: LiveShadowSession;
  readonly log: (line: string) => void;
}

export class SymbolStreamChannel {
  /** True until a valid update for this symbol establishes readiness on the current attachment. */
  awaitingFirstUpdate = true;
  /** Messages refused by the stream validator, by reason. */
  readonly dropped: Record<string, number> = {};

  constructor(private readonly deps: SymbolStreamChannelDeps) {}

  /** A new attachment (connect, reconnect, re-attach after recovery): readiness must be re-established. */
  arm(): void {
    this.awaitingFirstUpdate = true;
  }

  refuse(error: LiveStreamError): void {
    this.dropped[error.code] = (this.dropped[error.code] ?? 0) + 1;
    this.deps.log(`REFUSED stream message (${error.code}): ${error.message}`);
  }

  accept(update: LiveKlineUpdate): ChannelResult {
    const { session } = this.deps;
    let readinessEstablished: LiveBarStatus | null = null;
    if (this.awaitingFirstUpdate) {
      const status: LiveBarStatus = session.markStreamReady(update);
      if (session.phase === "READY") {
        this.awaitingFirstUpdate = false;
        readinessEstablished = status;
        this.deps.log(
          `READINESS_ESTABLISHED at bar ${new Date(update.openTimeMs).toISOString()}: ${status}; live eligible from ${new Date(session.liveEligibleFromMs as number).toISOString()}`
        );
      }
    }
    if (session.phase === "RECOVERY_REQUIRED") return { outcome: null, recoveryReason: session.recoveryReason ?? "", readinessEstablished };
    if (session.phase !== "READY") return { outcome: null, recoveryReason: null, readinessEstablished };
    const outcome = session.onUpdate(update);
    for (const o of outcome.observations) {
      this.deps.log(`SHADOW_LIVE_ONLY ${o.barOpenTime} ${o.signal} ${o.sourceTf} ${o.levelColor} ${o.levelPrice} (${o.evidence.evidenceClass}) — not an alert, not actionable`);
    }
    if (outcome.commit !== null) this.logCommit(outcome.commit);
    // onUpdate may have moved the session into recovery: read the phase afresh.
    const recoveryReason = (session.phase as LiveSessionPhase) === "RECOVERY_REQUIRED" ? (session.recoveryReason ?? "") : null;
    return { outcome, recoveryReason, readinessEstablished };
  }

  logCommit(record: BarCloseCommitRecord): void {
    this.deps.log(
      `${record.classification} commit ${record.barOpenTime}: ${record.committedCandidates.length} committed candidate(s); hwm ${new Date(record.hwmOpenTimeMs).toISOString()} state ${record.stateSha256.slice(0, 12)}`
    );
  }
}

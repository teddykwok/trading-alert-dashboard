import type { NativeKline } from "@trading-alert-dashboard/shared";

import type { ScannerChartInterval } from "./binance-public-futures";
import { LiveStreamError, parseKlineStreamMessage } from "./live-kline-stream";
import type { BarCloseCommitRecord } from "./live-shadow-store";
import type { LiveBarStatus, LiveSessionPhase, LiveShadowSession, LiveUpdateOutcome } from "./live-shadow-session";

/**
 * Connects a live shadow session to a public kline stream, and recovers it.
 *
 * Every effect is injected: the stream transport, the public closed-kline
 * fetcher, the clock and the log. The CLI wires the real public WebSocket and
 * REST; tests wire fakes. Nothing here can reach an account, a database or an
 * order path.
 *
 * Disconnect -> live eligibility off at once. Recovery -> fetch the fully
 * closed gap, commit it as REPLAYED_NON_ACTIONABLE, reconnect, and quarantine
 * whatever bar is in progress. Late Immediate signals are never rescued.
 */

export interface StreamHandlers {
  onMessage(text: string): void;
  onClose(reason: string): void;
}

export interface StreamConnection {
  close(): void;
}

export type OpenPublicStream = (url: string, handlers: StreamHandlers) => StreamConnection;

export interface LiveShadowRunnerDeps {
  readonly session: LiveShadowSession;
  readonly url: string;
  readonly symbol: string;
  readonly interval: ScannerChartInterval;
  readonly openStream: OpenPublicStream;
  /** Public, verified CLOSED klines of [fromMs, toMs). */
  readonly fetchClosedBars: (fromMs: number, toMs: number) => Promise<NativeKline[]>;
  readonly nowMs: () => number;
  readonly log: (line: string) => void;
}

export class LiveShadowRunner {
  private connection: StreamConnection | null = null;
  /** Identifies the live connection; events from any older connection are ignored. */
  private generation = 0;
  private awaitingFirstUpdate = true;
  /** Messages refused by the stream validator, by reason. */
  readonly dropped: Record<string, number> = {};

  constructor(private readonly deps: LiveShadowRunnerDeps) {}

  /** Local time of the last message of any kind from the current connection (stale-stream watchdog). */
  lastMessageAtMs: number | null = null;

  get connected(): boolean {
    return this.connection !== null;
  }

  /** Drops the connection deliberately (stale stream, shutdown): live eligibility goes OFF at once. */
  disconnect(reason: string): void {
    this.drop(reason);
  }

  connect(): void {
    if (this.deps.session.phase === "RECOVERY_REQUIRED") throw new Error("recover before reconnecting");
    if (this.connection !== null) return;
    this.awaitingFirstUpdate = true;
    const generation = ++this.generation;
    this.connection = this.deps.openStream(this.deps.url, {
      onMessage: (text) => {
        if (generation === this.generation) this.handleMessage(text);
      },
      onClose: (reason) => {
        if (generation === this.generation) this.handleClose(reason);
      },
    });
    this.deps.log(`stream connecting: ${this.deps.url}`);
  }

  handleMessage(text: string): LiveUpdateOutcome | null {
    this.lastMessageAtMs = this.deps.nowMs();
    let update;
    try {
      update = parseKlineStreamMessage(text, this.deps.symbol, this.deps.interval);
    } catch (error) {
      if (!(error instanceof LiveStreamError)) throw error;
      this.dropped[error.code] = (this.dropped[error.code] ?? 0) + 1;
      this.deps.log(`REFUSED stream message (${error.code}): ${error.message}`);
      return null;
    }
    const { session } = this.deps;
    if (this.awaitingFirstUpdate) {
      const status: LiveBarStatus = session.markStreamReady(update);
      if (session.phase === "READY") {
        this.awaitingFirstUpdate = false;
        this.deps.log(
          `READY at bar ${new Date(update.openTimeMs).toISOString()}: ${status}; live eligible from ${new Date(session.liveEligibleFromMs as number).toISOString()}`
        );
      }
    }
    if (session.phase === "RECOVERY_REQUIRED") {
      this.drop(`RECOVERY_REQUIRED: ${session.recoveryReason ?? ""}`);
      return null;
    }
    if (session.phase !== "READY") return null;
    const outcome = session.onUpdate(update);
    for (const o of outcome.observations) {
      this.deps.log(`SHADOW_LIVE_ONLY ${o.barOpenTime} ${o.signal} ${o.sourceTf} ${o.levelColor} ${o.levelPrice} (${o.evidence.evidenceClass}) — not an alert, not actionable`);
    }
    if (outcome.commit !== null) this.logCommit(outcome.commit);
    // onUpdate may have moved the session into recovery: read the phase afresh.
    if ((session.phase as LiveSessionPhase) === "RECOVERY_REQUIRED") this.drop(`RECOVERY_REQUIRED: ${session.recoveryReason ?? ""}`);
    return outcome;
  }

  handleClose(reason: string): void {
    this.connection = null;
    this.deps.session.onDisconnect();
    this.deps.log(`stream closed (${reason}): live eligibility OFF until a fresh boundary after reconnecting`);
  }

  /** Fills the fully closed gap from public data, commits it as replayed evidence, then reconnects. */
  async recoverAndReconnect(): Promise<BarCloseCommitRecord[]> {
    this.drop("recovering");
    const { session } = this.deps;
    const currentBarOpen = Math.floor(this.deps.nowMs() / session.intervalMs) * session.intervalMs;
    const bars = currentBarOpen > session.hwmOpenTimeMs ? await this.deps.fetchClosedBars(session.hwmOpenTimeMs, currentBarOpen) : [];
    const records = session.recoverClosedBars(bars);
    for (const record of records) this.logCommit(record);
    this.connect();
    return records;
  }

  private drop(reason: string): void {
    const connection = this.connection;
    this.connection = null;
    this.generation += 1; // anything the dropped connection still delivers is ignored
    this.deps.session.onDisconnect();
    if (connection !== null) {
      connection.close();
      this.deps.log(`stream dropped (${reason})`);
    }
  }

  private logCommit(record: BarCloseCommitRecord): void {
    this.deps.log(
      `${record.classification} commit ${record.barOpenTime}: ${record.committedCandidates.length} committed candidate(s); hwm ${new Date(record.hwmOpenTimeMs).toISOString()} state ${record.stateSha256.slice(0, 12)}`
    );
  }
}

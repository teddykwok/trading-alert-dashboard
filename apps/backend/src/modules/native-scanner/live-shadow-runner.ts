import type { NativeKline } from "@trading-alert-dashboard/shared";

import type { ScannerChartInterval } from "./binance-public-futures";
import { LiveStreamError, parseKlineStreamMessage } from "./live-kline-stream";
import type { BarCloseCommitRecord } from "./live-shadow-store";
import type { LiveShadowSession, LiveUpdateOutcome } from "./live-shadow-session";
import { SymbolStreamChannel } from "./symbol-stream-channel";

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

/** Transport events. The CLI wires them to the real WebSocket; tests to a fake. */
export interface StreamHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onError(reason: string): void;
  onClose(reason: string): void;
}

export interface StreamConnection {
  close(): void;
}

export type OpenPublicStream = (url: string, handlers: StreamHandlers) => StreamConnection;

/** Every stage an operator can see, so nothing ever sits silently at "connecting". */
export type StreamLifecycle =
  | "IDLE"
  | "STREAM_CONNECTING"
  | "STREAM_OPEN"
  | "FIRST_MESSAGE_RECEIVED"
  | "READINESS_ESTABLISHED"
  | "STREAM_ERROR"
  | "STREAM_CLOSED";

/** No WebSocket OPEN within this long after connecting: fail visibly and reconnect. */
export const STREAM_OPEN_TIMEOUT_MS = 15_000;
/** OPEN, but no VALID kline update within this long (Binance pushes klines every 250 ms): fail visibly. */
export const STREAM_READINESS_TIMEOUT_MS = 30_000;
/** Ready, but no message of any kind for this long: the stream is stale. */
export const STREAM_STALE_TIMEOUT_MS = 90_000;

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
  /** The per-symbol half (readiness, session, recovery detection), shared with the supervisor. */
  private readonly channel: SymbolStreamChannel;
  private connectStartedAtMs: number | null = null;
  private openedAtMs: number | null = null;
  private firstMessageAtMs: number | null = null;
  /** The current connection's lifecycle stage. */
  lifecycle: StreamLifecycle = "IDLE";
  /** Local time of the last message of any kind from the current connection. */
  lastMessageAtMs: number | null = null;

  constructor(private readonly deps: LiveShadowRunnerDeps) {
    this.channel = new SymbolStreamChannel({ session: deps.session, log: deps.log });
  }

  /** Messages refused by the stream validator, by reason. */
  get dropped(): Record<string, number> {
    return this.channel.dropped;
  }

  private get awaitingFirstUpdate(): boolean {
    return this.channel.awaitingFirstUpdate;
  }

  get connected(): boolean {
    return this.connection !== null;
  }

  /** Drops the connection deliberately (timeout, shutdown): live eligibility goes OFF at once. */
  disconnect(reason: string): void {
    this.drop(reason);
  }

  connect(): void {
    if (this.deps.session.phase === "RECOVERY_REQUIRED") throw new Error("recover before reconnecting");
    if (this.connection !== null) return;
    this.channel.arm();
    this.connectStartedAtMs = this.deps.nowMs();
    this.openedAtMs = null;
    this.firstMessageAtMs = null;
    this.lastMessageAtMs = null;
    this.lifecycle = "STREAM_CONNECTING";
    const generation = ++this.generation;
    this.deps.log(`STREAM_CONNECTING ${this.deps.url}`);
    this.connection = this.deps.openStream(this.deps.url, {
      onOpen: () => {
        if (generation === this.generation) this.handleOpen();
      },
      onMessage: (text) => {
        if (generation === this.generation) this.handleMessage(text);
      },
      onError: (reason) => {
        if (generation === this.generation) this.handleError(reason);
      },
      onClose: (reason) => {
        if (generation === this.generation) this.handleClose(reason);
      },
    });
  }

  handleOpen(): void {
    this.openedAtMs = this.deps.nowMs();
    this.lifecycle = "STREAM_OPEN";
    this.deps.log("STREAM_OPEN: handshake complete; waiting for the first VALID kline update (readiness requires it)");
  }

  handleError(reason: string): void {
    this.lifecycle = "STREAM_ERROR";
    this.deps.log(`STREAM_ERROR (${reason})`);
    this.drop(`STREAM_ERROR: ${reason}`);
  }

  /**
   * Enforces the bounded timeouts. Returns the reason when it dropped the
   * connection, otherwise null. Called periodically by the CLI.
   */
  checkTimeouts(): string | null {
    if (this.connection === null) return null;
    const now = this.deps.nowMs();
    let reason: string | null = null;
    if (this.lifecycle === "STREAM_CONNECTING" && now - (this.connectStartedAtMs as number) > STREAM_OPEN_TIMEOUT_MS) {
      reason = `STREAM_OPEN_TIMEOUT: no WebSocket OPEN within ${STREAM_OPEN_TIMEOUT_MS / 1000}s`;
    } else if (this.awaitingFirstUpdate && now - (this.openedAtMs ?? (this.connectStartedAtMs as number)) > STREAM_READINESS_TIMEOUT_MS) {
      const refused = Object.values(this.dropped).reduce((a, b) => a + b, 0);
      reason = `STREAM_READINESS_TIMEOUT: no valid kline update within ${STREAM_READINESS_TIMEOUT_MS / 1000}s of OPEN (${
        this.firstMessageAtMs === null ? "no message at all" : `${refused} message(s) refused`
      })`;
    } else if (!this.awaitingFirstUpdate && this.lastMessageAtMs !== null && now - this.lastMessageAtMs > STREAM_STALE_TIMEOUT_MS) {
      reason = `STREAM_STALE: no message for ${STREAM_STALE_TIMEOUT_MS / 1000}s`;
    }
    if (reason !== null) this.drop(reason);
    return reason;
  }

  handleMessage(text: string): LiveUpdateOutcome | null {
    this.lastMessageAtMs = this.deps.nowMs();
    if (this.firstMessageAtMs === null) {
      this.firstMessageAtMs = this.lastMessageAtMs;
      if (this.awaitingFirstUpdate) this.lifecycle = "FIRST_MESSAGE_RECEIVED";
      this.deps.log("FIRST_MESSAGE_RECEIVED: validating (readiness needs a VALID update for this symbol and interval)");
    }
    let update;
    try {
      update = parseKlineStreamMessage(text, this.deps.symbol, this.deps.interval);
    } catch (error) {
      if (!(error instanceof LiveStreamError)) throw error;
      this.channel.refuse(error);
      return null;
    }
    const result = this.channel.accept(update);
    if (result.readinessEstablished !== null) this.lifecycle = "READINESS_ESTABLISHED";
    // One socket, one symbol: a session that needs recovery drops the socket.
    if (result.recoveryReason !== null) this.drop(`RECOVERY_REQUIRED: ${result.recoveryReason}`);
    return result.outcome;
  }

  handleClose(reason: string): void {
    this.connection = null;
    this.lifecycle = "STREAM_CLOSED";
    this.deps.session.onDisconnect();
    this.deps.log(`STREAM_CLOSED (${reason}): live eligibility OFF until a fresh boundary after reconnecting`);
  }

  /** Fills the fully closed gap from public data, commits it as replayed evidence, then reconnects. */
  async recoverAndReconnect(): Promise<BarCloseCommitRecord[]> {
    this.drop("recovering");
    const { session } = this.deps;
    const currentBarOpen = Math.floor(this.deps.nowMs() / session.intervalMs) * session.intervalMs;
    const bars = currentBarOpen > session.hwmOpenTimeMs ? await this.deps.fetchClosedBars(session.hwmOpenTimeMs, currentBarOpen) : [];
    const records = session.recoverClosedBars(bars);
    for (const record of records) this.channel.logCommit(record);
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
      this.lifecycle = "STREAM_CLOSED";
      this.deps.log(`STREAM_CLOSED (dropped: ${reason}): live eligibility OFF`);
    }
  }

}

import type { NativeKline } from "@trading-alert-dashboard/shared";

import { klineStreamNameOf } from "../../src/modules/native-scanner/exchange-symbol";
import type { PublicHttpResponse, PublicHttpTransport } from "../../src/modules/native-scanner/kline-fetcher";
import { assertPublicCombinedKlineStreamUrl } from "../../src/modules/native-scanner/live-kline-stream";
import type { OpenPublicStream, StreamHandlers } from "../../src/modules/native-scanner/live-shadow-runner";

/**
 * A SIMULATED PUBLIC BINANCE NETWORK with deterministic fault injection — TEST
 * ONLY. Nothing here can reach the real network, and nothing in production can
 * reach this: it is handed explicitly, as the transports, to the objects a
 * test constructs (the scanner's REST and WebSocket, the Always-On
 * connectivity probe).
 *
 * One market and one fault state serve every path, so an outage changes
 * TRANSPORT behaviour, never a health flag:
 *
 *   REST (scanner)   UP | REFUSED (fetch failed, ECONNREFUSED) | TIMEOUT (held
 *                    until its 20 s client timeout elapses on the simulated
 *                    clock, then a TimeoutError — exactly the CLI's
 *                    AbortSignal.timeout(20_000))
 *   probe (fetch)    the same REST fault; a TIMEOUT answers at once with the
 *                    TimeoutError its own 5 s budget would produce
 *   open streams     UP | DROP (error + abnormal close 1006 on the next turn)
 *                    | SILENT (half-open: stays OPEN, delivers nothing)
 *   new streams      UP | REFUSED (error + close, never open) | BLACKHOLE
 *                    (never answers: stays CONNECTING)
 *
 * Fail-safe: every outage carries a mandatory maximum duration (at most
 * MAX_SIMULATED_OUTAGE_MS) and restores itself when the simulated clock passes
 * it, whether or not the test remembered to; `withOutage` restores in
 * `finally`; `dispose` restores, fails every held request and refuses any
 * further use. Only one outage is active at a time.
 *
 * The market streams like Binance: an in-progress update of the current bar on
 * every turn, and the closing update (x: true) of a bar only on the turn in
 * which it closed — a socket that was down or silent then simply never gets it.
 * REST serves only bars closed by the simulated clock.
 */

export const SIMULATED_REST_TIMEOUT_MS = 20_000;
export const MAX_SIMULATED_OUTAGE_MS = 6 * 60 * 60 * 1000;
const REST_HOST = "fapi.binance.com";
const M15 = 15 * 60_000;

export type RestFault = "REFUSED" | "TIMEOUT";
export type OpenStreamFault = "DROP" | "SILENT";
export type NewStreamFault = "REFUSED" | "BLACKHOLE";

export interface OutageSpec {
  readonly rest?: RestFault;
  readonly openStreams?: OpenStreamFault;
  readonly newStreams?: NewStreamFault;
  /** Mandatory: the outage restores itself once the simulated clock passes start + this. */
  readonly maxDurationMs: number;
  readonly label?: string;
}

export interface SimulatedMarket {
  /** The symbols exchangeInfo lists as TRADING USDT perpetuals now. */
  symbols(): readonly string[];
  /** The symbol's full 15m series; the simulated clock decides what has closed. */
  bars(symbol: string): readonly NativeKline[];
  onboardDateMs(symbol: string): number;
}

export interface SimulatedRequest {
  readonly atMs: number;
  readonly via: "rest" | "probe";
  readonly path: string;
  readonly symbol: string | null;
  outcome: "OK" | "REFUSED" | "TIMEOUT" | "PENDING";
  settledAtMs: number | null;
}

export interface SimulatedSocket {
  readonly id: number;
  readonly url: string;
  readonly symbols: readonly string[];
  readonly createdAtMs: number;
  state: "CONNECTING" | "OPEN" | "CLOSED";
  openedAtMs: number | null;
  closedAtMs: number | null;
  closeReason: string | null;
  messages: number;
  /** Per symbol: the open time of the last bar whose closing update was sent. */
  readonly lastClosedSent: Map<string, number>;
}

export interface SimulatedEvent {
  readonly atMs: number;
  readonly kind: "OUTAGE_STARTED" | "RESTORED" | "AUTO_RESTORED" | "DISPOSED";
  readonly detail: string;
}

export class SimulatedNetworkViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatedNetworkViolation";
  }
}

interface ActiveOutage {
  readonly spec: OutageSpec;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
}

interface HeldRequest {
  readonly record: SimulatedRequest;
  readonly deadlineMs: number;
  readonly reject: (error: unknown) => void;
}

interface Pending {
  readonly socket: SimulatedSocket;
  readonly handlers: StreamHandlers;
  readonly kind: "open" | "drop" | "refuse" | "client-close";
}

export interface OutageHandle {
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  restore(): void;
}

export function timeoutError(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

export function refusedError(): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}

const binanceRow = (k: NativeKline) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"];

export class SimulatedPublicNetwork {
  readonly requests: SimulatedRequest[] = [];
  readonly sockets: SimulatedSocket[] = [];
  readonly events: SimulatedEvent[] = [];
  readonly violations: string[] = [];
  private outageState: ActiveOutage | null = null;
  private readonly held: HeldRequest[] = [];
  private readonly pending: Pending[] = [];
  private readonly handlersOf = new Map<number, StreamHandlers>();
  private readonly silentSince = new Map<number, number>();
  private disposed = false;
  private nextSocketId = 1;
  private lastPumpMs: number;

  constructor(
    private readonly nowMs: () => number,
    private readonly market: SimulatedMarket
  ) {
    this.lastPumpMs = nowMs();
  }

  // ---------------------------------------------------------------------------
  // Fault control
  // ---------------------------------------------------------------------------

  get outage(): OutageSpec | null {
    this.expireOutage();
    return this.outageState?.spec ?? null;
  }

  /** Starts ONE bounded outage. Refused while another is active, without a duration, or longer than the cap. */
  cut(spec: OutageSpec): OutageHandle {
    this.assertUsable();
    this.expireOutage();
    if (this.outageState !== null) throw new SimulatedNetworkViolation("an outage is already active: restore it first");
    if (spec.rest === undefined && spec.openStreams === undefined && spec.newStreams === undefined) throw new SimulatedNetworkViolation("an outage must fault at least one path");
    if (!Number.isFinite(spec.maxDurationMs) || spec.maxDurationMs <= 0 || spec.maxDurationMs > MAX_SIMULATED_OUTAGE_MS) {
      throw new SimulatedNetworkViolation(`an outage needs a maximum duration in (0, ${MAX_SIMULATED_OUTAGE_MS}] ms`);
    }
    const now = this.nowMs();
    const active: ActiveOutage = { spec, startedAtMs: now, deadlineMs: now + spec.maxDurationMs };
    this.outageState = active;
    this.events.push({ atMs: now, kind: "OUTAGE_STARTED", detail: describe(spec) });
    if (spec.openStreams === "DROP") {
      for (const socket of this.sockets) if (socket.state !== "CLOSED") this.queue(socket, "drop");
    }
    if (spec.openStreams === "SILENT") {
      for (const socket of this.sockets) if (socket.state !== "CLOSED") this.silentSince.set(socket.id, now);
    }
    return {
      startedAtMs: active.startedAtMs,
      deadlineMs: active.deadlineMs,
      restore: () => {
        if (this.outageState === active) this.endOutage("RESTORED", `restored after ${Math.round((this.nowMs() - active.startedAtMs) / 1000)}s`);
      },
    };
  }

  /** Runs `body` inside one bounded outage and ALWAYS restores, even when `body` throws. */
  async withOutage<T>(spec: OutageSpec, body: (handle: OutageHandle) => Promise<T>): Promise<T> {
    const handle = this.cut(spec);
    try {
      return await body(handle);
    } finally {
      handle.restore();
    }
  }

  /** Ends whatever outage is active (idempotent). */
  restore(): void {
    if (this.outageState !== null) this.endOutage("RESTORED", "restored");
  }

  /** Test teardown: restore, fail every held request, close every socket without delivering anything, refuse any further use. */
  dispose(): void {
    if (this.disposed) return;
    this.restore();
    for (const h of this.held.splice(0)) {
      h.record.outcome = "TIMEOUT";
      h.record.settledAtMs = this.nowMs();
      h.reject(new Error("simulated network disposed"));
    }
    this.pending.length = 0;
    for (const socket of this.sockets) {
      if (socket.state === "CLOSED") continue;
      socket.state = "CLOSED";
      socket.closedAtMs = this.nowMs();
      socket.closeReason = "disposed";
    }
    this.handlersOf.clear();
    this.disposed = true;
    this.events.push({ atMs: this.nowMs(), kind: "DISPOSED", detail: "simulated network disposed" });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get heldRequests(): number {
    return this.held.length;
  }

  // ---------------------------------------------------------------------------
  // REST (the scanner) and the probe's fetch
  // ---------------------------------------------------------------------------

  readonly rest: PublicHttpTransport = async (url, init) => {
    const target = this.admit(url, init.headers);
    const record: SimulatedRequest = { atMs: this.nowMs(), via: "rest", path: target.pathname, symbol: target.searchParams.get("symbol"), outcome: "PENDING", settledAtMs: null };
    this.requests.push(record);
    const fault = this.outage?.rest;
    if (fault === "REFUSED") return this.settle(record, "REFUSED", () => Promise.reject(refusedError()));
    if (fault === "TIMEOUT") {
      return new Promise<PublicHttpResponse>((_resolve, reject) => {
        this.held.push({ record, deadlineMs: record.atMs + SIMULATED_REST_TIMEOUT_MS, reject });
      });
    }
    return this.settle(record, "OK", async () => this.serve(target));
  };

  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    if ((init?.method ?? "GET").toUpperCase() !== "GET") this.violate(`a ${String(init?.method)} request reached the simulated network`);
    const target = this.admit(raw, headers);
    const record: SimulatedRequest = { atMs: this.nowMs(), via: "probe", path: target.pathname, symbol: target.searchParams.get("symbol"), outcome: "PENDING", settledAtMs: null };
    this.requests.push(record);
    const fault = this.outage?.rest;
    if (fault === "REFUSED") return this.settle(record, "REFUSED", () => Promise.reject(refusedError()));
    if (fault === "TIMEOUT") return this.settle(record, "TIMEOUT", () => Promise.reject(timeoutError()));
    const answer = this.serve(target);
    return this.settle(record, "OK", async () => new Response(await answer.text(), { status: answer.status }));
  }) as typeof fetch;

  private admit(raw: string, headers: Readonly<Record<string, string>>): URL {
    this.assertUsable();
    this.expireOutage();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return this.violate(`unparseable URL reached the simulated network: ${raw}`);
    }
    if (url.protocol !== "https:" || url.hostname !== REST_HOST || url.port !== "" || url.username !== "" || url.password !== "") {
      this.violate(`only https://${REST_HOST} is served, not ${url.origin}`);
    }
    if (url.searchParams.has("signature") || url.searchParams.has("timestamp") || url.searchParams.has("recvWindow")) {
      this.violate(`a signed request reached the simulated network: ${url.pathname}`);
    }
    if (Object.keys(headers).some((h) => h.toLowerCase() === "x-mbx-apikey")) this.violate(`an API key header reached the simulated network: ${url.pathname}`);
    return url;
  }

  private settle<T>(record: SimulatedRequest, outcome: SimulatedRequest["outcome"], answer: () => Promise<T>): Promise<T> {
    record.outcome = outcome;
    record.settledAtMs = this.nowMs();
    return answer();
  }

  private serve(url: URL): PublicHttpResponse {
    const now = this.nowMs();
    const respond = (status: number, body: unknown): PublicHttpResponse => ({ status, header: () => null, text: async () => JSON.stringify(body) });
    if (url.pathname === "/fapi/v1/time") return respond(200, { serverTime: now });
    if (url.pathname === "/fapi/v1/exchangeInfo") {
      return respond(200, {
        symbols: this.market.symbols().map((symbol) => ({
          symbol,
          baseAsset: symbol.replace(/USDT$/, ""),
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          onboardDate: this.market.onboardDateMs(symbol),
          underlyingType: "COIN",
        })),
      });
    }
    if (url.pathname === "/fapi/v1/klines") {
      const symbol = url.searchParams.get("symbol") as string;
      const start = Number(url.searchParams.get("startTime"));
      const end = Number(url.searchParams.get("endTime"));
      const limit = Number(url.searchParams.get("limit"));
      const rows = this.market
        .bars(symbol)
        .filter((b) => b.openTimeMs >= start && b.openTimeMs <= end && b.closeTimeMs < now)
        .slice(0, limit);
      return respond(200, rows.map(binanceRow));
    }
    return respond(404, {});
  }

  // ---------------------------------------------------------------------------
  // WebSocket (the scanner's combined kline streams)
  // ---------------------------------------------------------------------------

  readonly openStream: OpenPublicStream = (url, handlers) => {
    this.assertUsable();
    this.expireOutage();
    const streams = (() => {
      try {
        return new URL(url).searchParams.get("streams")?.split("/") ?? [];
      } catch {
        return [];
      }
    })();
    const byStream = new Map(this.market.symbols().map((s) => [klineStreamNameOf(s, "15m"), s]));
    const symbols = streams.map((name) => byStream.get(name) ?? this.violate(`stream ${name} is not a listed symbol`));
    try {
      assertPublicCombinedKlineStreamUrl(url, symbols, "15m");
    } catch (error) {
      this.violate(`refused stream URL: ${error instanceof Error ? error.message : String(error)}`);
    }
    const socket: SimulatedSocket = {
      id: this.nextSocketId++,
      url,
      symbols,
      createdAtMs: this.nowMs(),
      state: "CONNECTING",
      openedAtMs: null,
      closedAtMs: null,
      closeReason: null,
      messages: 0,
      lastClosedSent: new Map(),
    };
    this.sockets.push(socket);
    this.handlersOf.set(socket.id, handlers);
    const fault = this.outage?.newStreams;
    if (fault === "REFUSED") this.queue(socket, "refuse");
    else if (fault !== "BLACKHOLE") this.queue(socket, "open");
    return {
      close: () => {
        if (socket.state === "CLOSED") return;
        this.queue(socket, "client-close");
      },
    };
  };

  private queue(socket: SimulatedSocket, kind: Pending["kind"]): void {
    const handlers = this.handlersOf.get(socket.id);
    if (handlers !== undefined) this.pending.push({ socket, handlers, kind });
  }

  /**
   * One network turn at the current simulated time: an expired outage restores itself, held requests whose client
   * timeout elapsed fail, queued socket events are delivered, then every delivering socket gets its kline updates.
   */
  pump(): void {
    this.assertUsable();
    this.expireOutage();
    const now = this.nowMs();
    for (const h of [...this.held]) {
      if (now < h.deadlineMs) continue;
      this.held.splice(this.held.indexOf(h), 1);
      h.record.outcome = "TIMEOUT";
      h.record.settledAtMs = now;
      h.reject(timeoutError());
    }
    for (const event of this.pending.splice(0)) this.deliver(event, now);
    const silent = this.outage?.openStreams === "SILENT";
    for (const socket of this.sockets) {
      if (socket.state !== "OPEN") continue;
      if (silent && this.silentSince.has(socket.id)) continue;
      const handlers = this.handlersOf.get(socket.id);
      if (handlers === undefined) continue;
      for (const symbol of socket.symbols) this.stream(socket, handlers, symbol, now);
    }
    this.lastPumpMs = now;
  }

  private deliver(event: Pending, now: number): void {
    const { socket, handlers, kind } = event;
    if (socket.state === "CLOSED") return;
    if (kind === "open") {
      if (socket.state !== "CONNECTING") return;
      socket.state = "OPEN";
      socket.openedAtMs = now;
      // A fresh subscription starts with the bar in progress: closes before it are not replayed.
      for (const symbol of socket.symbols) socket.lastClosedSent.set(symbol, Math.floor(now / M15) * M15 - M15);
      if (this.outage?.openStreams === "SILENT") this.silentSince.set(socket.id, now);
      handlers.onOpen();
      return;
    }
    socket.state = "CLOSED";
    socket.closedAtMs = now;
    this.handlersOf.delete(socket.id);
    this.silentSince.delete(socket.id);
    if (kind === "client-close") {
      socket.closeReason = "client closed";
      handlers.onClose("code 1000");
      return;
    }
    socket.closeReason = kind === "drop" ? "dropped by the simulated outage" : "refused by the simulated outage";
    handlers.onError("websocket error event");
    handlers.onClose("code 1006");
  }

  private stream(socket: SimulatedSocket, handlers: StreamHandlers, symbol: string, now: number): void {
    const name = klineStreamNameOf(symbol, "15m");
    const bars = this.market.bars(symbol);
    const currentOpen = Math.floor(now / M15) * M15;
    const justClosed = bars.find((b) => b.openTimeMs === currentOpen - M15);
    const lastSent = socket.lastClosedSent.get(symbol) ?? Number.NEGATIVE_INFINITY;
    // The closing update is pushed only in the turn the bar closed in; a socket that missed it never gets it.
    if (justClosed !== undefined && justClosed.openTimeMs > lastSent && justClosed.closeTimeMs >= this.lastPumpMs - 1) {
      this.send(socket, handlers, name, symbol, justClosed, true, justClosed.closeTimeMs + 1);
    }
    if (justClosed !== undefined) socket.lastClosedSent.set(symbol, Math.max(lastSent, justClosed.openTimeMs));
    const current = bars.find((b) => b.openTimeMs === currentOpen);
    if (current !== undefined) this.send(socket, handlers, name, symbol, current, false, now);
  }

  private send(socket: SimulatedSocket, handlers: StreamHandlers, stream: string, symbol: string, k: NativeKline, closed: boolean, eventTimeMs: number): void {
    socket.messages += 1;
    handlers.onMessage(
      JSON.stringify({
        stream,
        data: { e: "kline", E: eventTimeMs, s: symbol, k: { t: k.openTimeMs, T: k.closeTimeMs, s: symbol, i: "15m", o: String(k.open), c: String(k.close), h: String(k.high), l: String(k.low), x: closed } },
      })
    );
  }

  // ---------------------------------------------------------------------------

  /** An expired outage is over AT its deadline (recorded with that instant), whenever it is first observed. */
  private expireOutage(): void {
    const active = this.outageState;
    if (active !== null && this.nowMs() >= active.deadlineMs) {
      this.endOutage("AUTO_RESTORED", `maximum duration ${Math.round(active.spec.maxDurationMs / 1000)}s reached: restored automatically`, active.deadlineMs);
    }
  }

  private endOutage(kind: "RESTORED" | "AUTO_RESTORED", detail: string, atMs: number = this.nowMs()): void {
    this.outageState = null;
    this.silentSince.clear();
    this.events.push({ atMs, kind, detail });
  }

  private assertUsable(): void {
    if (this.disposed) this.violate("the simulated network was disposed");
  }

  private violate(message: string): never {
    this.violations.push(message);
    throw new SimulatedNetworkViolation(message);
  }
}

function describe(spec: OutageSpec): string {
  const parts = [spec.rest && `rest ${spec.rest}`, spec.openStreams && `open streams ${spec.openStreams}`, spec.newStreams && `new streams ${spec.newStreams}`].filter(Boolean);
  return `${spec.label ? `${spec.label}: ` : ""}${parts.join(", ")} (max ${Math.round(spec.maxDurationMs / 1000)}s)`;
}

import { Emitter } from "@socket.io/redis-emitter";
import type { Alert as PrismaAlert } from "@prisma/client";
import { SOCKET_EVENTS } from "@trading-alert-dashboard/shared";

import { withAlertContext } from "../alerts/alert-context";

/**
 * LIVE DASHBOARD PUBLICATION for a COMMITTED Native alert — and nothing else.
 *
 * Cross-process by design, through the transport the dashboard already uses:
 * the Generic Backend's Socket.IO server runs the Redis adapter, and any
 * process that publishes through a Socket.IO Redis emitter reaches its browser
 * clients (the BullMQ worker already does exactly this). The Native emitter is
 * a separate process, so it publishes the same way. No new broker, channel,
 * queue, subscriber or HTTP endpoint exists.
 *
 * The event is the canonical one: `new_alert` with the committed Alert row
 * serialized by `withAlertContext`, exactly as a TradingView alert is pushed.
 * The browser tells them apart by `source`.
 *
 * Strictly presentation:
 *  - called only after the delivery transaction has COMMITTED;
 *  - validates before publishing: an Alert that is not a committed,
 *    non-actionable NATIVE row is never pushed;
 *  - never throws: a failed or slow publish is reported as an outcome and
 *    logged without content. The database stays the truth; a browser that
 *    missed the push sees the alert on its next normal refresh;
 *  - no screenshot, AI vision, Extreme RR, execution, notification channel or
 *    TradingView handling of any kind.
 */

/** Socket.IO's own Redis emitter needs only `publish`. */
export interface RedisPublisher {
  publish(channel: string, message: string | Buffer): Promise<unknown>;
}

export type LivePublishOutcome = "PUBLISHED" | "REFUSED" | "FAILED";

export const NATIVE_LIVE_PUBLISH_TIMEOUT_MS = 2_000;

/** Prisma cuid: lowercase alphanumerics. Anything else is not an Alert id this system wrote. */
const ALERT_ID = /^[a-z0-9]{20,40}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Why a row must not be pushed as a live Native alert, or null when it may. */
export function refuseLiveNativeAlert(alert: PrismaAlert): string | null {
  if (!isRecord(alert)) return "not an alert row";
  if (typeof alert.id !== "string" || !ALERT_ID.test(alert.id)) return "malformed alert id";
  if (alert.source !== "NATIVE") return "not a NATIVE alert";
  const payload = isRecord(alert.rawPayload) ? alert.rawPayload : null;
  if (payload === null || payload.actionable !== false) return "not a non-actionable Native payload";
  return null;
}

/**
 * Wraps a Redis client so the emitter's otherwise fire-and-forget `publish`
 * can be awaited and its failure caught — never an unhandled rejection.
 */
export function awaitableSocketEmit(client: RedisPublisher): (event: string, payload: unknown) => Promise<void> {
  let pending: Promise<unknown> | null = null;
  const capturing: RedisPublisher = {
    publish: (channel, message) => {
      pending = Promise.resolve(client.publish(channel, message));
      return pending;
    },
  };
  const emitter = new Emitter(capturing as never);
  return async (event, payload) => {
    pending = null;
    emitter.emit(event, payload);
    const published = pending as Promise<unknown> | null;
    if (published !== null) await published;
  };
}

export interface NativeAlertLivePublisherDeps {
  readonly emit: (event: string, payload: unknown) => Promise<void>;
  /** Content-free: an outcome and an error NAME, never a payload, URL or secret. */
  readonly log: (line: string) => void;
  readonly timeoutMs?: number;
}

export interface NativeAlertLivePublisher {
  /** Never throws. */
  publishCommitted(alert: PrismaAlert): Promise<LivePublishOutcome>;
}

export function createNativeAlertLivePublisher(deps: NativeAlertLivePublisherDeps): NativeAlertLivePublisher {
  const timeoutMs = deps.timeoutMs ?? NATIVE_LIVE_PUBLISH_TIMEOUT_MS;
  return {
    async publishCommitted(alert) {
      const refusal = refuseLiveNativeAlert(alert);
      if (refusal !== null) {
        deps.log(`live dashboard push skipped (${refusal})`);
        return "REFUSED";
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          deps.emit(SOCKET_EVENTS.NEW_ALERT, withAlertContext(alert)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs);
            timer.unref?.();
          }),
        ]);
        return "PUBLISHED";
      } catch (error) {
        deps.log(`live dashboard push failed (${error instanceof Error ? error.name : "unknown"}); the alert is committed and appears on the next refresh`);
        return "FAILED";
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

/**
 * The emitter process's live publisher, on its OWN connection to the same Redis
 * the Generic Backend's Socket.IO adapter listens on. Opened only for COMMIT
 * (a dry run never loads this module); `close` releases the connection.
 */
export async function openNativeAlertLivePublisher(log: (line: string) => void): Promise<{ publisher: NativeAlertLivePublisher; close: () => void }> {
  const { env } = await import("../../config/env");
  const { default: IORedis } = await import("ioredis");
  // Bounded: a Redis that is down fails a publish quickly instead of queueing it forever.
  const client = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  // Connection errors are expected while Redis is down; they never reach the delivery path.
  client.on("error", () => undefined);
  const publisher = createNativeAlertLivePublisher({ emit: awaitableSocketEmit(client), log });
  return { publisher, close: () => client.disconnect() };
}


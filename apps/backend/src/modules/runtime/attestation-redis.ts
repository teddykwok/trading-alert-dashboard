import Redis from "ioredis";

import { env } from "../../config/env";
import type { RuntimeAttestationRedis } from "./runtime-attestation";

/**
 * The DEDICATED Redis connection long-lived runtimes publish attestation on.
 *
 * ## Why this exists
 *
 * Both runtimes used to heartbeat over `bullConnection`, which BullMQ requires
 * to be built with `maxRetriesPerRequest: null`. That option is correct for
 * BullMQ and wrong for a heartbeat: in ioredis 5, the code that fails queued
 * commands is guarded by `typeof maxRetriesPerRequest === "number"`
 * (`built/redis/event_handler.js`), so with `null` a command is NEVER failed
 * for exhausting retries. Combined with the default offline queue, a command
 * issued while the link is down is queued and its promise simply never settles.
 *
 * That is exactly what a heartbeat must not do. A rejected publish is harmless
 * — the caller logs it and the next beat retries — but a publish that never
 * settles produces no error, no log and no heartbeat, and the attestation key
 * silently expires while the process still looks alive to every other observer.
 *
 * So the heartbeat gets its own connection with the opposite bias: fail fast,
 * say so, and try again on the next beat.
 *
 *   - `enableOfflineQueue: false` — a command issued while disconnected is
 *     rejected immediately instead of waiting for a reconnect that may never
 *     come.
 *   - a finite `maxRetriesPerRequest` — an in-flight command is failed rather
 *     than carried across unlimited reconnect attempts.
 *   - a bounded `connectTimeout` — connecting cannot hang either.
 *
 * None of this touches the BullMQ connection, whose reliability requirements
 * are unchanged. Isolation, not weakening.
 *
 * The remaining case none of these options covers is a half-open socket, where
 * the command is written to a link the OS still believes is up and no reply or
 * error ever arrives. `createRuntimeAttestationPublisher` bounds that with an
 * explicit per-publish timeout.
 */

/** Connecting is bounded; the same value the operator CLIs already use. */
export const ATTESTATION_REDIS_CONNECT_TIMEOUT_MS = 3_000;

/**
 * Finite ON PURPOSE. `null` is the BullMQ requirement and the precise reason
 * the heartbeat could hang; two reconnect attempts is generous for a beat that
 * repeats every five seconds.
 */
export const ATTESTATION_REDIS_MAX_RETRIES_PER_REQUEST = 2;

/**
 * How long a graceful QUIT may take before the socket is simply torn down.
 *
 * QUIT is a command like any other, so on the half-open socket described
 * above it can wait as long as a write would. Shutdown must not be the one
 * path that still hangs.
 */
export const ATTESTATION_REDIS_QUIT_TIMEOUT_MS = 1_000;

export interface AttestationRedisClient {
  redis: RuntimeAttestationRedis;
  /** Closes the connection. Safe to call when it was never established. */
  close(): Promise<void>;
}

/**
 * A log-safe description of a Redis failure.
 *
 * Deliberately reports the error's TYPE and errno code and never its message.
 * ioredis puts the endpoint it was dialling into messages (`connect
 * ECONNREFUSED host:port`), and the endpoint is part of `REDIS_URL` — so the
 * only way to guarantee a connection string cannot reach a log line is to never
 * pass the message through. The name and code carry the diagnosis anyway:
 * ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ECONNRESET and EPIPE each say plainly
 * what happened.
 */
export function describeRedisFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${error.name}(${code})` : error.name;
  }
  return "UnknownError";
}

/**
 * Builds the heartbeat connection.
 *
 * An ioredis client with no `error` listener re-emits as an uncaught exception,
 * which would turn a transient Redis blip into a dead worker — so the listener
 * is attached here rather than left to the caller to remember.
 */
export function createAttestationRedisClient(
  options: { onError?: (detail: string) => void } = {}
): AttestationRedisClient {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: ATTESTATION_REDIS_MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: false,
    connectTimeout: ATTESTATION_REDIS_CONNECT_TIMEOUT_MS,
  });

  client.on("error", (error) => options.onError?.(describeRedisFailure(error)));

  return {
    redis: client as unknown as RuntimeAttestationRedis,
    async close() {
      let timer: NodeJS.Timeout | undefined;
      try {
        // A clean QUIT when the link is up. A disconnected client rejects it
        // and an unresponsive one never answers; either way the socket is torn
        // down, which is the whole of what is left to do.
        await Promise.race([
          client.quit(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("attestation redis QUIT timed out")),
              ATTESTATION_REDIS_QUIT_TIMEOUT_MS
            );
            timer.unref?.();
          }),
        ]);
      } catch {
        client.disconnect();
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

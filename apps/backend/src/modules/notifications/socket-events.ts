import { Emitter } from "@socket.io/redis-emitter";
import Redis from "ioredis";
import type { Alert as PrismaAlert } from "@prisma/client";
import { SOCKET_EVENTS } from "@trading-alert-dashboard/shared";
import { env } from "../../config/env";

// Prisma's Alert type (Date objects, Json fields) is what the server and
// worker actually hold. It serializes over the socket wire into the shape
// described by the shared `Alert` type that the frontend consumes.
type Alert = PrismaAlert;

/**
 * A Redis-backed Socket.IO emitter. Both the Fastify server (webhook route)
 * and the separate BullMQ worker process publish through this emitter; the
 * Socket.IO server's Redis adapter (see plugins/socket.ts) picks the
 * messages up and broadcasts them to connected dashboard clients. This
 * decouples "who emits an event" from "who holds the live socket connections".
 */
const emitterRedisClient = new Redis(env.REDIS_URL);
const emitter = new Emitter(emitterRedisClient);

export function emitNewAlert(alert: Alert): void {
  emitter.emit(SOCKET_EVENTS.NEW_ALERT, alert);
}

export function emitAlertUpdated(alert: Alert): void {
  emitter.emit(SOCKET_EVENTS.ALERT_UPDATED, alert);
}

export function emitAlertFailed(alert: Alert): void {
  emitter.emit(SOCKET_EVENTS.ALERT_FAILED, alert);
}

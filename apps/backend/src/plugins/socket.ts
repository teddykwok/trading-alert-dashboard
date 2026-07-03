import { createAdapter } from "@socket.io/redis-adapter";
import fp from "fastify-plugin";
import { Server as SocketIOServer } from "socket.io";
import Redis from "ioredis";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env";

declare module "fastify" {
  interface FastifyInstance {
    io: SocketIOServer;
  }
}

/**
 * Attaches a Socket.IO server to the underlying HTTP server and wires it to
 * a Redis pub/sub adapter. The adapter is what lets the separate BullMQ
 * worker process (see modules/notifications/socket-events.ts) broadcast
 * events to clients connected to this server without sharing memory.
 */
export const socketPlugin = fp(async (app: FastifyInstance) => {
  const io = new SocketIOServer(app.server, {
    cors: {
      origin: env.FRONTEND_URL,
      methods: ["GET", "POST"],
    },
  });

  const pubClient = new Redis(env.REDIS_URL);
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  app.decorate("io", io);

  app.addHook("onClose", async () => {
    io.close();
    pubClient.disconnect();
    subClient.disconnect();
  });
});

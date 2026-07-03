import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

/**
 * Global, in-memory rate limiting. Good enough for a personal single-instance
 * deployment; swap for a Redis store if this ever runs behind multiple nodes.
 */
export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
});

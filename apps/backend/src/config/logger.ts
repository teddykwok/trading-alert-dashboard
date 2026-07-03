import pino from "pino";

/**
 * Plain (JSON-serializable) pino options, safe to hand to Fastify's own
 * `logger` option — Fastify constructs its own internal pino instance from
 * this rather than us passing a pre-built instance, which avoids type
 * mismatches between our pino version's Logger type and Fastify's.
 */
export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
};

// Standalone logger for non-Fastify contexts (the worker process, scripts).
export const logger = pino(loggerOptions);

import pino from "pino";

/**
 * Plain (JSON-serializable) pino options, safe to hand to Fastify's own
 * `logger` option — Fastify constructs its own internal pino instance from
 * this rather than us passing a pre-built instance, which avoids type
 * mismatches between our pino version's Logger type and Fastify's.
 */
export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  // Fastify's default request serializer does not include headers, so an
  // operator bearer token never reaches a log line today. This makes that
  // structural rather than incidental: if request logging is ever widened,
  // the credential still cannot be printed.
  redact: {
    paths: ["req.headers.authorization", "request.headers.authorization", "headers.authorization"],
    censor: "***REDACTED***",
  },
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

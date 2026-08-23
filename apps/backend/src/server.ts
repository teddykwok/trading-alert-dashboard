import { buildApp } from "./app";
import { env } from "./config/env";
import { createRuntimeAttestationPublisher } from "./modules/runtime/runtime-attestation";
import {
  createAttestationRedisClient,
  describeRedisFailure,
} from "./modules/runtime/attestation-redis";

async function start(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port: env.BACKEND_PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  // Phase 12.4D-A.1: only AFTER listen resolves, so the heartbeat never claims
  // a backend is ready before it actually is. It republishes the gate snapshot
  // this process parsed at import — an operator editing .env cannot change it
  // without restarting this process, which is the whole point of the interlock.
  // Its OWN bounded connection, never the BullMQ one: BullMQ requires
  // maxRetriesPerRequest=null, which is exactly the option that lets a command
  // wait forever rather than fail. See modules/runtime/attestation-redis.
  const attestationRedis = createAttestationRedisClient({
    onError: (detail) =>
      app.log.error({ detail }, "Runtime attestation Redis connection error"),
  });

  const attestation = createRuntimeAttestationPublisher({
    role: "BACKEND",
    redis: attestationRedis.redis,
    onError: (error) =>
      app.log.error({ detail: describeRedisFailure(error) }, "Runtime attestation heartbeat failed"),
  });
  attestation.start();

  // Best effort: TTL expiry remains the correctness mechanism after a crash.
  const shutdown = async () => {
    await attestation.stop();
    await attestationRedis.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

start();

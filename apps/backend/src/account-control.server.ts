// Phase 11F.1 -- MUST be the first import in this file.
//
// Static imports are hoisted and evaluated in source order. The generated
// Prisma client loads the repository `.env` at its own module initialization,
// and neither loader overrides what is already set -- so an import above this
// line would hand this process the repository's account instead of the one
// DOTENV_CONFIG_PATH names, with every log line reporting the wrong one.
import "./config/bootstrap-account";

import {
  checkAccountEnvIntegrity,
  describeAccountEnvVerdict,
} from "./config/account-env";

/**
 * Phase 11F — THE account control plane. One process, one account.
 *
 * ## Why this is a separate process rather than a route parameter
 *
 * Every operator control service resolves its account from PROCESS
 * ENVIRONMENT — `resolveExecutionProfile(prisma, configuredProfileIdentity())`
 * — at sixteen call sites. That is deliberate: the repository refuses to let a
 * request name an account, because a route that accepted `executionProfileId`
 * would be a profile enumeration API.
 *
 * The readiness route goes further. It reaches `bindConfiguredExchangeRuntime`
 * and performs SIGNED Binance account reads, so whichever process serves these
 * routes HOLDS an account's credentials. Serving two accounts from one process
 * would mean two credential sets in one heap — the thing 11B and 11D exist to
 * prevent, and it would need a secret registry this system does not have.
 *
 * So the account identity comes from this process's environment and nowhere
 * else. Two accounts means two of these, each with its own env file.
 *
 * ## What it deliberately does not serve
 *
 * No webhook: TradingView ingestion is global, happens exactly once, and lives
 * on the generic backend. No alert ingestion, no Socket.IO, no screenshots.
 *
 * ## Ordering
 *
 * The account-environment check runs FIRST, before anything that could read
 * configuration, resolve a profile, construct a signed client or publish
 * attestation. Everything after it is imported dynamically for exactly that
 * reason: a static import would run `config/env` at module load, ahead of the
 * check.
 */

async function start(): Promise<void> {
  const envFilePath = process.env.DOTENV_CONFIG_PATH;

  // Note the import order: `config/env` has NOT been loaded yet, so this reads
  // the environment as the launcher left it plus whatever dotenv/config will
  // apply. dotenv does not override what is already set, which is precisely the
  // failure this detects.
  const verdict = checkAccountEnvIntegrity({
    envFilePath,
    effective: process.env,
  });
  if (!verdict.ok) {
    // eslint-disable-next-line no-console -- the logger loads config/env.
    console.error(describeAccountEnvVerdict(verdict, envFilePath));
    console.error("Account control did NOT start. No profile was resolved and no client was built.");
    process.exit(1);
  }

  const { env } = await import("./config/env");

  // Phase 11F: credential presence is no longer a global config rule, so it
  // is asserted HERE, before anything else happens.
  //
  // The readiness route reaches `bindConfiguredExchangeRuntime` and performs
  // signed reads, so this process IS an account -- and an account control
  // plane that listened, answered /health and published a BACKEND
  // attestation while holding no credentials would be counted as a live
  // runtime by the activation interlock and could never act. Refusing here
  // is earlier than the first signed request and earlier than attestation.
  //
  // The canonical seam decides, so there is one answer to 'are credentials
  // configured', shared with every binding site.
  const { resolveConfiguredExchangeCredentials } = await import(
    "./modules/execution/exchange-runtime-binding"
  );
  const credentials = resolveConfiguredExchangeCredentials();
  if (!credentials.ok) {
    // Reason code and the variable NAMES the seam reports. Never a value.
    // eslint-disable-next-line no-console -- the logger is not built yet.
    console.error(
      `account credentials: ${credentials.reasonCode} - ${credentials.message}`
    );
    console.error(
      "Account control did NOT start. No app was built, nothing listened and no " +
        "attestation was published."
    );
    process.exit(1);
  }

  const { buildAccountControlApp } = await import("./app");
  const { createRuntimeAttestationPublisher } = await import("./modules/runtime/runtime-attestation");
  const { createAttestationRedisClient, describeRedisFailure } = await import(
    "./modules/runtime/attestation-redis"
  );

  const app = await buildAccountControlApp();

  // A port is REQUIRED and has no default. The generic backend owns 4000; an
  // account control plane that silently defaulted anywhere would either fight
  // it for the port or appear on one nobody configured.
  if (env.ACCOUNT_CONTROL_PORT === undefined) {
    app.log.error("ACCOUNT_CONTROL_PORT is not set. Account control did NOT start.");
    process.exit(1);
  }

  try {
    // Loopback by DEFAULT. This is an operator control plane holding an
    // account's credentials; it must not become externally reachable merely
    // because it was given a different port from the public backend. Exposing
    // it is an explicit act, never an accident.
    await app.listen({ port: env.ACCOUNT_CONTROL_PORT, host: env.ACCOUNT_CONTROL_HOST });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  app.log.info(
    { reasonCode: verdict.reasonCode, host: env.ACCOUNT_CONTROL_HOST, port: env.ACCOUNT_CONTROL_PORT },
    "Account control plane listening"
  );

  // Phase 11F: the BACKEND attestation moved here from the generic server.
  // Activation requires one fresh BACKEND and one fresh WORKER for the SAME
  // account identity, and after this slice only an account-bound process can be
  // either. The generic backend publishes none, exactly as the generic worker
  // has published none since 11E.
  const attestationRedis = createAttestationRedisClient({
    onError: (detail) => app.log.error({ detail }, "Runtime attestation Redis connection error"),
  });

  const attestation = createRuntimeAttestationPublisher({
    role: "BACKEND",
    redis: attestationRedis.redis,
    // Phase 11F: the first beat waits for a writable link instead of racing it.
    waitUntilReady: attestationRedis.waitUntilReady,
    onError: (error) =>
      app.log.error({ detail: describeRedisFailure(error) }, "Runtime attestation heartbeat failed"),
  });
  attestation.start();

  const shutdown = async (): Promise<void> => {
    // Withdraws only THIS instance's key: the key carries this process's own
    // instanceId, so another account's control plane is untouched.
    await attestation.stop();
    await attestationRedis.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void start().catch((error) => {
  // eslint-disable-next-line no-console -- the logger may not be loaded yet.
  console.error(
    "Account control bootstrap threw:",
    error instanceof Error ? error.message.slice(0, 300) : "unknown"
  );
  process.exit(1);
});

import { bootstrapRuntimeEnv, describeRuntimeEnvFailure } from "./runtime-env";

/**
 * Phase 11F.1 -- import this FIRST in a generic entrypoint.
 *
 * A side-effect module rather than a function call, because static imports are
 * hoisted: `bootstrapRuntimeEnv("GENERIC")` written in the entrypoint body
 * would run after every sibling import had already been evaluated, and the
 * generated Prisma client would have loaded the repository `.env` by then.
 * Being the first import is the only placement that runs first.
 *
 * A generic process holds no account. If it ends up holding one, this refuses
 * to let it start rather than letting it attest as a live runtime while
 * carrying another account's key.
 */
try {
  bootstrapRuntimeEnv("GENERIC");
} catch (error) {
  // eslint-disable-next-line no-console -- the logger is not configured yet.
  console.error(describeRuntimeEnvFailure(error));
  console.error("Generic process did NOT start.");
  process.exit(1);
}

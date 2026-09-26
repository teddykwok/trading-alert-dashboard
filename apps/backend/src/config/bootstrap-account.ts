import { bootstrapRuntimeEnv, describeRuntimeEnvFailure } from "./runtime-env";

/**
 * Phase 11F.1 -- import this FIRST in an account-bound entrypoint.
 *
 * See `bootstrap-generic` for why this is an import rather than a call. The
 * account variant additionally compares the account file against what the
 * launching shell inherited, BEFORE anything is written to `process.env`, and
 * refuses a disagreement. That check is worthless once a loader has run, which
 * is exactly why it lives at the very front of the process.
 */
try {
  bootstrapRuntimeEnv("ACCOUNT");
} catch (error) {
  // eslint-disable-next-line no-console -- the logger is not configured yet.
  console.error(describeRuntimeEnvFailure(error));
  console.error(
    "Account process did NOT start. No profile was resolved, no exchange client " +
      "was constructed and nothing was attested."
  );
  process.exit(1);
}

import type { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import {
  classifyBinanceFuturesEnvironment,
  connectorEnvironmentMatches,
} from "../binance/binance-environment";
import { resolveExecutionProfile, type ProfileResolutionFailure } from "./execution-profile.service";

/**
 * Proof that an ExecutionProfile and the Binance connector THIS PROCESS IS
 * CONFIGURED AGAINST describe the same environment.
 *
 * ## Why a type rather than a check
 *
 * An authenticated Binance response belongs to whichever credentials produced
 * it. The fill ledger is scoped by `executionProfileId`, so ingestion needs
 * both — and if they arrive as two independent arguments, nothing stops
 * `ingestUserTrades(someOtherProfileId, trades)` from compiling and running.
 * That would file one environment's fills under another's history, and no later
 * check could tell, because the rows would look perfectly well-formed. The
 * existing predicate cannot prevent it: a caller who never calls it is
 * indistinguishable from one who did.
 *
 * So the binding is a THING rather than a step. A future ingestion entry point
 * takes this context instead of a bare id, and the only way to obtain one is to
 * have it built from the process's own configuration.
 *
 * ## Why the connector is not a parameter
 *
 * It used to be, defaulted from configuration — and that quietly reopened the
 * hole from the other side. There is ONE process-global Binance client, so a
 * caller who passed a different sanctioned origin could obtain a context whose
 * environment did not describe the client that would actually issue the
 * request: a TESTNET-looking context over a MAINNET connector. Both halves must
 * come from the same authoritative configuration or the pair proves nothing, so
 * neither is accepted from the caller. The compile-time contract at the bottom
 * of this file keeps it that way.
 *
 * ## What it does NOT prove
 *
 * ENVIRONMENT ONLY — which is why the type says so in its name. It does not
 * prove that `accountIdentifier` names the account those API keys authenticate
 * as: that field is an operator-chosen alias, and the repository holds no
 * exchange-issued account identity to compare it against. Credentials are also
 * process-global today, so there is exactly one account in play and "which
 * profile do these keys belong to" is answered by configuration rather than by
 * evidence. Multi-account support must introduce credential resolution per
 * ExecutionProfile before more than one profile can be ingested safely; until
 * then this context is the honest limit of what can be asserted.
 */

/**
 * The brand is a module-private symbol, so a value of this type cannot be
 * written by hand anywhere else. Construction is the factory or nothing.
 */
declare const environmentBound: unique symbol;

export interface EnvironmentBoundBinanceExecutionProfile {
  readonly [environmentBound]: true;
  /** The profile resolved from configuration — never a caller's argument. */
  readonly executionProfileId: string;
  /**
   * The one environment both sides agree on. Stored once rather than as a
   * profile value and a connector value, because a context only exists when
   * they are equal; keeping two fields would invite a comparison that is
   * already settled.
   */
  readonly environment: "TESTNET" | "MAINNET";
  /**
   * The rest of the profile's NON-SECRET identity, carried so a caller that
   * holds this context never has to go and look the profile up again -- and,
   * more importantly, cannot look up a DIFFERENT one while believing it is
   * describing this binding.
   *
   * `accountIdentifier` is the operator-chosen alias. It is not a credential,
   * not an exchange-issued account number, and safe to print.
   */
  readonly exchange: string;
  readonly product: string;
  readonly accountIdentifier: string;
}

/**
 * Why a binding could not be made.
 *
 * Reuses the profile resolver's own failures plus the canonical
 * `PROFILE_ENVIRONMENT_MISMATCH` that SafetyAdmission already reports for this
 * exact condition. No new taxonomy: an operator reading "profile environment
 * does not match the connector" should not have to learn that it means
 * something different here.
 */
export type BinanceProfileBindingFailure = ProfileResolutionFailure | "PROFILE_ENVIRONMENT_MISMATCH";

export type BinanceProfileBindingResult =
  | { ok: true; context: EnvironmentBoundBinanceExecutionProfile }
  | { ok: false; reasonCode: BinanceProfileBindingFailure; message: string };

/**
 * Binds the CONFIGURED profile to the CONFIGURED connector, or explains why it
 * cannot.
 *
 * Takes neither a profile id nor a connector: both come from the same process
 * configuration the rest of the system runs on, so the resulting context cannot
 * describe a pairing that does not exist. A result rather than a throw, matching
 * `resolveExecutionProfile` — the future ingestion subsystem refuses to ACTIVATE
 * on a failure, which is a decision it makes rather than an exception it
 * catches.
 */
export async function bindConfiguredExecutionProfileEnvironment(
  prisma: PrismaClient
): Promise<BinanceProfileBindingResult> {
  const resolution = await resolveExecutionProfile(prisma);
  if (!resolution.ok) {
    return { ok: false, reasonCode: resolution.reasonCode, message: resolution.message };
  }

  const profile = resolution.profile;
  const configuredConnector = env.BINANCE_FUTURES_REST_BASE_URL;

  // The canonical predicate, the same one SafetyAdmission and the entry
  // lifecycle call. Classification, origin allowlisting and every spoof
  // defence live there and are deliberately not repeated here.
  if (!connectorEnvironmentMatches(profile.environment, configuredConnector)) {
    const connector = classifyBinanceFuturesEnvironment(configuredConnector);
    return {
      ok: false,
      reasonCode: "PROFILE_ENVIRONMENT_MISMATCH",
      // Same code, different sentence: an unrecognised host is a typo or an
      // unapproved endpoint, while a recognised one is a crossed pair. They
      // need different operator actions, and only the message can say so.
      message:
        connector === "UNKNOWN"
          ? "The configured Binance REST base URL is not a recognised USD-M origin, so no environment can be proven."
          : `Execution profile is ${profile.environment} but the configured Binance connector is ${connector}.`,
    };
  }

  return {
    ok: true,
    context: {
      executionProfileId: profile.id,
      environment: profile.environment,
      exchange: profile.exchange,
      product: profile.product,
      accountIdentifier: profile.accountIdentifier,
    } as EnvironmentBoundBinanceExecutionProfile,
  };
}

/**
 * The factory takes the database handle and NOTHING else.
 *
 * Enforced here, in a typechecked source file, rather than in a test: the test
 * project is excluded from `tsc`, so a contract asserted there would not
 * actually be checked. Adding a second parameter — including an optional or
 * defaulted one, which is exactly how the connector override crept in before —
 * makes `Parameters<...>` stop matching `[PrismaClient]` and fails the build.
 */
type ExactTuple<A extends readonly unknown[], B extends readonly unknown[]> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const bindingTakesOnlyPrisma: ExactTuple<
  Parameters<typeof bindConfiguredExecutionProfileEnvironment>,
  [PrismaClient]
> = true;
void bindingTakesOnlyPrisma;

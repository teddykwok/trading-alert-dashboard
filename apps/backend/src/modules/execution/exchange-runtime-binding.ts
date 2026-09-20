import type { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import {
  bindConfiguredExecutionProfileEnvironment,
  type BinanceProfileBindingFailure,
  type EnvironmentBoundBinanceExecutionProfile,
} from "./binance-profile-binding";

/**
 * The exchange credentials and the execution profile THIS PROCESS IS
 * CONFIGURED AS, resolved together and only together.
 *
 * ## The hole this closes
 *
 * Every Binance client constructor reads `options.apiKey ?? env.BINANCE_API_KEY`.
 * That default is invisible at the call site: a production composition could
 * write `new BinanceUsdMExecutionClient({ readOnlyClient: undefined })` and
 * silently authenticate as whatever account the process environment happened to
 * name. With one configured profile per process that is correct by accident --
 * configuration and credentials cannot disagree when there is only one of each.
 * The moment a second profile exists it becomes a way to submit one account's
 * order with another account's key, and nothing in the type system would object.
 *
 * So credentials stop being ambient here. Production composition asks for them
 * explicitly, and what it receives is bound to the configured profile rather
 * than floating free.
 *
 * ## Two entry points, deliberately
 *
 * `resolveConfiguredExchangeCredentials()` is SYNCHRONOUS and reads only
 * configuration. It exists because several production compositions are built
 * synchronously -- the orchestration scheduler among them -- and making them
 * async to fetch a profile row would change scheduler construction, which is a
 * different slice's problem. It takes NO arguments, so it cannot be pointed at
 * one profile while the process runs as another.
 *
 * `bindConfiguredExchangeRuntime()` is the full context: the profile resolved
 * from configuration, its environment already agreed with the connector, and
 * those same credentials, in one branded value. Callers that already bind
 * asynchronously should take this, because it is the only form that PROVES the
 * two halves came from the same place.
 *
 * ## What this still does not prove
 *
 * That these keys authenticate as `accountIdentifier`. The repository holds no
 * exchange-issued account identity to compare against, and this slice makes no
 * signed call to ask. Credentials remain process-global: ONE account per
 * process, changed only by editing configuration and restarting. Running two
 * accounts in one process is still unsafe, and remains so until runtime
 * construction and reconciliation are themselves profile-scoped.
 */

/** Construction is the factory or nothing; the brand is module-private. */
declare const exchangeRuntimeBound: unique symbol;

/**
 * Signed-request credentials for the configured account.
 *
 * `toJSON` is overridden so a stray `JSON.stringify` of a context, a log line
 * or a serialized error cannot carry key material out of the process. It is a
 * backstop, not the policy: the policy is that these values are passed to a
 * client constructor and nowhere else.
 */
export interface ExchangeCredentials {
  readonly apiKey: string;
  readonly apiSecret: string;
  toJSON(): string;
}

/**
 * The NON-SECRET half of a bound runtime, for the many services that need to
 * know which profile this process owns and nothing else.
 *
 * `accountIdentifier` is deliberately ABSENT. Most consumers -- database
 * discovery, recovery ownership, environment-dependent judgements -- need an
 * id and at most an environment, and an operator alias that travels further
 * than it must is one more thing that can end up in a log line. A service
 * that genuinely needs the alias should take a narrower projection of its
 * own rather than widen this one.
 *
 * Derived ONLY by `profileProjectionOf`, from an already-bound runtime, so a
 * projection cannot describe a profile that was never proven.
 */
export interface BoundExecutionProfileProjection {
  readonly executionProfileId: string;
  readonly exchange: string;
  readonly product: string;
  readonly environment: "TESTNET" | "MAINNET";
}

export interface BoundExchangeRuntime {
  readonly [exchangeRuntimeBound]: true;
  /** The configured profile, with its environment already agreed. */
  readonly profile: EnvironmentBoundBinanceExecutionProfile;
  readonly credentials: ExchangeCredentials;
}

/** Why a runtime could not be bound. */
export type ExchangeRuntimeBindingFailure =
  | BinanceProfileBindingFailure
  | "EXCHANGE_CREDENTIALS_MISSING";

export type ExchangeCredentialsResult =
  | { ok: true; credentials: ExchangeCredentials }
  | { ok: false; reasonCode: "EXCHANGE_CREDENTIALS_MISSING"; message: string };

export type BoundExchangeRuntimeResult =
  | { ok: true; runtime: BoundExchangeRuntime }
  | { ok: false; reasonCode: ExchangeRuntimeBindingFailure; message: string };

/** The redacted stand-in every serialization of credentials produces. */
export const CREDENTIALS_REDACTED = "[redacted]";

function credentialsOf(apiKey: string, apiSecret: string): ExchangeCredentials {
  return {
    apiKey,
    apiSecret,
    // Never the values, on any serialization path.
    toJSON: () => CREDENTIALS_REDACTED,
  };
}

/**
 * The configured account's credentials, or an explicit refusal.
 *
 * FAILS CLOSED. An absent key or secret is not "unsigned mode": it is a process
 * that cannot prove which account it is, and a signed client built from it would
 * fail at the exchange with a message an operator has to decode. Refusing here
 * names the missing variable instead.
 *
 * The message names the VARIABLE, never a value -- there is no length, no
 * prefix and no suffix of either secret anywhere in this module's output.
 */
export function resolveConfiguredExchangeCredentials(): ExchangeCredentialsResult {
  const apiKey = env.BINANCE_API_KEY;
  const apiSecret = env.BINANCE_API_SECRET;

  const missing: string[] = [];
  if (apiKey.trim() === "") missing.push("BINANCE_API_KEY");
  if (apiSecret.trim() === "") missing.push("BINANCE_API_SECRET");

  if (missing.length > 0) {
    return {
      ok: false,
      reasonCode: "EXCHANGE_CREDENTIALS_MISSING",
      message: `${missing.join(" and ")} must be configured before a signed exchange client can be built.`,
    };
  }

  return { ok: true, credentials: credentialsOf(apiKey, apiSecret) };
}

/**
 * A synchronous composition asked for credentials the process does not have.
 *
 * Thrown rather than returned, because the only callers are composition sites
 * that have no branch to take: a scheduler or a worker being built cannot
 * "continue without credentials" -- continuing means constructing a signed
 * client that will reach the exchange. Failing here means no client object
 * exists, so no signed request is reachable.
 *
 * The message names the missing VARIABLE and carries no value. It is produced
 * by `resolveConfiguredExchangeCredentials`, so there is exactly one place
 * where "configured" is decided.
 */
export class ExchangeCredentialsMissingError extends Error {
  readonly reasonCode = "EXCHANGE_CREDENTIALS_MISSING";

  constructor(detail: string) {
    super(detail);
    this.name = "ExchangeCredentialsMissingError";
  }
}

/**
 * The credential options a client constructor is handed, always explicitly.
 *
 * FAILS CLOSED, synchronously, BEFORE a client exists. An absent key or secret
 * used to be passed on as two empty strings, which built a perfectly ordinary
 * signed client that failed later, at the exchange, with a message about a
 * signature rather than about configuration. Worse, "two empty strings" is a
 * value -- it can be logged, compared, and mistaken for a configured account.
 *
 * Throwing means the composition never completes: no `BinanceReadOnlyClient`,
 * no `BinanceUsdMExecutionClient`, and therefore no signed request possible.
 * Nothing is logged here and no network or database call is made; the caller
 * decides how loudly to die.
 *
 * Delegates to `resolveConfiguredExchangeCredentials` -- the validation is not
 * repeated, only its refusal is turned into a throw for callers that cannot
 * branch.
 *
 * Use this at synchronous composition sites. Callers that can refuse early --
 * anything already binding a profile asynchronously -- should take
 * `bindConfiguredExchangeRuntime` instead and act on its failure.
 */
export function configuredExchangeClientOptions(): { apiKey: string; apiSecret: string } {
  const resolved = resolveConfiguredExchangeCredentials();
  if (!resolved.ok) {
    throw new ExchangeCredentialsMissingError(resolved.message);
  }
  return { apiKey: resolved.credentials.apiKey, apiSecret: resolved.credentials.apiSecret };
}

/**
 * Binds the CONFIGURED profile and the CONFIGURED credentials into one context.
 *
 * Takes the database handle and nothing else, for the same reason the profile
 * binder does: a caller who could name the profile could pair it with the
 * process's credentials and obtain a context asserting a relationship that does
 * not exist.
 */
export async function bindConfiguredExchangeRuntime(
  prisma: PrismaClient
): Promise<BoundExchangeRuntimeResult> {
  const binding = await bindConfiguredExecutionProfileEnvironment(prisma);
  if (!binding.ok) {
    return { ok: false, reasonCode: binding.reasonCode, message: binding.message };
  }

  const credentials = resolveConfiguredExchangeCredentials();
  if (!credentials.ok) {
    return { ok: false, reasonCode: credentials.reasonCode, message: credentials.message };
  }

  return {
    ok: true,
    runtime: {
      profile: binding.context,
      credentials: credentials.credentials,
    } as BoundExchangeRuntime,
  };
}

/**
 * The non-secret view of a bound runtime.
 *
 * Takes the RUNTIME, never a profile id: a projection can only ever describe
 * the profile this process actually bound, so a caller cannot manufacture one
 * pointing somewhere else. Carries no credential, so it is safe to hand to a
 * database-only service.
 */
export function profileProjectionOf(
  runtime: BoundExchangeRuntime
): BoundExecutionProfileProjection {
  return {
    executionProfileId: runtime.profile.executionProfileId,
    exchange: runtime.profile.exchange,
    product: runtime.profile.product,
    environment: runtime.profile.environment,
  };
}

/**
 * The credential options a client constructor is handed, FROM A BOUND RUNTIME.
 *
 * This is the production composition surface. `configuredExchangeClientOptions`
 * remains for the narrow synchronous cases that have no runtime to hand, but an
 * account-specific production path should reach credentials through the runtime
 * it also took its profile from -- that pairing is the whole point, and two
 * independent lookups cannot be proven to agree.
 */
export function exchangeClientOptionsOf(runtime: BoundExchangeRuntime): {
  apiKey: string;
  apiSecret: string;
} {
  return { apiKey: runtime.credentials.apiKey, apiSecret: runtime.credentials.apiSecret };
}

/**
 * Both factories take exactly what they are allowed to take.
 *
 * Asserted in a typechecked source file rather than a test, because the test
 * project is excluded from `tsc`. Adding a parameter -- including an optional
 * one, which is how a profile selector would most plausibly arrive -- stops
 * these tuples matching and fails the build.
 */
type ExactTuple<A extends readonly unknown[], B extends readonly unknown[]> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const credentialsTakeNothing: ExactTuple<
  Parameters<typeof resolveConfiguredExchangeCredentials>,
  []
> = true;
void credentialsTakeNothing;

const clientOptionsTakeNothing: ExactTuple<
  Parameters<typeof configuredExchangeClientOptions>,
  []
> = true;
void clientOptionsTakeNothing;

const runtimeBindingTakesOnlyPrisma: ExactTuple<
  Parameters<typeof bindConfiguredExchangeRuntime>,
  [PrismaClient]
> = true;
void runtimeBindingTakesOnlyPrisma;

/** A projection and client options come from a RUNTIME, never from an id. */
const projectionTakesOnlyARuntime: ExactTuple<
  Parameters<typeof profileProjectionOf>,
  [BoundExchangeRuntime]
> = true;
void projectionTakesOnlyARuntime;

const clientOptionsTakeOnlyARuntime: ExactTuple<
  Parameters<typeof exchangeClientOptionsOf>,
  [BoundExchangeRuntime]
> = true;
void clientOptionsTakeOnlyARuntime;

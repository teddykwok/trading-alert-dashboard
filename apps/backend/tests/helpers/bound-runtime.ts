import type {
  BoundExchangeRuntime,
  BoundExecutionProfileProjection,
} from "../../src/modules/execution/exchange-runtime-binding";

/**
 * Synthetic bound runtimes, for tests that need a shape rather than a binding.
 *
 * Production code can only obtain a `BoundExchangeRuntime` from
 * `bindConfiguredExchangeRuntime`, which is the point: the brand makes the
 * pairing of a proven profile with the configured credentials unforgeable. A
 * test that wants to exercise a service ONE layer below that binding needs a
 * value of the same shape, and the cast here is where that concession is made
 * -- once, visibly, in a helper that never ships.
 *
 * The credentials are obvious fakes and the profile ids are caller-supplied, so
 * nothing here can be mistaken for, or resolve to, a real account.
 */

export const TEST_API_KEY = "test-bound-runtime-api-key";
export const TEST_API_SECRET = "test-bound-runtime-api-secret";

/** The non-secret half: what most services actually take. */
export function testProfileProjection(
  overrides: Partial<BoundExecutionProfileProjection> = {}
): BoundExecutionProfileProjection {
  return {
    executionProfileId: "profile-1",
    exchange: "BINANCE",
    product: "USD_M_FUTURES",
    environment: "TESTNET",
    ...overrides,
  };
}

/**
 * The full context, branded by assertion.
 *
 * `credentials.toJSON` is kept faithful to production: a stray serialization in
 * a test must redact exactly as it would in the worker, or the redaction tests
 * would be proving something about the helper instead of about the code.
 */
export function testBoundRuntime(
  overrides: Partial<BoundExecutionProfileProjection> & {
    accountIdentifier?: string;
    apiKey?: string;
    apiSecret?: string;
  } = {}
): BoundExchangeRuntime {
  const {
    accountIdentifier = "test-account",
    apiKey = TEST_API_KEY,
    apiSecret = TEST_API_SECRET,
    ...profileOverrides
  } = overrides;
  const projection = testProfileProjection(profileOverrides);

  return {
    profile: {
      executionProfileId: projection.executionProfileId,
      environment: projection.environment,
      exchange: projection.exchange,
      product: projection.product,
      accountIdentifier,
    },
    credentials: {
      apiKey,
      apiSecret,
      toJSON: () => "[redacted]",
    },
  } as unknown as BoundExchangeRuntime;
}

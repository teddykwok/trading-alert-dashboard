import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The credential/profile runtime seam, without a database where possible.
 *
 * What is proved here is the CONTRACT: credentials come from configuration and
 * nowhere else, an absent one fails closed by NAME rather than by value, and no
 * serialization path can carry key material out of the process.
 */

const KEY = "unit-test-api-key-000000000000000000";
const SECRET = "unit-test-api-secret-00000000000000";

/** Re-imports the module under a pinned environment, since `env` is frozen at load. */
async function withEnv(overrides: Record<string, string | undefined>) {
  const previous = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
  const module = await import("../src/modules/execution/exchange-runtime-binding");
  return {
    module,
    restore: () => {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, previous);
    },
  };
}

let restoreEnv: (() => void) | null = null;

afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
  vi.resetModules();
});

describe("credentials come from configuration and fail closed", () => {
  it("resolves the configured pair", async () => {
    const { module, restore } = await withEnv({
      BINANCE_API_KEY: KEY,
      BINANCE_API_SECRET: SECRET,
    });
    restoreEnv = restore;

    const result = module.resolveConfiguredExchangeCredentials();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.apiKey).toBe(KEY);
    expect(result.credentials.apiSecret).toBe(SECRET);
  });

  const MISSING: ReadonlyArray<readonly [string, Record<string, string | undefined>, string]> = [
    ["the key is absent", { BINANCE_API_KEY: undefined, BINANCE_API_SECRET: SECRET }, "BINANCE_API_KEY"],
    ["the secret is absent", { BINANCE_API_KEY: KEY, BINANCE_API_SECRET: undefined }, "BINANCE_API_SECRET"],
    ["the key is blank", { BINANCE_API_KEY: "   ", BINANCE_API_SECRET: SECRET }, "BINANCE_API_KEY"],
    ["the secret is blank", { BINANCE_API_KEY: KEY, BINANCE_API_SECRET: "" }, "BINANCE_API_SECRET"],
    ["both are absent", { BINANCE_API_KEY: undefined, BINANCE_API_SECRET: undefined }, "BINANCE_API_KEY"],
  ];

  for (const [description, overrides, named] of MISSING) {
    it(`refuses when ${description}, naming the variable`, async () => {
      const { module, restore } = await withEnv(overrides);
      restoreEnv = restore;

      const result = module.resolveConfiguredExchangeCredentials();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reasonCode).toBe("EXCHANGE_CREDENTIALS_MISSING");
      expect(result.message).toContain(named);
      // The message names the VARIABLE, never a value.
      expect(result.message).not.toContain(KEY);
      expect(result.message).not.toContain(SECRET);
    });
  }
});

describe("credentials cannot be serialized out of the process", () => {
  it("JSON.stringify of the credentials yields only the redacted marker", async () => {
    const { module, restore } = await withEnv({
      BINANCE_API_KEY: KEY,
      BINANCE_API_SECRET: SECRET,
    });
    restoreEnv = restore;

    const result = module.resolveConfiguredExchangeCredentials();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialized = JSON.stringify(result.credentials);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain(module.CREDENTIALS_REDACTED);
  });

  it("stringifying a whole object that holds them leaks nothing", async () => {
    const { module, restore } = await withEnv({
      BINANCE_API_KEY: KEY,
      BINANCE_API_SECRET: SECRET,
    });
    restoreEnv = restore;

    const result = module.resolveConfiguredExchangeCredentials();
    if (!result.ok) throw new Error("expected credentials");

    // The shape a diagnostic or a log line would most plausibly take.
    const serialized = JSON.stringify({ note: "diagnostic", credentials: result.credentials });
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(SECRET);
  });
});

describe("the synchronous client-options helper fails closed", () => {
  /**
   * C. Both present -> the configured pair, explicitly.
   */
  it("returns the configured pair when both are set", async () => {
    const { module, restore } = await withEnv({
      BINANCE_API_KEY: KEY,
      BINANCE_API_SECRET: SECRET,
    });
    restoreEnv = restore;

    expect(module.configuredExchangeClientOptions()).toEqual({ apiKey: KEY, apiSecret: SECRET });
  });

  /**
   * A and B, separately: an absent key and an absent secret are distinct
   * misconfigurations and each must refuse on its own. Proved one at a time
   * rather than together so a resolver that only ever checked the key would
   * still fail case B.
   */
  const MISSING_ONE: ReadonlyArray<readonly [string, Record<string, string | undefined>, string, string]> = [
    ["A: the key is absent", { BINANCE_API_KEY: undefined, BINANCE_API_SECRET: SECRET }, "BINANCE_API_KEY", "BINANCE_API_SECRET"],
    ["B: the secret is absent", { BINANCE_API_KEY: KEY, BINANCE_API_SECRET: undefined }, "BINANCE_API_SECRET", "BINANCE_API_KEY"],
  ];

  for (const [description, overrides, named, notNamed] of MISSING_ONE) {
    it(`${description} -> throws synchronously, naming only that variable`, async () => {
      const { module, restore } = await withEnv(overrides);
      restoreEnv = restore;

      // SYNCHRONOUS: no promise, nothing to await, nothing already in flight.
      let thrown: unknown;
      try {
        module.configuredExchangeClientOptions();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(module.ExchangeCredentialsMissingError);
      const error = thrown as InstanceType<typeof module.ExchangeCredentialsMissingError>;
      expect(error.reasonCode).toBe("EXCHANGE_CREDENTIALS_MISSING");
      expect(error.message).toContain(named);
      expect(error.message).not.toContain(notNamed);
    });
  }

  it("a blank-but-present value refuses exactly like an absent one", async () => {
    const { module, restore } = await withEnv({ BINANCE_API_KEY: "   ", BINANCE_API_SECRET: SECRET });
    restoreEnv = restore;

    expect(() => module.configuredExchangeClientOptions()).toThrow(
      module.ExchangeCredentialsMissingError
    );
  });

  it("never returns the empty-string pair that used to stand in for missing credentials", async () => {
    // The regression this replaces: two empty strings are a VALUE. They build an
    // ordinary signed client that fails much later, at the exchange, with a
    // message about a signature rather than about configuration.
    const { module, restore } = await withEnv({
      BINANCE_API_KEY: undefined,
      BINANCE_API_SECRET: undefined,
    });
    restoreEnv = restore;

    let returned: unknown = "did not return";
    try {
      returned = module.configuredExchangeClientOptions();
    } catch {
      returned = "threw";
    }
    expect(returned).toBe("threw");
    expect(returned).not.toEqual({ apiKey: "", apiSecret: "" });
  });

  /**
   * D. The refusal carries no credential material -- neither the value that is
   * present nor any fragment of it.
   */
  it("the refusal contains no credential values", async () => {
    const { module, restore } = await withEnv({
      BINANCE_API_KEY: KEY,
      BINANCE_API_SECRET: undefined,
    });
    restoreEnv = restore;

    let thrown: unknown;
    try {
      module.configuredExchangeClientOptions();
    } catch (error) {
      thrown = error;
    }

    const error = thrown as Error;
    const surfaces = [error.message, String(error), error.stack ?? ""];
    for (const surface of surfaces) {
      expect(surface).not.toContain(KEY);
      expect(surface).not.toContain(SECRET);
      // Not a prefix either: a "first six characters" diagnostic is still a leak.
      expect(surface).not.toContain(KEY.slice(0, 8));
      expect(surface).not.toContain(SECRET.slice(0, 8));
    }
  });

  /**
   * E. No exchange client is constructed and no request is made.
   *
   * The production shape is `new BinanceReadOnlyClient(configuredExchangeClientOptions())`.
   * JavaScript evaluates the argument BEFORE the constructor runs, so a throw
   * from the helper means the client object never comes into existence -- which
   * is the whole point of failing here rather than at signing time. This drives
   * the REAL client class through that exact shape and proves both halves:
   * nothing was constructed, and `fetch` was never reached.
   */
  it("constructs no Binance client and issues no request when credentials are missing", async () => {
    const { module, restore } = await withEnv({
      BINANCE_API_KEY: undefined,
      BINANCE_API_SECRET: undefined,
    });
    restoreEnv = restore;

    const { BinanceReadOnlyClient } = await import("../src/modules/binance/binance.client");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    let constructed = 0;
    const composeLikeProduction = () => {
      const options = module.configuredExchangeClientOptions();
      // Only reachable once options resolve; the production sites are written
      // as a single expression, which is strictly stronger.
      constructed += 1;
      return new BinanceReadOnlyClient(options);
    };

    expect(composeLikeProduction).toThrow(module.ExchangeCredentialsMissingError);
    expect(constructed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("resolving credentials performs no request even when they are present", async () => {
    const { module, restore } = await withEnv({
      BINANCE_API_KEY: KEY,
      BINANCE_API_SECRET: SECRET,
    });
    restoreEnv = restore;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    module.configuredExchangeClientOptions();
    module.resolveConfiguredExchangeCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

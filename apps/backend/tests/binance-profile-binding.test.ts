import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { BINANCE_MAINNET_FUTURES_ORIGIN } from "../src/modules/binance/binance-environment";
import { BINANCE_TESTNET_ORIGIN } from "../src/modules/binance/testnet-verifier/testnet-config";

/**
 * The bound context, and only the bound context.
 *
 * Origin classification, trailing slashes, malformed URLs, spoofed hostnames
 * and the legacy sanctioned origin are already the responsibility of
 * `binance-environment.test.ts`, which owns the canonical matcher. Repeating
 * that matrix here would create the second copy this repository has already
 * been bitten by once. These tests ask a different question: can a binding
 * exist when it should not?
 */

const BACKEND = path.resolve(__dirname, "..");
const SOURCE = path.join(BACKEND, "src", "modules", "execution", "binance-profile-binding.ts");
const ORIGINAL_IDENTIFIER = process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER;
const ORIGINAL_ENVIRONMENT = process.env.EXECUTION_PROFILE_ENVIRONMENT;
const ORIGINAL_BASE_URL = process.env.BINANCE_FUTURES_REST_BASE_URL;

/** A prisma stub answering only what profile resolution reads. */
function prismaWith(profile: Record<string, unknown> | null): PrismaClient {
  return {
    executionProfile: {
      findMany: vi.fn(async () => (profile === null ? [] : [profile])),
    },
  } as unknown as PrismaClient;
}

const profileRow = (environment: "TESTNET" | "MAINNET", accountIdentifier = "primary-futures") => ({
  id: `profile-${environment.toLowerCase()}`,
  accountIdentifier,
  environment,
  isEnabled: true,
  safetyPolicy: { id: "policy-1" },
});

/**
 * Drives the connector through CONFIGURATION, which is the only way the
 * factory will read it.
 *
 * This is also the test seam: the base URL is set on `process.env` and the
 * module graph is reset, so `src/config/env.ts` re-parses and the factory sees
 * the value a real process would. Nothing is injected past the public
 * signature, so these tests exercise exactly the production construction path
 * — and they would fail if the factory ever stopped reading configuration.
 */
async function bind(configuredConnector: string, profile: Record<string, unknown> | null) {
  process.env.BINANCE_FUTURES_REST_BASE_URL = configuredConnector;
  vi.resetModules();
  const { bindConfiguredExecutionProfileEnvironment } = await import(
    "../src/modules/execution/binance-profile-binding"
  );
  return bindConfiguredExecutionProfileEnvironment(prismaWith(profile));
}

beforeEach(() => {
  process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = "primary-futures";
  process.env.EXECUTION_PROFILE_ENVIRONMENT = "MAINNET";
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_IDENTIFIER === undefined) delete process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER;
  else process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = ORIGINAL_IDENTIFIER;
  if (ORIGINAL_ENVIRONMENT === undefined) delete process.env.EXECUTION_PROFILE_ENVIRONMENT;
  else process.env.EXECUTION_PROFILE_ENVIRONMENT = ORIGINAL_ENVIRONMENT;
  if (ORIGINAL_BASE_URL === undefined) delete process.env.BINANCE_FUTURES_REST_BASE_URL;
  else process.env.BINANCE_FUTURES_REST_BASE_URL = ORIGINAL_BASE_URL;
  vi.resetModules();
});

describe("a Binance execution profile binding exists only when both sides agree", () => {
  it("A. a MAINNET profile binds to the MAINNET connector", async () => {
    const result = await bind(BINANCE_MAINNET_FUTURES_ORIGIN, profileRow("MAINNET"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.environment).toBe("MAINNET");
    expect(result.context.executionProfileId).toBe("profile-mainnet");
  });

  it("B. a TESTNET profile binds to the sanctioned testnet connector", async () => {
    process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";
    const result = await bind(BINANCE_TESTNET_ORIGIN, profileRow("TESTNET"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.environment).toBe("TESTNET");
  });

  it("C. a TESTNET profile cannot bind to the MAINNET connector", async () => {
    process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";
    const result = await bind(BINANCE_MAINNET_FUTURES_ORIGIN, profileRow("TESTNET"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe("PROFILE_ENVIRONMENT_MISMATCH");
    expect(result.message).toContain("TESTNET");
    expect(result.message).toContain("MAINNET");
  });

  it("D. a MAINNET profile cannot bind to a testnet connector", async () => {
    const result = await bind(BINANCE_TESTNET_ORIGIN, profileRow("MAINNET"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe("PROFILE_ENVIRONMENT_MISMATCH");
  });

  it("E. an unrecognised connector origin can bind to nothing", async () => {
    // Not a second classifier: the canonical matcher answers UNKNOWN and this
    // refuses on it. The message differs because the operator action does --
    // an unapproved host is a typo, not a crossed pair.
    for (const environment of ["MAINNET", "TESTNET"] as const) {
      process.env.EXECUTION_PROFILE_ENVIRONMENT = environment;
      vi.resetModules();
      const result = await bind("https://fapi.binance.com.evil.example", profileRow(environment));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reasonCode).toBe("PROFILE_ENVIRONMENT_MISMATCH");
      expect(result.message).toContain("not a recognised");
    }
  });

  it("F. the account alias has no bearing on the binding", async () => {
    // It is an operator-chosen label, not evidence. A binding must not become
    // easier or harder because of what someone typed there.
    for (const alias of ["primary-futures", "MAINNET", "testnet", "", "  spaced  "]) {
      vi.resetModules();
      const result = await bind(BINANCE_TESTNET_ORIGIN, profileRow("MAINNET", alias));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reasonCode).toBe("PROFILE_ENVIRONMENT_MISMATCH");
    }

    // And no alias value rescues, or spoils, a pair that already agrees.
    for (const alias of ["", "wrong-label", "TESTNET"]) {
      vi.resetModules();
      const result = await bind(BINANCE_MAINNET_FUTURES_ORIGIN, profileRow("MAINNET", alias));
      expect(result.ok).toBe(true);
    }
  });

  it("G. the bound id is the RESOLVED profile, never a caller's argument", async () => {
    // The whole point of the type. The factory takes no profile id, so there is
    // no parameter through which an unrelated one could arrive.
    const result = await bind(BINANCE_MAINNET_FUTURES_ORIGIN, profileRow("MAINNET"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.executionProfileId).toBe("profile-mainnet");

    // Neither an id nor a connector can be handed in: the factory's only
    // parameter is the database handle, which is asserted at compile time in
    // the module itself (`bindingTakesOnlyPrisma`) and observable here.
    const { bindConfiguredExecutionProfileEnvironment } = await import(
      "../src/modules/execution/binance-profile-binding"
    );
    expect(bindConfiguredExecutionProfileEnvironment.length).toBe(1);
  });

  it("H. a caller cannot name a connector to manufacture a passing context", async () => {
    // The hole this revision closes. There is ONE global Binance client, so a
    // context built against a base URL the caller chose could describe an
    // environment the real client is not using -- a TESTNET-looking context
    // over a MAINNET connector. The configured connector is MAINNET here, and a
    // TESTNET profile must be refused no matter what any caller would prefer.
    process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";
    const result = await bind(BINANCE_MAINNET_FUTURES_ORIGIN, profileRow("TESTNET"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe("PROFILE_ENVIRONMENT_MISMATCH");

    // And the factory exposes no second parameter through which one could be
    // supplied, defaulted or otherwise.
    const { bindConfiguredExecutionProfileEnvironment } = await import(
      "../src/modules/execution/binance-profile-binding"
    );
    expect(bindConfiguredExecutionProfileEnvironment.length).toBe(1);
    const source = readFileSync(SOURCE, "utf8");
    expect(source).toContain("Parameters<typeof bindConfiguredExecutionProfileEnvironment>");
  });

  it("a profile that cannot be resolved cannot be bound, and says why", async () => {
    const result = await bind(BINANCE_MAINNET_FUTURES_ORIGIN, null);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The resolver's own reason travels through unchanged.
    expect(result.reasonCode).toBe("PROFILE_NOT_FOUND");
  });

  it("H. binding needs no exchange request, and retains no credential", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await bind(BINANCE_MAINNET_FUTURES_ORIGIN, profileRow("MAINNET"));

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A plain, loggable value: the profile's NON-SECRET identity and nothing
    // else. The set grew in 11B so a holder of this context never has to look
    // the profile up again -- `accountIdentifier` is the operator-chosen alias,
    // not an exchange account number and not a credential.
    expect(Object.keys(result.context).sort()).toEqual([
      "accountIdentifier",
      "environment",
      "exchange",
      "executionProfileId",
      "product",
    ]);
    // Still nothing credential-shaped in the value itself.
    expect(JSON.stringify(result.context)).not.toMatch(/apiKey|apiSecret|secret/i);

    const source = readFileSync(SOURCE, "utf8");
    for (const forbidden of ["apiKey", "apiSecret", "BINANCE_API_KEY", "BINANCE_API_SECRET"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("classification is delegated, never re-implemented here", async () => {
    // The defect this repository already fixed once was two copies of the same
    // host test drifting apart. There must not be a third.
    const source = readFileSync(SOURCE, "utf8");
    expect(source).toContain("connectorEnvironmentMatches");
    expect(source).not.toContain("fapi.binance.com");
    expect(source).not.toMatch(/new URL\(/);
    expect(source).not.toMatch(/includes\(["'].*testnet/i);
  });
});

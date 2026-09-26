import { describe, expect, it } from "vitest";

import {
  ACCOUNT_IDENTITY_KEYS,
  checkAccountEnvIntegrity,
  describeAccountEnvVerdict,
} from "../src/config/account-env";

/**
 * Phase 11F — an account process must have loaded the account file it names.
 *
 * `config/env.ts` starts with `import "dotenv/config"`, and dotenv's `override`
 * defaults to FALSE. A variable already in the environment therefore beats the
 * file. Launch Account B from a shell still exporting Account A's identity and
 * the process reads B's file, keeps A's key, resolves A's profile and signs as
 * A — while every log line says B. Profile, credentials and attestation are all
 * consistent with each other and all wrong, so nothing downstream can catch it.
 *
 * These cases are about that one failure and its boundaries.
 */

const A_FILE = "apps/backend/.env.account-a";

function fileWith(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

describe("account env integrity", () => {
  it("agrees when the file's identity is the identity in force", () => {
    const verdict = checkAccountEnvIntegrity({
      envFilePath: A_FILE,
      effective: {
        BINANCE_API_KEY: "synthetic-a-key",
        BINANCE_API_SECRET: "synthetic-a-secret",
        EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "synthetic-account-a",
        EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
      },
      readFile: () =>
        fileWith({
          BINANCE_API_KEY: "synthetic-a-key",
          BINANCE_API_SECRET: "synthetic-a-secret",
          EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "synthetic-account-a",
          EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
        }),
    });
    expect(verdict).toEqual({ ok: true, reasonCode: "ACCOUNT_ENV_FILE_HONOURED" });
  });

  it("REFUSES when an inherited value overrides the account file", () => {
    // The dangerous case, exactly: B's file is named, A's identity is in force.
    const verdict = checkAccountEnvIntegrity({
      envFilePath: "apps/backend/.env.account-b",
      effective: {
        BINANCE_API_KEY: "synthetic-a-key",
        BINANCE_API_SECRET: "synthetic-a-secret",
        EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "synthetic-account-a",
        EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
      },
      readFile: () =>
        fileWith({
          BINANCE_API_KEY: "synthetic-b-key",
          BINANCE_API_SECRET: "synthetic-b-secret",
          EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "synthetic-account-b",
          EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
        }),
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reasonCode).toBe("ACCOUNT_ENV_CONFLICT");
    // Every disagreeing key is named; the matching one is not a conflict.
    expect(verdict.conflictingKeys).toEqual([
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER",
    ]);
  });

  it("names the variable and never its value", () => {
    const verdict = checkAccountEnvIntegrity({
      envFilePath: A_FILE,
      effective: { EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "leaky-inherited-identity" },
      readFile: () => fileWith({ EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "leaky-file-identity" }),
    });
    const described = describeAccountEnvVerdict(verdict, A_FILE);

    expect(described).toContain("ACCOUNT_ENV_CONFLICT");
    expect(described).toContain("EXECUTION_PROFILE_ACCOUNT_IDENTIFIER");
    for (const secret of ["leaky-inherited-identity", "leaky-file-identity"]) {
      expect(`value in message: ${described.includes(secret)}`).toBe("value in message: false");
    }
  });

  it("treats a missing variable in force as a conflict when the file states one", () => {
    // Not a nicety: an account process whose credential never reached it would
    // otherwise fail later, further from the cause, as a credential error.
    const verdict = checkAccountEnvIntegrity({
      envFilePath: A_FILE,
      effective: {},
      readFile: () => fileWith({ BINANCE_API_KEY: "synthetic-a-key" }),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.conflictingKeys).toEqual(["BINANCE_API_KEY"]);
  });

  it("does not invent a conflict for a variable the file never claims", () => {
    // Shared settings — database, Redis — are inherited on purpose. Only the
    // four identity keys can make a process the wrong account.
    const verdict = checkAccountEnvIntegrity({
      envFilePath: A_FILE,
      effective: { BINANCE_API_KEY: "synthetic-a-key", DATABASE_URL: "inherited" },
      readFile: () => fileWith({ BINANCE_API_KEY: "synthetic-a-key" }),
    });
    expect(verdict).toEqual({ ok: true, reasonCode: "ACCOUNT_ENV_FILE_HONOURED" });
  });

  it("is a no-op when no account file was named", () => {
    // The single-account deployment that predates 11F: there is no second
    // opinion to disagree with, so there is nothing to refuse.
    const verdict = checkAccountEnvIntegrity({ envFilePath: undefined, effective: {} });
    expect(verdict).toEqual({ ok: true, reasonCode: "NO_ACCOUNT_ENV_FILE" });
  });

  it("refuses an unreadable account file rather than continuing", () => {
    const verdict = checkAccountEnvIntegrity({
      envFilePath: A_FILE,
      effective: {},
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reasonCode).toBe("ACCOUNT_ENV_UNREADABLE");
  });

  it("guards exactly the four variables that decide which account this is", () => {
    expect([...ACCOUNT_IDENTITY_KEYS]).toEqual([
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER",
      "EXECUTION_PROFILE_ENVIRONMENT",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Two synthetic accounts, side by side
// ---------------------------------------------------------------------------

describe("two account processes, synthetic identities only", () => {
  const A = {
    BINANCE_API_KEY: "synthetic-a-key",
    BINANCE_API_SECRET: "synthetic-a-secret",
    EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "synthetic-account-a",
    EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
  };
  const B = {
    BINANCE_API_KEY: "synthetic-b-key",
    BINANCE_API_SECRET: "synthetic-b-secret",
    EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "synthetic-account-b",
    EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
  };

  it("each accepts only its own file, and cross-launches are refused", () => {
    expect(
      checkAccountEnvIntegrity({ envFilePath: "a", effective: A, readFile: () => fileWith(A) }).ok
    ).toBe(true);
    expect(
      checkAccountEnvIntegrity({ envFilePath: "b", effective: B, readFile: () => fileWith(B) }).ok
    ).toBe(true);
    // A's environment with B's file, and the reverse: both refused.
    expect(
      checkAccountEnvIntegrity({ envFilePath: "b", effective: A, readFile: () => fileWith(B) }).ok
    ).toBe(false);
    expect(
      checkAccountEnvIntegrity({ envFilePath: "a", effective: B, readFile: () => fileWith(A) }).ok
    ).toBe(false);
  });
});

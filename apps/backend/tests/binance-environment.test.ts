import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BINANCE_LEGACY_TESTNET_FUTURES_ORIGIN,
  BINANCE_MAINNET_FUTURES_ORIGIN,
  classifyBinanceFuturesEnvironment,
  connectorEnvironmentMatches,
} from "../src/modules/binance/binance-environment";
import { BINANCE_TESTNET_ORIGIN } from "../src/modules/binance/testnet-verifier/testnet-config";

/**
 * The bug this file exists for.
 *
 * `safety-admission.service.ts` and `entry-lifecycle.service.ts` each carried
 * their own copy of `host.includes("testnet")`. The repository's sanctioned
 * testnet origin is `https://demo-fapi.binance.com`, which does not contain the
 * word "testnet", so the sanctioned TESTNET connector was classified MAINNET and
 * every TESTNET profile was refused with PROFILE_ENVIRONMENT_MISMATCH — making
 * the supported testnet path impossible to exercise end to end.
 */

describe("binance environment classification: the original defect", () => {
  it("classifies the sanctioned demo-fapi testnet origin as TESTNET", () => {
    // THE regression. Under `host.includes("testnet")` this returned MAINNET,
    // because "demo-fapi.binance.com" contains no such substring.
    expect(BINANCE_TESTNET_ORIGIN).toBe("https://demo-fapi.binance.com");
    expect(BINANCE_TESTNET_ORIGIN.includes("testnet")).toBe(false);
    expect(classifyBinanceFuturesEnvironment(BINANCE_TESTNET_ORIGIN)).toBe("TESTNET");
  });

  it("lets a TESTNET profile match the sanctioned testnet connector", () => {
    expect(connectorEnvironmentMatches("TESTNET", BINANCE_TESTNET_ORIGIN)).toBe(true);
  });
});

describe("binance environment classification: known origins", () => {
  it.each([
    [BINANCE_TESTNET_ORIGIN, "TESTNET"],
    [BINANCE_LEGACY_TESTNET_FUTURES_ORIGIN, "TESTNET"],
    [BINANCE_MAINNET_FUTURES_ORIGIN, "MAINNET"],
  ])("%s -> %s", (url, expected) => {
    expect(classifyBinanceFuturesEnvironment(url)).toBe(expected);
  });

  it("keeps the MAINNET origin classified as MAINNET and matching a MAINNET profile", () => {
    // No behaviour regression for the live configuration.
    expect(BINANCE_MAINNET_FUTURES_ORIGIN).toBe("https://fapi.binance.com");
    expect(connectorEnvironmentMatches("MAINNET", BINANCE_MAINNET_FUTURES_ORIGIN)).toBe(true);
  });

  it("normalizes case, trailing slash and default port", () => {
    for (const variant of [
      "HTTPS://FAPI.BINANCE.COM",
      "https://fapi.binance.com/",
      "https://fapi.binance.com:443",
      "  https://fapi.binance.com  ",
    ]) {
      expect(`${variant}:${classifyBinanceFuturesEnvironment(variant)}`).toBe(`${variant}:MAINNET`);
    }
  });
});

describe("binance environment classification: crossing is refused", () => {
  it("refuses a TESTNET profile against the MAINNET connector", () => {
    expect(connectorEnvironmentMatches("TESTNET", BINANCE_MAINNET_FUTURES_ORIGIN)).toBe(false);
  });

  it("refuses a MAINNET profile against either testnet connector", () => {
    expect(connectorEnvironmentMatches("MAINNET", BINANCE_TESTNET_ORIGIN)).toBe(false);
    expect(connectorEnvironmentMatches("MAINNET", BINANCE_LEGACY_TESTNET_FUTURES_ORIGIN)).toBe(false);
  });
});

describe("binance environment classification: unknown fails closed", () => {
  it.each([
    ["https://testnet.binancefuture.example", "a reserved documentation host"],
    ["https://demo-fapi.binance.com.attacker.example", "a lookalike that CONTAINS the sanctioned host"],
    ["https://testnet.evil.example", "a lookalike that contains the word testnet"],
    ["https://fapi.binance.com.evil.example", "a lookalike that contains the mainnet host"],
    ["https://fapi.binance.com:8443", "a non-default port"],
    ["http://fapi.binance.com", "plain http"],
    ["not-a-url", "an unparseable value"],
    ["", "an empty value"],
  ])("%s is UNKNOWN (%s)", (url) => {
    expect(classifyBinanceFuturesEnvironment(url)).toBe("UNKNOWN");
  });

  it("matches NOTHING when the origin is unknown", () => {
    // The old heuristic answered MAINNET for anything unrecognised, so a typo
    // silently satisfied a MAINNET profile. An unknown connector now matches
    // neither environment and execution refuses.
    for (const profile of ["TESTNET", "MAINNET"]) {
      expect(`${profile}:${connectorEnvironmentMatches(profile, "https://typo.example")}`).toBe(`${profile}:false`);
    }
  });

  it("never uses substring matching", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/modules/binance/binance-environment.ts"),
      "utf8"
    );
    // Comments are stripped first: the doc comment deliberately NAMES the old
    // heuristic, and that prose must neither fail nor satisfy this assertion.
    const code = source
      .split(/\r?\n/)
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join(" ");
    expect(code).not.toContain('includes("testnet")');
    expect(code).toContain("new URL(");
    expect(code).toContain(".origin");
  });
});

describe("binance environment classification: one shared source of truth", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), "src/modules/execution", file), "utf8");

  it("both SafetyAdmission and EntryLifecycle call the shared predicate", () => {
    // The drift this module exists to prevent: one file recognising an origin
    // the other does not.
    for (const file of ["safety-admission.service.ts", "entry-lifecycle.service.ts"]) {
      const code = read(file);
      expect(`${file}:imports`).toBe(`${file}:${code.includes("binance-environment") ? "imports" : "MISSING"}`);
      expect(`${file}:calls`).toBe(
        `${file}:${code.includes("connectorEnvironmentMatches(") ? "calls" : "MISSING"}`
      );
      // And neither keeps a private heuristic of its own.
      expect(`${file}:substring`).toBe(`${file}:${code.includes('includes("testnet")') ? "PRESENT" : "substring"}`);
    }
  });
});

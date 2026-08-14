import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROTECTION_PRICE_PROTECT,
  DEFAULT_STOP_WORKING_TYPE,
  DEFAULT_TAKE_PROFIT_WORKING_TYPE,
  PROTECTION_WORKING_TYPES,
  protectionWorkingType,
  resolveProtectionPolicy,
} from "../src/modules/execution/protection-policy";

/**
 * The single home of the role-specific protection policy.
 *
 * A stop and a take profit trigger on DIFFERENT price feeds, and `workingType`
 * is a field the production identity comparator judges. The Phase 20 demo
 * verifier used to submit MARK_PRICE for both roles, so it never exercised the
 * real TAKE_PROFIT identity — the same class of parity gap that let Mainnet
 * Canary #2 through. These tests pin the rule and its single source.
 */

describe("protection working-type policy", () => {
  it("defaults the stop to MARK_PRICE and the take profit to CONTRACT_PRICE", () => {
    expect(DEFAULT_STOP_WORKING_TYPE).toBe("MARK_PRICE");
    expect(DEFAULT_TAKE_PROFIT_WORKING_TYPE).toBe("CONTRACT_PRICE");
    expect(DEFAULT_PROTECTION_PRICE_PROTECT).toBe(false);
    expect(PROTECTION_WORKING_TYPES).toEqual(["MARK_PRICE", "CONTRACT_PRICE"]);
  });

  it("resolves the documented defaults from an empty environment", () => {
    const policy = resolveProtectionPolicy({});
    expect(policy).toEqual({
      stopWorkingType: "MARK_PRICE",
      takeProfitWorkingType: "CONTRACT_PRICE",
      priceProtect: false,
    });
  });

  it("maps each role to its own configured working type", () => {
    const policy = resolveProtectionPolicy({});
    // The rule the verifier and the production service now share.
    expect(protectionWorkingType("STOP_LOSS", policy)).toBe("MARK_PRICE");
    expect(protectionWorkingType("TAKE_PROFIT", policy)).toBe("CONTRACT_PRICE");
    // The two roles must NOT resolve to the same value under the defaults.
    expect(protectionWorkingType("STOP_LOSS", policy)).not.toBe(protectionWorkingType("TAKE_PROFIT", policy));
  });

  it("honours an explicit override for either role", () => {
    const policy = resolveProtectionPolicy({
      EXECUTION_SL_WORKING_TYPE: "CONTRACT_PRICE",
      EXECUTION_TP_WORKING_TYPE: "MARK_PRICE",
      EXECUTION_PROTECTION_PRICE_PROTECT: "true",
    });
    expect(protectionWorkingType("STOP_LOSS", policy)).toBe("CONTRACT_PRICE");
    expect(protectionWorkingType("TAKE_PROFIT", policy)).toBe("MARK_PRICE");
    expect(policy.priceProtect).toBe(true);
  });

  it("treats a blank value as unset rather than invalid", () => {
    expect(resolveProtectionPolicy({ EXECUTION_TP_WORKING_TYPE: "   " }).takeProfitWorkingType).toBe("CONTRACT_PRICE");
  });

  it("refuses an explicit but invalid value rather than defaulting it away", () => {
    for (const raw of ["LAST_PRICE", "mark_price", "TRUE", "0"]) {
      expect(() => resolveProtectionPolicy({ EXECUTION_SL_WORKING_TYPE: raw }), raw).toThrow(
        /EXECUTION_SL_WORKING_TYPE/
      );
    }
    expect(() => resolveProtectionPolicy({ EXECUTION_PROTECTION_PRICE_PROTECT: "yes" })).toThrow(
      /EXECUTION_PROTECTION_PRICE_PROTECT/
    );
  });

  it("has no imports, so config/env and the testnet verifier can both use it", () => {
    const source = readFileSync(path.join(process.cwd(), "src/modules/execution/protection-policy.ts"), "utf8");
    expect(/^\s*import\s/m.test(source)).toBe(false);
  });
});

describe("single source of truth", () => {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  it("has the env schema derive its defaults from the shared module", () => {
    const env = read("src/config/env.ts");
    expect(env).toContain("DEFAULT_STOP_WORKING_TYPE");
    expect(env).toContain("DEFAULT_TAKE_PROFIT_WORKING_TYPE");
    // The literals must not be re-typed in the schema.
    expect(env).not.toMatch(/EXECUTION_SL_WORKING_TYPE[\s\S]{0,120}\.default\("MARK_PRICE"\)/);
    expect(env).not.toMatch(/EXECUTION_TP_WORKING_TYPE[\s\S]{0,120}\.default\("CONTRACT_PRICE"\)/);
  });

  it("has the production service resolve the role rule through the shared module", () => {
    const service = read("src/modules/execution/protection-lifecycle.service.ts");
    expect(service).toContain("protectionWorkingType(");
    // The inline ternary that used to encode the rule is gone.
    expect(service).not.toMatch(/role === "STOP_LOSS" \? workingTypeStop : workingTypeTakeProfit/);
  });

  it("leaves NO hard-coded working-type policy in the testnet verifier", () => {
    const verifier = read("src/modules/binance/testnet-verifier/testnet-verifier.ts");
    expect(verifier).toContain("protectionWorkingType(");
    // The verifier must not name a working type literal anywhere: that is how
    // it came to submit MARK_PRICE for a TAKE_PROFIT.
    const code = verifier.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain('"MARK_PRICE"');
    expect(code).not.toContain('"CONTRACT_PRICE"');
  });
});

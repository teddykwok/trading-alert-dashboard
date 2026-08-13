import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  BINANCE_TESTNET_ORIGIN,
  resolveTestnetConfig,
  validateTestnetOrigin,
  type TestnetEnvironmentInput,
} from "../src/modules/binance/testnet-verifier/testnet-config";
import { classifyAlgoProbe } from "../src/modules/binance/testnet-verifier/testnet-algo-probe";
import {
  buildProbeClientAlgoId,
  deriveIdentities,
  generateRunId,
  ownsIdentity,
} from "../src/modules/binance/testnet-verifier/testnet-identities";
import {
  planLongTriggers,
  planMarketableLimitPrice,
  planMinimumQuantity,
} from "../src/modules/binance/testnet-verifier/testnet-sizing";
import {
  compareDecimal,
  formatDecimal,
  parseDecimal,
  parsePositiveDecimal,
  snapToGrid,
} from "../src/modules/binance/testnet-verifier/testnet-decimal";
import { MemoryStateStore, parseVerifierState } from "../src/modules/binance/testnet-verifier/testnet-state";
import { BINANCE_CLIENT_ORDER_ID_PATTERN } from "../src/modules/execution/execution-safety";
import {
  createTestnetMutationClients,
  createTestnetProbeClients,
} from "../src/modules/binance/testnet-verifier/testnet-clients";

/**
 * Phase 20B — fail-closed gates, identities, exact math and probe semantics.
 *
 * Entirely pure: no network, no filesystem writes, no database. The point of
 * this suite is that every REFUSAL happens before a Binance client can exist.
 */

const VERIFIER_DIR = path.join(process.cwd(), "src/modules/binance/testnet-verifier");

const GOOD: TestnetEnvironmentInput = {
  BINANCE_TESTNET_PROTECTION_VERIFY: "true",
  BINANCE_TESTNET_API_KEY: "demo-key-000000000000000000",
  BINANCE_TESTNET_API_SECRET: "demo-secret-00000000000000",
  BINANCE_TESTNET_BASE_URL: BINANCE_TESTNET_ORIGIN,
};

const refusal = (input: TestnetEnvironmentInput) => {
  const decision = resolveTestnetConfig(input);
  return decision.ok ? null : decision.reasonCode;
};

// ---------------------------------------------------------------------------
// Configuration gate
// ---------------------------------------------------------------------------

describe("testnet configuration gate", () => {
  it("accepts a complete, correct configuration", () => {
    const decision = resolveTestnetConfig(GOOD);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    // The canonical constant is used, never the operator's raw string.
    expect(decision.config.baseUrl).toBe(BINANCE_TESTNET_ORIGIN);
  });

  it("refuses unless the operator gate is exactly \"true\"", () => {
    for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes"]) {
      expect(refusal({ ...GOOD, BINANCE_TESTNET_PROTECTION_VERIFY: value }), String(value)).toBe("VERIFY_GATE_CLOSED");
    }
  });

  it("refuses when any dedicated testnet variable is missing", () => {
    expect(refusal({ ...GOOD, BINANCE_TESTNET_API_KEY: undefined })).toBe("TESTNET_API_KEY_MISSING");
    expect(refusal({ ...GOOD, BINANCE_TESTNET_API_KEY: "   " })).toBe("TESTNET_API_KEY_MISSING");
    expect(refusal({ ...GOOD, BINANCE_TESTNET_API_SECRET: undefined })).toBe("TESTNET_API_SECRET_MISSING");
    expect(refusal({ ...GOOD, BINANCE_TESTNET_BASE_URL: undefined })).toBe("TESTNET_BASE_URL_MISSING");
  });

  it("has NO fallback to the production names", () => {
    // Production values present and correct; testnet values absent. This must
    // still refuse — there is no inheritance path of any kind.
    const decision = resolveTestnetConfig({
      BINANCE_TESTNET_PROTECTION_VERIFY: "true",
      BINANCE_API_KEY: "production-key-1111111111",
      BINANCE_API_SECRET: "production-secret-1111111",
    });
    expect(decision.ok).toBe(false);
  });

  it("refuses when the testnet credentials equal the production credentials", () => {
    expect(
      refusal({ ...GOOD, BINANCE_API_KEY: GOOD.BINANCE_TESTNET_API_KEY, BINANCE_API_SECRET: "other" })
    ).toBe("TESTNET_CREDENTIALS_MATCH_PRODUCTION");
    expect(
      refusal({ ...GOOD, BINANCE_API_KEY: "other", BINANCE_API_SECRET: GOOD.BINANCE_TESTNET_API_SECRET })
    ).toBe("TESTNET_CREDENTIALS_MATCH_PRODUCTION");
  });

  it("never puts a credential in the refusal message", () => {
    const decision = resolveTestnetConfig({
      ...GOOD,
      BINANCE_API_KEY: GOOD.BINANCE_TESTNET_API_KEY,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.message).not.toContain(GOOD.BINANCE_TESTNET_API_KEY as string);
    expect(decision.message).not.toContain(GOOD.BINANCE_TESTNET_API_SECRET as string);
  });
});

// ---------------------------------------------------------------------------
// Exact-origin protection
// ---------------------------------------------------------------------------

describe("exact origin protection", () => {
  it("accepts only the documented demo origin", () => {
    expect(validateTestnetOrigin(BINANCE_TESTNET_ORIGIN)).toBeNull();
    expect(validateTestnetOrigin(`  ${BINANCE_TESTNET_ORIGIN}  `)).toBeNull();
    // A single trailing slash is still a bare origin.
    expect(validateTestnetOrigin(`${BINANCE_TESTNET_ORIGIN}/`)).toBeNull();
  });

  it("refuses MAINNET", () => {
    for (const host of ["https://fapi.binance.com", "https://api.binance.com", "https://dapi.binance.com"]) {
      expect(validateTestnetOrigin(host)?.reasonCode, host).toBe("TESTNET_ORIGIN_NOT_ALLOWED");
    }
  });

  it("refuses http and every non-https scheme", () => {
    for (const url of [
      "http://demo-fapi.binance.com",
      "ws://demo-fapi.binance.com",
      "ftp://demo-fapi.binance.com",
    ]) {
      expect(validateTestnetOrigin(url)?.reasonCode, url).toBe("TESTNET_ORIGIN_NOT_ALLOWED");
    }
  });

  it("refuses lookalike hostnames that a substring check would accept", () => {
    for (const url of [
      "https://demo-fapi.binance.com.attacker.example",
      "https://demo-fapi.binance.com.evil.co",
      "https://demo-fapi-binance.com",
      "https://demo.fapi.binance.com",
      "https://x-demo-fapi.binance.com",
      "https://demo-fapi.binance.co",
      "https://DEMO-FAPI.BINANCE.COM.evil.example",
    ]) {
      expect(validateTestnetOrigin(url)?.reasonCode, url).toBe("TESTNET_ORIGIN_NOT_ALLOWED");
    }
  });

  it("refuses an unexpected port", () => {
    expect(validateTestnetOrigin("https://demo-fapi.binance.com:8443")?.reasonCode).toBe("TESTNET_ORIGIN_NOT_ALLOWED");
  });

  it("refuses embedded userinfo", () => {
    expect(validateTestnetOrigin("https://user:pw@demo-fapi.binance.com")?.reasonCode).toBe(
      "TESTNET_URL_EMBEDS_CREDENTIALS"
    );
    expect(validateTestnetOrigin("https://token@demo-fapi.binance.com")?.reasonCode).toBe(
      "TESTNET_URL_EMBEDS_CREDENTIALS"
    );
  });

  it("refuses a path, query or fragment pretending to be the origin", () => {
    for (const url of [
      "https://demo-fapi.binance.com/fapi",
      "https://demo-fapi.binance.com/?host=demo-fapi.binance.com",
      "https://demo-fapi.binance.com/#https://demo-fapi.binance.com",
      "https://attacker.example/https://demo-fapi.binance.com",
    ]) {
      const reason = validateTestnetOrigin(url)?.reasonCode;
      expect(["TESTNET_URL_NOT_BARE_ORIGIN", "TESTNET_ORIGIN_NOT_ALLOWED"], url).toContain(reason);
    }
  });

  it("refuses an unparseable URL", () => {
    for (const url of ["demo-fapi.binance.com", "not a url", "//demo-fapi.binance.com"]) {
      expect(validateTestnetOrigin(url)?.reasonCode, url).toBe("TESTNET_BASE_URL_UNPARSEABLE");
    }
  });

  it("refuses to build clients for any other origin, even if a caller forges the config", () => {
    expect(() =>
      createTestnetMutationClients({ baseUrl: "https://fapi.binance.com", apiKey: "k", apiSecret: "s" })
    ).toThrow(/demo-fapi\.binance\.com/);
  });
});

// ---------------------------------------------------------------------------
// Structural mainnet isolation
// ---------------------------------------------------------------------------

describe("mainnet isolation is structural", () => {
  const sources = readdirSync(VERIFIER_DIR)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(path.join(VERIFIER_DIR, file), "utf8") }));

  it("never imports config/env, so no production value can be read", () => {
    for (const { file, text } of sources) {
      expect(`${file}:${/from ["'][^"']*config\/env["']/.test(text)}`).toBe(`${file}:false`);
    }
  });

  it("loads raw .env values but never the parsed production config", () => {
    const entry = readFileSync(path.join(process.cwd(), "src/modules/binance/run-testnet-protection-verify.ts"), "utf8");
    // dotenv only populates process.env; it validates nothing and pulls in no
    // production defaults. It is what makes the credential-collision check real.
    expect(entry).toContain('import "dotenv/config"');
    expect(/from ["'][^"']*config\/env["']/.test(entry)).toBe(false);
    // And the verifier reads ONLY its own names plus the two it compares against.
    expect(entry).toContain("BINANCE_TESTNET_PROTECTION_VERIFY");
    expect(entry).not.toContain("BINANCE_FUTURES_REST_BASE_URL");
    expect(entry).not.toContain("EXECUTION_PROFILE");
  });

  it("never imports Prisma or any database client", () => {
    const entry = readFileSync(path.join(process.cwd(), "src/modules/binance/run-testnet-protection-verify.ts"), "utf8");
    for (const { file, text } of [...sources, { file: "run-testnet-protection-verify.ts", text: entry }]) {
      expect(`${file}:${/@prisma\/client|PrismaClient|from ["'][^"']*prisma/.test(text)}`).toBe(`${file}:false`);
    }
  });

  it("passes every routing and auth option explicitly when building clients", () => {
    const factory = readFileSync(path.join(VERIFIER_DIR, "testnet-clients.ts"), "utf8");
    // Each of these, if omitted, silently falls back to a production env value.
    for (const option of ["baseUrl:", "apiKey:", "apiSecret:", "recvWindowMs:", "enabled:", "readOnlyClient,", "liveEntryEnabled:", "protectionReady:"]) {
      expect(`${option}:${factory.includes(option)}`).toBe(`${option}:true`);
    }
    // And no `?? env.` fallback may appear in real CODE anywhere in the tree.
    // Comments are stripped first: these files deliberately DOCUMENT the
    // production fallback they exist to avoid.
    const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const { file, text } of sources) {
      expect(`${file}:${/\?\?\s*env\./.test(stripComments(text))}`).toBe(`${file}:false`);
    }
  });

  it("builds clients bound to the demo host with the read-only gate forced open", () => {
    const clients = createTestnetMutationClients({ baseUrl: BINANCE_TESTNET_ORIGIN, apiKey: "k1", apiSecret: "s1" });
    expect(clients.readOnlyClient.host).toBe("demo-fapi.binance.com");
    // Independent of the production BINANCE_READ_ONLY_ENABLED switch.
    expect(clients.readOnlyClient.isEnabled).toBe(true);
    expect(clients.mutations.isLiveMutationAllowed).toBe(true);
  });

  it("gives the probe factory no mutation capability whatsoever", () => {
    const probeClients = createTestnetProbeClients({
      baseUrl: BINANCE_TESTNET_ORIGIN,
      apiKey: "k1",
      apiSecret: "s1",
    });
    expect(probeClients.readOnlyClient.host).toBe("demo-fapi.binance.com");
    expect("mutations" in probeClients).toBe(false);
    for (const value of Object.values(probeClients)) {
      // Nothing returned may expose a mutation surface.
      expect(typeof (value as Record<string, unknown>).submitProtectionOrder).toBe("undefined");
      expect(typeof (value as Record<string, unknown>).submitLimitEntry).toBe("undefined");
    }
  });

  it("refuses to build probe clients for any other origin", () => {
    expect(() =>
      createTestnetProbeClients({ baseUrl: "https://fapi.binance.com", apiKey: "k", apiSecret: "s" })
    ).toThrow(/demo-fapi\.binance\.com/);
  });

  it("routes the CLI's probe branch to the probe factory only", () => {
    const entry = readFileSync(
      path.join(process.cwd(), "src/modules/binance/run-testnet-protection-verify.ts"),
      "utf8"
    );
    const probeBranch = entry.slice(entry.indexOf("if (probeOnly)"), entry.indexOf("createTestnetMutationClients("));
    expect(probeBranch).toContain("createTestnetProbeClients(");
    // The probe branch returns before the mutation factory is ever reached.
    expect(probeBranch).toContain("return;");
  });
});

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

describe("verifier identities", () => {
  const identities = deriveIdentities("0123456789ab");

  it("derives ids that satisfy the documented clientAlgoId format", () => {
    for (const id of [
      identities.entryClientOrderId,
      identities.stopClientAlgoId,
      identities.takeProfitClientAlgoId,
      identities.emergencyClientOrderId,
      identities.probeClientAlgoId,
    ]) {
      expect(BINANCE_CLIENT_ORDER_ID_PATTERN.test(id), id).toBe(true);
      expect(id.length).toBeLessThanOrEqual(36);
    }
  });

  it("is deterministic — the same runId always yields the same ids", () => {
    expect(deriveIdentities("0123456789ab")).toEqual(identities);
  });

  it("gives different runs completely different ids", () => {
    const other = deriveIdentities("ffffffffffff");
    expect(other.stopClientAlgoId).not.toBe(identities.stopClientAlgoId);
    expect(other.probeClientAlgoId).not.toBe(identities.probeClientAlgoId);
  });

  it("namespaces the synthetic execution id so it cannot be a production cuid", () => {
    expect(identities.syntheticExecutionId.startsWith("tadverify-")).toBe(true);
  });

  it("proves ownership by derivation, never by prefix", () => {
    expect(ownsIdentity(identities, identities.stopClientAlgoId)).toBe(true);
    // Same production-shaped prefix, different derivation: NOT owned.
    expect(ownsIdentity(identities, deriveIdentities("ffffffffffff").stopClientAlgoId)).toBe(false);
    expect(ownsIdentity(identities, "tad-sl-1-000000000000")).toBe(false);
  });

  it("rejects a malformed runId rather than inventing one", () => {
    for (const bad of ["", "xyz", "0123456789AB", "0123456789abc"]) {
      expect(() => deriveIdentities(bad), bad).toThrow();
    }
  });

  it("generates a runId of the documented shape", () => {
    expect(/^[0-9a-f]{12}$/.test(generateRunId())).toBe(true);
    expect(buildProbeClientAlgoId("0123456789ab")).toBe("tadverify-probe-0123456789ab");
  });
});

// ---------------------------------------------------------------------------
// Exact decimal arithmetic
// ---------------------------------------------------------------------------

describe("exact decimal arithmetic", () => {
  it("rejects anything that is not a plain decimal literal", () => {
    for (const bad of ["", " ", "-1", "1e-8", "1.", ".5", "abc", "0x10"]) {
      expect(parseDecimal(bad), bad).toBeNull();
    }
    expect(parsePositiveDecimal("0")).toBeNull();
    expect(parsePositiveDecimal("0.000")).toBeNull();
    expect(parsePositiveDecimal("0.001")).not.toBeNull();
  });

  it("compares across differing scales without float error", () => {
    const a = parseDecimal("0.10") as never;
    const b = parseDecimal("0.1") as never;
    expect(compareDecimal(a, b)).toBe(0);
    expect(compareDecimal(parseDecimal("0.3") as never, parseDecimal("0.29999") as never)).toBe(1);
  });

  it("snaps onto a grid in both directions and leaves exact values alone", () => {
    const tick = parseDecimal("0.01") as never;
    expect(formatDecimal(snapToGrid(parseDecimal("1.234") as never, tick, "DOWN"), 2)).toBe("1.23");
    expect(formatDecimal(snapToGrid(parseDecimal("1.234") as never, tick, "UP"), 2)).toBe("1.24");
    // Already on the grid: neither direction moves it.
    expect(formatDecimal(snapToGrid(parseDecimal("1.23") as never, tick, "UP"), 2)).toBe("1.23");
    expect(formatDecimal(snapToGrid(parseDecimal("1.23") as never, tick, "DOWN"), 2)).toBe("1.23");
  });

  it("survives the classic float traps exactly", () => {
    // 0.1 + 0.2 territory: 3 × 0.1 must land exactly on a 0.1 grid.
    const grid = parseDecimal("0.1") as never;
    expect(formatDecimal(snapToGrid(parseDecimal("0.30000000000000004") as never, grid, "DOWN"), 1)).toBe("0.3");
  });
});

// ---------------------------------------------------------------------------
// Sizing and triggers
// ---------------------------------------------------------------------------

describe("position sizing from live filters", () => {
  const filters = { tickSize: "0.10", stepSize: "0.001", minQty: "0.001", minNotional: "100" };

  it("derives the smallest quantity satisfying minQty AND minNotional", () => {
    const plan = planMinimumQuantity({ filters, markPrice: "50000.0" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // 100 / 50000 = 0.002 exactly, already on the 0.001 step grid.
    expect(plan.value.quantity).toBe("0.002");
  });

  it("always snaps UP so the notional floor cannot be undercut", () => {
    // 100 / 30000 = 0.00333… -> must become 0.004, never 0.003.
    const plan = planMinimumQuantity({ filters, markPrice: "30000" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.quantity).toBe("0.004");
    expect(Number(plan.value.notional)).toBeGreaterThanOrEqual(100);
  });

  it("honours minQty when it dominates the notional requirement", () => {
    const plan = planMinimumQuantity({
      filters: { ...filters, minQty: "1", minNotional: "5" },
      markPrice: "50000",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.quantity).toBe("1.000");
  });

  it("refuses to size when a filter is missing or the mark price is unusable", () => {
    expect(planMinimumQuantity({ filters: { ...filters, stepSize: null }, markPrice: "5" }).ok).toBe(false);
    expect(planMinimumQuantity({ filters: { ...filters, minNotional: null }, markPrice: "5" }).ok).toBe(false);
    for (const mark of ["0", "-1", "abc", ""]) {
      expect(planMinimumQuantity({ filters, markPrice: mark }).ok, mark).toBe(false);
    }
  });

  it("hard-codes no quantity anywhere", () => {
    const source = readFileSync(path.join(VERIFIER_DIR, "testnet-sizing.ts"), "utf8");
    expect(/quantity\s*[:=]\s*["']\d/.test(source)).toBe(false);
  });
});

describe("trigger normalization", () => {
  it("places STOP below and TP above the mark, normalized AWAY from it", () => {
    const plan = planLongTriggers({ markPrice: "100.00", tickSize: "0.10", triggerOffsetBps: 1000 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.stopTriggerPrice).toBe("90.0");
    expect(plan.value.takeProfitTriggerPrice).toBe("110.0");
  });

  it("floors the STOP and ceils the TP so snapping never shrinks the distance", () => {
    // mark 101.13, 100 bps -> stop 100.1187 (floor 100.11), tp 102.1413 (ceil 102.15).
    const plan = planLongTriggers({ markPrice: "101.13", tickSize: "0.01", triggerOffsetBps: 100 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.stopTriggerPrice).toBe("100.11");
    expect(plan.value.takeProfitTriggerPrice).toBe("102.15");
  });

  it("requires an explicit whole-number offset and refuses a silent default", () => {
    for (const bps of [0, -5, 10_000, 20_000, Number.NaN, 10.5]) {
      const plan = planLongTriggers({ markPrice: "100", tickSize: "0.01", triggerOffsetBps: bps });
      expect(plan.ok, String(bps)).toBe(false);
      if (!plan.ok) expect(plan.reasonCode).toBe("TRIGGER_OFFSET_INVALID");
    }
  });

  it("fails closed when a coarse tick grid would collapse the stop to zero", () => {
    // A tick grid coarser than the price itself: 5 × 0.99 = 4.95 floors onto a
    // grid of 10 as ZERO, which is not a trigger price. Refuse rather than
    // submit a stop at 0.
    const plan = planLongTriggers({ markPrice: "5", tickSize: "10", triggerOffsetBps: 100 });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reasonCode).toBe("TRIGGER_ORDERING_INVALID");
  });

  it("keeps STOP strictly below the mark even on a coarse grid", () => {
    // Snapping DOWN can never reach the mark, so the ordering holds wherever
    // the stop remains positive.
    const plan = planLongTriggers({ markPrice: "100", tickSize: "10", triggerOffsetBps: 1 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.stopTriggerPrice).toBe("90");
    expect(plan.value.takeProfitTriggerPrice).toBe("110");
  });

  it("prices a marketable LIMIT strictly above the mark", () => {
    const plan = planMarketableLimitPrice({ markPrice: "100.00", tickSize: "0.10", crossBps: 20 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.price).toBe("100.2");
  });
});

// ---------------------------------------------------------------------------
// Algo capability probe
// ---------------------------------------------------------------------------

describe("algo capability probe", () => {
  const probe = (failure: { kind: string; httpStatus: number | null; binanceCode: number | null } | null) =>
    classifyAlgoProbe({ failure: failure as never });

  it("treats ONLY a served 4xx carrying -2013 as proof of support", () => {
    const result = probe({ kind: "MALFORMED_RESPONSE", httpStatus: 400, binanceCode: -2013 });
    expect(result.outcome).toBe("SUPPORTED");
    expect(result.supported).toBe(true);
  });

  it("refuses a CONTRADICTORY 5xx that carries -2013", () => {
    // A gateway can attach any body to a 5xx; that is not an endpoint answer.
    for (const httpStatus of [500, 502, 503, 504]) {
      const result = probe({ kind: "SERVER", httpStatus, binanceCode: -2013 });
      expect(result.supported, String(httpStatus)).toBe(false);
      expect(result.outcome).toBe("INCONCLUSIVE");
      expect(result.detail).toMatch(/contradictory/i);
    }
  });

  it("refuses -2013 delivered with a rate-limit or ban status", () => {
    for (const failure of [
      { kind: "RATE_LIMIT", httpStatus: 429, binanceCode: -2013 },
      { kind: "IP_BANNED", httpStatus: 418, binanceCode: -2013 },
    ]) {
      expect(probe(failure).supported, failure.kind).toBe(false);
    }
  });

  it("refuses -2013 with no HTTP status at all", () => {
    expect(probe({ kind: "MALFORMED_RESPONSE", httpStatus: null, binanceCode: -2013 }).supported).toBe(false);
  });

  it("accepts every 4xx status a served rejection may legitimately carry", () => {
    for (const httpStatus of [400, 404, 418 - 18, 499]) {
      expect(probe({ kind: "MALFORMED_RESPONSE", httpStatus, binanceCode: -2013 }).supported, String(httpStatus)).toBe(
        true
      );
    }
  });

  it("never infers support from HTTP routing alone", () => {
    // A 200 for an impossible identity is not an endorsement.
    expect(probe(null).supported).toBe(false);
    expect(probe(null).outcome).toBe("INCONCLUSIVE");
  });

  it("treats a missing route or unknown 4xx as NOT supported", () => {
    for (const failure of [
      { kind: "MALFORMED_RESPONSE", httpStatus: 404, binanceCode: null },
      { kind: "MALFORMED_RESPONSE", httpStatus: 400, binanceCode: -1121 },
      { kind: "REQUEST_INVALID", httpStatus: 400, binanceCode: -1104 },
      { kind: "UNSUPPORTED_SYMBOL", httpStatus: 400, binanceCode: -1121 },
    ]) {
      const result = probe(failure);
      expect(result.supported, JSON.stringify(failure)).toBe(false);
      expect(result.outcome).toBe("NOT_SUPPORTED");
    }
  });

  it("treats transport, auth and rate-limit noise as inconclusive, never support", () => {
    for (const kind of ["TIMEOUT", "NETWORK", "SERVER", "RATE_LIMIT", "IP_BANNED", "AUTH", "PERMISSION", "MISSING_CREDENTIALS"]) {
      const result = probe({ kind, httpStatus: null, binanceCode: null });
      expect(result.supported, kind).toBe(false);
      expect(result.outcome).toBe("INCONCLUSIVE");
    }
  });

  it("puts no credential material in its detail text", () => {
    const result = probe({ kind: "AUTH", httpStatus: 401, binanceCode: -2014 });
    expect(result.detail).not.toMatch(/signature|apikey|secret/i);
  });
});

// ---------------------------------------------------------------------------
// Crash-recovery state
// ---------------------------------------------------------------------------

describe("crash-recovery state", () => {
  const identities = deriveIdentities("0123456789ab");
  const valid = {
    verifierVersion: "20B.1",
    runId: identities.runId,
    origin: BINANCE_TESTNET_ORIGIN,
    symbol: "BTCUSDT",
    direction: "LONG",
    entryClientOrderId: identities.entryClientOrderId,
    stopClientAlgoId: identities.stopClientAlgoId,
    takeProfitClientAlgoId: identities.takeProfitClientAlgoId,
    emergencyClientOrderId: identities.emergencyClientOrderId,
    phase: "STOP_SUBMITTED",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:01.000Z",
  };

  it("round-trips a complete state file", () => {
    expect(parseVerifierState(JSON.stringify(valid))?.runId).toBe(identities.runId);
  });

  it("refuses a truncated, corrupt or hand-edited file rather than reading it as absent", () => {
    for (const bad of ["", "{", "null", "[]", '"text"', JSON.stringify({ ...valid, runId: "nope" })]) {
      expect(parseVerifierState(bad), bad.slice(0, 12)).toBeNull();
    }
    for (const field of ["runId", "stopClientAlgoId", "symbol", "origin"]) {
      const partial = { ...valid, [field]: "" };
      expect(parseVerifierState(JSON.stringify(partial)), field).toBeNull();
    }
  });

  it("refuses state written by a different verifier version", () => {
    expect(parseVerifierState(JSON.stringify({ ...valid, verifierVersion: "20A.0" }))).toBeNull();
  });

  it("distinguishes ABSENT from UNREADABLE", () => {
    const store = new MemoryStateStore();
    expect(store.readDetailed().status).toBe("ABSENT");
    store.unreadable = true;
    expect(store.readDetailed().status).toBe("UNREADABLE");
  });

  it("carries no credential material", () => {
    const serialized = JSON.stringify(valid);
    for (const forbidden of ["apiKey", "apiSecret", "signature", "X-MBX", "Authorization"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

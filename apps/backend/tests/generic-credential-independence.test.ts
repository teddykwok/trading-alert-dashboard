import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 11F — the generic runtimes start with no account credentials.
 *
 * ## The production failure this reproduces
 *
 * The generic backend was launched with its own env file, which deliberately
 * omits BINANCE_API_KEY, BINANCE_API_SECRET and
 * EXECUTION_PROFILE_ACCOUNT_IDENTIFIER while keeping the safe posture
 * BINANCE_READ_ONLY_ENABLED=true. It refused to boot:
 *
 *   Invalid environment variables:
 *     BINANCE_API_KEY:    is required when BINANCE_READ_ONLY_ENABLED=true
 *     BINANCE_API_SECRET: is required when BINANCE_READ_ONLY_ENABLED=true
 *
 * A global `superRefine` coupled the read-only flag to credential presence.
 * That was right while every backend process was account-bound; after the 11F
 * split two processes are not, and they parse the same schema.
 *
 * The earlier structural test asserted the FIELD-level schema kept those keys
 * optional — which was true, and missed the cross-field rule entirely. These
 * cases parse the real schema instead, which is the only thing that could have
 * caught it.
 *
 * Enforcement moved rather than vanished: the account entrypoints reach
 * `resolveConfiguredExchangeCredentials` before they attest, listen as
 * account-ready or orchestrate. The negative cases below hold it to that.
 */

const BACKEND = path.resolve(__dirname, "..");

/** Exactly what a generic env file provides: shared settings, no account. */
const GENERIC_ENV = {
  DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_generic",
  REDIS_URL: "redis://127.0.0.1:1",
  WEBHOOK_SECRET: "synthetic-webhook-secret",
  BINANCE_READ_ONLY_ENABLED: "true",
} as const;

const ACCOUNT_KEYS = [
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER",
] as const;

/**
 * Parses `config/env` under a pinned environment.
 *
 * The whole process environment is replaced, not merged: an inherited
 * credential from the test runner's own shell would mask the very absence
 * these cases are about.
 */
async function parseUnder(overrides: Record<string, string>) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, overrides);
  vi.resetModules();
  try {
    const module = await import("../src/config/env");
    return { ok: true as const, env: module.env };
  } catch (error) {
    return { ok: false as const, error: error as Error };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    vi.resetModules();
  }
}

afterEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// The generic half
// ---------------------------------------------------------------------------

describe("generic configuration parses without account credentials", () => {
  it("accepts the exact generic env that failed in production", async () => {
    const result = await parseUnder({ ...GENERIC_ENV });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The safe posture is KEPT. The fix was never to switch this off.
    expect(result.env.BINANCE_READ_ONLY_ENABLED).toBe(true);
    // And the account keys are simply absent, defaulting to empty.
    expect(result.env.BINANCE_API_KEY).toBe("");
    expect(result.env.BINANCE_API_SECRET).toBe("");
    expect(result.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER).toBe("");
  });

  it.each(ACCOUNT_KEYS)("still parses when only %s is supplied", async (supplied) => {
    // A half-configured generic file must not become valid-looking either way:
    // presence of one account key is not what makes a process an account.
    const result = await parseUnder({ ...GENERIC_ENV, [supplied]: "synthetic-value" });
    expect(result.ok).toBe(true);
  });

  it("unrelated cross-field validation is untouched", async () => {
    // Only the credential coupling was narrowed. The fill-runtime rule, which
    // guards a shared exchange weight budget, must still refuse.
    const result = await parseUnder({
      ...GENERIC_ENV,
      EXECUTION_FILL_RUNTIME_ENABLED: "true",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/Invalid environment variables/);
  });

  it("the generic backend and worker reach their entrypoint on that config", async () => {
    // Both import config/env at module load, so a parse failure would stop
    // them before anything else. Proving the parse succeeds is proving they
    // get past the point that actually failed in production. Neither is
    // imported here: doing so would open a port and connect real queues.
    const result = await parseUnder({ ...GENERIC_ENV });
    expect(result.ok).toBe(true);

    for (const entrypoint of ["src/server.ts", "src/modules/jobs/vision-analysis.worker.ts"]) {
      const source = readFileSync(path.join(BACKEND, entrypoint), "utf8");
      // No credential is read, so none can be required.
      for (const forbidden of ["BINANCE_API_KEY", "BINANCE_API_SECRET"]) {
        expect(`${forbidden} in ${entrypoint}: ${source.includes(forbidden)}`).toBe(
          `${forbidden} in ${entrypoint}: false`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The account half — enforcement moved here, and must actually be here
// ---------------------------------------------------------------------------

describe("account runtimes still fail closed without credentials", () => {
  async function resolveUnder(overrides: Record<string, string>) {
    const previous = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, overrides);
    vi.resetModules();
    try {
      const module = await import("../src/modules/execution/exchange-runtime-binding");
      return module.resolveConfiguredExchangeCredentials();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
      vi.resetModules();
    }
  }

  const ACCOUNT_ENV = {
    ...GENERIC_ENV,
    EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "synthetic-account-a",
    EXECUTION_PROFILE_ENVIRONMENT: "TESTNET",
  } as const;

  it("refuses when the API key is missing", async () => {
    const result = await resolveUnder({ ...ACCOUNT_ENV, BINANCE_API_SECRET: "synthetic-secret" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe("EXCHANGE_CREDENTIALS_MISSING");
    expect(result.message).toContain("BINANCE_API_KEY");
    // The NAME, never a value.
    expect(result.message).not.toContain("synthetic-secret");
  });

  it("refuses when the API secret is missing", async () => {
    const result = await resolveUnder({ ...ACCOUNT_ENV, BINANCE_API_KEY: "synthetic-key" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe("EXCHANGE_CREDENTIALS_MISSING");
    expect(result.message).toContain("BINANCE_API_SECRET");
    expect(result.message).not.toContain("synthetic-key");
  });

  it("refuses when both are missing, naming both", async () => {
    const result = await resolveUnder({ ...ACCOUNT_ENV });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe("EXCHANGE_CREDENTIALS_MISSING");
    expect(result.message).toContain("BINANCE_API_KEY");
    expect(result.message).toContain("BINANCE_API_SECRET");
  });

  it("refuses whitespace, which a copy-paste can produce", async () => {
    const result = await resolveUnder({
      ...ACCOUNT_ENV,
      BINANCE_API_KEY: "   ",
      BINANCE_API_SECRET: "   ",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a complete account configuration", async () => {
    const result = await resolveUnder({
      ...ACCOUNT_ENV,
      BINANCE_API_KEY: "synthetic-key",
      BINANCE_API_SECRET: "synthetic-secret",
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural: the enforcement point cannot drift back or disappear
// ---------------------------------------------------------------------------

describe("credential enforcement lives at the account runtime", () => {
  const codeOf = (relative: string) =>
    readFileSync(path.join(BACKEND, relative), "utf8")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "");

  it("the global schema requires no account credential", () => {
    // The exact regression: a cross-field rule that made a credential-free
    // generic process unbootable.
    const code = codeOf("src/config/env.ts");
    for (const forbidden of [
      'path: ["BINANCE_API_KEY"]',
      'path: ["BINANCE_API_SECRET"]',
      'path: ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER"]',
    ]) {
      expect(`${forbidden} in env schema: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in env schema: false`
      );
    }
  });

  it("the account control plane refuses before it builds, listens or attests", () => {
    const code = codeOf("src/account-control.server.ts");
    const refusal = code.indexOf("resolveConfiguredExchangeCredentials()");
    expect(refusal).toBeGreaterThan(-1);

    // Everything that would make it look operational comes AFTER.
    for (const later of [
      "buildAccountControlApp()",
      "app.listen(",
      "createRuntimeAttestationPublisher(",
    ]) {
      expect(`${later} after credential check: ${code.indexOf(later) > refusal}`).toBe(
        `${later} after credential check: true`
      );
    }
    // And the refusal is UNCONDITIONAL on the seam's verdict. Asserting only
    // that an exit appears nearby would survive the guard being disabled.
    const block = code.slice(refusal, code.indexOf("buildAccountControlApp()"));
    expect(block).toContain("if (!credentials.ok) {");
    expect(block).toContain("process.exit(1)");
    // No short-circuit may neuter it.
    expect(`guard short-circuited: ${/if\s*\(\s*(false|0)\s*&&/.test(block)}`).toBe(
      `guard short-circuited: false`
    );
  });

  it("the execution worker refuses before orchestration or adoption", () => {
    const code = codeOf("src/modules/jobs/execution.worker.ts");
    const bind = code.indexOf("bindConfiguredExchangeRuntime(prisma)");
    const refuse = code.indexOf("if (!bound.ok)");
    expect(refuse).toBeGreaterThan(bind);

    for (const later of [
      "startExecutionOrchestrationScheduler(runtime)",
      "startSelectedPlanAdoptionScheduler(",
      "createRuntimeAttestationPublisher(",
    ]) {
      expect(`${later} after binding refusal: ${code.indexOf(later) > refuse}`).toBe(
        `${later} after binding refusal: true`
      );
    }
  });

  it("every Binance CLI reaches the exchange through the canonical seam", () => {
    // They relied on the global schema to stop them; now they must refuse
    // through their own binding, with a reason code rather than a TypeError.
    for (const cli of [
      "src/modules/binance/run-read-only-check.ts",
      "src/modules/binance/run-account-health.ts",
      "src/modules/binance/run-margin-plan.ts",
      "src/modules/binance/run-liquidation-validation.ts",
      "src/modules/binance/run-set-hedge-mode.ts",
      "src/modules/binance/run-test-order.ts",
    ]) {
      const code = codeOf(cli);
      // The CALL, not merely the identifier: an import left behind while the
      // call was removed would still contain the name.
      expect(`${cli} binds a runtime: ${/bindConfiguredExchangeRuntime\s*\(/.test(code)}`).toBe(
        `${cli} binds a runtime: true`
      );
      // Any client it does build takes its credentials from that bound
      // runtime, never from ambient configuration. (The exhaustive version of
      // this rule lives in exchange-runtime-anti-bypass; here it only has to
      // hold for the CLIs that used to lean on the global schema.)
      if (/new\s+Binance/.test(code)) {
        expect(
          `${cli} derives client options from the runtime: ` +
            `${/exchangeClientOptionsOf\(|FromRuntime\(/.test(code)}`
        ).toBe(`${cli} derives client options from the runtime: true`);
      }
      for (const ambient of ["env.BINANCE_API_KEY", "env.BINANCE_API_SECRET"]) {
        expect(`${cli} reads ${ambient}: ${code.includes(ambient)}`).toBe(
          `${cli} reads ${ambient}: false`
        );
      }
      // And reports the refusal rather than constructing a client anyway.
      expect(`${cli} handles a refusal: ${code.includes("reasonCode")}`).toBe(
        `${cli} handles a refusal: true`
      );
    }
  });
});

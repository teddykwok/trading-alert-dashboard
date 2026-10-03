import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 11F — the structural guarantees of the generic/account control split.
 *
 * ## The failure this removes
 *
 * Every operator control service resolves its account from PROCESS
 * ENVIRONMENT, at sixteen call sites, and the readiness route reaches
 * `bindConfiguredExchangeRuntime` and performs SIGNED Binance reads. So the
 * process serving those routes IS an account: it holds that account's
 * credentials and can act only for it.
 *
 * Serving two accounts from one backend would therefore mean two credential
 * sets in one heap — the thing 11B and 11D exist to prevent — or a request
 * parameter naming the account, which the repository deliberately refuses.
 *
 * So the split is by process, matching 11E:
 *
 *   server.ts                  ONE process, no account   generic/public
 *   account-control.server.ts  ONE process PER account   account control
 *
 * Source-level, because importing either entrypoint would open a port, connect
 * Redis and start a heartbeat.
 */

const BACKEND = path.resolve(__dirname, "..");
const SRC = path.join(BACKEND, "src");

const GENERIC_SERVER = "src/server.ts";
const ACCOUNT_SERVER = "src/account-control.server.ts";
const APP = "src/app.ts";
const WEBHOOK_SERVICE = "src/modules/webhook/webhook.service.ts";
const GENERIC_WORKER = "src/modules/jobs/vision-analysis.worker.ts";
const ACCOUNT_ENV = "src/config/account-env.ts";

const raw = (relative: string) => readFileSync(path.join(BACKEND, relative), "utf8");

/** Source with comments removed — these bans are about code, not about prose. */
function codeOf(relative: string): string {
  return raw(relative)
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionSources(full);
    return full.endsWith(".ts") ? [path.relative(BACKEND, full).split(path.sep).join("/")] : [];
  });
}

// ---------------------------------------------------------------------------
// 1–4. The generic backend cannot act as an account
// ---------------------------------------------------------------------------

describe("the generic backend binds no account", () => {
  it("1. imports no account identity or credential seam", () => {
    const code = codeOf(GENERIC_SERVER);
    for (const forbidden of [
      "configuredProfileIdentity",
      "resolveExecutionProfile",
      "bindConfiguredExchangeRuntime",
      "configuredExchangeClientOptions",
      "CanaryPreflightService",
      "exchange-runtime-binding",
      "execution-profile.service",
    ]) {
      expect(`${forbidden} in generic server: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in generic server: false`
      );
    }
  });

  it("2. publishes no runtime attestation", () => {
    // Activation requires a fresh BACKEND and WORKER pair for ONE account
    // identity. A process that binds no account attesting as that account's
    // BACKEND would let the interlock count a runtime that cannot act — the
    // same rule the generic worker has followed since 11E.
    const code = codeOf(GENERIC_SERVER);
    for (const forbidden of [
      "createRuntimeAttestationPublisher",
      "createAttestationRedisClient",
      "runtime-attestation",
      "attestation-redis",
    ]) {
      expect(`${forbidden} in generic server: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in generic server: false`
      );
    }
  });

  it("3. does not mount the operator control routes", () => {
    const generic = codeOf(APP).slice(
      codeOf(APP).indexOf("export async function buildApp("),
      codeOf(APP).indexOf("export async function buildAccountControlApp(")
    );
    expect(`operatorRoutes in generic composition: ${generic.includes("operatorRoutes")}`).toBe(
      "operatorRoutes in generic composition: false"
    );
    // And it keeps every generic surface.
    for (const kept of [
      "healthRoutes",
      "webhookRoutes",
      "alertsRoutes",
      "assetsRoutes",
      "settingsRoutes",
      "tradeReviewsRoutes",
      "tradeJournalsRoutes",
      "riskTemplatesRoutes",
      "extremeRRRoutes",
      "executionsRoutes",
    ]) {
      expect(generic).toContain(kept);
    }
  });

  it("4. requires no Binance credential to start", () => {
    // This assertion used to read the FIELD-level schema and pass while a
    // cross-field superRefine made a credential-free generic process
    // unbootable -- the exact production failure. Field optionality is
    // necessary but nowhere near sufficient, so it is checked here and the
    // real proof is a PARSE, in generic-credential-independence.test.ts.
    const env = raw("src/config/env.ts");
    for (const optional of [
      "BINANCE_API_KEY: z.string().optional().default(\"\")",
      "BINANCE_API_SECRET: z.string().optional().default(\"\")",
      "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: z.string().optional().default(\"\")",
    ]) {
      expect(env).toContain(optional);
    }
    // And no cross-field rule may reinstate the requirement.
    const code = codeOf("src/config/env.ts");
    for (const forbidden of [
      'path: ["BINANCE_API_KEY"]',
      'path: ["BINANCE_API_SECRET"]',
    ]) {
      expect(`${forbidden} in env schema: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in env schema: false`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5–8. The account control plane is an account, and only one
// ---------------------------------------------------------------------------

describe("the account control plane serves one account and no generic work", () => {
  it("5. mounts no webhook and no generic ingestion", () => {
    const app = codeOf(APP);
    const account = app.slice(app.indexOf("export async function buildAccountControlApp("));
    for (const forbidden of [
      "webhookRoutes",
      "alertsRoutes",
      "assetsRoutes",
      "extremeRRRoutes",
      "socketPlugin",
      "fastifyStatic",
    ]) {
      expect(`${forbidden} in account composition: ${account.includes(forbidden)}`).toBe(
        `${forbidden} in account composition: false`
      );
    }
    expect(account).toContain("operatorRoutes");
  });

  it("6. owns the BACKEND attestation", () => {
    const code = codeOf(ACCOUNT_SERVER);
    expect(code).toContain("createRuntimeAttestationPublisher");
    expect(code).toContain('role: "BACKEND"');
    // Exactly one publisher: one process, one identity, one key.
    expect(code.match(/createRuntimeAttestationPublisher\(/g)).toHaveLength(1);
  });

  it("7. takes no account selector from a request", () => {
    // A route that accepted executionProfileId would be a profile enumeration
    // API. The account comes from this process's configuration and nowhere
    // else, which is what makes one process mean one account.
    const code = codeOf(ACCOUNT_SERVER);
    expect(`executionProfileId in account server: ${code.includes("executionProfileId")}`).toBe(
      "executionProfileId in account server: false"
    );
    const operator = codeOf("src/routes/operator.routes.ts");
    expect(
      `executionProfileId read from request: ${/request\.(body|query|params)[^;]*executionProfileId/.test(operator)}`
    ).toBe("executionProfileId read from request: false");
  });

  it("8. checks its account environment BEFORE anything can bind", () => {
    const code = codeOf(ACCOUNT_SERVER);
    const check = code.indexOf("checkAccountEnvIntegrity(");
    // Everything capable of resolving a profile, building a client or
    // attesting is imported dynamically, AFTER the check.
    for (const deferred of ['await import("./config/env")', 'await import("./app")']) {
      expect(code.indexOf(deferred)).toBeGreaterThan(check);
    }
    expect(check).toBeGreaterThan(-1);
    // A static import of config/env would run it at module load, ahead of the
    // check, and the guard would be decorative.
    expect(`config/env statically imported: ${/^import .*config\/env/m.test(code)}`).toBe(
      "config/env statically imported: false"
    );
  });
});

// ---------------------------------------------------------------------------
// 9–11. Webhook is global, and singular
// ---------------------------------------------------------------------------

describe("webhook ingestion belongs to no account and happens once", () => {
  it("8b. an account-env conflict EXITS before anything can bind", () => {
    const code = codeOf(ACCOUNT_SERVER);
    const conflict = code.slice(code.indexOf("if (!verdict.ok) {"));
    const exits = conflict.slice(0, conflict.indexOf("}", conflict.indexOf("console.error")));
    // Reported AND fatal. Logging a conflict and continuing would leave the
    // process signing as the wrong account with a warning nobody reads.
    expect(exits).toContain("process.exit(1)");
  });

  it("9. exactly one production composition registers it", () => {
    const registrations = productionSources().filter((module) =>
      codeOf(module).includes("register(webhookRoutes)")
    );
    expect(registrations).toEqual([APP]);
    // And within app.ts, once.
    expect(codeOf(APP).match(/register\(webhookRoutes\)/g)).toHaveLength(1);
  });

  it("10. ingestion no longer resolves the process's configured profile", () => {
    // Before 11F the webhook bound a canary to whichever account the generic
    // process happened to be configured for — Account A by accident. The token
    // itself names the account now.
    const code = codeOf(WEBHOOK_SERVICE);
    for (const forbidden of ["resolveExecutionProfile", "configuredProfileIdentity"]) {
      expect(`${forbidden} in webhook: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in webhook: false`
      );
    }
    expect(code).toContain("consumeByToken(");
  });

  it("11. the account-agnostic path still applies every original rule", () => {
    // consumeByToken resolves the owning profile and then delegates to the
    // UNCHANGED consume, so structure, identity and state checks are identical.
    const code = codeOf("src/modules/execution/canary-authorization.service.ts");
    const byToken = code.slice(
      code.indexOf("async consumeByToken("),
      code.indexOf("async consume(")
    );
    expect(byToken).toContain("tokenHash: hashCanaryToken(input.token)");
    expect(byToken).toContain("return this.consume({");
    expect(byToken).toContain("executionProfileId: owner.executionProfileId");
    // The profile fence in consume is untouched for account-scoped callers.
    expect(code).toContain("existing.executionProfileId !== input.executionProfileId");
  });
});

// ---------------------------------------------------------------------------
// 12–14. Listener, attestation readiness, and the generic worker
// ---------------------------------------------------------------------------

describe("deployment shape", () => {
  it("12. the account plane binds loopback by default and needs an explicit port", () => {
    const env = raw("src/config/env.ts");
    expect(env).toContain("ACCOUNT_CONTROL_PORT: z.coerce.number().int().positive().optional()");
    expect(env).toContain('ACCOUNT_CONTROL_HOST: z.string().min(1).default("127.0.0.1")');

    const code = codeOf(ACCOUNT_SERVER);
    // Never 0.0.0.0 by accident: the host comes from configuration whose
    // default is loopback, and the literal appears nowhere here.
    expect(`0.0.0.0 in account server: ${code.includes("0.0.0.0")}`).toBe(
      "0.0.0.0 in account server: false"
    );
    expect(code).toContain("host: env.ACCOUNT_CONTROL_HOST");
    expect(code).toContain("if (env.ACCOUNT_CONTROL_PORT === undefined)");
    // The public backend's binding is deliberately unchanged.
    expect(codeOf(GENERIC_SERVER)).toContain('host: "0.0.0.0"');
  });

  it("13. every attestation publisher waits for a writable link first", () => {
    const publisher = codeOf("src/modules/runtime/runtime-attestation.ts");
    const start = publisher.slice(publisher.indexOf("start() {"));
    expect(start).toContain("options.waitUntilReady");
    // The wait precedes the first publish, and only the first.
    expect(start.indexOf("waitUntilReady")).toBeLessThan(start.indexOf("setInterval"));

    for (const entrypoint of [ACCOUNT_SERVER, "src/modules/jobs/execution.worker.ts"]) {
      expect(codeOf(entrypoint)).toContain("waitUntilReady: attestationRedis.waitUntilReady");
    }
  });

  it("14. the generic analysis worker gained no account surface", () => {
    const code = codeOf(GENERIC_WORKER);
    for (const forbidden of [
      "operatorRoutes",
      "bindConfiguredExchangeRuntime",
      "configuredProfileIdentity",
      "createRuntimeAttestationPublisher",
    ]) {
      expect(`${forbidden} in generic worker: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in generic worker: false`
      );
    }
  });

  it("15. the account env guard names variables, never values", () => {
    const code = raw(ACCOUNT_ENV);
    // Only the KEY list is ever emitted. A value, a length or a hash of a short
    // account identifier would each leak something.
    expect(code).toContain("conflictingKeys");
    for (const forbidden of ["createHash", "slice(0,", ".length}"]) {
      expect(`${forbidden} in account env guard: ${code.includes(forbidden)}`).toBe(
        `${forbidden} in account env guard: false`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 16. The operator UI keeps working across the split
// ---------------------------------------------------------------------------

describe("the dashboard still reaches operator control", () => {
  it("16. operator traffic is same-origin and account-explicit: /api -> generic gateway -> ONE loopback control plane", () => {
    // The ONE frontend names the account in every operator request
    // (/api/operator/accounts/A|B/...). It reaches the generic backend under
    // "/api", whose gateway forwards it to exactly that account's loopback
    // control plane. The browser holds no control-plane URL or port, and the
    // old single-account proxy (VITE_ACCOUNT_CONTROL_URL) is gone.
    const config = readFileSync(
      path.join(BACKEND, "..", "frontend", "vite.config.ts"),
      "utf8"
    );
    expect(config).toContain('"/api": { target: "http://127.0.0.1:4000", changeOrigin: true }');
    expect(config).not.toMatch(/"\/api\/operator"\s*:/);
    expect(config).not.toMatch(/accountControlUrl|VITE_ACCOUNT_CONTROL_URL|4001|4002/);
    const generic = codeOf(APP).slice(
      codeOf(APP).indexOf("export async function buildApp("),
      codeOf(APP).indexOf("export async function buildAccountControlApp(")
    );
    expect(generic).toContain("accountOperatorGatewayRoutes");
    // The control planes stay loopback-only by contract.
    const topology = codeOf("src/modules/operator/dual-account-topology.ts");
    for (const role of ["account-a-control", "account-b-control"]) {
      const block = topology.slice(topology.indexOf(`"${role}": {`), topology.indexOf("},", topology.indexOf(`"${role}": {`)));
      expect(`${role}:${block.includes("loopbackOnly: true")}`).toBe(`${role}:true`);
    }
  });
});

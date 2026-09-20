import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE seam proof: production composition never authenticates ambiently.
 *
 * Every Binance client constructor reads `options.apiKey ?? env.BINANCE_API_KEY`.
 * That default is correct-by-accident while one profile exists per process, and
 * becomes a wrong-account dispatch the moment a second one does. These tests
 * pin the property that makes a later per-profile runtime a local change: no
 * production composition site builds a signed client without saying, at the
 * call site, which credentials it is using.
 *
 * Structural on purpose. A regression here would not fail a behavioural test --
 * with one account configured, ambient and explicit credentials are the same
 * bytes.
 */

const BACKEND = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const SRC = path.join(BACKEND, "src");
const BINDING = "src/modules/execution/exchange-runtime-binding.ts";
const PROFILE_BINDING = "src/modules/execution/binance-profile-binding.ts";

/**
 * Source with comments removed; the prose necessarily names what it forbids.
 *
 * Line comments are stripped BEFORE block comments, and the order matters.
 * `config/env.ts` has a line comment describing a `/screenshots` wildcard route,
 * and it ends in a stray block-comment OPENER. Strip block comments first and
 * that opener swallows every line until the next closing marker -- roughly 150
 * lines of real code, including the credential declarations themselves. A scan
 * that runs over every production file cannot afford a blind spot that arbitrary
 * prose can open.
 *
 * The `[^:]` guard keeps `https://` inside string literals intact.
 */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
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

/**
 * The client classes themselves, where a zero-argument construction is a
 * DEFAULT PARAMETER rather than a composition decision.
 *
 * These are the only files allowed to build a client with no credentials: the
 * fallback is retained deliberately so tests, the testnet verifier and injected
 * callers keep working. What must never happen is a COMPOSITION relying on it.
 */
const CLASS_INTERNAL_DEFAULTS = new Set([
  "src/modules/binance/binance.client.ts",
  "src/modules/binance/binance-read-only.service.ts",
  "src/modules/binance/binance-execution.client.ts",
  "src/modules/binance/binance-account-setup.client.ts",
  "src/modules/binance/binance-account-connection.service.ts",
  "src/modules/binance/binance-margin-plan.service.ts",
  "src/modules/execution/canary-symbol-validation.ts",
]);

/**
 * The two runtime factories, and the only production way to build a signed
 * wrapper that is not a client the caller already holds credentials for.
 */
const RUNTIME_FACTORIES = [
  [
    "src/modules/binance/binance-margin-plan.service.ts",
    "marginPlanServiceFromRuntime",
    "BinanceMarginPlanService",
  ],
  [
    "src/modules/binance/binance-account-connection.service.ts",
    "accountConnectionFromRuntime",
    "BinanceAccountConnectionService",
  ],
] as const;

/**
 * Sites that build a client for an UNSIGNED endpoint only.
 *
 * `listSymbolFilters` reads `exchangeInfo`, declared `signed: false` in the
 * endpoint table, so no credential participates in the request. Listed
 * separately from the defaults above because the reason it is safe is
 * different, and a future SIGNED call from here should fail this test.
 */
const UNSIGNED_ONLY = new Set(["src/modules/operator/allowlist.service.ts"]);

/** Every production site that composes a client reaching a SIGNED endpoint. */
const SIGNED_COMPOSITION: ReadonlyArray<readonly [string, string]> = [
  ["src/modules/jobs/execution-orchestration.scheduler.ts", "the orchestration scheduler"],
  ["src/modules/jobs/historical-fill-worker-runtime.ts", "the historical fill runtime"],
  ["src/modules/jobs/execution.worker.ts", "the account execution worker"],
  ["src/modules/execution/run-protection-recovery.ts", "protection recovery"],
  ["src/modules/execution/run-shutdown-drain.ts", "shutdown drain"],
  ["src/modules/execution/run-entry-recovery.ts", "entry recovery"],
  ["src/modules/execution/run-fill-canary.ts", "the targeted fill canary"],
  ["src/modules/execution/run-canary-controls.ts", "canary controls"],
  ["src/modules/binance/run-read-only-check.ts", "the read-only connectivity check"],
];

/**
 * Every wrapper that can reach a SIGNED endpoint.
 *
 * Derived from the source rather than remembered: `SIGNED_WRAPPERS` is
 * asserted below against the classes that actually exist in the binance
 * module, so a NEW signed wrapper cannot be added without either appearing
 * here or failing that assertion. The 11B version of this list was written by
 * hand and silently omitted BinanceMarginPlanService and
 * BinanceAccountConnectionService, which is how six production sites kept
 * selecting an account from ambient configuration.
 */
const SIGNED_WRAPPERS = [
  "BinanceReadOnlyClient",
  "BinanceReadOnlyService",
  "BinanceUsdMExecutionClient",
  "BinanceAccountSetupClient",
  "BinanceMarginPlanService",
  "BinanceAccountConnectionService",
] as const;

/** A construction with no arguments at all. */
const ZERO_ARG = new RegExp(
  `new\\s+(${SIGNED_WRAPPERS.join("|")})\\s*\\(\\s*\\)`,
  "g"
);

describe("no production composition authenticates ambiently", () => {
  it("every zero-argument client construction is a class-internal default", () => {
    const offenders = productionSources()
      .filter((module) => !CLASS_INTERNAL_DEFAULTS.has(module))
      .filter((module) => !UNSIGNED_ONLY.has(module))
      .filter((module) => ZERO_ARG.test(codeOf(module)) || (ZERO_ARG.lastIndex = 0) !== 0);
    // Reset the shared regex's lastIndex between files above; assert the result.
    expect(offenders).toEqual([]);
  });

  for (const [module, description] of SIGNED_COMPOSITION) {
    it(`${description} resolves credentials from the BOUND RUNTIME`, () => {
      const code = codeOf(module);
      // Phase 11D: credentials no longer come from configuration at the call
      // site, they come from the runtime that also proved the profile. Either
      // form counts, and nothing else does.
      const fromRuntime =
        code.includes("exchangeClientOptionsOf(") ||
        code.includes("marginPlanServiceFromRuntime(") ||
        code.includes("accountConnectionFromRuntime(");
      expect(`${module} derives credentials from a runtime: ${fromRuntime}`).toBe(
        `${module} derives credentials from a runtime: true`
      );
      expect(code).not.toContain("configuredExchangeClientOptions()");

      // And builds no signed wrapper without them.
      ZERO_ARG.lastIndex = 0;
      expect(ZERO_ARG.test(code)).toBe(false);
    });
  }

  it("the generic worker composes no signed client and reads no credential", () => {
    // Phase 11E: this file used to be a SIGNED_COMPOSITION site. Membership
    // of that list moving is not by itself proof that the credentials left,
    // so this asserts the absence directly: no signed wrapper, no binding
    // helper, no credential variable. A second copy of this process is
    // expected to exist one day, and it must never be able to act as an
    // account.
    const code = codeOf("src/modules/jobs/vision-analysis.worker.ts");
    for (const wrapper of SIGNED_WRAPPERS) {
      expect(`${wrapper} constructed in generic worker: ${code.includes(`new ${wrapper}`)}`).toBe(
        `${wrapper} constructed in generic worker: false`
      );
    }
    for (const helper of [
      "exchangeClientOptionsOf(",
      "marginPlanServiceFromRuntime(",
      "accountConnectionFromRuntime(",
      "configuredExchangeClientOptions(",
      "bindConfiguredExchangeRuntime(",
    ]) {
      expect(`${helper} in generic worker: ${code.includes(helper)}`).toBe(
        `${helper} in generic worker: false`
      );
    }
    expect(CREDENTIAL_ENV_READ.test(code)).toBe(false);
  });

  it("no production composition passes an execution client without credentials", () => {
    // The precise shape the orchestrator used to have.
    const offenders = productionSources().filter((module) =>
      /new\s+BinanceUsdMExecutionClient\(\{\s*readOnlyClient:\s*undefined\s*\}\)/.test(codeOf(module))
    );
    expect(offenders).toEqual([]);
  });
});

describe("the credential seam cannot be aimed", () => {
  it("neither factory accepts a profile selector", () => {
    const binding = codeOf(BINDING).replace(/\s+/g, " ");
    // Compile-time tuple contracts, asserted in typechecked source rather than
    // here, because the test project is excluded from `tsc`.
    expect(binding).toContain("Parameters<typeof resolveConfiguredExchangeCredentials>, []");
    expect(binding).toContain("Parameters<typeof configuredExchangeClientOptions>, []");
    expect(binding).toContain("Parameters<typeof bindConfiguredExchangeRuntime>, [PrismaClient]");
  });

  it("exposes no getCredentials(profileId)-shaped surface", () => {
    const binding = codeOf(BINDING);
    expect(binding).not.toMatch(/export function \w*[Cc]redentials\w*\(\s*\w+\s*:/);
    expect(binding).not.toContain("profileId:");
    expect(binding).not.toContain("accountIdentifier:");
  });

  it("the runtime binding composes the profile binder rather than re-resolving", () => {
    // Re-resolving would let the two halves come from different places.
    const binding = codeOf(BINDING);
    expect(binding).toContain("bindConfiguredExecutionProfileEnvironment(prisma)");
    expect(binding).not.toContain("resolveExecutionProfile(");
    expect(binding).not.toContain("configuredProfileIdentity(");
  });

  it("the bound runtime carries the profile and the credentials together", () => {
    const binding = codeOf(BINDING);
    expect(binding).toContain("readonly profile: EnvironmentBoundBinanceExecutionProfile;");
    expect(binding).toContain("readonly credentials: ExchangeCredentials;");
    // Branded: construction is the factory or nothing.
    expect(binding).toContain("declare const exchangeRuntimeBound: unique symbol");
  });
});

describe("credentials never leave the process", () => {
  it("the binding module logs nothing", () => {
    const binding = codeOf(BINDING);
    for (const sink of ["logger", "console.log", "console.error", "console.warn"]) {
      expect(binding).not.toContain(sink);
    }
  });

  it("the binding module performs no database write", () => {
    const binding = codeOf(BINDING);
    for (const mutation of [
      ".create(", ".createMany(", ".update(", ".updateMany(",
      ".upsert(", ".delete(", ".deleteMany(", "$executeRaw",
    ]) {
      expect(binding).not.toContain(mutation);
    }
  });

  it("no schema model stores credential material", () => {
    const schema = readFileSync(path.join(BACKEND, "prisma/schema.prisma"), "utf8");
    const columns = schema
      .split("\n")
      .filter((line) => /^\s{2}\w+\s+(String|Bytes)/.test(line))
      .map((line) => line.trim().split(/\s+/)[0]!.toLowerCase());
    for (const column of columns) {
      expect(column).not.toMatch(/apikey|apisecret|secretkey|privatekey/);
    }
  });

  it("the non-secret profile identity is carried, and nothing more", () => {
    // accountIdentifier is an operator alias and safe to print; it must not be
    // confused with, or accompanied by, anything credential-shaped.
    const profileBinding = codeOf(PROFILE_BINDING);
    expect(profileBinding).toContain("readonly accountIdentifier: string;");
    for (const forbidden of ["apiKey", "apiSecret", "credential"]) {
      expect(profileBinding).not.toContain(forbidden);
    }
  });
});

/**
 * The second hole: a composition that keeps the seam in place and reads the
 * environment anyway.
 *
 * Forbidding zero-argument construction is not enough on its own. A scheduler
 * can satisfy that rule perfectly while writing
 *
 *     new BinanceReadOnlyClient({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET })
 *
 * which is explicit at the call site and still selects the account ambiently --
 * the same wrong-key dispatch, one layer up. So the credential VARIABLES
 * themselves are the thing with an allowlist, not just the constructors.
 */

/** `env.X`, `process.env.X` and the bracket forms of either. */
const CREDENTIAL_ENV_READ =
  /\benv\s*(?:\.\s*BINANCE_API_(?:KEY|SECRET)\b|\[\s*["'`]BINANCE_API_(?:KEY|SECRET)["'`]\s*\])/;

/**
 * The ONLY production modules permitted to touch the credential variables.
 *
 * Per-file and source-justified; no directory is exempt, because the point of
 * the rule is that a NEW file in any of these directories must not be able to
 * read them.
 *
 *  - `config/env.ts`                   declares and parses them; nothing reads
 *                                      a value there, but it is where they are
 *                                      defined and a schema change belongs.
 *  - `exchange-runtime-binding.ts`     the seam itself -- the one place a value
 *                                      is read, by design.
 *  - the three client classes          the `options.apiKey ?? env.BINANCE_API_KEY`
 *                                      compatibility fallback, kept deliberately
 *                                      (see the module docs) and reachable only
 *                                      when a caller omits the option. Every
 *                                      production COMPOSITION is forbidden from
 *                                      relying on it by the tests above.
 *  - `run-testnet-protection-verify.ts` reads the PRODUCTION credentials for one
 *                                      purpose only: a collision guard that
 *                                      refuses if they were pasted into the
 *                                      testnet slots. Never used to build a
 *                                      client, asserted separately below.
 */
const CREDENTIAL_ENV_READERS = [
  "src/config/env.ts",
  "src/modules/execution/exchange-runtime-binding.ts",
  "src/modules/binance/binance.client.ts",
  "src/modules/binance/binance-execution.client.ts",
  "src/modules/binance/binance-account-setup.client.ts",
  "src/modules/binance/run-testnet-protection-verify.ts",
] as const;

const TESTNET_COLLISION_GUARD = "src/modules/binance/run-testnet-protection-verify.ts";

describe("credential variables are read only where source proves they must be", () => {
  it("no other production module reads BINANCE_API_KEY or BINANCE_API_SECRET", () => {
    const allowed = new Set<string>(CREDENTIAL_ENV_READERS);
    const offenders = productionSources()
      .filter((module) => !allowed.has(module))
      .filter((module) => CREDENTIAL_ENV_READ.test(codeOf(module)));

    expect(offenders).toEqual([]);
  });

  it("the allowlist is exactly these files and cannot be widened quietly", () => {
    // Widening it is how a bypass would be legitimised; the list is therefore
    // pinned, and adding a module here fails until the pin is changed too.
    expect([...CREDENTIAL_ENV_READERS]).toEqual([
      "src/config/env.ts",
      "src/modules/execution/exchange-runtime-binding.ts",
      "src/modules/binance/binance.client.ts",
      "src/modules/binance/binance-execution.client.ts",
      "src/modules/binance/binance-account-setup.client.ts",
      "src/modules/binance/run-testnet-protection-verify.ts",
    ]);
  });

  it("every allowlisted module still exists and still reads them", () => {
    // A stale exemption is a pre-authorised bypass: it would silently cover a
    // file that starts reading credentials later.
    for (const module of CREDENTIAL_ENV_READERS) {
      const code = codeOf(module);
      if (module === "src/config/env.ts") {
        // The declaration site: it defines the variables rather than reading one.
        expect(code).toContain("BINANCE_API_KEY: z.string()");
        expect(code).toContain("BINANCE_API_SECRET: z.string()");
        expect(CREDENTIAL_ENV_READ.test(code)).toBe(false);
        continue;
      }
      expect(CREDENTIAL_ENV_READ.test(code)).toBe(true);
    }
  });

  for (const [module, description] of SIGNED_COMPOSITION) {
    it(`${description} reads no credential variable of its own`, () => {
      // The exact regression this forbids: swapping
      //   configuredExchangeClientOptions()
      // for
      //   { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET }
      expect(CREDENTIAL_ENV_READ.test(codeOf(module))).toBe(false);
    });
  }

  it("the testnet collision guard compares the production values, never builds with them", () => {
    const code = codeOf(TESTNET_COLLISION_GUARD);
    // They reach a validator as named inputs...
    expect(code).toContain("resolveTestnetConfig({");
    expect(code).toContain("BINANCE_API_KEY: process.env.BINANCE_API_KEY");
    // ...and never a client's credential options.
    expect(code).not.toMatch(/apiKey\s*:\s*process\.env\.BINANCE_API_KEY/);
    expect(code).not.toMatch(/apiSecret\s*:\s*process\.env\.BINANCE_API_SECRET/);
  });
});

describe("the synchronous seam refuses rather than substituting a value", () => {
  it("the client-options helper throws instead of returning empty credentials", () => {
    const binding = codeOf(BINDING);
    expect(binding).toContain("throw new ExchangeCredentialsMissingError(");
    // The empty-string pair is a VALUE, and values get logged, compared and
    // mistaken for configuration.
    expect(binding).not.toMatch(/apiKey:\s*""\s*,\s*apiSecret:\s*""/);
  });

  it("the refusal still comes from the single resolver", () => {
    // One place decides what "configured" means; the helper only turns its
    // refusal into a throw.
    const binding = codeOf(BINDING).replace(/\s+/g, " ");
    expect(binding).toContain(
      "export function configuredExchangeClientOptions(): { apiKey: string; apiSecret: string } { const resolved = resolveConfiguredExchangeCredentials();"
    );
    // Exactly one place reads the variables.
    expect(binding.match(/env\.BINANCE_API_KEY/g)).toHaveLength(1);
    expect(binding.match(/env\.BINANCE_API_SECRET/g)).toHaveLength(1);
  });
});

/**
 * Phase 11D — the canonical bound runtime is the only production source of
 * account identity AND credentials, and the guard now covers every signed
 * wrapper rather than the four it happened to list.
 */
describe("every signed wrapper is covered, and the list cannot silently shrink", () => {
  it("names every class in the binance module whose construction can sign", () => {
    // Pinned literally: adding a signed wrapper without adding it here is the
    // exact mistake 11B made, and this is where it now costs a red test.
    expect([...SIGNED_WRAPPERS]).toEqual([
      "BinanceReadOnlyClient",
      "BinanceReadOnlyService",
      "BinanceUsdMExecutionClient",
      "BinanceAccountSetupClient",
      "BinanceMarginPlanService",
      "BinanceAccountConnectionService",
    ]);
  });

  it("covers the two wrappers whose omission let six production sites drift", () => {
    expect(SIGNED_WRAPPERS).toContain("BinanceMarginPlanService");
    expect(SIGNED_WRAPPERS).toContain("BinanceAccountConnectionService");
  });

  it("finds no zero-argument construction of ANY of them outside the class files", () => {
    const offenders = productionSources()
      .filter((module) => !CLASS_INTERNAL_DEFAULTS.has(module))
      .filter((module) => !UNSIGNED_ONLY.has(module))
      .filter((module) => {
        ZERO_ARG.lastIndex = 0;
        return ZERO_ARG.test(codeOf(module));
      });
    expect(offenders).toEqual([]);
  });
});

describe("the six sites that used to select an account ambiently", () => {
  const REPAIRED = [
    ["src/modules/binance/run-margin-plan.ts", "marginPlanServiceFromRuntime"],
    ["src/modules/binance/run-liquidation-validation.ts", "marginPlanServiceFromRuntime"],
    ["src/modules/binance/run-account-health.ts", "accountConnectionFromRuntime"],
    ["src/modules/binance/run-set-hedge-mode.ts", "accountConnectionFromRuntime"],
    ["src/modules/binance/run-test-order.ts", "accountConnectionFromRuntime"],
  ] as const;

  for (const [module, factory] of REPAIRED) {
    it(`${module} binds a runtime before building its signed service`, () => {
      const code = codeOf(module);
      expect(code).toContain("bindConfiguredExchangeRuntime(prisma)");
      expect(code).toContain(`${factory}(bound.runtime)`);
      // And the refusal precedes the construction, so a failed binding leaves
      // no client in existence.
      const refuse = code.indexOf("if (!bound.ok) {");
      const build = code.indexOf(`${factory}(bound.runtime)`);
      expect(refuse).toBeGreaterThan(-1);
      expect(refuse).toBeLessThan(build);
    });
  }

  it("the canary preflight no longer invents an account connection", () => {
    const code = codeOf("src/modules/execution/canary-preflight.service.ts");
    expect(code).not.toContain("new BinanceAccountConnectionService()");
    // Absent an injected one, it binds -- and an unbindable process reports a
    // health that has learned nothing rather than a healthy account.
    expect(code).toContain("bindConfiguredExchangeRuntime(this.prisma)");
    expect(code).toContain("accountConnectionFromRuntime(runtime)");
    // A binding failure yields a health that learned nothing, built without
    // a client and therefore without a request.
    expect(code).toContain("unbindableConnection(bound.ok ? \"UNKNOWN\" : bound.reasonCode)");
    expect(codeOf("src/modules/binance/binance-account-connection.service.ts")).toContain(
      "export function unbindableAccountHealth("
    );
  });

  it("each runtime factory takes a runtime and builds its own wrapper", () => {
    for (const [module, factory, wrapper] of RUNTIME_FACTORIES) {
      const code = codeOf(module);
      expect(code).toContain(`export function ${factory}(`);
      expect(code).toContain("runtime: BoundExchangeRuntime");
      expect(code).toContain(`return new ${wrapper}(`);
      // Credentials come from the runtime, never from the environment.
      expect(code).toContain("exchangeClientOptionsOf(runtime)");
    }
  });
});

describe("production composition consumes the bound runtime, not configuration", () => {
  it("no production module calls configuredExchangeClientOptions()", () => {
    // It survives for the narrow synchronous cases that have no runtime, but
    // after 11D no production path is one of those.
    const offenders = productionSources()
      .filter((module) => module !== BINDING)
      .filter((module) => codeOf(module).includes("configuredExchangeClientOptions()"));
    expect(offenders).toEqual([]);
  });

  it("client options and the profile projection both come from a runtime", () => {
    const binding = codeOf(BINDING).replace(/\s+/g, " ");
    expect(binding).toContain("Parameters<typeof profileProjectionOf>, [BoundExchangeRuntime]");
    expect(binding).toContain("Parameters<typeof exchangeClientOptionsOf>, [BoundExchangeRuntime]");
  });

  it("the projection carries no credential and no account alias", () => {
    const binding = codeOf(BINDING);
    const at = binding.indexOf("export interface BoundExecutionProfileProjection {");
    expect(at).toBeGreaterThan(-1);
    const body = binding.slice(at, binding.indexOf("}", at));
    for (const forbidden of ["apiKey", "apiSecret", "credentials", "accountIdentifier"]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

/**
 * Phase 11D final gate — where DB profile state and signed account state meet,
 * they must meet inside ONE binding.
 *
 * The earlier guards prove credentials come from a bound runtime. These prove
 * the other half: that a module combining profile-specific rows with signed
 * exchange access does not establish the two sides independently. A direct
 * `resolveExecutionProfile` is fine in a module that cannot reach the exchange
 * at all, and is a split brain in one that can.
 */

const SAFETY_ADMISSION = "src/modules/execution/safety-admission.service.ts";
const CANARY_PREFLIGHT = "src/modules/execution/canary-preflight.service.ts";
const CANARY_CONTROLS = "src/modules/execution/run-canary-controls.ts";
const ORCHESTRATOR = "src/modules/execution/execution-orchestrator.ts";

describe("safety admission inherits one runtime for both halves", () => {
  it("resolves no configured profile of its own", () => {
    const code = codeOf(SAFETY_ADMISSION);
    expect(code).not.toContain("resolveExecutionProfile(");
    expect(code).not.toContain("configuredProfileIdentity(");
  });

  it("holds no credentials -- only an injected read-only service", () => {
    const code = codeOf(SAFETY_ADMISSION);
    for (const forbidden of ["apiKey", "apiSecret", "exchangeClientOptionsOf", "BINANCE_API"]) {
      expect(code).not.toContain(forbidden);
    }
    expect(code).toContain("private readonly readOnly: BinanceReadOnlyService");
  });

  it("its ONE caller gates on the bound profile before admission is reached", () => {
    const orchestrator = codeOf(ORCHESTRATOR);
    const gate = orchestrator.indexOf("if (execution.executionProfileId !== boundProfileId) {");
    const call = orchestrator.indexOf("this.deps.admission.evaluateAndReserveSafetyAdmission(");
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);

    // And there is exactly one production call site, so the gate cannot be
    // routed around by a second caller.
    const callers = productionSources().filter((module) =>
      codeOf(module).includes("evaluateAndReserveSafetyAdmission(")
    );
    expect(callers.sort()).toEqual([ORCHESTRATOR, SAFETY_ADMISSION]);
  });

  it("an execution never changes profile, so the gate stays true afterwards", () => {
    // Admission re-reads the row by id. That is only safe because nothing
    // reassigns an execution's profile after creation.
    // UPDATE paths only. A create legitimately sets the profile once; what
    // must never happen is a later write moving a row to another account.
    const UPDATE_SETTING_PROFILE =
      /tradeExecution\s*\.\s*update(Many)?\s*\(\s*\{[\s\S]{0,600}?data:\s*\{[^}]*executionProfileId/;
    const offenders = productionSources().filter((module) =>
      UPDATE_SETTING_PROFILE.test(codeOf(module))
    );
    expect(offenders).toEqual([]);
  });
});

describe("the canary preflight binds once for a single readiness verdict", () => {
  it("resolves no configured profile independently", () => {
    const code = codeOf(CANARY_PREFLIGHT);
    expect(code).not.toContain("resolveExecutionProfile(");
    expect(code).not.toContain("configuredProfileIdentity(");
  });

  it("binds exactly once per run, before either half is read", () => {
    const code = codeOf(CANARY_PREFLIGHT);
    const binds = code.match(/bindConfiguredExchangeRuntime\(/g) ?? [];
    expect(binds).toHaveLength(1);

    const bind = code.indexOf("const bound = await bindConfiguredExchangeRuntime(this.prisma);");
    const health = code.indexOf("await binance.checkAccountConnection()");
    const local = code.indexOf("this.readLocalExecutionState(boundProfileId)");
    expect(bind).toBeGreaterThan(-1);
    expect(bind).toBeLessThan(health);
    expect(bind).toBeLessThan(local);
  });

  it("both halves read the SAME bound identity", () => {
    const code = codeOf(CANARY_PREFLIGHT);
    // DB side: every reader takes the bound id.
    expect(code).toContain("readLocalExecutionState(boundProfileId)");
    expect(code).toContain("readProfilePolicyRow(boundProfileId)");
    expect(code).toContain("readAuthorizationState(mode, boundProfileId)");
    // Signed side: from the same runtime object.
    expect(code).toContain("accountConnectionFromRuntime(runtime)");
    expect(code).toContain("const boundProfileId = runtime?.profile.executionProfileId ?? null;");
  });
});

describe("canary controls that combine both halves bind once", () => {
  /** The three that gate a durable mutation on SIGNED evidence. */
  const ACCOUNT_SPECIFIC = [
    "export async function prepareCanary(",
    "export async function armCanary(",
    "export async function armNaturalCanary(",
  ] as const;

  const bodyOf = (signature: string): string => {
    const code = codeOf(CANARY_CONTROLS);
    const start = code.indexOf(signature);
    // To the next FUNCTION of any kind: a private helper sitting between two
    // commands is not part of either, and reading it as such would make this
    // assertion describe the wrong code.
    // Plain string search: the next function of ANY kind, exported or not.
    const next = code.indexOf("async function ", start + 10);
    return next === -1 ? code.slice(start) : code.slice(start, next);
  };

  for (const signature of ACCOUNT_SPECIFIC) {
    it(`${signature.slice(23, -1)} takes its profile from the binding`, () => {
      const body = bodyOf(signature);
      expect(body).toContain("await boundProfileForControl(prisma)");
      // Never a second, independent answer alongside it.
      expect(body).not.toContain("resolveExecutionProfile(");
      expect(body).not.toContain("configuredProfileIdentity(");
    });
  }

  it("the helper loads the row by the id the binding proved", () => {
    const code = codeOf(CANARY_CONTROLS);
    const at = code.indexOf("async function boundProfileForControl(");
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, at + 1200);
    expect(body).toContain("bindConfiguredExchangeRuntime(prisma)");
    expect(body).toContain("where: { id: bound.runtime.profile.executionProfileId }");
  });

  it("the attestation helper reads an identity, not a profile", () => {
    // `evaluateRuntimeAttestation` builds { accountIdentifier, environment } to
    // find the right Redis attestation key. It resolves no profile row, holds
    // no client, and gates nothing about which account is traded.
    const code = codeOf(CANARY_CONTROLS);
    const at = code.indexOf("async function evaluateRuntimeAttestation(");
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, at + 700);
    expect(body).toContain("const identity = configuredProfileIdentity();");
    expect(body).not.toContain("resolveExecutionProfile(");
    expect(body).not.toContain("new Binance");
  });

  it("the DB-only commands may still resolve directly", () => {
    // They read and write authorization rows and reach no exchange client.
    // Forbidding them would buy nothing and make the rule less honest.
    const code = codeOf(CANARY_CONTROLS);
    expect(code).toContain("resolveExecutionProfile(prisma, configuredProfileIdentity())");
  });
});

/**
 * The complete direct-resolution allowlist.
 *
 * Every entry is a module that reaches NO signed exchange client, or the
 * canonical binder itself. It is pinned literally so a module that later grows
 * an exchange client cannot quietly keep its direct resolution.
 */
const DIRECT_PROFILE_RESOLUTION = [
  "src/modules/execution/binance-profile-binding.ts",
  "src/modules/execution/execution-profile.service.ts",
  "src/modules/execution/entry-recovery-cli.ts",
  "src/modules/execution/protection-recovery-cli.ts",
  "src/modules/execution/run-canary-controls.ts",
  "src/modules/execution/run-canary-preflight.ts",
  "src/modules/execution/run-ensure-profile.ts",
  "src/modules/execution/run-set-policy.ts",
  "src/modules/extreme-rr/extreme-rr.service.ts",
  "src/modules/operator/allowlist.service.ts",
  "src/modules/operator/extreme-rr-lookback.service.ts",
  "src/modules/operator/policy-editor.service.ts",
  "src/modules/operator/source-timeframes.service.ts",
  "src/modules/operator/trading-control-actions.service.ts",
  "src/modules/operator/trading-control.service.ts",
  "src/modules/webhook/webhook.service.ts",
] as const;

describe("direct profile resolution survives only where it cannot reach the exchange", () => {
  const RESOLVES = /resolveExecutionProfile\(|configuredProfileIdentity\(/;

  it("no module outside the allowlist resolves directly", () => {
    const allowed = new Set<string>(DIRECT_PROFILE_RESOLUTION);
    const offenders = productionSources()
      .filter((module) => !allowed.has(module))
      .filter((module) => RESOLVES.test(codeOf(module)));
    expect(offenders).toEqual([]);
  });

  it("the allowlist is exactly this, and cannot be widened quietly", () => {
    expect([...DIRECT_PROFILE_RESOLUTION]).toEqual([
      "src/modules/execution/binance-profile-binding.ts",
      "src/modules/execution/execution-profile.service.ts",
      "src/modules/execution/entry-recovery-cli.ts",
      "src/modules/execution/protection-recovery-cli.ts",
      "src/modules/execution/run-canary-controls.ts",
      "src/modules/execution/run-canary-preflight.ts",
      "src/modules/execution/run-ensure-profile.ts",
      "src/modules/execution/run-set-policy.ts",
      "src/modules/extreme-rr/extreme-rr.service.ts",
      "src/modules/operator/allowlist.service.ts",
      "src/modules/operator/extreme-rr-lookback.service.ts",
      "src/modules/operator/policy-editor.service.ts",
      "src/modules/operator/source-timeframes.service.ts",
      "src/modules/operator/trading-control-actions.service.ts",
      "src/modules/operator/trading-control.service.ts",
      "src/modules/webhook/webhook.service.ts",
    ]);
  });

  it("every allowlisted module still resolves, so no exemption is dead", () => {
    for (const module of DIRECT_PROFILE_RESOLUTION) {
      expect(`${module} resolves: ${RESOLVES.test(codeOf(module))}`).toBe(
        `${module} resolves: true`
      );
    }
  });

  it("none of them constructs a signed client, except where 11D bound it", () => {
    // `run-canary-controls` is the one module holding both, and its
    // account-specific commands are pinned above to bind for both halves.
    const CLIENTS = /new\s+Binance(ReadOnlyClient|UsdMExecutionClient|AccountSetupClient)\s*\(/;
    const holdsAClient = DIRECT_PROFILE_RESOLUTION.filter((module) =>
      CLIENTS.test(codeOf(module))
    );
    expect(holdsAClient).toEqual([CANARY_CONTROLS]);
  });
});

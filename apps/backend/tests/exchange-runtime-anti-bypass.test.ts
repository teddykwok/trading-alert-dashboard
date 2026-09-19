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
  ["src/modules/jobs/vision-analysis.worker.ts", "the normal worker"],
  ["src/modules/execution/run-protection-recovery.ts", "protection recovery"],
  ["src/modules/execution/run-shutdown-drain.ts", "shutdown drain"],
  ["src/modules/execution/run-entry-recovery.ts", "entry recovery"],
  ["src/modules/execution/run-fill-canary.ts", "the targeted fill canary"],
  ["src/modules/execution/run-canary-controls.ts", "canary controls"],
  ["src/modules/binance/run-read-only-check.ts", "the read-only connectivity check"],
];

/** A construction with no arguments at all. */
const ZERO_ARG = /new\s+(BinanceReadOnlyClient|BinanceReadOnlyService|BinanceUsdMExecutionClient|BinanceAccountSetupClient)\s*\(\s*\)/g;

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
    it(`${description} resolves credentials explicitly`, () => {
      const code = codeOf(module);
      expect(code).toContain("configuredExchangeClientOptions()");
      // And builds no client without them.
      const zeroArg = code.match(
        /new\s+(BinanceReadOnlyClient|BinanceReadOnlyService|BinanceUsdMExecutionClient|BinanceAccountSetupClient)\s*\(\s*\)/g
      );
      expect(zeroArg).toBeNull();
    });
  }

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

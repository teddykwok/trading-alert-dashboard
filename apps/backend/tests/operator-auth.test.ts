import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * The operator authentication boundary.
 *
 * Every execution safety layer in this project — natural authorization, the
 * policy CAS, the shared operator advisory lock, the runtime-attestation
 * interlock — sits BEHIND the operator commands and assumes the caller is the
 * operator at a local terminal. The moment those actions become reachable over
 * HTTP that assumption is gone, so this boundary has to hold before any control
 * route exists. These tests are the proof that it does.
 *
 * Nothing here touches a database, Redis, Binance or execution state: the guard
 * is deliberately a pure function of one header and one environment variable.
 */

// >= 32 characters, exactly as the env schema demands of a real token.
const TOKEN = "operator-test-token-0123456789abcdef";
const originalToken = process.env.OPERATOR_API_TOKEN;

/**
 * Builds a bare Fastify app on a FRESH module graph.
 *
 * `config/env.ts` parses `process.env` once at import, so the only way to
 * exercise both the configured and unconfigured cases is to reset modules
 * between them.
 *
 * The unconfigured case sets an empty string rather than deleting the key:
 * `dotenv` refuses to overwrite a variable that is already present, so an empty
 * value pins the test to "unconfigured" no matter what the operator's real
 * `.env` happens to contain.
 */
async function buildApp(token: string): Promise<FastifyInstance> {
  process.env.OPERATOR_API_TOKEN = token;
  vi.resetModules();

  const { operatorRoutes } = await import("../src/routes/operator.routes");
  const { requireOperatorAuth } = await import("../src/modules/operator/operator-auth");
  const { AppError } = await import("../src/utils/errors");

  const app = Fastify();
  await app.register(operatorRoutes);
  // A SECOND guarded route: the guard must be a reusable preHandler, not
  // something welded to one path.
  app.get("/api/operator/second", { preHandler: requireOperatorAuth }, async () => ({ ok: true }));
  // An UNGUARDED route standing in for the dashboard's ordinary read APIs,
  // which must keep working exactly as before.
  app.get("/api/alerts", async () => ({ open: true }));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.name, message: error.message });
    }
    return reply.code(500).send({ error: "Internal", message: "failed" });
  });
  await app.ready();
  return app;
}

const probe = (app: FastifyInstance, authorization?: string) =>
  app.inject({
    method: "GET",
    url: "/api/operator/auth-check",
    headers: authorization === undefined ? {} : { authorization },
  });

afterAll(() => {
  if (originalToken === undefined) delete process.env.OPERATOR_API_TOKEN;
  else process.env.OPERATOR_API_TOKEN = originalToken;
  vi.resetModules();
});

describe("operator auth: a valid token is accepted", () => {
  it("answers 200 with nothing but the authenticated flag", async () => {
    const app = await buildApp(TOKEN);
    const response = await probe(app, `Bearer ${TOKEN}`);

    expect(response.statusCode).toBe(200);
    // Deep equality, not a subset check: the probe must not become a place
    // where profile state, gates, symbols or counts leak to whoever holds the
    // token. Knowing the token is valid is all this route may tell you.
    expect(response.json()).toEqual({ authenticated: true });
    await app.close();
  });

  it.each([
    ["Bearer", `Bearer ${TOKEN}`],
    ["bearer (HTTP schemes are case-insensitive)", `bearer ${TOKEN}`],
    ["BEARER", `BEARER ${TOKEN}`],
    ["surrounding whitespace", `  Bearer ${TOKEN}  `],
    ["extra space after the scheme", `Bearer  ${TOKEN}`],
  ])("accepts %s", async (_label, header) => {
    const app = await buildApp(TOKEN);
    expect((await probe(app, header)).statusCode).toBe(200);
    await app.close();
  });
});

describe("operator auth: everything else is refused", () => {
  const refusals: [string, string | undefined][] = [
    ["no Authorization header at all", undefined],
    ["an empty header", ""],
    ["the scheme with no token", "Bearer"],
    ["the scheme with an empty token", "Bearer "],
    ["a Basic scheme", `Basic ${TOKEN}`],
    ["an unrecognised scheme", `Token ${TOKEN}`],
    ["the bare token with no scheme", TOKEN],
    ["a completely wrong token", "Bearer not-the-operator-token-0123456789"],
    ["a PREFIX of the real token", `Bearer ${TOKEN.slice(0, -1)}`],
    ["the real token with one byte appended", `Bearer ${TOKEN}x`],
    ["the real token in the wrong case", `Bearer ${TOKEN.toUpperCase()}`],
    ["the real token with an embedded space", `Bearer ${TOKEN.slice(0, 8)} ${TOKEN.slice(8)}`],
  ];

  it.each(refusals)("refuses %s with 401", async (_label, header) => {
    const app = await buildApp(TOKEN);
    expect((await probe(app, header)).statusCode).toBe(401);
    await app.close();
  });

  it("gives one identical refusal for every failure mode", async () => {
    // A caller must not be able to tell "no header" from "wrong scheme" from
    // "wrong token" from "a token that is right for the first 35 bytes". Any
    // difference between those answers is free reconnaissance against the one
    // credential that can arm a real-money account.
    const app = await buildApp(TOKEN);
    const bodies = new Set<string>();
    const statuses = new Set<number>();
    for (const [, header] of refusals) {
      const response = await probe(app, header);
      statuses.add(response.statusCode);
      bodies.add(response.body);
    }
    expect([...statuses]).toEqual([401]);
    expect([...bodies]).toHaveLength(1);
    await app.close();
  });

  it("never echoes the token, or any part of it, back to the caller", async () => {
    const app = await buildApp(TOKEN);
    for (const [, header] of refusals) {
      const response = await probe(app, header);
      const serialized = `${response.body} ${JSON.stringify(response.headers)}`;
      expect(serialized).not.toContain(TOKEN);
      // Not even the leading fragment a near-miss reply could confirm.
      expect(serialized).not.toContain(TOKEN.slice(0, 12));
    }
    // And not on the success path either.
    const ok = await probe(app, `Bearer ${TOKEN}`);
    expect(`${ok.body} ${JSON.stringify(ok.headers)}`).not.toContain(TOKEN.slice(0, 12));
    await app.close();
  });
});

describe("operator auth: an unconfigured token closes the door, it does not open it", () => {
  it.each([
    ["no header", undefined],
    ["an empty bearer", "Bearer "],
    ["the token this deployment does not have", `Bearer ${TOKEN}`],
    ["a literal empty-string token", `Bearer ""`],
  ])("refuses %s when OPERATOR_API_TOKEN is unset", async (_label, header) => {
    // The failure mode that would matter most: a deployment that never set the
    // variable must have NO operator API, not an open one.
    const app = await buildApp("");
    expect((await probe(app, header)).statusCode).toBe(401);
    await app.close();
  });

  it("refuses the empty string as a candidate token", async () => {
    const { isValidOperatorToken } = await import("../src/modules/operator/operator-auth");
    expect(isValidOperatorToken("")).toBe(false);
  });
});

describe("operator auth: the guard is opt-in, never global", () => {
  it("leaves an unguarded route reachable without any credential", async () => {
    // Registering the operator boundary must not quietly lock the dashboard's
    // ordinary read APIs — the alert list, assets, settings and the rest keep
    // working exactly as they did.
    const app = await buildApp(TOKEN);
    const response = await app.inject({ method: "GET", url: "/api/alerts" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("protects every route that opts in, not just the first", async () => {
    const app = await buildApp(TOKEN);
    const unauthorized = await app.inject({ method: "GET", url: "/api/operator/second" });
    const authorized = await app.inject({
      method: "GET",
      url: "/api/operator/second",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(`${unauthorized.statusCode}/${authorized.statusCode}`).toBe("401/200");
    await app.close();
  });
});

describe("operator auth: header parsing", () => {
  it("returns null for every malformed shape, so the caller cannot distinguish them", async () => {
    const { extractBearerToken } = await import("../src/modules/operator/operator-auth");
    for (const header of [undefined, "", "   ", "Bearer", "Bearer ", "Basic abc", "abc", "Bearerabc"]) {
      expect(`${JSON.stringify(header)}:${extractBearerToken(header)}`).toBe(`${JSON.stringify(header)}:null`);
    }
    expect(extractBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });
});

describe("operator auth: structural guarantees", () => {
  /**
   * Source with comments stripped: the prose deliberately names the very things
   * these assertions forbid, and must neither fail nor satisfy them.
   */
  const codeOf = (relative: string) =>
    readFileSync(path.join(process.cwd(), relative), "utf8")
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

  it("compares the token in constant time", () => {
    const code = codeOf("src/modules/operator/operator-auth.ts");
    expect(code).toContain("timingSafeEqual(");
    // A plain `===` against the configured value would reintroduce the timing
    // side channel this module exists to avoid.
    expect(code).not.toContain("=== configured");
    expect(code).not.toContain("configured ===");
  });

  it("never logs or interpolates the credential", () => {
    const code = codeOf("src/modules/operator/operator-auth.ts");
    for (const forbidden of ["console.", "request.log", "${token", "${candidate", "${configured"]) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("redacts the Authorization header from the logger", () => {
    // Fastify's default request serializer does not log headers, so nothing
    // leaks today. This makes that structural instead of incidental.
    const code = codeOf("src/config/logger.ts");
    expect(code).toContain("redact");
    expect(code).toContain("req.headers.authorization");
  });

  it("guards every operator route, and exposes exactly the reviewed mutations", () => {
    const code = codeOf("src/routes/operator.routes.ts");
    const routes = code.match(/app\.(get|post|put|patch|delete)\(/g) ?? [];
    const guards = code.match(/preHandler: requireOperatorAuth/g) ?? [];
    // Every route opts in. A new one that forgets the guard breaks this.
    expect(`routes:${routes.length} guards:${guards.length}`).toBe(`routes:${routes.length} guards:${routes.length}`);
    expect(routes.length).toBeGreaterThan(0);

    // The mutation surface is enumerated, not merely counted: a new action
    // cannot appear without this test naming it.
    const mutations = (code.match(/app\.post\(\s*"([^"]+)"/g) ?? []).map((entry) =>
      entry.replace(/[\s\S]*"/, "").replace(/"$/, "")
    );
    expect(code.match(/app\.(put|patch|delete)\(/g)).toBeNull();
    expect((code.match(/app\.post\(/g) ?? []).length).toBe(5);
    for (const expected of [
      "/api/operator/trading-control/start",
      "/api/operator/trading-control/stop-new-trades",
      "/api/operator/trading-control/safe-off",
      "/api/operator/trading-control/allowlist/validate",
      "/api/operator/trading-control/allowlist",
    ]) {
      expect(`${expected}:${code.includes(`"${expected}"`)}`).toBe(`${expected}:true`);
    }
    expect(mutations.length).toBe(5);

    // And every mutation carries the strict budget, not the dashboard one.
    expect((code.match(/OPERATOR_ACTION_RATE_LIMIT/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("does not reuse the TradingView webhook secret", () => {
    const code = codeOf("src/modules/operator/operator-auth.ts");
    // That secret is shared with an external service and travels inside alert
    // bodies, which makes it the wrong kind of credential for this.
    expect(code).not.toContain("WEBHOOK_SECRET");
    expect(code).toContain("env.OPERATOR_API_TOKEN");
  });
});

describe("operator auth: the token is validated at startup", () => {
  async function loadEnv(token: string) {
    process.env.OPERATOR_API_TOKEN = token;
    vi.resetModules();
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      const module = await import("../src/config/env");
      return { ok: true as const, value: module.env.OPERATOR_API_TOKEN, errors };
    } catch (error) {
      return { ok: false as const, error, errors };
    } finally {
      spy.mockRestore();
    }
  }

  it("rejects a token shorter than 32 characters", async () => {
    // A weak token is worse than none: it protects the one API that can arm a
    // real-money account. Failing at boot makes the mistake loud instead of
    // silent under load.
    expect((await loadEnv("too-short")).ok).toBe(false);
  });

  it("rejects 31 characters and accepts 32", async () => {
    expect((await loadEnv("a".repeat(31))).ok).toBe(false);
    const accepted = await loadEnv("a".repeat(32));
    expect(`${accepted.ok}:${accepted.ok ? accepted.value.length : 0}`).toBe("true:32");
  });

  it("starts happily with no token at all", async () => {
    const result = await loadEnv("");
    expect(`${result.ok}:${result.ok ? result.value : "n/a"}`).toBe("true:");
  });

  it("does not print the rejected token", async () => {
    const secretish = "s3cr3t";
    const result = await loadEnv(secretish);
    expect(result.ok).toBe(false);
    // The startup error names the variable and the rule, never the value.
    expect(JSON.stringify(result.errors)).not.toContain(secretish);
  });
});

import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  OperatorGatewayConfigError,
  accountOperatorGatewayRoutes,
  assertLoopbackDestination,
  defaultOperatorGatewayDestinations,
  forwardTargetFor,
  validateDestinations,
} from "../src/modules/operator/account-operator-gateway";

/**
 * The generic backend's ACCOUNT OPERATOR GATEWAY, against two mock loopback
 * control planes on random test ports (never 4001/4002). No real account is
 * started; no credential exists; nothing reaches Binance.
 */

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface MockControl {
  server: Server;
  port: number;
  seen: Seen[];
  respond: (seen: Seen) => { status: number; body: string; headers?: Record<string, string> } | "HANG";
}

async function mockControl(name: string): Promise<MockControl> {
  const mock: MockControl = {
    server: null as unknown as Server,
    port: 0,
    seen: [],
    respond: (seen) => ({ status: 200, body: JSON.stringify({ from: name, url: seen.url, method: seen.method }) }),
  };
  mock.server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      mock.seen.push(seen);
      const out = mock.respond(seen);
      if (out === "HANG") return; // never answers
      res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  mock.port = (mock.server.address() as AddressInfo).port;
  return mock;
}

let A: MockControl;
let B: MockControl;
let app: FastifyInstance;
let closedPort: number;

beforeAll(async () => {
  A = await mockControl("A");
  B = await mockControl("B");
  // A port that was bound and released: connection refused.
  const temp = await mockControl("gone");
  closedPort = temp.port;
  await new Promise<void>((resolve) => temp.server.close(() => resolve()));
  app = Fastify();
  await accountOperatorGatewayRoutes(app, { destinations: { A: `http://127.0.0.1:${A.port}`, B: `http://127.0.0.1:${B.port}` }, timeoutMs: 400 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const m of [A, B]) await new Promise<void>((resolve) => m.server.close(() => resolve()));
});

afterEach(() => {
  for (const m of [A, B]) {
    m.seen.length = 0;
    m.respond = (seen) => ({ status: 200, body: JSON.stringify({ url: seen.url, method: seen.method }) });
  }
});

describe("routing: exactly one allowlisted account per request", () => {
  it("A maps only to A's loopback control plane, B only to B's", async () => {
    const a = await app.inject({ method: "GET", url: "/api/operator/accounts/A/trading-control/status" });
    expect(a.statusCode).toBe(200);
    expect(a.headers["x-operator-account"]).toBe("A");
    expect(A.seen.map((s) => s.url)).toEqual(["/api/operator/trading-control/status"]);
    expect(B.seen).toHaveLength(0);
    const b = await app.inject({ method: "GET", url: "/api/operator/accounts/B/auth-check" });
    expect(b.headers["x-operator-account"]).toBe("B");
    expect(B.seen.map((s) => s.url)).toEqual(["/api/operator/auth-check"]);
    expect(A.seen).toHaveLength(1);
  });

  it.each(["C", "ALL", "all", "a", "AB", "%41", "A%2FB", "0"])("an unknown account %j is refused before anything is contacted", async (account) => {
    const res = await app.inject({ method: "GET", url: `/api/operator/accounts/${account}/trading-control/status` });
    expect([404, 400]).toContain(res.statusCode);
    expect(A.seen.length + B.seen.length).toBe(0);
  });

  it.each([
    "/api/operator/accounts/A/..%2f..%2fhealth",
    "/api/operator/accounts/A/%2e%2e/admin",
    "/api/operator/accounts/A//evil.example/x",
    "/api/operator/accounts/A/@evil.example/x",
    "/api/operator/accounts/A/trading-control/status%00",
    "/api/operator/accounts/A/http:/evil.example",
    "/api/operator/accounts/A/",
  ])("the path cannot inject a host, a traversal or an encoding: %s", async (url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(A.seen.length + B.seen.length).toBe(0);
  });

  it("a raw backslash path over a REAL socket is refused (the inject client would normalise it, so this uses HTTP)", async () => {
    const live = Fastify();
    await accountOperatorGatewayRoutes(live, { destinations: { A: `http://127.0.0.1:${A.port}`, B: `http://127.0.0.1:${B.port}` }, timeoutMs: 400 });
    await live.listen({ port: 0, host: "127.0.0.1" });
    const port = (live.server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path: "/api/operator/accounts/A/trading-control\\status" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    await live.close();
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(A.seen.length + B.seen.length).toBe(0);
  });

  it("no request can name a target: a URL in the query or a Host header only ever reaches the allowlisted A", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/operator/accounts/A/trading-control/status?target=http://evil.example/&x=1",
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    expect(res.statusCode).toBe(200);
    expect(A.seen).toHaveLength(1);
    expect(A.seen[0].headers.host).toBe(`127.0.0.1:${A.port}`);
    expect(A.seen[0].headers["x-forwarded-host"]).toBeUndefined();
    // The query string is preserved verbatim as data.
    expect(A.seen[0].url).toBe("/api/operator/trading-control/status?target=http://evil.example/&x=1");
  });

  it("the HTTP method and the JSON body are preserved for allowed routes; other methods are not routed", async () => {
    const post = await app.inject({ method: "POST", url: "/api/operator/accounts/B/trading-control/allowlist", payload: { symbols: "BTCUSDT,ETHUSDT" } });
    expect(post.statusCode).toBe(200);
    expect(B.seen[0].method).toBe("POST");
    expect(JSON.parse(B.seen[0].body)).toEqual({ symbols: "BTCUSDT,ETHUSDT" });
    for (const method of ["PUT", "DELETE", "PATCH"] as const) {
      const res = await app.inject({ method, url: "/api/operator/accounts/B/trading-control/allowlist", payload: {} });
      expect(res.statusCode).toBe(404);
    }
    expect(B.seen).toHaveLength(1);
  });
});

describe("headers: the credential goes to the selected account only, nothing else leaks", () => {
  it("forwards Authorization to the selected account only, and drops cookies, hop-by-hop and proxy headers", async () => {
    await app.inject({
      method: "GET",
      url: "/api/operator/accounts/A/trading-control/status",
      headers: {
        authorization: "Bearer token-for-A",
        cookie: "session=abc",
        connection: "keep-alive, x-secret",
        "x-secret": "1",
        "proxy-authorization": "Basic zzz",
        te: "trailers",
        "x-forwarded-for": "1.2.3.4",
      },
    });
    const h = A.seen[0].headers;
    expect(h.authorization).toBe("Bearer token-for-A");
    for (const dropped of ["cookie", "x-secret", "proxy-authorization", "te", "x-forwarded-for"]) expect({ dropped, v: h[dropped] }).toEqual({ dropped, v: undefined });
    expect(B.seen).toHaveLength(0);
  });

  it("the token-free health route never forwards the credential", async () => {
    const res = await app.inject({ method: "GET", url: "/api/operator/accounts/B/health", headers: { authorization: "Bearer token-for-B" } });
    expect(res.statusCode).toBe(200);
    expect(B.seen[0].url).toBe("/health");
    expect(B.seen[0].headers.authorization).toBeUndefined();
    const post = await app.inject({ method: "POST", url: "/api/operator/accounts/B/health", payload: {} });
    expect(post.statusCode).toBe(405);
  });

  it("propagates status and body, but not upstream cookies; responses are never cached", async () => {
    A.respond = () => ({ status: 409, body: JSON.stringify({ error: "ConflictError", message: "not SAFE_OFF" }), headers: { "set-cookie": "x=1" } });
    const res = await app.inject({ method: "POST", url: "/api/operator/accounts/A/trading-control/start", payload: { confirmation: "x" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "ConflictError", message: "not SAFE_OFF" });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("failure is explicit and never falls back to the other account", () => {
  it("a control plane that does not answer in time is a 504 for THAT account — no retry, no fallback", async () => {
    A.respond = () => "HANG";
    const res = await app.inject({ method: "GET", url: "/api/operator/accounts/A/trading-control/status" });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: "OperatorControlTimeout", account: "A" });
    expect(A.seen).toHaveLength(1);
    expect(B.seen).toHaveLength(0);
  });

  it("an offline control plane is an explicit 503 'unreachable', never a 401 and never a guess at the other account", async () => {
    const offline = Fastify();
    await accountOperatorGatewayRoutes(offline, { destinations: { A: `http://127.0.0.1:${closedPort}`, B: `http://127.0.0.1:${B.port}` }, timeoutMs: 1_000 });
    const res = await offline.inject({ method: "GET", url: "/api/operator/accounts/A/auth-check", headers: { authorization: "Bearer token-for-A" } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "OperatorControlUnreachable", account: "A" });
    expect(res.json().message).toMatch(/Account A control plane is not reachable/);
    expect(JSON.stringify(res.json())).not.toContain("token-for-A");
    expect(B.seen).toHaveLength(0);
    await offline.close();
  });

  it("an upstream 500 is propagated once, with no retry", async () => {
    A.respond = () => ({ status: 500, body: JSON.stringify({ error: "InternalServerError" }) });
    const res = await app.inject({ method: "POST", url: "/api/operator/accounts/A/trading-control/safe-off", payload: {} });
    expect(res.statusCode).toBe(500);
    expect(A.seen).toHaveLength(1);
    expect(B.seen).toHaveLength(0);
  });
});

describe("destinations: loopback-only, fixed, distinct", () => {
  it("the default allowlist is the two loopback control-plane ports from the topology contract", () => {
    expect(defaultOperatorGatewayDestinations()).toEqual({ A: "http://127.0.0.1:4001", B: "http://127.0.0.1:4002" });
  });

  it.each(["http://localhost:4001", "https://127.0.0.1:4001", "http://127.0.0.2:4001", "http://0.0.0.0:4001", "http://127.0.0.1", "http://127.0.0.1:4001/api", "http://u:p@127.0.0.1:4001", "http://127.0.0.1:4001?x=1", "file:///etc", "not a url", "http://[::1]:4001"])(
    "refuses a non-loopback or decorated destination %j",
    (value) => {
      expect(() => assertLoopbackDestination(value)).toThrow(OperatorGatewayConfigError);
    }
  );

  it("refuses A and B sharing one control plane", () => {
    expect(() => validateDestinations({ A: "http://127.0.0.1:4001", B: "http://127.0.0.1:4001" })).toThrow(/different control planes/);
  });

  it("maps only plain route paths", () => {
    expect(forwardTargetFor("/trading-control/status")).toEqual({ kind: "OPERATOR", path: "/api/operator/trading-control/status" });
    expect(forwardTargetFor("/health")).toEqual({ kind: "HEALTH", path: "/health" });
    for (const bad of ["", "/", "//x", "/a/../b", "/a/./b", "/a%2fb", "/a b", "/a?b", "/a#b", "/a\\b", "/a:b", "/a@b"]) expect(forwardTargetFor(bad)).toBeNull();
  });
});

describe("static: the gateway is not an account, an authority or a general proxy", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("imports no credential, profile, attestation, execution, Binance or database seam, logs nothing, and stores nothing", () => {
    const gateway = read("src/modules/operator/account-operator-gateway.ts");
    expect(gateway).not.toMatch(/prisma|config\/env|process\.env|bootstrap-account|runtime-attestation|execution|binance|resolveExecutionProfile|OPERATOR_API_TOKEN|console\.|\.log\(|localStorage|writeFile/i);
    expect(gateway).not.toMatch(/websocket|upgrade/i);
  });
  it("is mounted on the GENERIC surface only; the account control plane keeps its own operator routes", () => {
    const appSource = read("src/app.ts");
    const generic = appSource.slice(appSource.indexOf("export async function buildApp("), appSource.indexOf("export async function buildAccountControlApp("));
    const account = appSource.slice(appSource.indexOf("export async function buildAccountControlApp("));
    expect(generic).toContain("await app.register(accountOperatorGatewayRoutes);");
    expect(generic).not.toContain("operatorRoutes)");
    expect(account).not.toContain("accountOperatorGatewayRoutes");
  });
});

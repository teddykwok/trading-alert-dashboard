import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ROLE_CONTRACTS, type DualRole } from "./dual-account-topology";

/**
 * THE ACCOUNT OPERATOR GATEWAY — same-origin, account-explicit, loopback-only.
 *
 * The dashboard is ONE frontend. Each account keeps its OWN control plane (its
 * own process, env file, credentials, worker, gates and attestation) listening
 * on loopback only. This gateway lets the one frontend reach exactly one of
 * them per request, without the browser ever talking to 4001/4002 and without
 * the generic backend becoming an account:
 *
 *   /api/operator/accounts/A/<route>  ->  http://127.0.0.1:<account-a-control port>/api/operator/<route>
 *   /api/operator/accounts/B/<route>  ->  http://127.0.0.1:<account-b-control port>/api/operator/<route>
 *   /api/operator/accounts/{A|B}/health -> that control plane's unauthenticated /health (liveness only)
 *
 * What it deliberately is NOT:
 *  - not a general proxy: the destination is chosen from a two-entry allowlist
 *    built from the topology contract, never from anything in the request;
 *  - not an authority: it holds no credential, resolves no profile and decides
 *    nothing. The account control plane still authenticates every request;
 *  - not a fan-out: one request, one account, one attempt. No fallback from A
 *    to B, no retry, no guessed default account, no "ALL";
 *  - not a token store: the operator's Authorization header is forwarded to the
 *    SELECTED account only, never logged, never kept.
 */

export const OPERATOR_GATEWAY_ACCOUNTS = ["A", "B"] as const;
export type OperatorGatewayAccount = (typeof OPERATOR_GATEWAY_ACCOUNTS)[number];

const CONTROL_ROLE: Readonly<Record<OperatorGatewayAccount, DualRole>> = Object.freeze({ A: "account-a-control", B: "account-b-control" });
const LABEL: Readonly<Record<OperatorGatewayAccount, string>> = Object.freeze({ A: "Account A", B: "Account B" });

/** Base URLs of the two control planes. Validated loopback-only before use. */
export type OperatorGatewayDestinations = Readonly<Record<OperatorGatewayAccount, string>>;

export const OPERATOR_GATEWAY_TIMEOUT_MS = 30_000;
export const OPERATOR_GATEWAY_PREFIX = "/api/operator/accounts/";

export class OperatorGatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorGatewayConfigError";
  }
}

export function isOperatorGatewayAccount(value: unknown): value is OperatorGatewayAccount {
  return typeof value === "string" && (OPERATOR_GATEWAY_ACCOUNTS as readonly string[]).includes(value);
}

/**
 * A control-plane base URL must be exactly `http://127.0.0.1:<port>` — IPv4
 * loopback, plain HTTP, an explicit port, and nothing else (no credentials,
 * path, query or fragment). Anything else is refused at startup.
 */
export function assertLoopbackDestination(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OperatorGatewayConfigError("a control-plane destination is not a URL");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new OperatorGatewayConfigError("a control-plane destination must be exactly http://127.0.0.1:<port>");
  }
  return `http://127.0.0.1:${port}`;
}

/** The allowlist, from the topology contract: the same ports the launcher binds, loopback-only by contract. */
export function defaultOperatorGatewayDestinations(): OperatorGatewayDestinations {
  const entries = OPERATOR_GATEWAY_ACCOUNTS.map((account) => {
    const contract = ROLE_CONTRACTS[CONTROL_ROLE[account]];
    if (!contract.loopbackOnly || contract.port === null) {
      throw new OperatorGatewayConfigError(`${CONTROL_ROLE[account]} is not a loopback-only control plane`);
    }
    return [account, assertLoopbackDestination(`http://127.0.0.1:${contract.port}`)] as const;
  });
  return validateDestinations(Object.fromEntries(entries) as OperatorGatewayDestinations);
}

export function validateDestinations(destinations: OperatorGatewayDestinations): OperatorGatewayDestinations {
  const a = assertLoopbackDestination(destinations.A);
  const b = assertLoopbackDestination(destinations.B);
  // Two accounts on one control plane would be the merge this design forbids.
  if (a === b) throw new OperatorGatewayConfigError("Account A and Account B must have different control planes");
  return Object.freeze({ A: a, B: b });
}

/** Path characters a forwarded route may contain: no dots, no encoding, no separators but "/". */
const SAFE_PATH = /^(\/[A-Za-z0-9-]+)+$/;

export type ForwardTarget = { readonly kind: "HEALTH"; readonly path: "/health" } | { readonly kind: "OPERATOR"; readonly path: string };

/**
 * Maps what follows `/api/operator/accounts/<account>` to the control-plane
 * path, or null when it is not a plain, safe route. Rejects traversal, encoded
 * characters, empty segments, backslashes, "@", ":" and anything else that is
 * not letters, digits, "-" and "/".
 */
export function forwardTargetFor(pathAfterAccount: string): ForwardTarget | null {
  if (!SAFE_PATH.test(pathAfterAccount)) return null;
  if (pathAfterAccount === "/health") return { kind: "HEALTH", path: "/health" };
  return { kind: "OPERATOR", path: `/api/operator${pathAfterAccount}` };
}

export interface GatewayRequest {
  readonly account: string;
  readonly method: string;
  /** Everything after `/api/operator/accounts/<account>`, query string included. */
  readonly rest: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: unknown;
}

export interface GatewayResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** The account the response came from, or null when nothing was contacted. */
  readonly account: OperatorGatewayAccount | null;
}

export interface GatewayDeps {
  readonly destinations: OperatorGatewayDestinations;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
}

const json = (status: number, body: Record<string, unknown>, account: OperatorGatewayAccount | null): GatewayResponse => ({
  status,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(body),
  account,
});

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Forwards ONE request to ONE account's control plane, once.
 *
 * Pure apart from the injected fetch: no logging, no retry, no fallback. Every
 * refusal is decided before anything is contacted.
 */
export async function forwardOperatorRequest(request: GatewayRequest, deps: GatewayDeps): Promise<GatewayResponse> {
  if (!isOperatorGatewayAccount(request.account)) {
    return json(404, { error: "UnknownOperatorAccount", message: "Unknown operator account. Use A or B." }, null);
  }
  const account = request.account;
  if (request.method !== "GET" && request.method !== "POST") {
    return json(405, { error: "MethodNotAllowed", message: "Only GET and POST reach an account control plane." }, null);
  }
  const queryAt = request.rest.indexOf("?");
  const pathPart = queryAt === -1 ? request.rest : request.rest.slice(0, queryAt);
  const query = queryAt === -1 ? "" : request.rest.slice(queryAt + 1);
  const target = forwardTargetFor(pathPart);
  if (target === null) return json(400, { error: "InvalidOperatorPath", message: "That operator path is not allowed." }, null);
  if (target.kind === "HEALTH" && request.method !== "GET") {
    return json(405, { error: "MethodNotAllowed", message: "Health is read-only." }, null);
  }

  // The destination comes from the allowlist and nowhere else.
  const url = new URL(target.path, `${deps.destinations[account]}/`);
  if (query !== "") url.search = query;
  if (url.origin !== new URL(deps.destinations[account]).origin) {
    return json(400, { error: "InvalidOperatorPath", message: "That operator path is not allowed." }, null);
  }

  const headers: Record<string, string> = { accept: "application/json" };
  // Liveness never needs, and never receives, the operator credential.
  if (target.kind === "OPERATOR" && request.authorization !== undefined) headers.authorization = request.authorization;
  let body: string | undefined;
  if (request.method === "POST") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(request.body ?? {});
  }

  let upstream: Response;
  try {
    upstream = await deps.fetch(url, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(deps.timeoutMs) });
  } catch (error) {
    // Message deliberately dropped: it can name an endpoint.
    return isTimeout(error)
      ? json(504, { error: "OperatorControlTimeout", account, message: `${LABEL[account]} control plane did not answer in time.` }, account)
      : json(503, { error: "OperatorControlUnreachable", account, message: `${LABEL[account]} control plane is not reachable (offline).` }, account);
  }
  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") ?? "";
  return {
    status: upstream.status,
    contentType: /^(application\/json|text\/plain)\b/i.test(contentType) ? contentType : "application/json; charset=utf-8",
    body: text,
    account,
  };
}

export interface OperatorGatewayOptions {
  readonly destinations?: OperatorGatewayDestinations;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Registers the gateway on the GENERIC surface. GET and POST only; no websocket surface. */
export async function accountOperatorGatewayRoutes(app: FastifyInstance, options: OperatorGatewayOptions = {}): Promise<void> {
  const deps: GatewayDeps = {
    destinations: validateDestinations(options.destinations ?? defaultOperatorGatewayDestinations()),
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? OPERATOR_GATEWAY_TIMEOUT_MS,
  };

  const handler = async (request: FastifyRequest<{ Params: { account: string } }>, reply: FastifyReply) => {
    const account = request.params.account;
    const raw = request.raw.url ?? "";
    const prefix = `${OPERATOR_GATEWAY_PREFIX}${account}`;
    const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : "";
    const result = await forwardOperatorRequest(
      {
        account,
        method: request.method,
        rest,
        authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        contentType: typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : undefined,
        body: request.body,
      },
      deps
    );
    reply.header("cache-control", "no-store");
    if (result.account !== null) reply.header("x-operator-account", result.account);
    return reply.code(result.status).type(result.contentType).send(result.body);
  };

  app.route({ method: ["GET", "POST"], url: `${OPERATOR_GATEWAY_PREFIX}:account/*`, handler });
}

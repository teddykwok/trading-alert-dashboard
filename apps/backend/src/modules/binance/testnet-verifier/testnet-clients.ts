import { BinanceReadOnlyClient } from "../binance.client";
import { BinanceUsdMExecutionClient } from "../binance-execution.client";
import { BinanceReadOnlyService } from "../binance-read-only.service";
import { BINANCE_TESTNET_ORIGIN, type TestnetConfig } from "./testnet-config";
import { DocumentedFormClient, type VerifierTransport } from "./testnet-documented-form";

/**
 * Constructs the dedicated TESTNET clients.
 *
 * EVERY option that influences routing or authentication is passed
 * EXPLICITLY. That is the whole point of this file: each Binance client
 * constructor falls back to `config/env` for anything omitted
 * (`options.baseUrl ?? env.BINANCE_FUTURES_REST_BASE_URL`,
 * `options.apiKey ?? env.BINANCE_API_KEY`, …), so a single missing option
 * would silently point a live-gated client at production.
 *
 * The execution client is additionally given `readOnlyClient` explicitly.
 * Without it, its constructor would build a DEFAULT read-only client from
 * production env, and `mutate()` calls `readOnly.syncTime()` on every
 * mutation — one omitted option would put a mainnet request in the middle of
 * every testnet write.
 *
 * `liveEntryEnabled` / `protectionReady` are set true HERE, for this
 * testnet-only client, and are never read from the environment: the operator's
 * production gates stay closed and unexamined.
 */

/** Binance's documented default. Not read from env, so nothing can widen it. */
export const TESTNET_RECV_WINDOW_MS = 5_000;

/** Read-only capability set. Structurally incapable of mutating anything. */
export interface TestnetProbeClients {
  readonly readOnlyClient: BinanceReadOnlyClient;
  readonly readOnly: BinanceReadOnlyService;
  readonly documented: DocumentedFormClient;
}

export interface TestnetMutationClients extends TestnetProbeClients {
  readonly mutations: BinanceUsdMExecutionClient;
}

/**
 * PROBE-ONLY clients.
 *
 * `BinanceUsdMExecutionClient` is never referenced in this function, so a
 * probe run cannot hold a live-gated mutation client even by accident. That
 * is a stronger guarantee than "the probe code path does not call it": the
 * capability does not exist in the process at all.
 */
export function createTestnetProbeClients(
  config: TestnetConfig,
  transport?: VerifierTransport
): TestnetProbeClients {
  const readOnlyClient = buildReadOnlyClient(config);
  return {
    readOnlyClient,
    readOnly: new BinanceReadOnlyService(readOnlyClient),
    documented: buildDocumentedClient(config, readOnlyClient, transport),
  };
}

function assertDemoOrigin(config: TestnetConfig): void {
  // Refuse one more time at the point of construction. `resolveTestnetConfig`
  // already proved this, but these factories are what actually hand
  // credentials to something that can dispatch.
  if (config.baseUrl !== BINANCE_TESTNET_ORIGIN) {
    throw new Error(`Refusing to build a Binance client for any origin other than ${BINANCE_TESTNET_ORIGIN}.`);
  }
}

function buildReadOnlyClient(config: TestnetConfig): BinanceReadOnlyClient {
  assertDemoOrigin(config);
  return new BinanceReadOnlyClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    recvWindowMs: TESTNET_RECV_WINDOW_MS,
    // Explicit: the production BINANCE_READ_ONLY_ENABLED switch is irrelevant
    // to a testnet verifier and must not be able to disable or enable it.
    enabled: true,
  });
}

function buildDocumentedClient(
  config: TestnetConfig,
  readOnlyClient: BinanceReadOnlyClient,
  transport?: VerifierTransport
): DocumentedFormClient {
  return new DocumentedFormClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    recvWindowMs: TESTNET_RECV_WINDOW_MS,
    transport: transport ?? ((url, init) => fetch(url, init)),
    clockOffsetMs: () => readOnlyClient.clockOffsetMs,
  });
}

/**
 * MUTATION clients. Only this factory can produce a live-gated execution
 * client, and only the mutation code path calls it.
 *
 * `readOnlyClient` is injected explicitly: without it the execution client's
 * constructor would build a DEFAULT read-only client from production env, and
 * `mutate()` calls `readOnly.syncTime()` on every mutation — one omitted
 * option would put a mainnet request inside every testnet write.
 *
 * `liveEntryEnabled` / `protectionReady` are set true HERE, for this
 * testnet-only client, and are never read from the environment: the
 * operator's production gates stay closed and unexamined.
 */
export function createTestnetMutationClients(
  config: TestnetConfig,
  transport?: VerifierTransport
): TestnetMutationClients {
  const readOnlyClient = buildReadOnlyClient(config);

  const mutations = new BinanceUsdMExecutionClient({
    readOnlyClient,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    recvWindowMs: TESTNET_RECV_WINDOW_MS,
    liveEntryEnabled: true,
    protectionReady: true,
    ...(transport ? { transport } : {}),
  });

  return {
    readOnlyClient,
    readOnly: new BinanceReadOnlyService(readOnlyClient),
    documented: buildDocumentedClient(config, readOnlyClient, transport),
    mutations,
  };
}

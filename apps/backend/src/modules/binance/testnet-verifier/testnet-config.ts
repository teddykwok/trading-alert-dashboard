/**
 * Fail-closed configuration gate for the TESTNET protection verifier.
 *
 * This module is the boundary that keeps a verifier run off MAINNET. It is
 * deliberately PURE — it takes an environment record and returns a decision —
 * so every refusal path is unit-testable without constructing a client, and so
 * nothing here can read `config/env`.
 *
 * That last point is structural, not stylistic. `config/env` parses
 * `process.env` at import time and every Binance client constructor falls back
 * to it (`options.baseUrl ?? env.BINANCE_FUTURES_REST_BASE_URL`). If this file
 * imported it, one forgotten option would silently point a live-gated client
 * at real money. Nothing in this directory may import it.
 */

/**
 * The ONLY origin a verifier run may target, from the current official
 * "Testnet API Information" section of the USDⓈ-M Futures documentation.
 * Compared with exact string equality — never a prefix, suffix, `includes`
 * or regex, all of which accept lookalikes such as
 * `https://demo-fapi.binance.com.attacker.example`.
 */
export const BINANCE_TESTNET_ORIGIN = "https://demo-fapi.binance.com";

export type TestnetRefusalCode =
  | "VERIFY_GATE_CLOSED"
  | "TESTNET_API_KEY_MISSING"
  | "TESTNET_API_SECRET_MISSING"
  | "TESTNET_BASE_URL_MISSING"
  | "TESTNET_BASE_URL_UNPARSEABLE"
  | "TESTNET_URL_EMBEDS_CREDENTIALS"
  | "TESTNET_URL_NOT_BARE_ORIGIN"
  | "TESTNET_ORIGIN_NOT_ALLOWED"
  | "TESTNET_CREDENTIALS_MATCH_PRODUCTION";

export interface TestnetConfig {
  /** Always exactly BINANCE_TESTNET_ORIGIN — never the operator's raw string. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

export type TestnetConfigDecision =
  | { readonly ok: true; readonly config: TestnetConfig }
  | { readonly ok: false; readonly reasonCode: TestnetRefusalCode; readonly message: string };

/** Only the names this verifier is allowed to read. */
export interface TestnetEnvironmentInput {
  readonly BINANCE_TESTNET_PROTECTION_VERIFY?: string;
  readonly BINANCE_TESTNET_API_KEY?: string;
  readonly BINANCE_TESTNET_API_SECRET?: string;
  readonly BINANCE_TESTNET_BASE_URL?: string;
  /**
   * Production values, read ONLY to prove the testnet slots are not a
   * copy-paste of them. Never stored, never logged, never sent anywhere.
   */
  readonly BINANCE_API_KEY?: string;
  readonly BINANCE_API_SECRET?: string;
}

function refuse(reasonCode: TestnetRefusalCode, message: string): TestnetConfigDecision {
  return { ok: false, reasonCode, message };
}

/**
 * Validates that `raw` is EXACTLY the allowed testnet origin and nothing more.
 *
 * `URL.origin` alone is not sufficient: it ignores userinfo, path, query and
 * fragment, so `https://user:pw@demo-fapi.binance.com/../fapi` and
 * `https://demo-fapi.binance.com/?x=1#y` both share the allowed origin while
 * being different requests. Each component is therefore checked explicitly.
 */
export function validateTestnetOrigin(raw: string): TestnetConfigDecision | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refuse("TESTNET_BASE_URL_UNPARSEABLE", "BINANCE_TESTNET_BASE_URL is not a valid absolute URL.");
  }

  // Credentials in a URL would be sent on every request and would land in any
  // log that ever prints one.
  if (url.username !== "" || url.password !== "") {
    return refuse("TESTNET_URL_EMBEDS_CREDENTIALS", "BINANCE_TESTNET_BASE_URL must not embed a username or password.");
  }

  // A path, query or fragment can make a hostile string LOOK like the allowed
  // origin to a careless reader. Only a bare origin is accepted.
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    return refuse(
      "TESTNET_URL_NOT_BARE_ORIGIN",
      "BINANCE_TESTNET_BASE_URL must be a bare origin with no path, query string or fragment."
    );
  }

  // Covers protocol, hostname AND port in one exact comparison: `URL.origin`
  // renders an explicit non-default port, so `https://demo-fapi.binance.com:8443`
  // does not equal the allowed origin. http:// fails here too.
  if (url.origin !== BINANCE_TESTNET_ORIGIN) {
    return refuse(
      "TESTNET_ORIGIN_NOT_ALLOWED",
      `Refusing to run: the only permitted origin is ${BINANCE_TESTNET_ORIGIN}.`
    );
  }

  return null;
}

/**
 * Resolves the verifier's configuration or refuses.
 *
 * ORDER MATTERS. The operator gate is checked first, then presence, then the
 * origin, then the production-credential comparison. A caller that receives
 * `ok: false` must not construct any Binance client.
 */
export function resolveTestnetConfig(input: TestnetEnvironmentInput): TestnetConfigDecision {
  // Strict equality against the literal "true": "TRUE", "1" and "yes" are all
  // refusals, so a typo cannot read as an authorization.
  if (input.BINANCE_TESTNET_PROTECTION_VERIFY !== "true") {
    return refuse(
      "VERIFY_GATE_CLOSED",
      'BINANCE_TESTNET_PROTECTION_VERIFY must be exactly "true" to run the testnet verifier.'
    );
  }

  const apiKey = (input.BINANCE_TESTNET_API_KEY ?? "").trim();
  const apiSecret = (input.BINANCE_TESTNET_API_SECRET ?? "").trim();
  const baseUrl = (input.BINANCE_TESTNET_BASE_URL ?? "").trim();

  if (!apiKey) return refuse("TESTNET_API_KEY_MISSING", "BINANCE_TESTNET_API_KEY is required and must be non-empty.");
  if (!apiSecret) {
    return refuse("TESTNET_API_SECRET_MISSING", "BINANCE_TESTNET_API_SECRET is required and must be non-empty.");
  }
  // No default: the operator must state the host. A default is exactly how a
  // verifier ends up somewhere nobody chose.
  if (!baseUrl) {
    return refuse("TESTNET_BASE_URL_MISSING", "BINANCE_TESTNET_BASE_URL is required and has no default.");
  }

  const originRefusal = validateTestnetOrigin(baseUrl);
  if (originRefusal) return originRefusal;

  // A copy-paste of the production credentials into the testnet slots would
  // authenticate against the demo host with real keys — or, worse, be the
  // first half of a mistake whose second half is a wrong base URL. Compared
  // by value, never printed, never included in any report.
  const productionKey = (input.BINANCE_API_KEY ?? "").trim();
  const productionSecret = (input.BINANCE_API_SECRET ?? "").trim();
  const keyCollides = productionKey !== "" && productionKey === apiKey;
  const secretCollides = productionSecret !== "" && productionSecret === apiSecret;
  if (keyCollides || secretCollides) {
    return refuse(
      "TESTNET_CREDENTIALS_MATCH_PRODUCTION",
      `The testnet ${keyCollides ? "API key" : "API secret"} is identical to the production value. ` +
        "Generate dedicated demo credentials; the verifier will not run with production keys."
    );
  }

  return {
    ok: true,
    // The canonical constant, not the operator's string: whatever formatting
    // variation was supplied, everything downstream uses one exact origin.
    config: { baseUrl: BINANCE_TESTNET_ORIGIN, apiKey, apiSecret },
  };
}

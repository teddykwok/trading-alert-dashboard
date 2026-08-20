import { BINANCE_TESTNET_ORIGIN } from "./testnet-verifier/testnet-config";

/**
 * Which Binance USDⓈ-M Futures environment a REST base URL points at.
 *
 * This replaces two independently-maintained copies of
 * `host.includes("testnet")` that lived in `safety-admission.service.ts` and
 * `entry-lifecycle.service.ts`. That heuristic was wrong in a way that mattered:
 * the repository's own sanctioned testnet origin is
 * `https://demo-fapi.binance.com`, which does not contain the English word
 * "testnet", so the sanctioned TESTNET connector was classified MAINNET and
 * every TESTNET profile was refused with PROFILE_ENVIRONMENT_MISMATCH.
 *
 * The failure was fail-safe — it refused execution rather than permitting it —
 * but it made the supported testnet path impossible to exercise end to end.
 *
 * Classification is by EXACT origin, never by substring. A substring test
 * accepts lookalikes: `https://demo-fapi.binance.com.attacker.example` contains
 * the sanctioned host and `https://testnet.evil.example` contains "testnet".
 * `URL.origin` compares protocol, host and port together, so neither passes.
 */

/** The live account. Matches `BINANCE_FUTURES_REST_BASE_URL`'s own default. */
export const BINANCE_MAINNET_FUTURES_ORIGIN = "https://fapi.binance.com";

/**
 * Binance's long-standing USDⓈ-M Futures testnet host, still the one the
 * execution integration suites point at. Kept alongside the newer
 * `BINANCE_TESTNET_ORIGIN` (`demo-fapi`) because both are real Binance testnet
 * endpoints and an operator may legitimately be configured against either.
 */
export const BINANCE_LEGACY_TESTNET_FUTURES_ORIGIN = "https://testnet.binancefuture.com";

const TESTNET_ORIGINS: readonly string[] = [BINANCE_TESTNET_ORIGIN, BINANCE_LEGACY_TESTNET_FUTURES_ORIGIN];
const MAINNET_ORIGINS: readonly string[] = [BINANCE_MAINNET_FUTURES_ORIGIN];

/**
 * UNKNOWN is a real outcome, not a synonym for MAINNET.
 *
 * The previous heuristic answered MAINNET for anything it did not recognise,
 * including a typo, so a misconfigured connector silently satisfied a MAINNET
 * profile. An unrecognised origin now matches nothing and execution refuses.
 */
export type BinanceConnectorEnvironment = "TESTNET" | "MAINNET" | "UNKNOWN";

export function classifyBinanceFuturesEnvironment(baseUrl: string): BinanceConnectorEnvironment {
  let origin: string;
  try {
    // Parsing normalizes case, default ports and a trailing slash, so
    // "HTTPS://FAPI.BINANCE.COM/" and the configured value compare equal.
    origin = new URL(baseUrl.trim()).origin;
  } catch {
    return "UNKNOWN";
  }
  if (TESTNET_ORIGINS.includes(origin)) return "TESTNET";
  if (MAINNET_ORIGINS.includes(origin)) return "MAINNET";
  return "UNKNOWN";
}

/**
 * Whether an ExecutionProfile's declared environment matches the connector the
 * process is actually configured against.
 *
 * The single predicate both SafetyAdmission and the entry lifecycle call, so
 * the two can never disagree about the same base URL — the drift this module
 * exists to prevent.
 */
export function connectorEnvironmentMatches(profileEnvironment: string, baseUrl: string): boolean {
  const connector = classifyBinanceFuturesEnvironment(baseUrl);
  if (connector === "UNKNOWN") return false;
  return profileEnvironment === connector;
}

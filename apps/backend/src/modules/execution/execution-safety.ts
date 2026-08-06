import { createHash } from "node:crypto";

/**
 * Pure helpers shared by the execution lifecycle: deterministic client order
 * IDs, metadata sanitization and decimal validation. No I/O, no Prisma, no
 * network — and nothing here can submit anything anywhere.
 */

// ---------------------------------------------------------------------------
// Client order IDs
// ---------------------------------------------------------------------------

/**
 * Binance USDⓈ-M documents newClientOrderId as
 * `^[\.A-Z\:/a-z0-9_-]{1,36}$` (max 36 characters). We stay well inside that
 * with a conservative subset: lowercase/uppercase letters, digits, `-` and `_`.
 */
export const BINANCE_CLIENT_ORDER_ID_PATTERN = /^[.A-Z:/a-z0-9_-]{1,36}$/;
export const BINANCE_CLIENT_ORDER_ID_MAX_LENGTH = 36;

const ROLE_CODES: Record<string, string> = {
  ENTRY: "en",
  STOP_LOSS: "sl",
  TAKE_PROFIT: "tp",
  EMERGENCY_CLOSE: "ec",
};

/**
 * Deterministic, non-identifying client order id.
 *
 * Shape: `tad-<role>-<gen>-<hash12>` (e.g. `tad-en-1-9f2c1ab34de5`), always
 * ≤ 36 characters. The execution id is hashed rather than embedded so the id
 * leaks no account alias, symbol or other personal information, while staying
 * stable across retries: the same (executionId, role, generation) always
 * yields the same string, which is what makes order reservation idempotent.
 */
export function buildClientOrderId(executionId: string, role: string, generation: number): string {
  const roleCode = ROLE_CODES[role];
  if (!roleCode) throw new Error(`Unknown order role "${role}".`);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`Generation must be a positive integer (got ${generation}).`);
  }

  const digest = createHash("sha256")
    .update(`${executionId}:${role}:${generation}`)
    .digest("hex")
    .slice(0, 12);

  const clientOrderId = `tad-${roleCode}-${generation}-${digest}`;

  // Defensive: the format is fixed, but never emit an id Binance would reject.
  if (!BINANCE_CLIENT_ORDER_ID_PATTERN.test(clientOrderId)) {
    throw new Error("Generated client order id does not satisfy the Binance format.");
  }
  return clientOrderId;
}

// ---------------------------------------------------------------------------
// Metadata sanitization
// ---------------------------------------------------------------------------

/** Keys whose values must never be persisted in event metadata. */
export const FORBIDDEN_METADATA_KEYS = [
  "apikey",
  "apisecret",
  "secret",
  "signature",
  "authorization",
  "signedquery",
  "x-mbx-apikey",
  "token",
  "password",
  "credential",
] as const;

export const REDACTED = "***REDACTED***";

function isForbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return FORBIDDEN_METADATA_KEYS.some((forbidden) => normalized.includes(forbidden.replace(/[^a-z]/g, "")));
}

/**
 * Recursively redacts credential-like keys and strips signature/API-key
 * fragments from strings. Applied to every event's metadata before storage so
 * a careless caller cannot persist a secret. Depth-limited to avoid pathological
 * structures.
 */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limited]";

  if (typeof value === "string") {
    return value
      .replace(/signature=[A-Fa-f0-9]+/gi, `signature=${REDACTED}`)
      .replace(/X-MBX-APIKEY:\s*\S+/gi, `X-MBX-APIKEY: ${REDACTED}`);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeMetadata(entry, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isForbiddenKey(key) ? REDACTED : sanitizeMetadata(entry, depth + 1);
  }
  return output;
}

/** True when any credential-like key is present at any depth. */
export function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenKey(entry, depth + 1));

  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) => isForbiddenKey(key) || containsForbiddenKey(entry, depth + 1)
  );
}

// ---------------------------------------------------------------------------
// Decimal validation
// ---------------------------------------------------------------------------

/** Plain decimal literal — no exponent form, no NaN/Infinity, optional sign. */
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export interface DecimalOptions {
  allowNegative?: boolean;
  allowZero?: boolean;
}

/**
 * Validates an authoritative decimal STRING for persistence. Strings are
 * required so no value is ever round-tripped through a JS float; NaN,
 * Infinity, exponent notation and malformed input are all rejected.
 */
export function assertDecimalString(
  value: unknown,
  field: string,
  options: DecimalOptions = {}
): string {
  const { allowNegative = false, allowZero = true } = options;

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a decimal string.`);
  }
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(`${field} must be a plain decimal string (got "${trimmed}").`);
  }
  const negative = trimmed.startsWith("-");
  const zero = !/[1-9]/.test(trimmed);

  if (negative && !allowNegative) throw new Error(`${field} must not be negative.`);
  if (zero && !allowZero) throw new Error(`${field} must be greater than zero.`);

  return trimmed;
}

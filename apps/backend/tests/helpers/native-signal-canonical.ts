import { createHash } from "node:crypto";

/**
 * Canonical JSON for behavioural fingerprints of the native signal engine.
 *
 * A fingerprint is only as stable as its serialization, so the rules are
 * explicit rather than "whatever JSON.stringify happens to do":
 *
 *  - object keys are emitted in ascending UTF-16 code-unit order, so property
 *    insertion order can never move a hash;
 *  - arrays keep their order — level order and candidate order ARE behaviour;
 *  - numbers must be finite and not -0; they are written with ECMAScript's
 *    shortest round-trip form, which is fully specified;
 *  - only null, booleans, finite numbers, strings, arrays and plain objects are
 *    accepted. undefined, functions, symbols, bigints, Dates, Maps and class
 *    instances are refused instead of being silently dropped or coerced.
 *
 * Nothing here reads a clock, the environment or the filesystem.
 */

export class CanonicalJsonError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CanonicalJsonError";
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, `non-finite number ${String(value)}`);
      if (Object.is(value, -0)) throw new CanonicalJsonError(path, "negative zero");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => write(item, `${path}[${index}]`)).join(",")}]`;
      }
      if (!isPlainObject(value)) throw new CanonicalJsonError(path, "only plain objects are canonical");
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${write(record[key], `${path}.${key}`)}`).join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(path, `unsupported ${typeof value}`);
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Every field whose name ends in `Ms` or `Index` (timestamps, bar indices,
 * level ages) must be a safe integer. Returns the offending paths.
 */
export function nonIntegerTimeOrIndexFields(value: unknown, path = "$"): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => nonIntegerTimeOrIndexFields(item, `${path}[${index}]`));
  const out: string[] = [];
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    const fieldPath = `${path}.${key}`;
    if (/(Ms|Index)$/.test(key) && !(typeof field === "number" && Number.isSafeInteger(field))) out.push(fieldPath);
    out.push(...nonIntegerTimeOrIndexFields(field, fieldPath));
  }
  return out;
}

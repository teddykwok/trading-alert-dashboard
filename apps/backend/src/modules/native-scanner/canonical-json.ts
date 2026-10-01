import { createHash } from "node:crypto";

/**
 * Canonical JSON for everything the scanner hashes as an IDENTITY: lineage
 * inputs, committed engine state, replay records.
 *
 * A hash is only as stable as its serialization, so the rules are explicit:
 *  - object keys in ascending UTF-16 code-unit order (insertion order can never
 *    move a hash);
 *  - arrays keep their order (level order and candidate order are behaviour);
 *  - numbers must be finite and not -0, written in ECMAScript's specified
 *    shortest round-trip form;
 *  - only null, booleans, finite numbers, strings, arrays and plain objects.
 *    undefined, functions, symbols, bigints, Dates, Maps and class instances
 *    are refused rather than silently dropped or coerced.
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

function write(value: unknown, at: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(at, `non-finite number ${String(value)}`);
      if (Object.is(value, -0)) throw new CanonicalJsonError(at, "negative zero");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item, index) => write(item, `${at}[${index}]`)).join(",")}]`;
      if (!isPlainObject(value)) throw new CanonicalJsonError(at, "only plain objects are canonical");
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${write(record[key], `${at}.${key}`)}`)
        .join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(at, `unsupported ${typeof value}`);
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

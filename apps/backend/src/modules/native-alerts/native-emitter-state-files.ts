import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

import { ENGINE_NAMESPACE_PREFIX_CHARS } from "../native-scanner/scanner-profile";
import type { EmitterCursor, EmitterCursorReader, EmitterCursorWriter } from "./multi-symbol-emitter";

/**
 * The multi-symbol emitter's LOCAL FILE STATE: production cursors and status
 * files, written durably (temp file, fsync, rename). The only emitter module
 * besides its CLI that touches the file system. Never a database, never the
 * scanner's own files: it reads and writes only under native-emitter/.
 */

/** native-emitter/cursors/<profileId>/<engine prefix>/<market>/<interval>: one file per symbol. */
export function emitterCursorDir(scannerRoot: string, profileId: string, engineFingerprint: string, marketType: string, chartInterval: string): string {
  if (!/^[A-Z][A-Z0-9_]*_V[0-9]+$/.test(profileId)) throw new Error("profileId is not a versioned machine identifier");
  if (!/^[0-9a-f]{64}$/.test(engineFingerprint)) throw new Error("the engine fingerprint must be a SHA-256 hex digest");
  return path.join(scannerRoot, "native-emitter", "cursors", profileId, engineFingerprint.slice(0, ENGINE_NAMESPACE_PREFIX_CHARS), marketType, chartInterval);
}

/** native-emitter/runs/<runId>: the emitter's status files for one pinned run. */
export const emitterRunDir = (scannerRoot: string, runId: string) => path.join(scannerRoot, "native-emitter", "runs", runId);

/** Durable replace: write a temp file, fsync it, then rename over the target. */
export function writeFileDurably(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

export const readTextIfExists = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null);

export class FileEmitterCursorStore implements EmitterCursorReader, EmitterCursorWriter {
  constructor(readonly dir: string) {}

  private fileOf(symbol: string): string {
    if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error(`not a bare symbol: ${symbol}`);
    return path.join(this.dir, `${symbol}.json`);
  }

  /**
   * The stored cursor, or null when none exists. Unparseable bytes come back as
   * an empty object: the emitter's cursor check refuses it and fails that lane
   * alone — a corrupt cursor is never silently treated as "no cursor".
   */
  load(symbol: string): EmitterCursor | null {
    const text = readTextIfExists(this.fileOf(symbol));
    if (text === null) return null;
    try {
      return JSON.parse(text) as EmitterCursor;
    } catch {
      return {} as EmitterCursor;
    }
  }

  save(cursor: EmitterCursor): void {
    writeFileDurably(this.fileOf(cursor.symbol), `${JSON.stringify(cursor)}\n`);
  }
}

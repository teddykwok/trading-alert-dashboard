import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";

import { isScannerSymbolShape, symbolPathSegment } from "../native-scanner/exchange-symbol";
import { ENGINE_NAMESPACE_PREFIX_CHARS } from "../native-scanner/scanner-profile";
import type { EmitterCursor, EmitterCursorReader, EmitterCursorWriter } from "./multi-symbol-emitter";
import type { RebaselineStore } from "./native-emitter-cursor-rebaseline";

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

  /** One file per symbol, named by its path-safe segment (an ASCII symbol is itself; anything else "u-<utf8 hex>"). */
  private fileOf(symbol: string): string {
    if (!isScannerSymbolShape(symbol)) throw new Error(`not a bare symbol: ${JSON.stringify(symbol)}`);
    return path.join(this.dir, `${symbolPathSegment(symbol)}.json`);
  }

  /**
   * The stored cursor, or null when none exists. Unparseable bytes come back as
   * an empty object: the emitter's cursor check refuses it and fails that lane
   * alone — a corrupt cursor is never silently treated as "no cursor".
   */
  /** The cursor file's exact bytes, or null when none exists (the rebaseline's before-snapshot and its verification). */
  loadText(symbol: string): string | null {
    return readTextIfExists(this.fileOf(symbol));
  }

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

/**
 * native-emitter/rebaseline/<profileId>/<engine prefix>/<market>/<interval>:
 * one directory per NATIVE_EMITTER_CURSOR_REBASELINE_V1 operation of that
 * cursor namespace (plan, before/ snapshots, transaction state, result).
 */
export function emitterRebaselineDir(scannerRoot: string, profileId: string, engineFingerprint: string, marketType: string, chartInterval: string): string {
  if (!/^[A-Z][A-Z0-9_]*_V[0-9]+$/.test(profileId)) throw new Error("profileId is not a versioned machine identifier");
  if (!/^[0-9a-f]{64}$/.test(engineFingerprint)) throw new Error("the engine fingerprint must be a SHA-256 hex digest");
  return path.join(scannerRoot, "native-emitter", "rebaseline", profileId, engineFingerprint.slice(0, ENGINE_NAMESPACE_PREFIX_CHARS), marketType, chartInterval);
}

/** Exclusive durable create: refuses (EEXIST) instead of ever overwriting existing evidence. */
export function writeFileExclusive(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "wx");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const OPERATION_ID = /^\d{14}Z-[0-9a-f]{12}$/;

/** The rebaseline's evidence and cursor files on disk. Evidence is created once; only transaction.json is replaced. */
export class FileRebaselineStore implements RebaselineStore {
  constructor(
    readonly dir: string,
    private readonly cursors: FileEmitterCursorStore
  ) {}

  private fileOf(operationId: string, name: string): string {
    if (!OPERATION_ID.test(operationId)) throw new Error(`not a rebaseline operation id: ${JSON.stringify(operationId)}`);
    if (!/^(plan|transaction|result)\.json$|^before\/[A-Za-z0-9-]+\.json$/.test(name)) throw new Error(`not a rebaseline evidence file: ${JSON.stringify(name)}`);
    return path.join(this.dir, operationId, ...name.split("/"));
  }

  listOperations(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((entry) => OPERATION_ID.test(entry) && statSync(path.join(this.dir, entry)).isDirectory());
  }

  readEvidence(operationId: string, name: string): string | null {
    return readTextIfExists(this.fileOf(operationId, name));
  }

  writeEvidenceOnce(operationId: string, name: string, text: string): void {
    writeFileExclusive(this.fileOf(operationId, name), text);
  }

  replaceEvidence(operationId: string, name: string, text: string): void {
    writeFileDurably(this.fileOf(operationId, name), text);
  }

  readCursorFile(symbol: string): string | null {
    return this.cursors.loadText(symbol);
  }

  writeCursor(cursor: EmitterCursor): void {
    this.cursors.save(cursor);
  }
}

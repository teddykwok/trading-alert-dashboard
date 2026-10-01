import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

import { intervalMsOf, type ScannerChartInterval, type ScannerMarketType } from "./binance-public-futures";
import { canonicalJson, canonicalSha256 } from "./canonical-json";

/**
 * The live shadow scanner's DURABLE CHECKPOINT for one symbol and one lineage.
 *
 * It records how far the causal engine has committed (the high-water mark), the
 * committed state's hash there, and a hash of every causal kline byte consumed
 * from the switchover up to it. On restart those bytes are re-hashed and the
 * state is rebuilt and re-hashed: any difference is a refusal, never a silent
 * rebuild. Scanner-local file state only — no database, no queue.
 */

export const LIVE_CHECKPOINT_SCHEMA = "teddy.native-scanner.live-checkpoint.v1";

export type LiveShadowErrorCode =
  | "CHECKPOINT_CORRUPT"
  | "LINEAGE_MISMATCH"
  | "STATE_MISMATCH"
  | "HISTORICAL_DATA_DRIFT"
  | "CHECKPOINT_AHEAD_OF_DATA"
  | "SHADOW_STORE_CORRUPT"
  | "RECOVERY_REQUIRED"
  | "INVALID_STATE";

export class LiveShadowError extends Error {
  constructor(
    readonly code: LiveShadowErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LiveShadowError";
  }
}

export interface LiveCheckpointBody {
  readonly schema: typeof LIVE_CHECKPOINT_SCHEMA;
  readonly lineageId: string;
  readonly marketType: ScannerMarketType;
  readonly symbol: string;
  readonly chartInterval: ScannerChartInterval;
  readonly compatibilitySwitchoverMs: number;
  readonly stateSha256AtSwitchover: string;
  /** Open time of the first bar NOT yet committed (exclusive high-water mark). */
  readonly hwmOpenTimeMs: number;
  /** hwmOpenTimeMs - interval: the last committed bar (S - interval when nothing causal is committed). */
  readonly lastCommittedBarOpenTimeMs: number;
  /** Bars in [switchover, hwm). */
  readonly causalBarCount: number;
  /** SHA-256 of the canonical kline bytes of [switchover, hwm). */
  readonly causalInputSha256ThroughHwm: string;
  /** SHA-256 of the canonical committed engine state after lastCommittedBarOpenTimeMs. */
  readonly stateSha256: string;
}

export interface LiveCheckpointFile {
  readonly body: LiveCheckpointBody;
  /** canonicalSha256(body): a torn or edited checkpoint cannot verify. */
  readonly bodySha256: string;
  /** Provenance only: never part of any hash. */
  readonly writtenAt: string;
}

const BODY_KEYS = [
  "schema",
  "lineageId",
  "marketType",
  "symbol",
  "chartInterval",
  "compatibilitySwitchoverMs",
  "stateSha256AtSwitchover",
  "hwmOpenTimeMs",
  "lastCommittedBarOpenTimeMs",
  "causalBarCount",
  "causalInputSha256ThroughHwm",
  "stateSha256",
].sort();
const SHA = /^[0-9a-f]{64}$/;

function corrupt(message: string): never {
  throw new LiveShadowError("CHECKPOINT_CORRUPT", message);
}

/** Every structural invariant of a checkpoint body; anything else is corrupt. */
export function assertCheckpointBody(body: LiveCheckpointBody): void {
  if (body === null || typeof body !== "object") corrupt("checkpoint body must be an object");
  if (canonicalJson(Object.keys(body).sort()) !== canonicalJson(BODY_KEYS)) corrupt("checkpoint body has missing or extra fields");
  if (body.schema !== LIVE_CHECKPOINT_SCHEMA) corrupt("unknown checkpoint schema");
  for (const field of ["lineageId", "stateSha256AtSwitchover", "causalInputSha256ThroughHwm", "stateSha256"] as const) {
    if (typeof body[field] !== "string" || !SHA.test(body[field])) corrupt(`${field} must be a SHA-256 hex digest`);
  }
  const intervalMs = intervalMsOf(body.chartInterval);
  for (const field of ["compatibilitySwitchoverMs", "hwmOpenTimeMs", "lastCommittedBarOpenTimeMs", "causalBarCount"] as const) {
    if (!Number.isSafeInteger(body[field])) corrupt(`${field} must be an integer`);
  }
  if (body.hwmOpenTimeMs % intervalMs !== 0 || body.compatibilitySwitchoverMs % intervalMs !== 0) corrupt("checkpoint times must be on bar boundaries");
  if (body.hwmOpenTimeMs < body.compatibilitySwitchoverMs) corrupt("high-water mark is before the switchover");
  if (body.lastCommittedBarOpenTimeMs !== body.hwmOpenTimeMs - intervalMs) corrupt("lastCommittedBarOpenTimeMs must be hwm - interval");
  if (body.causalBarCount !== (body.hwmOpenTimeMs - body.compatibilitySwitchoverMs) / intervalMs) corrupt("causalBarCount does not match the high-water mark");
}

/** Durable replace: write a temp file, fsync it, then rename over the target. */
function writeDurably(file: string, text: string): void {
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

export class LiveCheckpointStore {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = path.join(dir, "checkpoint.json");
  }

  /** The verified checkpoint, or null when none exists. Anything unverifiable throws. */
  load(): LiveCheckpointFile | null {
    if (!existsSync(this.file)) return null;
    let parsed: LiveCheckpointFile;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as LiveCheckpointFile;
    } catch {
      corrupt("checkpoint is not JSON");
    }
    if (parsed === null || typeof parsed !== "object" || canonicalJson(Object.keys(parsed).sort()) !== canonicalJson(["body", "bodySha256", "writtenAt"])) {
      corrupt("checkpoint file has missing or extra fields");
    }
    assertCheckpointBody(parsed.body);
    if (parsed.bodySha256 !== canonicalSha256(parsed.body)) corrupt("checkpoint body does not match its hash");
    return parsed;
  }

  save(body: LiveCheckpointBody, writtenAt: string): LiveCheckpointFile {
    assertCheckpointBody(body);
    const file: LiveCheckpointFile = { body, bodySha256: canonicalSha256(body), writtenAt };
    mkdirSync(this.dir, { recursive: true });
    writeDurably(this.file, `${canonicalJson(file)}\n`);
    return file;
  }
}

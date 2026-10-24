import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { ShadowLogTail } from "../src/modules/native-alerts/shadow-log-reader";

/**
 * The emitter re-reads every lane's whole log on each poll and keeps the
 * latest text per lane. The tail reader must keep a reference to that SAME
 * text — not to an earlier, equal copy — or an all-unchanged poll of 500+
 * lanes holds every log twice.
 *
 * Measured differentially: with the test still holding the current text,
 * dropping the reader may free nothing more than what only the reader held.
 */

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const used = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
};
/** Full collections, with time for V8 to release freed buffer backing stores (that happens after the GC itself). */
async function settled(): Promise<number> {
  for (let i = 0; i < 4; i += 1) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return used();
}

describe("the tail reader keeps no second copy of an unchanged log", () => {
  it("re-reading an equal log keeps only the CURRENT text", async () => {
    const SIZE = 32 * 1024 * 1024;
    const read = () => Buffer.alloc(SIZE, "a\n").toString("latin1");
    let tail: ShadowLogTail | null = new ShadowLogTail({ lineageId: "a".repeat(64), marketType: "USDM_PERPETUAL", symbol: "AAAUSDT", chartInterval: "15m" }, 0);
    let previous: string | null = read();
    tail.readBounded(previous, { maxRecords: 0, judgeTail: false });
    // The next poll: an unchanged file, read again — equal content, a new string.
    const current = read();
    previous = null;
    tail.readBounded(current, { maxRecords: 0, judgeTail: false });
    const withReader = await settled();
    tail = null;
    const freedByDroppingTheReader = withReader - (await settled());
    expect(current.length).toBe(SIZE);
    expect(freedByDroppingTheReader).toBeLessThan(SIZE / 4);
  });
});

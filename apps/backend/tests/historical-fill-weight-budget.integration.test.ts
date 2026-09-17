import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import {
  HISTORICAL_FILL_RESERVATION_WEIGHT,
  HistoricalFillWeightBudgetInvariantError,
  HistoricalFillWeightBudgetService,
  HistoricalFillWeightBudgetUnavailableError,
} from "../src/modules/execution/historical-fill-weight-budget.service";

/**
 * The cross-process historical weight ceiling, against a REAL Postgres.
 *
 * Every claim here is about what the DATABASE guarantees under genuine
 * concurrency, so none of it can be proven against a mock. Contenders are
 * INDEPENDENT PrismaClients — separate connections, separate service graphs —
 * because a shared client would prove only that one process agrees with
 * itself, which is exactly the thing that was never in doubt.
 *
 * No Binance client is imported here or by the code under test.
 */

const TAG = "fill-weight-budget-synthetic";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

/** Independent clients, created once, so contention is genuinely cross-connection. */
const clients: PrismaClient[] = [];
function contender(): HistoricalFillWeightBudgetService {
  const client = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
  clients.push(client);
  return new HistoricalFillWeightBudgetService(client);
}

let profileId = "";

async function makeProfile(suffix: string): Promise<string> {
  const profile = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${suffix}`,
      exchange: "BINANCE",
      product: "USD_M_FUTURES",
      environment: "TESTNET",
      accountIdentifier: `${TAG}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
    select: { id: true },
  });
  return profile.id;
}

beforeAll(async () => {
  if (!prisma || !available) return;
  profileId = await makeProfile("root");
});

afterEach(async () => {
  if (!prisma || !available) return;
  await prisma.historicalFillWeightReservation.deleteMany({
    where: { bucket: { executionProfileId: profileId } },
  });
  await prisma.historicalFillWeightBucket.deleteMany({ where: { executionProfileId: profileId } });
});

afterAll(async () => {
  if (prisma && available) {
    await prisma.historicalFillWeightReservation.deleteMany({
      where: { bucket: { executionProfile: { name: { startsWith: TAG } } } },
    });
    await prisma.historicalFillWeightBucket.deleteMany({
      where: { executionProfile: { name: { startsWith: TAG } } },
    });
    await prisma.executionProfile.deleteMany({ where: { name: { startsWith: TAG } } });
  }
  await Promise.all(clients.map((client) => client.$disconnect()));
  await prisma?.$disconnect();
});

describe("one dispatch is the only quantity", () => {
  maybe()("reserves exactly the pinned request weight", async () => {
    expect(HISTORICAL_FILL_RESERVATION_WEIGHT).toBe(5);

    const granted = await contender().reserve({ executionProfileId: profileId, weightCap: 25 });

    expect(granted.outcome).toBe("GRANTED");
    if (granted.outcome !== "GRANTED") return;
    expect(granted.reservation.weight).toBe(5);

    const row = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(row.weightUsed).toBe(5);
    expect(row.weightCap).toBe(25);
    // The bucket is a whole UTC minute, from the database clock.
    expect(row.bucketStart.getUTCSeconds()).toBe(0);
    expect(row.bucketStart.getUTCMilliseconds()).toBe(0);
  });
});

describe("concurrent contenders can never exceed the cap", () => {
  maybe()("cap 5: two simultaneous attempts, exactly one grant", async () => {
    const id = await makeProfile("cap5");
    const [a, b] = await Promise.all([
      contender().reserve({ executionProfileId: id, weightCap: 5 }),
      contender().reserve({ executionProfileId: id, weightCap: 5 }),
    ]);

    const granted = [a, b].filter((result) => result.outcome === "GRANTED");
    expect(granted).toHaveLength(1);
    expect([a, b].filter((result) => result.outcome === "EXHAUSTED")).toHaveLength(1);

    const row = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    });
    expect(row.weightUsed).toBe(5);
  });

  maybe()("cap 10: three simultaneous attempts, exactly two grants", async () => {
    const id = await makeProfile("cap10");
    const results = await Promise.all([
      contender().reserve({ executionProfileId: id, weightCap: 10 }),
      contender().reserve({ executionProfileId: id, weightCap: 10 }),
      contender().reserve({ executionProfileId: id, weightCap: 10 }),
    ]);

    expect(results.filter((result) => result.outcome === "GRANTED")).toHaveLength(2);
    const row = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    });
    expect(row.weightUsed).toBe(10);
  });

  maybe()("cap 25: eight contenders, at most five grants and never over cap", async () => {
    const id = await makeProfile("cap25");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => contender().reserve({ executionProfileId: id, weightCap: 25 }))
    );

    const granted = results.filter((result) => result.outcome === "GRANTED");
    expect(granted.length).toBeLessThanOrEqual(5);
    expect(granted).toHaveLength(5);

    const row = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    });
    expect(row.weightUsed).toBe(25);
    expect(row.weightUsed).toBeLessThanOrEqual(row.weightCap);
  });

  maybe()("the missing-bucket race converges on exactly one row", async () => {
    const id = await makeProfile("race");
    await Promise.all(
      Array.from({ length: 6 }, () => contender().reserve({ executionProfileId: id, weightCap: 30 }))
    );

    const rows = await prisma!.historicalFillWeightBucket.findMany({
      where: { executionProfileId: id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].weightUsed).toBe(30);
  });
});

describe("releasing a proven non-dispatch", () => {
  maybe()("returns exactly its own weight, and a new contender can take it", async () => {
    const id = await makeProfile("release");
    const service = contender();

    const first = await service.reserve({ executionProfileId: id, weightCap: 5 });
    expect(first.outcome).toBe("GRANTED");
    if (first.outcome !== "GRANTED") return;

    // The ceiling is full: the next contender is refused.
    expect((await contender().reserve({ executionProfileId: id, weightCap: 5 })).outcome).toBe(
      "EXHAUSTED"
    );

    await service.releaseCertainNonDispatch(first.reservation);

    expect((await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    })).weightUsed).toBe(0);

    // ...and the freed weight is usable by a DIFFERENT process.
    expect((await contender().reserve({ executionProfileId: id, weightCap: 5 })).outcome).toBe(
      "GRANTED"
    );
  });

  maybe()("releases the bucket it reserved, never the minute it is now", async () => {
    const id = await makeProfile("rollover");
    const service = contender();

    const granted = await service.reserve({ executionProfileId: id, weightCap: 25 });
    expect(granted.outcome).toBe("GRANTED");
    if (granted.outcome !== "GRANTED") return;

    // A later minute, established independently. A release carrying the FIRST
    // bucket must not decrement this one.
    const laterBucket = new Date(granted.reservation.bucketStart.getTime() + 60_000);
    await prisma!.historicalFillWeightBucket.create({
      data: { executionProfileId: id, bucketStart: laterBucket, weightCap: 25, weightUsed: 15 },
    });

    await service.releaseCertainNonDispatch(granted.reservation);

    const original = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id, bucketStart: granted.reservation.bucketStart },
    });
    const later = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id, bucketStart: laterBucket },
    });

    expect(original.weightUsed).toBe(0);
    expect(later.weightUsed).toBe(15);
  });

  maybe()("a release arriving AFTER the boundary still moves its own minute", async () => {
    const id = await makeProfile("late-release");
    const service = contender();

    // The current minute, established by a real reservation.
    const current = await service.reserve({ executionProfileId: id, weightCap: 25 });
    if (current.outcome !== "GRANTED") throw new Error("expected a grant");

    // A reservation genuinely taken in the PREVIOUS minute, whose release is
    // only arriving now -- exactly what happens when a batch straddles the
    // boundary. Releasing "the current minute" here would hand free weight to
    // a minute that never granted it, and leave the previous minute overcharged
    // forever.
    const previousStart = new Date(current.reservation.bucketStart.getTime() - 60_000);
    const previousBucket = await prisma!.historicalFillWeightBucket.create({
      data: { executionProfileId: id, bucketStart: previousStart, weightCap: 25, weightUsed: 5 },
      select: { id: true },
    });
    const previousReservation = await prisma!.historicalFillWeightReservation.create({
      data: { bucketId: previousBucket.id, weight: HISTORICAL_FILL_RESERVATION_WEIGHT },
      select: { id: true },
    });

    await service.releaseCertainNonDispatch({
      id: previousReservation.id,
      bucketId: previousBucket.id,
      executionProfileId: id,
      bucketStart: previousStart,
      weight: HISTORICAL_FILL_RESERVATION_WEIGHT,
    });

    const previous = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id, bucketStart: previousStart },
    });
    const now = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id, bucketStart: current.reservation.bucketStart },
    });

    // The minute that granted it gets it back...
    expect(previous.weightUsed).toBe(0);
    // ...and the current minute is untouched.
    expect(now.weightUsed).toBe(5);
  });

  maybe()("a second release of the only reservation is a no-op, not an underflow", async () => {
    const id = await makeProfile("floor");
    const service = contender();

    const granted = await service.reserve({ executionProfileId: id, weightCap: 25 });
    if (granted.outcome !== "GRANTED") throw new Error("expected a grant");

    await service.releaseCertainNonDispatch(granted.reservation);
    // A double release is refused by the guard rather than corrupting the count.
    await service.releaseCertainNonDispatch(granted.reservation);

    expect((await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    })).weightUsed).toBe(0);
  });
});

describe("a reservation may be released at most once", () => {
  maybe()("RED: releasing the same reservation twice must not free another one's weight", async () => {
    const id = await makeProfile("double-release");
    const service = contender();

    const r1 = await service.reserve({ executionProfileId: id, weightCap: 10 });
    const r2 = await service.reserve({ executionProfileId: id, weightCap: 10 });
    if (r1.outcome !== "GRANTED" || r2.outcome !== "GRANTED") throw new Error("expected two grants");

    const used = async () =>
      (await prisma!.historicalFillWeightBucket.findFirstOrThrow({
        where: { executionProfileId: id },
      })).weightUsed;

    expect(await used()).toBe(10);

    await service.releaseCertainNonDispatch(r1.reservation);
    expect(await used()).toBe(5);

    // The whole point: R2 is still outstanding and could still dispatch. A
    // second release of R1 must not hand away weight that belongs to R2.
    await service.releaseCertainNonDispatch(r1.reservation);
    expect(await used()).toBe(5);

    // The genuinely freed slot is usable exactly once...
    expect((await contender().reserve({ executionProfileId: id, weightCap: 10 })).outcome).toBe(
      "GRANTED"
    );
    expect(await used()).toBe(10);
    // ...and the ceiling is then full again.
    expect((await contender().reserve({ executionProfileId: id, weightCap: 10 })).outcome).toBe(
      "EXHAUSTED"
    );
  });

  maybe()("RED: two processes releasing the same reservation decrement exactly once", async () => {
    const id = await makeProfile("concurrent-release");
    const owner = contender();

    const r1 = await owner.reserve({ executionProfileId: id, weightCap: 10 });
    const r2 = await contender().reserve({ executionProfileId: id, weightCap: 10 });
    if (r1.outcome !== "GRANTED" || r2.outcome !== "GRANTED") throw new Error("expected two grants");

    // Independent service graphs, independent connections, same reservation.
    await Promise.all([
      contender().releaseCertainNonDispatch(r1.reservation),
      contender().releaseCertainNonDispatch(r1.reservation),
      contender().releaseCertainNonDispatch(r1.reservation),
    ]);

    const row = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    });
    expect(row.weightUsed).toBe(5);
    expect(row.weightUsed).not.toBe(0);
  });
});

describe("a release is whole, or it does not happen", () => {
  maybe()("RED: a decrement that cannot apply rolls the release back entirely", async () => {
    const id = await makeProfile("half-release");
    const service = contender();

    const granted = await service.reserve({ executionProfileId: id, weightCap: 10 });
    if (granted.outcome !== "GRANTED") throw new Error("expected a grant");

    // Deliberately corrupt the durable accounting into a state the service's
    // own API cannot produce: the reservation is still outstanding, but its
    // bucket no longer holds the weight that reservation is owed. Only storage
    // can put us here, and only this branch can be exercised from it.
    await prisma!.historicalFillWeightBucket.update({
      where: { id: granted.reservation.bucketId },
      data: { weightUsed: 0 },
    });

    // The release must refuse rather than commit a reservation marked released
    // whose weight is still charged -- a state nothing could ever correct,
    // because the reservation would never be releasable again.
    await expect(service.releaseCertainNonDispatch(granted.reservation)).rejects.toBeInstanceOf(
      HistoricalFillWeightBudgetInvariantError
    );

    const reservation = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
      where: { id: granted.reservation.id },
      select: { releasedAt: true },
    });
    const bucket = await prisma!.historicalFillWeightBucket.findUniqueOrThrow({
      where: { id: granted.reservation.bucketId },
      select: { weightUsed: true },
    });

    // The CAS rolled back with the transaction: still outstanding, still
    // releasable once the accounting is repaired by whoever broke it.
    expect(reservation.releasedAt).toBeNull();
    expect(bucket.weightUsed).toBe(0);
  });

  maybe()("an already-released reservation is a no-op, never an invariant error", async () => {
    const id = await makeProfile("noop-not-error");
    const service = contender();

    const r1 = await service.reserve({ executionProfileId: id, weightCap: 10 });
    const r2 = await service.reserve({ executionProfileId: id, weightCap: 10 });
    if (r1.outcome !== "GRANTED" || r2.outcome !== "GRANTED") throw new Error("expected two grants");

    await service.releaseCertainNonDispatch(r1.reservation);
    // The CAS finds nothing to claim, so there is no decrement to assert on.
    // A duplicate release is ordinary, not a violation.
    await expect(service.releaseCertainNonDispatch(r1.reservation)).resolves.toBeUndefined();

    expect((await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    })).weightUsed).toBe(5);
  });
});

describe("configuration drift fails closed", () => {
  maybe()("a different configured cap is refused, and never overwrites the one in force", async () => {
    const id = await makeProfile("drift");

    const established = await contender().reserve({ executionProfileId: id, weightCap: 25 });
    expect(established.outcome).toBe("GRANTED");

    // A second process believing the ceiling is 50 must not raise a ceiling the
    // first is already counting against.
    const drifted = await contender().reserve({ executionProfileId: id, weightCap: 50 });

    expect(drifted.outcome).toBe("CAP_MISMATCH");
    if (drifted.outcome !== "CAP_MISMATCH") return;
    expect(drifted.storedCap).toBe(25);
    expect(drifted.configuredCap).toBe(50);

    const row = await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    });
    expect(row.weightCap).toBe(25);
    expect(row.weightUsed).toBe(5);
  });

  maybe()("a drifted process cannot consume weight even when the ceiling has room", async () => {
    const id = await makeProfile("drift-room");

    expect((await contender().reserve({ executionProfileId: id, weightCap: 25 })).outcome).toBe(
      "GRANTED"
    );
    const before = (await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    })).weightUsed;

    expect((await contender().reserve({ executionProfileId: id, weightCap: 15 })).outcome).toBe(
      "CAP_MISMATCH"
    );

    expect((await prisma!.historicalFillWeightBucket.findFirstOrThrow({
      where: { executionProfileId: id },
    })).weightUsed).toBe(before);
  });
});

describe("coordination failure is never a denial", () => {
  maybe()("an unreachable database throws rather than reporting an empty ceiling", async () => {
    const broken = new PrismaClient({
      datasources: { db: { url: "postgresql://nobody:nobody@127.0.0.1:1/nope?schema=public" } },
    });
    const service = new HistoricalFillWeightBudgetService(broken);

    // "The ceiling is full" and "the ceiling could not be read" must never look
    // alike: one is a budget doing its job, the other is an outage.
    await expect(
      service.reserve({ executionProfileId: profileId, weightCap: 25 })
    ).rejects.toBeInstanceOf(HistoricalFillWeightBudgetUnavailableError);

    await broken.$disconnect().catch(() => undefined);
  });
});

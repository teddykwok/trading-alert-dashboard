-- Bounded userTrades ingestion work state — ADDITIVE ONLY.
--
-- One new enum and one new table. No existing table is altered, no column is
-- dropped or made required, no existing value is rewritten and NOTHING is
-- backfilled. ExecutionProfile gains only a Prisma-side back-relation, which is
-- virtual and produces no SQL. Nothing in the runtime calls this table yet.
--
-- WHY A TABLE AND NOT A CURSOR
-- A cursor answers "how far have we got", which is the wrong question: two
-- fills can share a millisecond, so advancing past a timestamp can silently
-- skip one. These rows answer "which exact intervals have been PROVEN
-- exhausted", and completeness is derived by walking them. That is also why
-- there is deliberately no high-water checkpoint table: a second writable
-- source of truth can disagree with the first, and it would disagree in the
-- dangerous direction — claiming more is proven than is.
--
-- WHY THE BOUNDS ARE BIGINT
-- The split tree's identity IS integer arithmetic: a saturated parent bisects
-- at `mid`, and its children are [start, mid] and [mid + 1, end]. Those are
-- exact millisecond integers, and the pure planner already works in them. A
-- timestamp type would introduce a timezone-bearing round trip on the one value
-- that must come back byte-identical to be the same node. This is the schema's
-- first BigInt, chosen deliberately over the DateTime convention used
-- everywhere else, because everywhere else stores an EVENT TIME and this stores
-- an IDENTITY.
--
-- WHY THE UNIQUE KEY CARRIES THE ACCOUNT AND THE SYMBOL
-- Two accounts may legitimately sweep the same symbol over the same range, and
-- userTrades makes `symbol` mandatory so an interval can never mean "all
-- symbols". Keying on the bounds alone would make the second account's tree
-- collide with the first the day it exists. The unique index is also the whole
-- idempotency mechanism: seeding the same interval twice, or re-deriving a
-- split child after a rolled-back transaction, converges to one row without any
-- caller remembering to check.
--
-- WHY THE CHECK CONSTRAINTS
-- These are timeless structural truths about an interval, not application
-- transitions: a negative millisecond is not a time, an interval cannot end
-- before it starts, Binance documents a seven-day maximum span, an attempt
-- count cannot be negative, and a lease is either held or not. Transitions are
-- enforced by compare-and-set in the service, where they belong; a CHECK cannot
-- see the previous row and a trigger would live outside Prisma's migration
-- story and drift. This is the first CHECK constraint in this schema.
--
-- WHY THE FOREIGN KEYS ARE RESTRICT
-- A window is proof about an account's history. Deleting the profile would
-- destroy the evidence, and deleting a SPLIT parent would orphan the lineage
-- explaining why its children exist. Same policy the execution tables already
-- use for financial records.

CREATE TYPE "FillIngestWindowStatus" AS ENUM (
  'PENDING',
  'COMPLETE',
  'SPLIT',
  'INCOMPLETE_SKIPPED_ROWS',
  'SATURATED_SINGLE_MILLISECOND',
  'ABANDONED'
);

CREATE TABLE "ExchangeFillIngestWindow" (
    "id" TEXT NOT NULL,
    "executionProfileId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "startTimeMs" BIGINT NOT NULL,
    "endTimeMs" BIGINT NOT NULL,
    "status" "FillIngestWindowStatus" NOT NULL DEFAULT 'PENDING',
    "parentId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "claimOwner" TEXT,
    "nextEligibleAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "sanitizedLastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeFillIngestWindow_pkey" PRIMARY KEY ("id")
);

-- The natural identity, and the idempotency mechanism for both seeding and
-- split-child re-derivation. Its column order (profile, symbol, start, end)
-- also serves the ordered coverage scan that derives contiguous completeness,
-- so no separate index is created for that query.
CREATE UNIQUE INDEX "ExchangeFillIngestWindow_executionProfileId_symbol_startTimeMs_endTimeMs_key"
  ON "ExchangeFillIngestWindow"("executionProfileId", "symbol", "startTimeMs", "endTimeMs");

-- Claim discovery: the selective columns of the eligibility predicate, in the
-- order it narrows. In steady state very few rows are PENDING, so this stays
-- small no matter how large the proven history grows.
CREATE INDEX "ExchangeFillIngestWindow_executionProfileId_status_nextEligibleAt_claimedAt_idx"
  ON "ExchangeFillIngestWindow"("executionProfileId", "status", "nextEligibleAt", "claimedAt");

-- Lineage: "why does this leaf exist".
CREATE INDEX "ExchangeFillIngestWindow_parentId_idx"
  ON "ExchangeFillIngestWindow"("parentId");

-- A negative millisecond is not a time, and an interval cannot end before it
-- starts.
ALTER TABLE "ExchangeFillIngestWindow"
  ADD CONSTRAINT "ExchangeFillIngestWindow_bounds_check"
  CHECK ("startTimeMs" >= 0 AND "endTimeMs" >= 0 AND "endTimeMs" >= "startTimeMs");

-- 604800000 = 7 * 24 * 60 * 60 * 1000, Binance's documented maximum span for
-- GET /fapi/v1/userTrades. The canonical constant is USER_TRADES_MAX_WINDOW_MS
-- in src/modules/binance/user-trades-window-planner.ts; a literal is unavoidable
-- in SQL, so a test pins the two to be equal.
ALTER TABLE "ExchangeFillIngestWindow"
  ADD CONSTRAINT "ExchangeFillIngestWindow_span_check"
  CHECK ("endTimeMs" - "startTimeMs" <= 604800000);

ALTER TABLE "ExchangeFillIngestWindow"
  ADD CONSTRAINT "ExchangeFillIngestWindow_attempts_check"
  CHECK ("attempts" >= 0);

-- A lease is held or it is not. Half a lease is not a state any code should
-- have to interpret.
ALTER TABLE "ExchangeFillIngestWindow"
  ADD CONSTRAINT "ExchangeFillIngestWindow_claim_pair_check"
  CHECK (("claimedAt" IS NULL) = ("claimOwner" IS NULL));

ALTER TABLE "ExchangeFillIngestWindow"
  ADD CONSTRAINT "ExchangeFillIngestWindow_executionProfileId_fkey"
  FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ExchangeFillIngestWindow"
  ADD CONSTRAINT "ExchangeFillIngestWindow_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "ExchangeFillIngestWindow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

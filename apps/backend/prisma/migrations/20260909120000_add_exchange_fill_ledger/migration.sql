-- Exchange fill ledger — ADDITIVE ONLY.
--
-- One new table and one new enum. No existing table is altered, no column is
-- dropped or made required, no existing value is rewritten, and NOTHING is
-- backfilled. The three existing models gain only Prisma-side back-relations,
-- which are virtual and produce no SQL.
--
-- WHY A LEDGER RATHER THAN COLUMNS ON TradeExecution
-- A trade's result is not one number the exchange hands over; it is the sum of
-- N fills, each with its own price, its own fee and its own realized amount.
-- Entry fills and exit fills both count, and one order can produce three fills
-- seconds apart. Collapsing that into execution columns at ingestion time
-- destroys the evidence and makes any later correction impossible to audit.
-- The rows are the facts; totals are a question asked of them.
--
-- WHY THE UNIQUE KEY CARRIES executionProfileId
-- A Binance trade id is unique per ACCOUNT, not globally. Two accounts may
-- legitimately both hold trade 1001, and TESTNET and MAINNET must never merge.
-- The profile is the durable account+environment anchor, so the natural
-- identity of a fill is (account, symbol, trade id). Keying on (symbol, id) or
-- on the id alone would make the second account's history collide with the
-- first the day it exists.
--
-- WHY THE UNIQUE INDEX IS THE IDEMPOTENCY MECHANISM
-- userTrades is read by time window, so overlapping reads and any replay after
-- a restart return trades already recorded. Making that a database constraint
-- rather than a caller's check means a duplicate cannot be written even by a
-- caller that forgot, and ingestion never accumulates in place — there is no
-- "total += observed" that a replay could apply twice.
--
-- WHY ATTRIBUTION IS AN ENUM RATHER THAN A NULLABLE LINK
-- "No owned order matched" and "several owned rows matched" are different
-- facts, and both differ from "matched". exchangeOrderId and actualOrderId are
-- NOT unique on BinanceOrder, so an ambiguous match is representable and must
-- be recorded as ambiguous rather than resolved to whichever row came first.
--
-- WHY FOREIGN KEYS ARE RESTRICT
-- These are financial records. An execution or order with fills against it
-- cannot be deleted out from under them, matching the policy already used for
-- BinanceOrder and ExecutionEvent.
--
-- WHY DECIMAL AND NOT FLOAT
-- Money. Every amount is stored at the precision the exchange delivered:
-- quantities at (40,18) and prices/amounts at (30,12), the same widths the
-- execution tables already use. realizedPnl and commission are nullable
-- because an absent value means UNKNOWN, which is not zero.

CREATE TYPE "FillAttribution" AS ENUM ('OWNED_ORDER', 'UNATTRIBUTED', 'AMBIGUOUS');

CREATE TABLE "ExchangeFillLedger" (
    "id" TEXT NOT NULL,
    "executionProfileId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchangeTradeId" TEXT NOT NULL,
    "exchangeOrderId" TEXT,
    "attribution" "FillAttribution" NOT NULL DEFAULT 'UNATTRIBUTED',
    "binanceOrderId" TEXT,
    "tradeExecutionId" TEXT,
    "side" "ExecutionOrderSide" NOT NULL,
    "positionSide" "ExecutionPositionSide" NOT NULL,
    "quantity" DECIMAL(40,18) NOT NULL,
    "price" DECIMAL(30,12) NOT NULL,
    "quoteQuantity" DECIMAL(30,12),
    "realizedPnl" DECIMAL(30,12),
    "commission" DECIMAL(30,12),
    "commissionAsset" TEXT,
    "maker" BOOLEAN,
    "tradeTime" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeFillLedger_pkey" PRIMARY KEY ("id")
);

-- The idempotency mechanism.
CREATE UNIQUE INDEX "ExchangeFillLedger_executionProfileId_symbol_exchangeTradeId_key"
  ON "ExchangeFillLedger"("executionProfileId", "symbol", "exchangeTradeId");

CREATE INDEX "ExchangeFillLedger_tradeExecutionId_idx"
  ON "ExchangeFillLedger"("tradeExecutionId");

CREATE INDEX "ExchangeFillLedger_binanceOrderId_idx"
  ON "ExchangeFillLedger"("binanceOrderId");

CREATE INDEX "ExchangeFillLedger_executionProfileId_symbol_tradeTime_idx"
  ON "ExchangeFillLedger"("executionProfileId", "symbol", "tradeTime");

CREATE INDEX "ExchangeFillLedger_attribution_idx"
  ON "ExchangeFillLedger"("attribution");

ALTER TABLE "ExchangeFillLedger"
  ADD CONSTRAINT "ExchangeFillLedger_executionProfileId_fkey"
  FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ExchangeFillLedger"
  ADD CONSTRAINT "ExchangeFillLedger_binanceOrderId_fkey"
  FOREIGN KEY ("binanceOrderId") REFERENCES "BinanceOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ExchangeFillLedger"
  ADD CONSTRAINT "ExchangeFillLedger_tradeExecutionId_fkey"
  FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

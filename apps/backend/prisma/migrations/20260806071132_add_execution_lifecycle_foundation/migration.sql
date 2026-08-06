-- CreateEnum
CREATE TYPE "ExecutionExchange" AS ENUM ('BINANCE');

-- CreateEnum
CREATE TYPE "ExecutionProduct" AS ENUM ('USD_M_FUTURES');

-- CreateEnum
CREATE TYPE "ExecutionEnvironment" AS ENUM ('MAINNET', 'TESTNET');

-- CreateEnum
CREATE TYPE "ExecutionPositionMode" AS ENUM ('HEDGE', 'ONE_WAY');

-- CreateEnum
CREATE TYPE "ExecutionMarginType" AS ENUM ('ISOLATED', 'CROSS');

-- CreateEnum
CREATE TYPE "ExecutionOrderType" AS ENUM ('LIMIT', 'MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET');

-- CreateEnum
CREATE TYPE "ExecutionDirection" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "ExecutionPositionSide" AS ENUM ('LONG', 'SHORT', 'BOTH');

-- CreateEnum
CREATE TYPE "ExecutionOrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TradeExecutionStatus" AS ENUM ('PLAN_READY', 'PREFLIGHT', 'ENTRY_SUBMITTING', 'ENTRY_PENDING', 'PARTIALLY_FILLED', 'ENTRY_FILLED', 'PLACING_PROTECTION', 'PROTECTED', 'ENTRY_EXPIRED', 'CLOSED_TP', 'CLOSED_SL', 'CANCELED', 'SKIPPED', 'FAILED', 'MANUAL_INTERVENTION');

-- CreateEnum
CREATE TYPE "ExecutionOrderRole" AS ENUM ('ENTRY', 'STOP_LOSS', 'TAKE_PROFIT', 'EMERGENCY_CLOSE');

-- CreateEnum
CREATE TYPE "ExecutionOrderStatus" AS ENUM ('PLANNED', 'SUBMITTING', 'NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ExecutionEventType" AS ENUM ('EXECUTION_CREATED', 'STATUS_CHANGED', 'ORDER_RESERVED', 'ORDER_UPDATED', 'PLAN_SNAPSHOT_RECORDED', 'ACTUALS_UPDATED', 'DECISION_RECORDED', 'FAILURE_RECORDED', 'MANUAL_INTERVENTION_REQUIRED');

-- CreateTable
CREATE TABLE "ExecutionProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountIdentifier" TEXT NOT NULL,
    "exchange" "ExecutionExchange" NOT NULL DEFAULT 'BINANCE',
    "product" "ExecutionProduct" NOT NULL DEFAULT 'USD_M_FUTURES',
    "environment" "ExecutionEnvironment" NOT NULL DEFAULT 'TESTNET',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "expectedPositionMode" "ExecutionPositionMode" NOT NULL DEFAULT 'HEDGE',
    "expectedMarginType" "ExecutionMarginType" NOT NULL DEFAULT 'ISOLATED',
    "entryOrderType" "ExecutionOrderType" NOT NULL DEFAULT 'LIMIT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeExecution" (
    "id" TEXT NOT NULL,
    "executionProfileId" TEXT NOT NULL,
    "alertId" TEXT,
    "extremeRRPlanId" TEXT,
    "symbol" TEXT NOT NULL,
    "direction" "ExecutionDirection" NOT NULL,
    "positionSide" "ExecutionPositionSide" NOT NULL,
    "selectedLookback" INTEGER NOT NULL,
    "status" "TradeExecutionStatus" NOT NULL DEFAULT 'PLAN_READY',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "plannedEntryPrice" DECIMAL(30,12) NOT NULL,
    "calculatedStopLoss" DECIMAL(30,12) NOT NULL,
    "executableStopLoss" DECIMAL(30,12) NOT NULL,
    "takeProfit" DECIMAL(30,12),
    "riskBudgetUsd" DECIMAL(30,12) NOT NULL,
    "quantityRaw" DECIMAL(40,18) NOT NULL,
    "plannedQuantity" DECIMAL(40,18) NOT NULL,
    "quantityStepSize" DECIMAL(40,18) NOT NULL,
    "actualPlannedLoss" DECIMAL(30,12) NOT NULL,
    "unusedRiskBudget" DECIMAL(30,12) NOT NULL,
    "positionNotional" DECIMAL(30,12) NOT NULL,
    "targetIsolatedMargin" DECIMAL(30,12) NOT NULL,
    "maximumIsolatedMargin" DECIMAL(30,12) NOT NULL,
    "selectedLeverage" INTEGER NOT NULL,
    "estimatedInitialMargin" DECIMAL(30,12) NOT NULL,
    "estimatedLiquidationPrice" DECIMAL(30,12),
    "requiredLiquidationBoundary" DECIMAL(30,12),
    "liquidationBufferRatio" DECIMAL(10,4) NOT NULL,
    "estimatedRewardRatio" DECIMAL(10,4),
    "entryExpiresAt" TIMESTAMP(3),
    "extremeRRCandidateSnapshot" JSONB,
    "marginPlanSnapshot" JSONB,
    "riskTemplateSnapshot" JSONB,
    "exchangeFiltersSnapshot" JSONB,
    "submittedEntryPrice" DECIMAL(30,12),
    "averageFillPrice" DECIMAL(30,12),
    "filledQuantity" DECIMAL(40,18),
    "actualLeverage" INTEGER,
    "actualIsolatedMargin" DECIMAL(30,12),
    "reportedLiquidationPrice" DECIMAL(30,12),
    "actualExitPrice" DECIMAL(30,12),
    "realizedPnl" DECIMAL(30,12),
    "exitReason" TEXT,
    "entrySubmittedAt" TIMESTAMP(3),
    "firstFillAt" TIMESTAMP(3),
    "entryFilledAt" TIMESTAMP(3),
    "protectionPlacedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "decisionReasonCode" TEXT,
    "sanitizedMessage" TEXT,
    "requiresManualIntervention" BOOLEAN NOT NULL DEFAULT false,
    "lastReconciledAt" TIMESTAMP(3),

    CONSTRAINT "TradeExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BinanceOrder" (
    "id" TEXT NOT NULL,
    "tradeExecutionId" TEXT NOT NULL,
    "role" "ExecutionOrderRole" NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "clientOrderId" TEXT NOT NULL,
    "exchangeOrderId" TEXT,
    "side" "ExecutionOrderSide" NOT NULL,
    "positionSide" "ExecutionPositionSide" NOT NULL,
    "orderType" "ExecutionOrderType" NOT NULL,
    "timeInForce" TEXT,
    "price" DECIMAL(30,12),
    "stopPrice" DECIMAL(30,12),
    "originalQuantity" DECIMAL(40,18) NOT NULL,
    "executedQuantity" DECIMAL(40,18) NOT NULL DEFAULT 0,
    "averageFillPrice" DECIMAL(30,12),
    "status" "ExecutionOrderStatus" NOT NULL DEFAULT 'PLANNED',
    "reduceOnly" BOOLEAN,
    "closePosition" BOOLEAN,
    "submittedAt" TIMESTAMP(3),
    "lastExchangeUpdateAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BinanceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionEvent" (
    "id" TEXT NOT NULL,
    "tradeExecutionId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "eventType" "ExecutionEventType" NOT NULL,
    "fromStatus" "TradeExecutionStatus",
    "toStatus" "TradeExecutionStatus",
    "reasonCode" TEXT,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionProfile_isEnabled_idx" ON "ExecutionProfile"("isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionProfile_exchange_environment_accountIdentifier_key" ON "ExecutionProfile"("exchange", "environment", "accountIdentifier");

-- CreateIndex
CREATE INDEX "TradeExecution_status_idx" ON "TradeExecution"("status");

-- CreateIndex
CREATE INDEX "TradeExecution_executionProfileId_idx" ON "TradeExecution"("executionProfileId");

-- CreateIndex
CREATE INDEX "TradeExecution_symbol_idx" ON "TradeExecution"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "TradeExecution_alertId_executionProfileId_key" ON "TradeExecution"("alertId", "executionProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "BinanceOrder_clientOrderId_key" ON "BinanceOrder"("clientOrderId");

-- CreateIndex
CREATE INDEX "BinanceOrder_tradeExecutionId_idx" ON "BinanceOrder"("tradeExecutionId");

-- CreateIndex
CREATE INDEX "BinanceOrder_status_idx" ON "BinanceOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BinanceOrder_tradeExecutionId_role_generation_key" ON "BinanceOrder"("tradeExecutionId", "role", "generation");

-- CreateIndex
CREATE INDEX "ExecutionEvent_tradeExecutionId_sequenceNumber_idx" ON "ExecutionEvent"("tradeExecutionId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "ExecutionEvent_eventType_idx" ON "ExecutionEvent"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionEvent_tradeExecutionId_sequenceNumber_key" ON "ExecutionEvent"("tradeExecutionId", "sequenceNumber");

-- AddForeignKey
ALTER TABLE "TradeExecution" ADD CONSTRAINT "TradeExecution_executionProfileId_fkey" FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeExecution" ADD CONSTRAINT "TradeExecution_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeExecution" ADD CONSTRAINT "TradeExecution_extremeRRPlanId_fkey" FOREIGN KEY ("extremeRRPlanId") REFERENCES "ExtremeRRPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BinanceOrder" ADD CONSTRAINT "BinanceOrder_tradeExecutionId_fkey" FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_tradeExecutionId_fkey" FOREIGN KEY ("tradeExecutionId") REFERENCES "TradeExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "RiskTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "referenceCapital" DECIMAL(30,12) NOT NULL,
    "riskPercent" DECIMAL(10,6) NOT NULL,
    "rewardRatio" DECIMAL(10,4) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskTemplate_isActive_idx" ON "RiskTemplate"("isActive");

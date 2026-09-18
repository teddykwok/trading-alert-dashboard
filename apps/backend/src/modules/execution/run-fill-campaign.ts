import { PrismaClient } from "@prisma/client";

import { HistoricalFillCampaignService } from "./historical-fill-campaign.service";
import { HistoricalFillCircuitBreakerService } from "./historical-fill-circuit-breaker.service";
import { runFillCampaignCli, type CliResult } from "./fill-campaign-cli";

/**
 * The process wrapper for every `execution:fill-campaign-*` command.
 *
 * Owns exactly what a process owns -- the Prisma client, the argv slice and the
 * exit code -- so the CLI module itself stays a pure function of its arguments
 * and its dependencies, and can be tested without a process or a terminal.
 */
export async function runFillCampaignCommand(command: string): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result: CliResult = await runFillCampaignCli([command, ...process.argv.slice(2)], {
      prisma,
      campaigns: new HistoricalFillCampaignService(prisma),
      // The SAME breaker service the runtime uses, on this process's own client.
      // Status reads it; acknowledge is the one operator action that writes it.
      circuit: new HistoricalFillCircuitBreakerService(prisma),
    });
    process.exitCode = result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

import { runFillCampaignCommand } from "./run-fill-campaign";

runFillCampaignCommand("pause").catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

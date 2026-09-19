import { runFillWindowCanaryCommand } from "./run-fill-canary";

runFillWindowCanaryCommand().catch((error) => {
  // The NAME only, never the message: several domain errors in this path embed
  // the bound execution profile id in their message text, and the classified
  // refusals are already reported by outcome inside the CLI.
  console.error(`Command failed: ${error instanceof Error ? error.name : "unknown error"}`);
  process.exitCode = 1;
});

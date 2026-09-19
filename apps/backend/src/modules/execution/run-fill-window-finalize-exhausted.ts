import { runFillWindowFinalizeExhaustedCommand } from "./run-fill-finalize";

runFillWindowFinalizeExhaustedCommand().catch((error) => {
  // The NAME only, never the message: domain errors in this module embed the
  // bound execution profile id in their message text, and the classified
  // refusals are already reported by outcome inside the CLI.
  console.error(`Command failed: ${error instanceof Error ? error.name : "unknown error"}`);
  process.exitCode = 1;
});

import { runFillRolloutPreflightCommand } from "./run-fill-preflight";

runFillRolloutPreflightCommand().catch((error) => {
  // The NAME only, never the message: domain errors in this module embed the
  // bound execution profile id in their message text.
  console.error(`Command failed: ${error instanceof Error ? error.name : "unknown error"}`);
  process.exitCode = 1;
});

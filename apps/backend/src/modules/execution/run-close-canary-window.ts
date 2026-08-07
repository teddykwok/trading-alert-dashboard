import { closeCanaryWindow } from "./run-canary-controls";

closeCanaryWindow().catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

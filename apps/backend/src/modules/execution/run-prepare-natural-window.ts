import { prepareNaturalWindow } from "./run-canary-controls";

prepareNaturalWindow().catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

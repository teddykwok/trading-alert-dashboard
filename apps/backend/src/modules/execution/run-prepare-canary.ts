import { prepareCanary } from "./run-canary-controls";

prepareCanary().catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

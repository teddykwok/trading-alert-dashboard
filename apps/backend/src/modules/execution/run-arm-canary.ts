import { armCanary } from "./run-canary-controls";

armCanary().catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

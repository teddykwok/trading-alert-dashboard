import { armNaturalCanary } from "./run-canary-controls";

armNaturalCanary().catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

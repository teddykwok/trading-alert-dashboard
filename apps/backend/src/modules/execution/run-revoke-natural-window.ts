import { revokeNaturalWindow } from "./run-canary-controls";

revokeNaturalWindow().catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

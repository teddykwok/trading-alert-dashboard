import { disarmCanary } from "./run-canary-controls";

disarmCanary().catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

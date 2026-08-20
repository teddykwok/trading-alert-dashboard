import { showAuthorization } from "./run-canary-controls";

showAuthorization().catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

import { setPolicy } from "./run-set-policy";

setPolicy().catch((error) => {
  console.error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

import { runFillBootstrapRootsCommand } from "./run-fill-bootstrap";

runFillBootstrapRootsCommand().catch((error) => {
  // The NAME only, never the message. Three of the domain errors this command
  // can surface embed the bound execution profile id in their message text, and
  // the classified ones are already reported by reason code inside the CLI.
  console.error(`Command failed: ${error instanceof Error ? error.name : "unknown error"}`);
  process.exitCode = 1;
});

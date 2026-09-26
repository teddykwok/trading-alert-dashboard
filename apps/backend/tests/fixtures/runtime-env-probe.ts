/* eslint-disable no-console -- this file IS its own output channel. */
/**
 * Phase 11F.1 -- the child process the runtime-env isolation suite observes.
 *
 * It runs OUT OF PROCESS on purpose. The defect is about what happens during
 * module initialization, once, before anything else; a test that imported the
 * bootstrap into the vitest worker would be measuring an environment a hundred
 * other modules had already touched, and could never run the same scenario
 * twice.
 *
 * It prints presence and equality only -- never a value -- so that pointing it
 * at a real env file could not disclose one.
 */
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const mode = process.argv[2];
const order = process.argv[3];
const backend = process.argv[4];
const argument = process.argv[5];
const expectedIdentity = process.argv[6];

const IDENTITY = "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER";
const REPORTED = [
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  IDENTITY,
  "EXECUTION_PROFILE_ENVIRONMENT",
  "DATABASE_URL",
];

/** Reproduces the pre-fix import order: the generated client, first. */
if (order === "prisma-first") {
  require("@prisma/client");
}

function firstImportOf(entrypoint: string): string {
  const source = fs
    .readFileSync(entrypoint, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const match = /(?:^|\n)\s*import\s+(?:[\s\S]*?from\s*)??["']([^"']+)["']/.exec(source);
  if (match === null) throw new Error("no import found in " + entrypoint);
  return match[1];
}

/**
 * What every real entrypoint does next.
 *
 * The bootstrap's quarantine only matters because something imports the
 * generated client AFTER it -- `plugins/prisma` in the workers, `@prisma/client`
 * directly in the CLIs. A probe that stopped at the bootstrap would report a
 * clean environment even with the quarantine removed, because nothing would
 * have tried to fill it. So the probe takes the same step the real process
 * takes, and the assertions mean what they appear to mean.
 */
function loadGeneratedClientAsAnEntrypointWould(): void {
  require("@prisma/client");
}

function report(): void {
  console.log("BOOTSTRAP_COMPLETED");
  for (const key of REPORTED) {
    console.log(`${key} ${process.env[key] === undefined ? "absent" : "present"}`);
  }
  if (expectedIdentity !== undefined) {
    console.log(`IDENTITY_MATCHES_EXPECTED ${process.env[IDENTITY] === expectedIdentity}`);
  }
}

async function main(): Promise<void> {
  if (mode === "entrypoint") {
    // Require whatever THIS ENTRYPOINT imports first, resolved exactly as the
    // entrypoint would resolve it. Delete its bootstrap import and this loads
    // something else -- which is the regression the suite is looking for.
    const specifier = firstImportOf(argument);
    require(specifier.startsWith(".") ? path.resolve(path.dirname(argument), specifier) : specifier);
    loadGeneratedClientAsAnEntrypointWould();
    report();
    return;
  }

  require(path.join(backend, "src", "config", `bootstrap-${mode === "bind" ? "account" : mode}`));

  if (mode !== "bind") {
    loadGeneratedClientAsAnEntrypointWould();
    report();
    return;
  }

  // The seam every account CLI depends on: bind before anything is built.
  const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
  const binding = require(
    path.join(backend, "src", "modules", "execution", "exchange-runtime-binding")
  ) as typeof import("../../src/modules/execution/exchange-runtime-binding");
  const prisma = new PrismaClient();
  try {
    const bound = await binding.bindConfiguredExchangeRuntime(prisma);
    console.log("BOOTSTRAP_COMPLETED");
    console.log(`BIND_OK ${bound.ok}`);
    console.log(`BIND_REASON ${bound.ok ? "none" : bound.reasonCode}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(`FIXTURE_FAILED ${error instanceof Error ? error.name : "unknown"}`);
  process.exitCode = 1;
});

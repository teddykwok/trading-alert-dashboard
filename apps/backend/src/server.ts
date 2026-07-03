import { buildApp } from "./app";
import { env } from "./config/env";

async function start(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port: env.BACKEND_PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();

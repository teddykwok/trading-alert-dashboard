import { vi } from "vitest";
import { resolveTestDatabase } from "./helpers/test-database";

/**
 * `DATABASE_URL` inside the test process points at the TEST database, always.
 *
 * Production code constructs its own `new PrismaClient()` with no datasource
 * override — every operator CLI does, and so does the app — so whatever this
 * variable holds is where that code writes. Left to `dotenv`, it would hold the
 * runtime/canary connection string from `.env`, which is how synthetic
 * executions ended up in the database the canary preflight counts.
 *
 * Overwriting (not `??=`) is the point: there must be no path by which a test
 * process reaches the runtime database, including an inherited shell variable.
 *
 * When no test database is configured this deliberately becomes an unusable
 * placeholder rather than a fallback. Pure unit tests, which never open a
 * connection, keep working; any suite that actually wants a database goes
 * through `connectTestDatabase()` and gets a hard failure explaining why.
 */
try {
  process.env.DATABASE_URL = resolveTestDatabase().url;
} catch {
  process.env.DATABASE_URL = "postgresql://unconfigured:unconfigured@127.0.0.1:1/no_test_database_configured";
}
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.BACKEND_PORT ??= "4000";
process.env.FRONTEND_URL ??= "http://localhost:5173";
process.env.WEBHOOK_SECRET ??= "test-secret";
process.env.SCREENSHOT_STORAGE_DIR ??= "src/storage/screenshots";
process.env.AI_VISION_PROVIDER ??= "mock";

vi.mock("ioredis", () => {
  class FakeRedis {
    duplicate(): FakeRedis {
      return new FakeRedis();
    }
    on(): this {
      return this;
    }
    disconnect(): void {}
    quit(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { default: FakeRedis };
});

vi.mock("bullmq", () => {
  class FakeQueue {
    add = vi.fn().mockResolvedValue(undefined);
  }
  class FakeWorker {
    on(): this {
      return this;
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker };
});

vi.mock("@socket.io/redis-emitter", () => {
  class FakeEmitter {
    emit = vi.fn();
  }
  return { Emitter: FakeEmitter };
});

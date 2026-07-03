import { vi } from "vitest";

// Minimal env so config/env.ts validation passes; tests never hit a real
// Postgres/Redis instance because ioredis/bullmq/socket.io are mocked below.
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/trading_alert_dashboard_test?schema=public";
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

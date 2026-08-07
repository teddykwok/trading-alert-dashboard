import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    /**
     * Test FILES run one at a time.
     *
     * Several suites here are integration tests against a single shared
     * Postgres, and some of them legitimately operate on global state: the
     * Phase 9 notification runner drains the whole outbox by design, and the
     * Phase 8 journal counts rows across executions. Run in parallel, those
     * suites see each other's synthetic data and fail for reasons that have
     * nothing to do with the code under test.
     *
     * Serializing costs roughly twenty seconds on the full suite and buys
     * deterministic results, which is the better trade for a suite that guards
     * money-moving code.
     */
    fileParallelism: false,
  },
});

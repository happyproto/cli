import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Spawned-binary tests start real processes and servers.
    testTimeout: 30_000,
    pool: "forks",
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    include: ["src/**/*.test.ts"],
    // Several tests deliberately exercise failure paths; their expected error
    // logs would otherwise drown the reporter output.
    env: { LOG_LEVEL: "silent" },
    coverage: {
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/cli/**"],
    },
  },
});

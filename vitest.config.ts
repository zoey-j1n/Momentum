import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
    // Tests share one database, so run files one at a time. Tests inside a file already run sequentially.
    fileParallelism: false,
    testTimeout: 15_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});

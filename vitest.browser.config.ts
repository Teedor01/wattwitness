import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/browser/**/*.browser.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 180_000,
    fileParallelism: false, // each file launches its own Chromium; running them together would only add CPU contention
  },
});

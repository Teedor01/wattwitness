import { defineConfig } from "vitest/config";

// Default suite: pure Node tests (core, contract, sensing, PWA logic). The real-browser suite is separate:
// `npm run test:browser` (needs the bundled Chromium from devDependencies and takes a few minutes).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "test/browser/**"],
    testTimeout: 60_000,
  },
});

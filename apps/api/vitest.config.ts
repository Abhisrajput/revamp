import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@revamp/shared-types": resolve(__dirname, "../../packages/shared-types/dist"),
      "@revamp/core-engine": resolve(__dirname, "../../packages/core-engine/dist"),
    },
  },
});

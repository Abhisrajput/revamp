import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    headless: true,
    trace: "retain-on-failure",
  },
  reporter: [["line"]],
  timeout: 60_000,
});

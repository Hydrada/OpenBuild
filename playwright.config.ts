import { defineConfig } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), NODE_ENV: "test" },
  },
});

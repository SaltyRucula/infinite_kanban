import { defineConfig } from '@playwright/test';

const TEST_SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 3002);
const TEST_CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 4176);

export default defineConfig({
  testDir: './tests',
  testMatch: 'a2a-console.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,

  use: {
    baseURL: `http://localhost:${TEST_CLIENT_PORT}`,
    extraHTTPHeaders: { Authorization: 'Bearer e2e-full-scope-token' },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node ../../scripts/e2e-server.cjs',
      port: TEST_SERVER_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node ../../scripts/e2e-client.cjs',
      port: TEST_CLIENT_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ...process.env, E2E_A2A_FIRST_UI: 'true' },
    },
  ],
});
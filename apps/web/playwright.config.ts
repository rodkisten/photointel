import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false,
  timeout: 30_000, expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0, reporter: 'list',
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
  projects: [{ name:'iphone',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'} },
    {name:'desktop',use:{...devices['Desktop Chrome']}}],
  webServer: {
    command:'npm run dev -- --port 4173', url:'http://127.0.0.1:4173',
    reuseExistingServer:!process.env.CI,
    env:{API_PROXY_TARGET:process.env.API_PROXY_TARGET??'http://127.0.0.1:8000'},
  },
});

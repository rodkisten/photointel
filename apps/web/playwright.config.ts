import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? '4173');
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
  throw new Error('PLAYWRIGHT_WEB_PORT must be an integer between 1024 and 65535');
}
const webOrigin = `http://127.0.0.1:${webPort}`;

// Chromium's binary override and Linux flags must never leak into WebKit.
const chromiumLaunchOptions = {
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'iphone',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', launchOptions: chromiumLaunchOptions },
    },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunchOptions } },
    ...(process.env.PHOTOINTEL_TEST_WEBKIT === '1'
      ? [{ name: 'iphone-webkit', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' as const } }]
      : []),
  ],
  webServer: {
    command: `npm run dev -- --port ${webPort} --strictPort`,
    url: webOrigin,
    reuseExistingServer: !process.env.CI,
    env: { API_PROXY_TARGET: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000' },
  },
});

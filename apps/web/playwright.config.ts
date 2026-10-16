import { defineConfig, devices } from '@playwright/test';

// Chromium's binary override and Linux flags must never leak into WebKit.
const chromiumLaunchOptions = {
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
};

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false,
  timeout: 30_000, expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0, reporter: 'list',
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name:'iphone',use:{...devices['iPhone 13'],defaultBrowserType:'chromium',
      launchOptions:chromiumLaunchOptions} },
    {name:'desktop',use:{...devices['Desktop Chrome'],
      launchOptions:chromiumLaunchOptions}},
    ...(process.env.PHOTOINTEL_TEST_WEBKIT === '1'
      ? [{name:'iphone-webkit',use:{...devices['iPhone 13'],
        defaultBrowserType:'webkit' as const}}]
      : []),
  ],
  webServer: {
    command:'npm run dev -- --port 4173', url:'http://127.0.0.1:4173',
    reuseExistingServer:!process.env.CI,
    env:{API_PROXY_TARGET:process.env.API_PROXY_TARGET??'http://127.0.0.1:8000'},
  },
});

import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PORT || 8123;

// CI installs its own browser; sandboxes that ship a preinstalled Chromium can
// point at it with PLAYWRIGHT_CHROMIUM_PATH instead of downloading another.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone'],
    // The Pixel 7 viewport this app is designed against.
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: devices['Pixel 5'].userAgent,
  },
  projects: [
    {
      name: 'chromium-pixel',
      use: {
        browserName: 'chromium',
        viewport: { width: 412, height: 915 },
        hasTouch: true,
        launchOptions: {
          executablePath,
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});

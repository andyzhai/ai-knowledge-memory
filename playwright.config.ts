import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testIgnore: 'h.spec.ts',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser-results.json' }]],
  use: { headless: true, screenshot: 'only-on-failure', trace: 'off' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } },
    { name: 'chrome-stable-capture', testMatch: 'capture.spec.ts', use: { browserName: 'chromium', channel: 'chrome' } },
  ],
});

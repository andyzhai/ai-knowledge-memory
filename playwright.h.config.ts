import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', testMatch: 'h.spec.ts', outputDir: 'artifacts/h-test-results', timeout: 120_000, expect: { timeout: 15_000 }, workers: 1,
  reporter: [['list'], ['json', { outputFile: 'artifacts/h-browser-results.json' }]], use: { headless: true, screenshot: 'only-on-failure' } });

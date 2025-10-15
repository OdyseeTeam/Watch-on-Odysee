import { defineConfig } from '@playwright/test'

const TRACE_MODE = process.env.E2E_TRACE as any || 'retain-on-failure' // 'on' | 'off' | 'retain-on-failure'
const VIDEO_MODE = process.env.E2E_VIDEO as any || 'retain-on-failure' // 'on' | 'off' | 'retain-on-failure'
const SCREENSHOT_MODE = process.env.E2E_SCREENSHOT as any || 'only-on-failure' // 'on' | 'off' | 'only-on-failure'
const SLOWMO = Number(process.env.E2E_SLOWMO || 0)

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'build/playwright-report.json' }],
  ],
  use: {
    // Extensions generally require headed mode; allow override via env
    headless: process.env.E2E_HEADLESS === '1' ? true : false,
    viewport: { width: 1400, height: 900 },
    trace: TRACE_MODE,
    video: VIDEO_MODE,
    screenshot: SCREENSHOT_MODE,
    launchOptions: {
      slowMo: SLOWMO,
    },
  },
})

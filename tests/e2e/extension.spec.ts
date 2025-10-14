import { chromium, test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import child_process from 'child_process'

// This test suite uses a single persistent Chromium context to enable MV3 service worker + extension pages.
test.describe.configure({ mode: 'serial' })

let context: import('@playwright/test').BrowserContext
let page: import('@playwright/test').Page
let popupPage: import('@playwright/test').Page
let extensionId: string

const root = path.resolve(__dirname, '../../')
const distPath = path.join(root, 'dist')
const artifactsDir = path.join(root, 'build', 'e2e-artifacts')
const E2E_DEBUG = process.env.E2E_DEBUG === '1'

function ensureArtifactsDir() {
  try { fs.mkdirSync(artifactsDir, { recursive: true }) } catch {}
}

function sanitize(name: string) {
  return name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 120)
}

async function realResolve(ids: { videos?: string[], channels?: string[] }) {
  const u = new URL('https://api.odysee.com/yt/resolve')
  if (ids.videos && ids.videos.length) u.searchParams.set('video_ids', ids.videos.join(','))
  if (ids.channels && ids.channels.length) u.searchParams.set('channel_ids', ids.channels.join(','))
  const res = await fetch(u, { method: 'GET' })
  if (!res.ok) return null
  return (await res.json()) as { data?: { videos?: Record<string,string>, channels?: Record<string,string> } }
}

async function getChannelIdForVideo(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { method: 'GET' })
    if (!res.ok) return null
    const html = await res.text()
    const m = html.match(/\"channelId\"\s*:\s*\"(UC[^"]+)\"/)
    return m?.[1] || null
  } catch { return null }
}

async function getChannelIdForHandle(handle: string): Promise<string | null> {
  const url = `https://www.youtube.com/@${handle.replace(/^@/, '')}`
  try {
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) return null
    const html = await res.text()
    const m = html.match(/\"channelId\"\s*:\s*\"(UC[^"]+)\"/)
    return m?.[1] || null
  } catch { return null }
}

function buildExtension() {
  // Always build MV3 to ensure dist/ is fresh
  child_process.execSync(process.platform === 'win32' ? 'npm run build:v3' : 'npm run build:v3', {
    cwd: root,
    stdio: 'inherit',
  })
  normalizeDistHtmlPaths()
}

function normalizeDistHtmlPaths() {
  // Windows builds sometimes emit backslashes in HTML asset paths; normalize to forward slashes
  try {
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        const st = fs.statSync(p)
        if (st.isDirectory()) walk(p)
        else if (/\.html$/i.test(name)) {
          try {
            const html = fs.readFileSync(p, 'utf8')
            const fixed = html.replace(/(src|href)="([^"]*\\[^\"]*)"/g, (_m, attr, val) => `${attr}="${val.replace(/\\/g, '/')}"`)
            if (fixed !== html) fs.writeFileSync(p, fixed)
          } catch {}
        }
      }
    }
    walk(distPath)
  } catch {}
}

async function launchWithExtension() {
  // Launch persistent context so MV3 service worker is available
  const userDataDir = path.join(root, '.pw-chromium-profile')
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}

  // Verify built extension exists
  const manifestJson = path.join(distPath, 'manifest.json')
  if (!fs.existsSync(distPath) || !fs.existsSync(manifestJson)) {
    throw new Error(`Built extension not found in dist/. Ensure build succeeded. Missing: ${manifestJson}`)
  }

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: process.env.E2E_HEADLESS === '1' ? true : false,
      args: [
        `--disable-extensions-except=${distPath}`,
        `--load-extension=${distPath}`,
        '--no-default-browser-check',
        '--no-first-run',
      ],
    })
  } catch (err: any) {
    const help = [
      'Failed to launch Chromium with extension.',
      '- Ensure Playwright browsers are installed: npm run test:e2e:install',
      '- On CI or headless environments, extensions require headed mode (E2E_HEADLESS=0).',
      `- Dist exists: ${fs.existsSync(distPath)} ; manifest: ${fs.existsSync(manifestJson)}`,
      `Original error: ${err?.message || err}`,
    ].join('\n')
    throw new Error(help)
  }

  // Create a page so service worker initializes as soon as a tab is present
  page = await context.newPage()
  if (E2E_DEBUG) hookPageDebug(page, 'YT')

  // Wait for MV3 service worker and extract extension ID from its URL
  const sw = await waitForServiceWorker(context)
  const m = sw.url().match(/^chrome-extension:\/\/([a-p]{32})\//)
  if (!m) throw new Error(`Could not determine extension ID from service worker URL: ${sw.url()}`)
  extensionId = m[1]

  // Prepare persistent popup page for toggles without disrupting the test page
  popupPage = await context.newPage()
  await popupPage.goto(`chrome-extension://${extensionId}/pages/popup/index.html`)
  if (E2E_DEBUG) hookPageDebug(popupPage, 'POPUP')
}

async function waitForServiceWorker(ctx: import('@playwright/test').BrowserContext) {
  // Fast path
  const existing = ctx.serviceWorkers()
  if (existing.length) return existing[0]
  // Try Playwright event with timeout
  try {
    const w = await ctx.waitForEvent('serviceworker', { timeout: 20000 })
    if (w.url().startsWith('chrome-extension://')) return w
  } catch {}
  // Fallback: poll a few times; MV3 workers can start lazily
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    const workers = ctx.serviceWorkers()
    const ext = workers.find(w => w.url().startsWith('chrome-extension://'))
    if (ext) return ext
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('Timed out waiting for MV3 service worker to register')
}

// Optional stub for Odysee resolve API. Enable with E2E_USE_STUBS=1
async function enableApiStub() {
  if (process.env.E2E_USE_STUBS !== '1') return
  await context.route((u) => {
    try {
      const url = new URL(u)
      return url.hostname.includes('api.odysee.com') && /\/resolve\b/.test(url.pathname)
    } catch { return false }
  }, async (route) => {
    const url = new URL(route.request().url())
    const vids = (url.searchParams.get('video_ids') || '').split(',').filter(Boolean)
    const chans = (url.searchParams.get('channel_ids') || '').split(',').filter(Boolean)
    const videos: Record<string, string> = {}
    const channels: Record<string, string> = {}
    for (const v of vids) videos[v] = `e2e-video-${v}:abc`
    for (const c of chans) channels[c] = `@e2e-channel-${c}:xyz`
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { videos, channels } }),
    })
  })
}

async function dismissYouTubeConsentIfPresent(p: import('@playwright/test').Page) {
  try {
    const consentBtn = p.locator('button:has-text("I agree"), button:has-text("Accept all"), button:has-text("Accept")').first()
    if (await consentBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await consentBtn.click({ trial: false })
    }
  } catch {}
}

async function dismissYouTubeOverlays(p: import('@playwright/test').Page) {
  // Dismiss common promotions/popovers that can obscure the player controls
  const candidates = [
    'button:has-text("Dismiss")',
    'button:has-text("No thanks")',
    'button:has-text("Not now")',
    'tp-yt-paper-button:has-text("Dismiss")',
  ]
  for (const sel of candidates) {
    try {
      const b = p.locator(sel).first()
      if (await b.isVisible({ timeout: 500 }).catch(() => false)) {
        await b.click({ trial: false }).catch(() => {})
      }
    } catch {}
  }
}

async function revealPlayerControls(p: import('@playwright/test').Page) {
  // Move mouse over the video element to make controls appear
  try {
    const video = p.locator('ytd-player video, #movie_player video').first()
    const box = await video.boundingBox()
    if (box) {
      await p.mouse.move(box.x + box.width / 2, box.y + 10)
    }
  } catch {}
  // Also try a quick play/pause toggle to reveal bar
  try { await p.keyboard.press('k') } catch {}
  // Wait for the control bar to be visible
  await p.waitForFunction(() => {
    const bar = document.querySelector('.ytp-chrome-bottom') as HTMLElement | null
    if (!bar) return false
    const style = getComputedStyle(bar)
    return style.opacity !== '0' && style.visibility !== 'hidden'
  }, { timeout: 10000 }).catch(() => {})
}

function hookPageDebug(p: import('@playwright/test').Page, tag: string) {
  p.on('console', (msg) => {
    try { console.log(`[${tag}][${msg.type()}]`, msg.text()) } catch {}
  })
  p.on('pageerror', (err) => {
    try { console.error(`[${tag}][pageerror]`, err) } catch {}
  })
  p.on('requestfailed', (req) => {
    try { console.warn(`[${tag}][requestfailed]`, req.url(), req.failure()?.errorText) } catch {}
  })
}

async function attachPlayerDebug(p: import('@playwright/test').Page, name: string) {
  ensureArtifactsDir()
  const info = await p.evaluate(() => {
    const q = (s: string) => Array.from(document.querySelectorAll(s)).length
    const bar = document.querySelector('.ytp-chrome-bottom') as HTMLElement | null
    const barVisible = !!bar && getComputedStyle(bar).opacity !== '0' && getComputedStyle(bar).visibility !== 'hidden'
    return {
      url: location.href,
      counts: {
        ctrlBtnTitle: q('.ytp-chrome-bottom .ytp-button[title^="Watch on "]'),
        ctrlBtnAria: q('.ytp-chrome-bottom .ytp-button[aria-label^="Watch on "]'),
        anchorHrefYtd: q('ytd-player a[role="button"][href^="https://odysee.com/"]'),
        anchorHrefMovie: q('#movie_player a[role="button"][href^="https://odysee.com/"]'),
      },
      barVisible,
    }
  })
  const json = Buffer.from(JSON.stringify(info, null, 2))
  await test.info().attach(`${name}.json`, { body: json, contentType: 'application/json' })
  const img = await p.screenshot()
  await test.info().attach(`${name}.png`, { body: img, contentType: 'image/png' })
  try { require('fs').writeFileSync(require('path').join(artifactsDir, `${name}.json`), json) } catch {}
  try { require('fs').writeFileSync(require('path').join(artifactsDir, `${name}.png`), img) } catch {}
}

const ToggleKey: Record<string, string> = {
  'Playing a video': 'redirectVideo',
  'Viewing a channel': 'redirectChannel',
  'Videos': 'buttonVideoSub',
  'Channels': 'buttonChannelSub',
  'Video Player': 'buttonVideoPlayer',
  'Video Previews': 'buttonOverlay',
  'Apply selections to Search Results': 'resultsApplySelections',
}

const ToggleDefault: Record<string, boolean> = {
  redirectVideo: true,
  redirectChannel: false,
  buttonVideoSub: true,
  buttonChannelSub: true,
  buttonVideoPlayer: true,
  buttonOverlay: true,
  resultsApplySelections: true,
}

async function ensurePopupToggle(label: keyof typeof ToggleKey, desiredActive: boolean) {
  // Support both <a class="button"> and <button class="button">
  const toggle = popupPage.locator(`text=${label}`).locator('..').locator('a.button, button.button')
  await expect(toggle).toBeVisible()
  const cls = (await toggle.getAttribute('class')) || ''
  const isActive = cls.includes('active')
  if (isActive !== desiredActive) {
    await toggle.click()
    const key = ToggleKey[label]
    const def = ToggleDefault[key]
    await popupPage.waitForFunction((k, expected, defVal) => new Promise<boolean>(resolve => chrome.storage.local.get(k, s => {
      const v = (s as any)[k]
      resolve(((v === undefined ? defVal : v) as boolean) === expected)
    })), key, desiredActive, def)
  }
}

test.beforeAll(async () => {
  // Build and bootstrap
  if (!fs.existsSync(distPath) || !fs.existsSync(path.join(distPath, 'manifest.v3.json'))) {
    buildExtension()
  } else {
    // Rebuild to ensure TS changes are included
    buildExtension()
  }
  await launchWithExtension()
  await enableApiStub()
  // Ensure good baseline: toggles on and resolver cache cleared
  try {
    await ensurePopupToggle('Videos', true)
    await ensurePopupToggle('Channels', true)
    const clearBtn = popupPage.locator('text=Clear Resolver Cache').first()
    if (await clearBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await clearBtn.click()
    }
  } catch {}
})

// Keep redirects off by default to avoid interfering with inline/button tests
test.beforeEach(async () => {
  try {
    await ensurePopupToggle('Playing a video', false)
    await ensurePopupToggle('Viewing a channel', false)
  } catch {}
})

test.afterAll(async () => {
  await context?.close()
})

test('popup toggles update storage', async () => {
  const popupUrl = `chrome-extension://${extensionId}/pages/popup/index.html`
  await popupPage.goto(popupUrl)

  // Ensure popup script executed and DOM is present (retry once if needed)
  const ensurePopupReady = async () => {
    const hdr = popupPage.locator('#popup header h1')
    try {
      await popupPage.waitForSelector('#popup header h1', { timeout: 15000 })
    } catch {
      // If script didn’t load due to path quirks, reload once
      await popupPage.reload({ waitUntil: 'domcontentloaded' })
      await popupPage.waitForSelector('#popup header h1', { timeout: 15000 })
    }
    await expect(hdr).toHaveText('Watch on Odysee')
  }
  await ensurePopupReady()

  // Determine effective initial state based on UI (accounts for defaults when key is unset)
  const overlayToggle = popupPage.locator('text=Video Previews').locator('..').locator('a.button, button.button')
  const initialActive = ((await overlayToggle.getAttribute('class')) || '').includes('active')

  // Toggle Video Previews and wait for both storage and UI to reflect the flip
  await overlayToggle.click()
  const expected = !initialActive
  await popupPage.waitForFunction((expected) => new Promise<boolean>(resolve => chrome.storage.local.get('buttonOverlay', s => resolve((s.buttonOverlay ?? true) === expected))), expected)
  await expect(overlayToggle).toHaveClass(new RegExp(expected ? '\\bactive\\b' : '(?!.*\\bactive\\b)'))
  // Attach popup screenshot
  ensureArtifactsDir()
  const buf = await popupPage.screenshot()
  await test.info().attach('popup.png', { body: buf, contentType: 'image/png' })
  const pth = path.join(artifactsDir, 'popup_after_toggle.png')
  try { fs.writeFileSync(pth, buf) } catch {}
})

test('injects subscribe area buttons on watch page with stubbed mapping', async () => {
  // Use WhiteHouse video to ensure available content
  const watchUrl = 'https://www.youtube.com/watch?v=qn2K3UyIsEo'
  // If running against real API and this video (or its channel) is not mirrored on Odysee, skip gracefully
  if (process.env.E2E_USE_STUBS !== '1') {
    const vid = 'qn2K3UyIsEo'
    const ch = await getChannelIdForVideo(vid)
    const res = await realResolve({ videos: [vid], channels: ch ? [ch] : [] })
    const hasVid = !!res?.data?.videos?.[vid]
    const hasCh = ch ? !!res?.data?.channels?.[ch] : false
    if (!hasVid && !hasCh) test.skip(true, 'Real API returned no mapping for video or channel; skipping injection assertion')
  }
  await page.goto(watchUrl, { waitUntil: 'domcontentloaded' })
  await dismissYouTubeConsentIfPresent(page)

  // Wait for our inline buttons near Subscribe
  const inlineBtn = page.locator('a[role="button"][href^="https://odysee.com/"]').first()
  await expect(inlineBtn).toBeVisible({ timeout: 45_000 })

  // Pixel-precise snapshot of the button only (reduces flakiness)
  await expect(inlineBtn).toHaveScreenshot('watch-inline-button.png', {
    // Slightly relax threshold to accommodate minor platform font/rendering differences
    maxDiffPixelRatio: 0.05,
  })
  // Full page screenshot for report
  ensureArtifactsDir()
  const pg = await page.screenshot({ fullPage: true })
  await test.info().attach('watch_page.png', { body: pg, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'watch_page.png'), pg)
})

test('player control button appears on watch page', async () => {
  if (process.env.E2E_USE_STUBS !== '1') {
    const vid = 'qn2K3UyIsEo'
    const ch = await getChannelIdForVideo(vid)
    const res = await realResolve({ videos: [vid], channels: ch ? [ch] : [] })
    const hasVid = !!res?.data?.videos?.[vid]
    const hasCh = ch ? !!res?.data?.channels?.[ch] : false
    if (!hasVid && !hasCh) test.skip(true, 'Real API: no mapping for video/channel; skipping control button assert')
  }
  // YouTube player control button with ytp-button class, title begins with Watch on
  // Navigate (ensure we are on the correct watch page)
  if (!page.url().includes('/watch?v=qn2K3UyIsEo')) {
    await page.goto('https://www.youtube.com/watch?v=qn2K3UyIsEo', { waitUntil: 'domcontentloaded' })
    await dismissYouTubeConsentIfPresent(page)
  }
  await dismissYouTubeOverlays(page)
  await revealPlayerControls(page)
  if (E2E_DEBUG) await attachPlayerDebug(page, 'player_before_assert')
  // Wait for any of the possible placements (controls area or in-player anchor)
  const anyBtnSel = [
    // Anywhere in the chrome bottom (covers sibling vs descendant placements)
    '.ytp-chrome-bottom .ytp-button[title^="Watch on "]',
    '.ytp-chrome-bottom .ytp-button[aria-label^="Watch on "]',
    // Fallback anchor inside player wrapper
    'ytd-player a[role="button"][href^="https://odysee.com/"]',
    '#movie_player a[role="button"][href^="https://odysee.com/"]',
  ].join(', ')
  await page.waitForFunction((sel) => !!document.querySelector(sel), anyBtnSel, { timeout: 60_000 })
  const anyBtn = page.locator(anyBtnSel).first()
  await expect(anyBtn).toBeVisible({ timeout: 10_000 })
  if (E2E_DEBUG) await attachPlayerDebug(page, 'player_after_assert')
  ensureArtifactsDir()
  const buf = await page.screenshot()
  await test.info().attach('player_ctrl.png', { body: buf, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'player_ctrl.png'), buf)
})

test('inline button matches Subscribe height (layout sanity)', async () => {
  // Ensure we are on a watch page
  if (!page.url().includes('/watch')) {
    await page.goto('https://www.youtube.com/watch?v=qn2K3UyIsEo', { waitUntil: 'domcontentloaded' })
  }
  await dismissYouTubeConsentIfPresent(page)
  // Find the inline button near the Subscribe area (not inside player controls)
  const candidateSelectors = [
    'div[data-wol-channel-action="1"] a[role="button"][href^="https://odysee.com/"]',
    '#owner a[role="button"][href^="https://odysee.com/"]',
    'ytd-watch-metadata a[role="button"][href^="https://odysee.com/"]',
  ]
  let inlineBtn = page.locator(candidateSelectors.join(', ')).filter({ hasNot: page.locator('#movie_player, .ytp-chrome-bottom') }).first()
  // Wait up to 45s for heavy layouts to settle
  await expect(inlineBtn).toBeVisible({ timeout: 45_000 })

  // Subscribe button anchor (one of several possible selectors); try a few
  const subscribe = page.locator([
    '#owner #subscribe-button',
    'ytd-subscribe-button-renderer#subscribe-button',
    'yt-flexible-actions-view-model yt-subscribe-button-view-model',
  ].join(', ')).first()
  await expect(subscribe).toBeVisible({ timeout: 45_000 })
  // Prefer an actual inner control for height (button or anchor) when present
  const subscribeInner = subscribe.locator('button, a, yt-button-shape button, yt-button-shape a').first()
  const subRef = (await subscribeInner.count()) ? subscribeInner : subscribe

  const [b1, b2] = await Promise.all([
    inlineBtn.boundingBox(),
    subRef.boundingBox(),
  ])
  expect(b1).toBeTruthy()
  expect(b2).toBeTruthy()
  const h1 = Math.round(b1!.height)
  const h2 = Math.round(b2!.height)
  // Allow a small tolerance due to platform/font differences and padding rounding
  // Increased from 6 → 10 to account for recent YouTube subscribe control sizing variations
  expect(Math.abs(h1 - h2)).toBeLessThanOrEqual(10)
  await test.info().attach('layout.json', { body: Buffer.from(JSON.stringify({ watchBtnHeight: h1, subscribeHeight: h2 })), contentType: 'application/json' })
  ensureArtifactsDir()
  fs.writeFileSync(path.join(artifactsDir, 'layout.json'), JSON.stringify({ watchBtnHeight: h1, subscribeHeight: h2 }, null, 2))
  const buf = await page.screenshot()
  await test.info().attach('layout.png', { body: buf, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'layout.png'), buf)
})

test('results page: inline Watch/Channel pills toggle without refresh', async () => {
  // Ensure buttons for Videos and Channels are enabled
  await ensurePopupToggle('Videos', true)
  await ensurePopupToggle('Channels', true)

  await page.goto('https://www.youtube.com/results?search_query=the+White+House')
  await dismissYouTubeConsentIfPresent(page)

  const watchPills = page.locator('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch]')
  const channelPills = page.locator('a[data-wol-inline-channel], [data-wol-results-channel-btn]')

  // Wait for any Watch or Channel pill to appear on results
  await expect(watchPills.or(channelPills).first()).toBeVisible({ timeout: 60_000 })

  ensureArtifactsDir()
  const withInline = await page.screenshot({ fullPage: true })
  await test.info().attach('results_with_inline.png', { body: withInline, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'results_with_inline.png'), withInline)

  // Toggle Videos off -> Watch pills disappear
  await ensurePopupToggle('Videos', false)
  await expect(page.locator('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch]')).toHaveCount(0, { timeout: 30_000 })

  // Toggle Channels off -> Channel pills disappear
  await ensurePopupToggle('Channels', false)
  await expect(page.locator('a[data-wol-inline-channel], [data-wol-results-channel-btn]')).toHaveCount(0, { timeout: 30_000 })

  const noInline = await page.screenshot({ fullPage: true })
  await test.info().attach('results_without_inline.png', { body: noInline, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'results_without_inline.png'), noInline)

  // Re-enable for subsequent tests
  await ensurePopupToggle('Videos', true)
  await ensurePopupToggle('Channels', true)
})

test('results page: master switch hides all pills regardless of Videos/Channels', async () => {
  // Ensure Videos and Channels are enabled
  await ensurePopupToggle('Videos', true)
  await ensurePopupToggle('Channels', true)

  await page.goto('https://www.youtube.com/results?search_query=the+White+House')
  await dismissYouTubeConsentIfPresent(page)

  // Wait for any pill to appear first
  const anyPill = page.locator('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch], a[data-wol-inline-channel], [data-wol-results-channel-btn]')
  await expect(anyPill.first()).toBeVisible({ timeout: 60_000 })

  // Open popup and toggle master switch OFF via popup
  await ensurePopupToggle('Apply selections to Search Results', false)

  // All pills should disappear
  await expect(anyPill).toHaveCount(0)

  // Flip it back ON and ensure some pill re-appears
  await ensurePopupToggle('Apply selections to Search Results', true)
  await expect(anyPill.first()).toBeVisible({ timeout: 60_000 })
})

test('redirects to Odysee when redirectVideo is enabled', async () => {
  // Pre-check with real API to avoid false negatives when not mirrored
  if (process.env.E2E_USE_STUBS !== '1') {
    const vid = 'qn2K3UyIsEo'
    const ch = await getChannelIdForVideo(vid)
    const res = await realResolve({ videos: [vid], channels: ch ? [ch] : [] })
    const hasVid = !!res?.data?.videos?.[vid]
    const hasCh = ch ? !!res?.data?.channels?.[ch] : false
    if (!hasVid && !hasCh) test.skip(true, 'Real API: no mapping for video/channel; skipping redirect assert')
  }
  // Enable redirectVideo, then navigate and wait for new tab to open on Odysee
  await ensurePopupToggle('Playing a video', true)
  const newPagePromise = context.waitForEvent('page')
  await page.goto('https://www.youtube.com/watch?v=qn2K3UyIsEo')
  await dismissYouTubeConsentIfPresent(page)
  const odyPage = await newPagePromise
  await odyPage.waitForURL(/https:\/\/odysee\.com\//, { timeout: 45000 })
  ensureArtifactsDir()
  const buf = await odyPage.screenshot()
  await test.info().attach('redirected_video.png', { body: buf, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'redirected_video.png'), buf)
  // Turn off again for subsequent tests
  await ensurePopupToggle('Playing a video', false)
})

test('redirects to Odysee when redirectChannel is enabled', async () => {
  // Pre-check with real API for @WhiteHouse channel
  if (process.env.E2E_USE_STUBS !== '1') {
    const chId = await getChannelIdForHandle('WhiteHouse')
    if (!chId) test.skip(true, 'Cannot resolve channel id for @WhiteHouse')
    const res = await realResolve({ channels: [chId!] })
    if (!res?.data?.channels?.[chId!]) test.skip(true, 'Real API: channel not mirrored on Odysee; skipping')
  }
  await ensurePopupToggle('Viewing a channel', true)
  const newPagePromise = context.waitForEvent('page')
  await page.goto('https://www.youtube.com/@WhiteHouse')
  await dismissYouTubeConsentIfPresent(page)
  const odyPage = await newPagePromise
  await odyPage.waitForURL(/https:\/\/odysee\.com\//, { timeout: 45000 })
  ensureArtifactsDir()
  const buf = await odyPage.screenshot()
  await test.info().attach('redirected_channel.png', { body: buf, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'redirected_channel.png'), buf)
  // Turn off again for subsequent tests
  await ensurePopupToggle('Viewing a channel', false)
})

test('video/channel button visibility follows settings', async () => {
  // Disable both
  await ensurePopupToggle('Videos', false)
  await ensurePopupToggle('Channels', false)

  // Back to watch page: expect no inline Watch/Channel buttons
  await page.goto('https://www.youtube.com/watch?v=qn2K3UyIsEo')
  // Scope to subscribe/owner header to avoid picking the in-player anchor
  const ownerBtns = page.locator('#owner a[role="button"][href^="https://odysee.com/"]').filter({ hasNotText: ' ' })
  await expect(page.locator('ytd-watch-metadata a[role="button"][href^="https://odysee.com/"]')).toHaveCount(0)

  // Re-enable video button; expect it to appear
  await ensurePopupToggle('Videos', true)
  const ownerWatch = page.locator('ytd-watch-metadata a[role="button"][href^="https://odysee.com/"]').filter({ hasText: 'Watch' }).first()
  await expect(ownerWatch).toBeVisible()

  // Re-enable channel button; expect a second button without page refresh
  await ensurePopupToggle('Channels', true)
  const ownerChannel = page.locator('ytd-watch-metadata a[role="button"][href^="https://odysee.com/"]').filter({ hasText: 'Channel' }).first()
  await expect(ownerChannel).toBeVisible()
  await expect(page.locator('ytd-watch-metadata a[role="button"][href^="https://odysee.com/"]')).toHaveCount(2)
  ensureArtifactsDir()
  const buf = await page.screenshot()
  await test.info().attach('watch_buttons_2.png', { body: buf, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'watch_buttons_2.png'), buf)
})

test('player control button toggles without refresh', async () => {
  if (process.env.E2E_USE_STUBS !== '1') {
    const vid = 'qn2K3UyIsEo'
    const ch = await getChannelIdForVideo(vid)
    const res = await realResolve({ videos: [vid], channels: ch ? [ch] : [] })
    const hasVid = !!res?.data?.videos?.[vid]
    const hasCh = ch ? !!res?.data?.channels?.[ch] : false
    if (!hasVid && !hasCh) test.skip(true, 'Real API: no mapping for video/channel; skipping control toggle assert')
  }
  // Ensure we are on watch page
  if (!page.url().includes('/watch')) {
    await page.goto('https://www.youtube.com/watch?v=qn2K3UyIsEo')
    await dismissYouTubeConsentIfPresent(page)
  }
  await dismissYouTubeOverlays(page)
  await revealPlayerControls(page)
  // Turn off
  await ensurePopupToggle('Video Player', false)
  const ctrlBtn = page.locator('.ytp-chrome-bottom .ytp-button[title^="Watch on "], .ytp-chrome-bottom .ytp-button[aria-label^="Watch on "]').first()
  await expect(ctrlBtn).toHaveCount(0)
  // Turn on
  await ensurePopupToggle('Video Player', true)
  await revealPlayerControls(page)
  const anyBtnSel = [
    '.ytp-chrome-bottom .ytp-button[title^="Watch on "]',
    '.ytp-chrome-bottom .ytp-button[aria-label^="Watch on "]',
    'ytd-player a[role="button"][href^="https://odysee.com/"]',
    '#movie_player a[role="button"][href^="https://odysee.com/"]',
  ].join(', ')
  await page.waitForFunction((sel) => !!document.querySelector(sel), anyBtnSel, { timeout: 60_000 })
  const anyBtn = page.locator(anyBtnSel).first()
  await expect(anyBtn).toBeVisible({ timeout: 10_000 })
})

test('watch page buttons toggle on/off without refresh', async () => {
  if (process.env.E2E_USE_STUBS !== '1') {
    const vid = 'qn2K3UyIsEo'
    const ch = await getChannelIdForVideo(vid)
    const res = await realResolve({ videos: [vid], channels: ch ? [ch] : [] })
    const hasVid = !!res?.data?.videos?.[vid]
    const hasCh = ch ? !!res?.data?.channels?.[ch] : false
    if (!hasVid && !hasCh) test.skip(true, 'Real API: no mapping for video/channel; skipping subscribe-area toggle assert')
  }
  await page.goto('https://www.youtube.com/watch?v=qn2K3UyIsEo')
  await dismissYouTubeConsentIfPresent(page)

  // Ensure both off
  await ensurePopupToggle('Videos', false)
  await ensurePopupToggle('Channels', false)
  await expect(page.locator('#owner a[role="button"][href^="https://odysee.com/"]')).toHaveCount(0)

  // Turn on Videos -> expect a Watch button
  await ensurePopupToggle('Videos', true)
  const watchBtn = page.locator('ytd-watch-metadata a[role="button"][href^="https://odysee.com/"] >> text=Watch').first()
  await expect(watchBtn).toBeVisible({ timeout: 30_000 })

  // Turn on Channels -> expect a Channel button; total 2
  await ensurePopupToggle('Channels', true)
  const channelBtn = page.locator('ytd-watch-metadata a[role="button"][href^="https://odysee.com/"] >> text=Channel').first()
  await expect(channelBtn).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('ytd-watch-metadata a[role="button"][href^="https://odysee.com/"]')).toHaveCount(2)
  const buf2 = await page.screenshot()
  await test.info().attach('watch_buttons_toggle_on.png', { body: buf2, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'watch_buttons_toggle_on.png'), buf2)

  // Turn off Videos -> Watch button disappears, Channel remains
  await ensurePopupToggle('Videos', false)
  await expect(watchBtn).toHaveCount(0)
  await expect(channelBtn).toBeVisible()

  // Turn off Channels -> Channel button disappears
  await ensurePopupToggle('Channels', false)
  await expect(channelBtn).toHaveCount(0)
  const buf3 = await page.screenshot()
  await test.info().attach('watch_buttons_toggle_off.png', { body: buf3, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'watch_buttons_toggle_off.png'), buf3)
})

test('shorts page: buttons toggle without refresh (specific ID)', async () => {
  if (process.env.E2E_USE_STUBS !== '1') {
    const vid = 'eiXDYyIT8WU'
    const res = await realResolve({ videos: [vid] })
    const hasVid = !!res?.data?.videos?.[vid]
    if (!hasVid) test.skip(true, 'Real API: no mapping for provided Shorts; skipping buttons assert')
  }
  // Directly open the provided Shorts ID
  await page.goto('https://www.youtube.com/shorts/eiXDYyIT8WU')
  await dismissYouTubeConsentIfPresent(page)
  const overlay = page.locator('ytd-reel-player-overlay-renderer')
  await expect(overlay).toBeVisible({ timeout: 60_000 })

  // Ensure off
  await ensurePopupToggle('Videos', false)
  await ensurePopupToggle('Channels', false)
  await expect(overlay.locator('a[role="button"][href^="https://odysee.com/"]')).toHaveCount(0)

  // Enable Videos -> expect Watch button in overlay actions
  await ensurePopupToggle('Video Player', true)
  // Accept either the inline Watch pill in overlay, or the player control button anchored to the video
  const shortsWatchAnchor = overlay.locator('a[role="button"][href^="https://odysee.com/"] >> text=Watch').first()
  const shortsPlayerBtn = page.locator('#player-container .ytp-button[title^="Watch on "], .ytp-chrome-bottom .ytp-button[title^="Watch on "]').first()
  await expect(shortsWatchAnchor.or(shortsPlayerBtn)).toBeVisible({ timeout: 30_000 })
  ensureArtifactsDir()
  const shortsOn = await page.screenshot()
  await test.info().attach('shorts_buttons_on.png', { body: shortsOn, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'shorts_buttons_on.png'), shortsOn)

  // Enable Channels -> expect Channel button near channel name or overlay
  await ensurePopupToggle('Channels', true)
  await expect(overlay.locator('a[role="button"][href^="https://odysee.com/"] >> text=Channel').first()).toBeVisible({ timeout: 30_000 })

  // Turn both off -> both disappear
  await ensurePopupToggle('Videos', false)
  await ensurePopupToggle('Channels', false)
  await expect(overlay.locator('a[role="button"][href^="https://odysee.com/"]')).toHaveCount(0)
  const shortsOff = await page.screenshot()
  await test.info().attach('shorts_buttons_off.png', { body: shortsOff, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'shorts_buttons_off.png'), shortsOff)
})

test('channel pages: buttons across tabs and toggle without refresh', async () => {
  const base = 'https://www.youtube.com/@WhiteHouse'
  if (process.env.E2E_USE_STUBS !== '1') {
    const chId = await getChannelIdForHandle('WhiteHouse')
    if (chId) {
      const res = await realResolve({ channels: [chId] })
      const hasCh = !!res?.data?.channels?.[chId]
      if (!hasCh) test.skip(true, 'Real API: channel not mirrored on Odysee; skipping channel button assert')
    } else {
      test.skip(true, 'Could not resolve channel id for @WhiteHouse; skipping')
    }
  }
  const paths = ['', '/videos', '/shorts', '/live']

  // Ensure channel buttons enabled
  await ensurePopupToggle('Channels', true)

  for (const p of paths) {
    await page.goto(base + p)
    await dismissYouTubeConsentIfPresent(page)
    // Subscribe area wrapper varies by layout; skip strict visibility requirement and assert our button directly
    // Expect Channel button near subscribe area or action wrapper
    const channelBtn = page.locator('a[role="button"][href^="https://odysee.com/"] >> text=Channel').first()
    await expect(channelBtn).toBeVisible({ timeout: 45_000 })
    ensureArtifactsDir()
    const buf = await page.screenshot({ fullPage: true })
    await test.info().attach(`channel_tab_${sanitize(p || 'root')}.png`, { body: buf, contentType: 'image/png' })
    fs.writeFileSync(path.join(artifactsDir, `channel_tab_${sanitize(p || 'root')}.png`), buf)
  }

  // Now on /videos, toggle off and ensure removal without refresh
  await page.goto(base + '/videos')
  const channelBtn = page.locator('a[role="button"][href^="https://odysee.com/"] >> text=Channel').first()
  await expect(channelBtn).toBeVisible({ timeout: 45_000 })
  await ensurePopupToggle('Channels', false)
  await expect(channelBtn).toHaveCount(0)
  const chOff = await page.screenshot({ fullPage: true })
  await test.info().attach('channel_buttons_off.png', { body: chOff, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'channel_buttons_off.png'), chOff)
})

test('results page: channel renderer button and chips appear (stubbed)', async () => {
  // Run this assertion only when stubs are enabled to avoid network/content flakiness
  test.skip(process.env.E2E_USE_STUBS !== '1', 'Skip CR/chip assertions without stubs')
  // Prefer running with stubs to avoid flakiness; skip deep href assertion if not stubbed
  const search = 'the white house'
  await page.goto('https://www.youtube.com/results?search_query=' + encodeURIComponent(search), { waitUntil: 'domcontentloaded' })
  await dismissYouTubeConsentIfPresent(page)

  // Prefer channel renderer button when present, but do not hard-fail if YouTube omits CR in this query
  const channelBtn = page.locator('ytd-channel-renderer [data-wol-results-channel-btn] a[href^="https://odysee.com/"]')
  try {
    await expect(channelBtn.first()).toBeVisible({ timeout: 45_000 })
  } catch {}

  // Expect at least one inline channel chip in video renderers
  const chip = page.locator('ytd-video-renderer a[data-wol-inline-channel]')
  await expect(chip.first()).toBeVisible({ timeout: 45_000 })

  // With stubs, href should contain @e2e-channel-<UC>:xyz for the WhiteHouse UC
  if (process.env.E2E_USE_STUBS === '1') {
    const uc = await getChannelIdForHandle('WhiteHouse')
    test.skip(!uc, 'Unable to resolve UC for @WhiteHouse; skip href assertion')
    await expect(chip.first()).toHaveAttribute('href', new RegExp(`@e2e-channel-${uc}:`))
  }

  ensureArtifactsDir()
  const buf = await page.screenshot({ fullPage: true })
  await test.info().attach('results_whitehouse.png', { body: buf, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'results_whitehouse.png'), buf)
})

test('results SPA navigation switches chips to new channel (stubbed)', async () => {
  test.skip(process.env.E2E_USE_STUBS !== '1', 'Skip SPA chips assertion without stubs')
  // Navigate between two searches and assert chips reflect the last query
  const q1 = 'the white house'
  const q2 = 'veritasium'
  await page.goto('https://www.youtube.com/results?search_query=' + encodeURIComponent(q1), { waitUntil: 'domcontentloaded' })
  await dismissYouTubeConsentIfPresent(page)
  await page.waitForSelector('ytd-video-renderer')

  // Move to q2 (SPA nav)
  await page.goto('https://www.youtube.com/results?search_query=' + encodeURIComponent(q2), { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('ytd-video-renderer')

  const chips = page.locator('ytd-video-renderer a[data-wol-inline-channel]')
  await expect(chips.first()).toBeVisible({ timeout: 45_000 })

  if (process.env.E2E_USE_STUBS === '1') {
    const uc2 = await getChannelIdForHandle('veritasium')
    test.skip(!uc2, 'Unable to resolve UC for @veritasium; skip href assertion')
    // At least one chip href should target the stubbed veritasium UC mapping
    await expect(chips.first()).toHaveAttribute('href', new RegExp(`@e2e-channel-${uc2}:`))
  }

  // Sanity: no renderer should contain more than one chip
  const rendererCount = await page.locator('ytd-video-renderer').count()
  const sample = Math.min(rendererCount, 8)
  for (let i = 0; i < sample; i++) {
    const r = page.locator('ytd-video-renderer').nth(i)
    await expect(r.locator('a[data-wol-inline-channel]')).toHaveCount(1)
  }

  ensureArtifactsDir()
  const buf = await page.screenshot({ fullPage: true })
  await test.info().attach('results_veritasium.png', { body: buf, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'results_veritasium.png'), buf)
})

// Known channels that typically have Odysee mirrors
const KNOWN_CHANNEL_HANDLES = ['WhiteHouse', 'veritasium', 'DistroTube', 'OregonPacifist'] as const

for (const handle of KNOWN_CHANNEL_HANDLES) {
  test(`channel page button visible for @${handle}`, async () => {
    const url = `https://www.youtube.com/@${handle}`
    if (process.env.E2E_USE_STUBS !== '1') {
      const chId = await getChannelIdForHandle(handle)
      if (chId) {
        const res = await realResolve({ channels: [chId] })
        const hasCh = !!res?.data?.channels?.[chId]
        test.skip(!hasCh, `Real API: @${handle} not mirrored on Odysee; skipping`)
      } else {
        test.skip(true, `Could not resolve channel id for @${handle}; skipping`)
      }
    }
    await page.goto(url)
    await dismissYouTubeConsentIfPresent(page)
    const subArea = page.locator('#subscribe-button, ytd-subscribe-button-renderer#subscribe-button').first()
    await expect(subArea).toBeVisible({ timeout: 60_000 })
    const channelBtn = page.locator('a[role="button"][href^="https://odysee.com/"] >> text=Channel').first()
    await expect(channelBtn).toBeVisible({ timeout: 45_000 })
    ensureArtifactsDir()
    const buf = await page.screenshot({ fullPage: true })
    await test.info().attach(`channel_${handle}.png`, { body: buf, contentType: 'image/png' })
    fs.writeFileSync(path.join(artifactsDir, `channel_${handle}.png`), buf)
  })
}

for (const handle of KNOWN_CHANNEL_HANDLES) {
  test(`results page chips and CR for ${handle}`, async () => {
    const q = handle
    await page.goto('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), { waitUntil: 'domcontentloaded' })
    await dismissYouTubeConsentIfPresent(page)
    // Channel renderer button should appear if present
    const channelBtn = page.locator('ytd-channel-renderer [data-wol-results-channel-btn] a[href^="https://odysee.com/"]').first()
    await expect(channelBtn).toBeVisible({ timeout: 45_000 })
    // At least one inline chip
    const chip = page.locator('ytd-video-renderer a[data-wol-inline-channel]').first()
    await expect(chip).toBeVisible({ timeout: 45_000 })
    if (process.env.E2E_USE_STUBS === '1') {
      const uc = await getChannelIdForHandle(handle)
      test.skip(!uc, `Unable to resolve UC for @${handle}; skip href assertion`)
      await expect(chip).toHaveAttribute('href', new RegExp(`@e2e-channel-${uc}:`))
    }
    ensureArtifactsDir()
    const buf = await page.screenshot({ fullPage: true })
    await test.info().attach(`results_${handle}.png`, { body: buf, contentType: 'image/png' })
    fs.writeFileSync(path.join(artifactsDir, `results_${handle}.png`), buf)
  })
}

test('CRITICAL: overlays persist when switching channel tabs via click', async () => {
  const base = 'https://www.youtube.com/@WhiteHouse'
  if (process.env.E2E_USE_STUBS !== '1') {
    const chId = await getChannelIdForHandle('WhiteHouse')
    if (chId) {
      const res = await realResolve({ channels: [chId] })
      const hasCh = !!res?.data?.channels?.[chId]
      if (!hasCh) test.skip(true, 'Real API: channel not mirrored; skipping overlay persistence test')
    } else {
      test.skip(true, 'Could not resolve channel id; skipping')
    }
  }

  // Enable overlays
  await ensurePopupToggle('Video Previews', true)

  // Navigate to Videos tab
  await page.goto(base + '/videos')
  await dismissYouTubeConsentIfPresent(page)

  // Wait for video thumbnails and overlays
  await page.waitForSelector('ytd-grid-video-renderer, ytd-rich-item-renderer', { timeout: 60_000 })
  const overlaysOnVideos = page.locator('[data-wol-overlay]')
  await expect(overlaysOnVideos.first()).toBeVisible({ timeout: 45_000 })
  const initialCount = await overlaysOnVideos.count()
  expect(initialCount).toBeGreaterThan(0)

  ensureArtifactsDir()
  const videosScreenshot = await page.screenshot({ fullPage: true })
  await test.info().attach('nav_test_videos_tab.png', { body: videosScreenshot, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'nav_test_videos_tab.png'), videosScreenshot)

  // Click on Streams tab (use tab navigation, not full page navigation)
  const streamsTab = page.locator('yt-tab-shape:has-text("Live"), tp-yt-paper-tab:has-text("Live")').first()
  if (await streamsTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    await streamsTab.click()

    // Wait for URL to change
    await page.waitForURL(/\/(live|streams)/, { timeout: 30_000 })

    // Wait for content to load
    await page.waitForTimeout(2000) // Give time for overlays to be created

    // Check that overlays appear on Streams/Live tab
    const overlaysOnStreams = page.locator('[data-wol-overlay]')
    await expect(overlaysOnStreams.first()).toBeVisible({ timeout: 45_000 })
    const streamsCount = await overlaysOnStreams.count()
    expect(streamsCount).toBeGreaterThan(0)

    const streamsScreenshot = await page.screenshot({ fullPage: true })
    await test.info().attach('nav_test_streams_tab.png', { body: streamsScreenshot, contentType: 'image/png' })
    fs.writeFileSync(path.join(artifactsDir, 'nav_test_streams_tab.png'), streamsScreenshot)

    // Click back to Videos tab
    const videosTab = page.locator('yt-tab-shape:has-text("Videos"), tp-yt-paper-tab:has-text("Videos")').first()
    await videosTab.click()
    await page.waitForURL(/\/videos/, { timeout: 30_000 })
    await page.waitForTimeout(2000)

    // CRITICAL: Verify overlays reappear on Videos tab
    const overlaysBackOnVideos = page.locator('[data-wol-overlay]')
    await expect(overlaysBackOnVideos.first()).toBeVisible({ timeout: 45_000 })
    const backCount = await overlaysBackOnVideos.count()
    expect(backCount).toBeGreaterThan(0)

    const backScreenshot = await page.screenshot({ fullPage: true })
    await test.info().attach('nav_test_back_to_videos.png', { body: backScreenshot, contentType: 'image/png' })
    fs.writeFileSync(path.join(artifactsDir, 'nav_test_back_to_videos.png'), backScreenshot)
  }
})

test('CRITICAL: overlays persist when navigating video -> tab -> back', async () => {
  const base = 'https://www.youtube.com/@WhiteHouse'
  if (process.env.E2E_USE_STUBS !== '1') {
    const chId = await getChannelIdForHandle('WhiteHouse')
    if (!chId) test.skip(true, 'Could not resolve channel id')
    const res = await realResolve({ channels: [chId] })
    if (!res?.data?.channels?.[chId]) test.skip(true, 'Real API: channel not mirrored')
  }

  await ensurePopupToggle('Video Previews', true)

  // Start on Videos tab
  await page.goto(base + '/videos')
  await dismissYouTubeConsentIfPresent(page)
  await page.waitForSelector('ytd-grid-video-renderer, ytd-rich-item-renderer', { timeout: 60_000 })

  // Verify overlays present
  const overlaysInitial = page.locator('[data-wol-overlay]')
  await expect(overlaysInitial.first()).toBeVisible({ timeout: 45_000 })

  ensureArtifactsDir()
  const initialScreenshot = await page.screenshot({ fullPage: true })
  fs.writeFileSync(path.join(artifactsDir, 'nav_video_back_1_videos.png'), initialScreenshot)

  // Find and click on a video thumbnail to watch
  const firstVideoLink = page.locator('ytd-grid-video-renderer a#video-title, ytd-rich-item-renderer a#video-title-link').first()
  await firstVideoLink.click()

  // Wait for watch page to load
  await page.waitForURL(/\/watch\?v=/, { timeout: 30_000 })
  await dismissYouTubeConsentIfPresent(page)
  await page.waitForSelector('#secondary, #related', { timeout: 30_000 })

  // Verify overlays on related videos
  const relatedOverlays = page.locator('#secondary [data-wol-overlay], #related [data-wol-overlay]')
  await expect(relatedOverlays.first()).toBeVisible({ timeout: 45_000 })

  const watchScreenshot = await page.screenshot({ fullPage: true })
  fs.writeFileSync(path.join(artifactsDir, 'nav_video_back_2_watch.png'), watchScreenshot)

  // Navigate back to channel Videos tab
  await page.goBack()
  await page.waitForURL(/\/@WhiteHouse\/videos/, { timeout: 30_000 })
  await page.waitForTimeout(2000) // Give time for overlays to recreate

  // CRITICAL: Verify overlays reappear after back navigation
  const overlaysFinal = page.locator('[data-wol-overlay]')
  await expect(overlaysFinal.first()).toBeVisible({ timeout: 45_000 })
  const finalCount = await overlaysFinal.count()
  expect(finalCount).toBeGreaterThan(0)

  const finalScreenshot = await page.screenshot({ fullPage: true })
  await test.info().attach('nav_video_back_3_back_to_videos.png', { body: finalScreenshot, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'nav_video_back_3_back_to_videos.png'), finalScreenshot)
})

test('CRITICAL: rapid tab switching maintains overlay consistency', async () => {
  const base = 'https://www.youtube.com/@WhiteHouse'
  if (process.env.E2E_USE_STUBS !== '1') {
    const chId = await getChannelIdForHandle('WhiteHouse')
    if (!chId) test.skip(true, 'Could not resolve channel id')
    const res = await realResolve({ channels: [chId] })
    if (!res?.data?.channels?.[chId]) test.skip(true, 'Real API: channel not mirrored')
  }

  await ensurePopupToggle('Video Previews', true)

  // Start on home tab
  await page.goto(base)
  await dismissYouTubeConsentIfPresent(page)

  // Rapidly switch between tabs
  const tabs = ['Videos', 'Shorts', 'Live', 'Videos', 'Shorts', 'Videos']

  for (const tabName of tabs) {
    const tab = page.locator(`yt-tab-shape:has-text("${tabName}"), tp-yt-paper-tab:has-text("${tabName}")`).first()
    if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tab.click()
      await page.waitForTimeout(500) // Short delay between clicks
    }
  }

  // Wait for final tab to settle
  await page.waitForTimeout(3000)

  // Verify overlays appear on final Videos tab
  const finalOverlays = page.locator('[data-wol-overlay]')
  await expect(finalOverlays.first()).toBeVisible({ timeout: 45_000 })
  const count = await finalOverlays.count()
  expect(count).toBeGreaterThan(0)

  ensureArtifactsDir()
  const rapidScreenshot = await page.screenshot({ fullPage: true })
  await test.info().attach('nav_rapid_final.png', { body: rapidScreenshot, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'nav_rapid_final.png'), rapidScreenshot)
})

test('watch page related rail overlays toggle without refresh', async () => {
  await ensurePopupToggle('Video Previews', true)
  await page.goto('https://www.youtube.com/watch?v=qn2K3UyIsEo')
  await dismissYouTubeConsentIfPresent(page)
  const relatedContainer = page.locator('#secondary, #related, ytd-watch-next-secondary-results-renderer').first()
  await expect(relatedContainer).toBeVisible({ timeout: 60_000 })
  const relOverlays = relatedContainer.locator('[data-wol-overlay]')
  await expect(relOverlays.first()).toBeVisible({ timeout: 60_000 })
  // Toggle off -> overlays disappear without refresh
  await ensurePopupToggle('Video Previews', false)
  await expect(relOverlays).toHaveCount(0)
  // Toggle on -> overlays return
  await ensurePopupToggle('Video Previews', true)
  await expect(relOverlays.first()).toBeVisible({ timeout: 60_000 })
  ensureArtifactsDir()
  const relImg = await page.screenshot({ fullPage: true })
  await test.info().attach('related_overlays.png', { body: relImg, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'related_overlays.png'), relImg)
})

test('REGRESSION: overlay toggle after hover + navigation', async () => {
  const base = 'https://www.youtube.com/@WhiteHouse'
  if (process.env.E2E_USE_STUBS !== '1') {
    const chId = await getChannelIdForHandle('WhiteHouse')
    if (!chId) test.skip(true, 'Could not resolve channel id')
    const res = await realResolve({ channels: [chId] })
    if (!res?.data?.channels?.[chId]) test.skip(true, 'Real API: channel not mirrored')
  }

  await ensurePopupToggle('Video Previews', true)

  // Navigate to Videos tab
  await page.goto(base + '/videos')
  await dismissYouTubeConsentIfPresent(page)
  await page.waitForSelector('ytd-grid-video-renderer, ytd-rich-item-renderer', { timeout: 60_000 })

  // Verify initial overlays
  const overlays = page.locator('[data-wol-overlay]')
  await expect(overlays.first()).toBeVisible({ timeout: 45_000 })

  // Hover over some video thumbnails to trigger hover handlers
  const thumbnails = page.locator('ytd-grid-video-renderer a#thumbnail, ytd-rich-item-renderer a#thumbnail')
  const thumbCount = await thumbnails.count()
  if (thumbCount > 0) {
    for (let i = 0; i < Math.min(3, thumbCount); i++) {
      await thumbnails.nth(i).hover()
      await page.waitForTimeout(200)
    }
  }

  ensureArtifactsDir()
  const afterHover = await page.screenshot({ fullPage: true })
  fs.writeFileSync(path.join(artifactsDir, 'regression_after_hover.png'), afterHover)

  // Navigate to a watch page
  const firstVideo = page.locator('ytd-grid-video-renderer a#video-title, ytd-rich-item-renderer a#video-title-link').first()
  await firstVideo.click()
  await page.waitForURL(/\/watch\?v=/, { timeout: 30_000 })
  await dismissYouTubeConsentIfPresent(page)

  // Navigate back to Videos tab
  await page.goBack()
  await page.waitForURL(/\/@WhiteHouse\/videos/, { timeout: 30_000 })
  await page.waitForTimeout(2000)

  // Verify overlays are present after navigation
  const overlaysAfterNav = page.locator('[data-wol-overlay]')
  await expect(overlaysAfterNav.first()).toBeVisible({ timeout: 45_000 })
  const countBeforeToggle = await overlaysAfterNav.count()
  expect(countBeforeToggle).toBeGreaterThan(0)

  const beforeToggle = await page.screenshot({ fullPage: true })
  fs.writeFileSync(path.join(artifactsDir, 'regression_before_toggle.png'), beforeToggle)

  // CRITICAL: Toggle overlays OFF - ALL overlays should disappear
  await ensurePopupToggle('Video Previews', false)
  await page.waitForTimeout(1000) // Give time for cleanup

  // Verify ALL overlays are gone (including any that were hovered)
  await expect(overlaysAfterNav).toHaveCount(0, { timeout: 5000 })

  const afterToggleOff = await page.screenshot({ fullPage: true })
  await test.info().attach('regression_after_toggle_off.png', { body: afterToggleOff, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'regression_after_toggle_off.png'), afterToggleOff)
})

test('REGRESSION: all overlays shown on channel page after navigation', async () => {
  const base = 'https://www.youtube.com/@WhiteHouse'
  if (process.env.E2E_USE_STUBS !== '1') {
    const chId = await getChannelIdForHandle('WhiteHouse')
    if (!chId) test.skip(true, 'Could not resolve channel id')
    const res = await realResolve({ channels: [chId] })
    if (!res?.data?.channels?.[chId]) test.skip(true, 'Real API: channel not mirrored')
  }

  await ensurePopupToggle('Video Previews', true)

  // Navigate to Videos tab
  await page.goto(base + '/videos')
  await dismissYouTubeConsentIfPresent(page)
  await page.waitForSelector('ytd-grid-video-renderer, ytd-rich-item-renderer', { timeout: 60_000 })

  // Count initial overlays
  const overlaysInitial = page.locator('[data-wol-overlay]')
  await expect(overlaysInitial.first()).toBeVisible({ timeout: 45_000 })
  const initialCount = await overlaysInitial.count()
  expect(initialCount).toBeGreaterThan(0)

  ensureArtifactsDir()
  const initialScreenshot = await page.screenshot({ fullPage: true })
  fs.writeFileSync(path.join(artifactsDir, 'regression_initial_overlays.png'), initialScreenshot)

  // Navigate to watch page
  const firstVideo = page.locator('ytd-grid-video-renderer a#video-title, ytd-rich-item-renderer a#video-title-link').first()
  await firstVideo.click()
  await page.waitForURL(/\/watch\?v=/, { timeout: 30_000 })
  await dismissYouTubeConsentIfPresent(page)

  // Navigate back to Videos tab
  await page.goBack()
  await page.waitForURL(/\/@WhiteHouse\/videos/, { timeout: 30_000 })
  await page.waitForTimeout(3000) // Give extra time for all overlays to be created

  // CRITICAL: Verify same number of overlays (or more) are present
  const overlaysAfterNav = page.locator('[data-wol-overlay]')
  await expect(overlaysAfterNav.first()).toBeVisible({ timeout: 45_000 })
  const afterNavCount = await overlaysAfterNav.count()

  // Allow for some variance (YouTube might show different number of videos), but ensure we have overlays
  expect(afterNavCount).toBeGreaterThan(0)
  expect(afterNavCount).toBeGreaterThanOrEqual(Math.floor(initialCount * 0.8)) // At least 80% of original count

  const afterNavScreenshot = await page.screenshot({ fullPage: true })
  await test.info().attach('regression_after_nav_overlays.png', { body: afterNavScreenshot, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'regression_after_nav_overlays.png'), afterNavScreenshot)

  // Navigate to Streams tab
  const streamsTab = page.locator('yt-tab-shape:has-text("Live"), tp-yt-paper-tab:has-text("Live")').first()
  if (await streamsTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    await streamsTab.click()
    await page.waitForURL(/\/(live|streams)/, { timeout: 30_000 })
    await page.waitForTimeout(2000)

    // Verify overlays on Streams tab
    const overlaysOnStreams = page.locator('[data-wol-overlay]')
    const streamsCount = await overlaysOnStreams.count()
    expect(streamsCount).toBeGreaterThan(0)

    // Navigate back to Videos
    const videosTab = page.locator('yt-tab-shape:has-text("Videos"), tp-yt-paper-tab:has-text("Videos")').first()
    await videosTab.click()
    await page.waitForURL(/\/videos/, { timeout: 30_000 })
    await page.waitForTimeout(3000)

    // CRITICAL: Verify all overlays still present
    const overlaysFinal = page.locator('[data-wol-overlay]')
    await expect(overlaysFinal.first()).toBeVisible({ timeout: 45_000 })
    const finalCount = await overlaysFinal.count()
    expect(finalCount).toBeGreaterThan(0)
    expect(finalCount).toBeGreaterThanOrEqual(Math.floor(initialCount * 0.8))

    const finalScreenshot = await page.screenshot({ fullPage: true })
    await test.info().attach('regression_final_overlays.png', { body: finalScreenshot, contentType: 'image/png' })
    fs.writeFileSync(path.join(artifactsDir, 'regression_final_overlays.png'), finalScreenshot)
  }
})

test('REGRESSION: watch page related videos all have overlays', async () => {
  await ensurePopupToggle('Video Previews', true)

  // Navigate to a watch page with related videos
  await page.goto('https://www.youtube.com/watch?v=qn2K3UyIsEo')
  await dismissYouTubeConsentIfPresent(page)

  // Wait for related/secondary container
  const relatedContainer = page.locator('#secondary, #related, ytd-watch-next-secondary-results-renderer').first()
  await expect(relatedContainer).toBeVisible({ timeout: 60_000 })

  // Wait for video thumbnails in related section
  await page.waitForSelector('#secondary ytd-compact-video-renderer, #related ytd-compact-video-renderer, ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer', { timeout: 60_000 })

  // Give time for all overlays to be created
  await page.waitForTimeout(3000)

  // Count video thumbnails
  const videoThumbnails = page.locator('#secondary ytd-compact-video-renderer a#thumbnail, #related ytd-compact-video-renderer a#thumbnail')
  const thumbCount = await videoThumbnails.count()
  expect(thumbCount).toBeGreaterThan(0)

  // Count overlays in related section
  const relatedOverlays = relatedContainer.locator('[data-wol-overlay]')
  const overlayCount = await relatedOverlays.count()

  // CRITICAL: Verify we have overlays for videos in related section
  expect(overlayCount).toBeGreaterThan(0)
  // Should have at least half the videos with overlays (accounting for ads, etc)
  expect(overlayCount).toBeGreaterThanOrEqual(Math.floor(thumbCount * 0.5))

  ensureArtifactsDir()
  const screenshot = await page.screenshot({ fullPage: true })
  await test.info().attach('regression_related_overlays.png', { body: screenshot, contentType: 'image/png' })
  fs.writeFileSync(path.join(artifactsDir, 'regression_related_overlays.png'), screenshot)
})

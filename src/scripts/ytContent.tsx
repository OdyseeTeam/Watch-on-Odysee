import { h, render, Fragment } from 'preact'
import { parseYouTubeURLTimeString } from '../modules/yt'
import type { resolveById, ResolveUrlTypes } from '../modules/yt/urlResolve'
import { getExtensionSettingsAsync, getSourcePlatfromSettingsFromHostname, getTargetPlatfromSettingsEntiries, SourcePlatform, sourcePlatfromSettings, TargetPlatform, targetPlatformSettings } from '../settings';
import { logger } from '../modules/logger'
import { channelCache } from '../modules/yt/channelCache'

(async () => {
  const sleep = (t: number) => new Promise(resolve => setTimeout(resolve, t))

  interface Target {
    platform: TargetPlatform
    odyseePathname: string
    type: ResolveUrlTypes
    time: number | null
  }

  interface Source {
    platform: SourcePlatform
    id: string
    type: ResolveUrlTypes
    url: URL
    time: number | null
  }

  const targetPlatforms = getTargetPlatfromSettingsEntiries()
  const settings = await getExtensionSettingsAsync()
  // Debug control (set localStorage.wolDebug = '1' to enable verbose logs)
  const WOL_DEBUG = (() => { try { return localStorage.getItem('wolDebug') === '1' } catch { return false } })()
  const dbg = (...args: any[]) => { if (WOL_DEBUG) try { logger.log(...args) } catch {} }
  // Enhanced debug for overlay tracking (set localStorage.wolOverlayDebug = '1')
  const OVERLAY_DEBUG = (() => { try { return localStorage.getItem('wolOverlayDebug') === '1' } catch { return false } })()
  const overlayDbg = (...args: any[]) => { if (OVERLAY_DEBUG) try { console.log('[WOL-Overlay]', ...args) } catch {} }
  // Debug logging throttles
  let lastLoggedHref: string | null = null
  const resolveLogCache = new Set<string>()
  let lastRenderContext: { source: Source, buttonTargets: Target[] | null, playerTarget: Target | null } | null = null
  let settingsDirty = false
  let lastResolveSig: string | null = null
  let lastResolved: Record<string, Target | null> = {}
  let lastResolveAt = 0
  let lastVideoPageChannelId: string | null = null
  let lastShortsChannelId: string | null = null

  // Track redirected URLs to prevent multiple redirects for the same URL
  const redirectedUrls = new Set<string>()
  let lastRedirectTime = 0

  // Performance optimization: Task scheduler to coalesce heavy work
  const scheduledTasks = new Map<string, number>()
  const taskLastRun = new Map<string, number>()

  function scheduleTask(taskName: string, fn: () => void | Promise<void>, delay: number = 100) {
    const existing = scheduledTasks.get(taskName)
    if (existing) clearTimeout(existing)

    // Enforce minimum time between task runs for specific heavy tasks
    const now = Date.now()
    const lastRun = taskLastRun.get(taskName) || 0
    const minInterval = taskName === 'enhanceListings' && location.pathname === '/watch' ? 500 : 200
    const effectiveDelay = Math.max(delay, minInterval - (now - lastRun))

    const timer = window.setTimeout(() => {
      scheduledTasks.delete(taskName)
      taskLastRun.set(taskName, Date.now())
      try {
        const result = fn()
        if (result instanceof Promise) {
          result.catch(e => logger.error(`Scheduled task ${taskName} failed:`, e))
        }
      } catch (e) {
        logger.error(`Scheduled task ${taskName} failed:`, e)
      }
    }, effectiveDelay)

    scheduledTasks.set(taskName, timer)
  }

  // Idle yield helper to prevent blocking the main thread
  function idleYield(timeout: number = 50): Promise<void> {
    return new Promise(resolve => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => resolve(), { timeout })
      } else {
        setTimeout(() => resolve(), Math.min(timeout, 16))
      }
    })
  }

  // Async batch DOM operations with yielding
  async function asyncBatchRemove(selector: string, batchSize: number = 20) {
    const elements = Array.from(document.querySelectorAll(selector))
    for (let i = 0; i < elements.length; i++) {
      elements[i].remove()
      if ((i + 1) % batchSize === 0 && i < elements.length - 1) {
        await idleYield(30)
      }
    }
  }

  async function asyncBatchProcess<T extends Element>(
    selector: string,
    processor: (el: T) => void,
    batchSize: number = 20
  ) {
    const elements = Array.from(document.querySelectorAll<T>(selector))
    for (let i = 0; i < elements.length; i++) {
      try {
        processor(elements[i])
      } catch {}
      if ((i + 1) % batchSize === 0 && i < elements.length - 1) {
        await idleYield(30)
      }
    }
  }

  // Batched cleanup operations
  async function performBatchedCleanup() {
    // Remove inline watch buttons
    await asyncBatchRemove('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch]')
    // Remove channel buttons
    await asyncBatchRemove('a[data-wol-inline-channel], [data-wol-results-channel-btn]')
    // Remove overlays
    await asyncBatchRemove('[data-wol-overlay]')
    // Clear attributes
    await asyncBatchProcess<HTMLElement>(
      'ytd-channel-renderer[data-wol-channel-button]',
      el => el.removeAttribute('data-wol-channel-button')
    )
    await asyncBatchProcess<HTMLElement>(
      'ytd-video-renderer a[data-wol-enhanced], ytd-channel-renderer a[data-wol-enhanced], .ytGridShelfViewModelGridShelfItem a[data-wol-enhanced]',
      el => el.removeAttribute('data-wol-enhanced')
    )
  }

  // Schedule heavy operations instead of calling directly
  function scheduleEnhanceListings(delay: number = 100, bypassThrottle: boolean = false) {
    // For watch pages with related content, use longer delay to batch more effectively
    const effectiveDelay = location.pathname === '/watch' ? Math.max(delay, 150) : delay
    // Use unique key for retry tasks to prevent them from being overwritten by regular enhancement calls
    const taskKey = bypassThrottle ? 'enhanceListings-retry' : 'enhanceListings'
    scheduleTask(taskKey, () => enhanceVideoTilesOnListings(bypassThrottle), effectiveDelay)
  }

  function scheduleRefreshResultsChips(delay: number = 120) {
    scheduleTask('refreshChips', () => refreshResultsVideoChannelChips(), delay)
  }

  function scheduleRefreshChannelButtons(delay: number = 150) {
    scheduleTask('refreshChannelButtons', () => refreshResultsChannelRendererButtons(), delay)
  }

  function scheduleBatchedCleanup(delay: number = 50) {
    scheduleTask('batchedCleanup', () => performBatchedCleanup(), delay)
  }

  // Wrapper to call async cleanup functions (can optionally await)
  function triggerCleanupOverlays(): Promise<void> {
    return cleanupOverlays().catch(e => { logger.error('Cleanup overlays failed:', e) })
  }

  function triggerCleanupResultsChannelButtons(options?: { disconnectOnly?: boolean }): Promise<void> {
    return cleanupResultsChannelButtons(options).catch(e => { logger.error('Cleanup channel buttons failed:', e) })
  }

  function triggerCleanupResultsVideoChips(options?: { disconnectOnly?: boolean }): Promise<void> {
    return cleanupResultsVideoChips(options).catch(e => { logger.error('Cleanup video chips failed:', e) })
  }

  // Global mutation observer for video tile enhancement
  let wolMutationObserver: MutationObserver | null = null
  // Navigation polling interval
  let wolNavigationPollInterval: number | null = null
  // Scroll handler for channel pages
  let wolChannelScrollHandler: ((e: Event) => void) | null = null
  // Extension boot tracking (for debugging)
  const EXT_BOOT_AT = Date.now()
  // Batch state for watch-page related sidebar overlays (container-gated)
  let relatedBatchStartAt: number | null = null
  let relatedBatchRevealTimer: number | null = null
  let relatedBatchRevealed = false
  let relatedBatchOverlayCount = 0
  // Guard flag to prevent concurrent enhancement runs
  let enhancementRunning = false

  // Ensure a global stylesheet exists to keep overlays visible above YouTube hover/previews
  function ensureOverlayCssInjected() {
    const id = 'wol-overlay-style'
    if (!document.getElementById(id)) {
      const style = document.createElement('style')
      style.id = id
      style.textContent = `
        /* Keep overlays above inline preview layers without fighting container-gating */
        [data-wol-overlay] {
          position: absolute;
          z-index: 2147483647 !important;
          pointer-events: auto;
          /* Prevent overlays from being hidden during hover animations */
          opacity: 1 !important;
          visibility: visible !important;
        }
        
        /* Results page specific - more aggressive positioning */
        ytd-video-renderer [data-wol-overlay],
        ytd-grid-video-renderer [data-wol-overlay] {
          position: absolute !important;
          z-index: 2147483647 !important;
          pointer-events: auto !important;
          opacity: 1 !important;
          visibility: visible !important;
        }

        /* Hide other overlays while one is globally pinned to avoid duplicates */
        [data-wol-overlay][data-wol-hidden="1"] { display: none !important; }

        /* Ensure channel name row can host an inline icon on results */
        ytd-video-renderer ytd-channel-name#channel-name #container {
          display: inline-flex !important;
          align-items: center !important;
          gap: 6px !important;
        }
        ytd-video-renderer ytd-channel-name#channel-name #text-container { display: inline-flex !important; }
      `
      document.head.appendChild(style)
    }
  }

  // Ensure results page pills visibility follows resultsApplySelections immediately
  function ensureResultsPillsVisibility() {
    const id = 'wol-results-pills-visibility'
    const existing = document.getElementById(id)
    // Only relevant on search results page
    if (location.pathname !== '/results') {
      if (existing) try { existing.remove() } catch {}
      return
    }
    if (!settings.resultsApplySelections) {
      if (!existing) {
        const style = document.createElement('style')
        style.id = id
        style.textContent = `
          a[data-wol-inline-watch],
          a[data-wol-inline-shorts-watch],
          a[data-wol-inline-channel],
          [data-wol-results-channel-btn] {
            display: none !important;
          }
        `
        try { document.documentElement.appendChild(style) } catch {}
      }
    } else {
      if (existing) try { existing.remove() } catch {}
    }
  }

  function ensureRelatedBatchCssInjected() {
    const id = 'wol-related-batch-style'
    if (!document.getElementById(id)) {
      const style = document.createElement('style')
      style.id = id
      style.textContent = `
        /* Hide overlays inside watch-page related rail until reveal */
        ytd-watch-flexy #secondary[data-wol-waiting-reveal] [data-wol-overlay],
        ytd-watch-flexy #related[data-wol-waiting-reveal] [data-wol-overlay],
        ytd-watch-flexy ytd-watch-next-secondary-results-renderer[data-wol-waiting-reveal] [data-wol-overlay] {
          opacity: 0 !important;
          visibility: hidden !important;
        }
      `
      document.head.appendChild(style)
    }
  }

  function getRelatedContainer(): HTMLElement | null {
    return (document.querySelector('#secondary') as HTMLElement | null)
      || (document.querySelector('#related') as HTMLElement | null)
      || (document.querySelector('ytd-watch-next-secondary-results-renderer') as unknown as HTMLElement | null)
  }

  function resetRelatedBatch() {
    relatedBatchStartAt = null
    if (relatedBatchRevealTimer) {
      try { clearTimeout(relatedBatchRevealTimer) } catch {}
    }
    relatedBatchRevealTimer = null
    relatedBatchRevealed = false
    relatedBatchOverlayCount = 0
    try {
      const cont = getRelatedContainer()
      if (cont) cont.removeAttribute('data-wol-waiting-reveal')
    } catch {}
  }

  // Global flag to track if extension context is invalidated
  let extensionContextInvalidated = false
  // Incrementing generation to invalidate stale overlay work across tab/page changes
  let overlayGeneration = 0
  let overlayGenerationBumpedAt = Date.now()
  // Per-generation timing metrics (for debugging latency)
  const navGenMetrics = new Map<number, { chipsFirstAt?: number, crFirstAt?: number, ucBatchAt?: number }>()

  // Track last href for both navigation handler and fallback polling
  let navigationLastHref = window.location.href
  // Guard flag to prevent concurrent navigation handlers
  let navigationHandlerRunning = false

  // Hook into YouTube SPA navigation events when available
  try {
    const bumpGen = async () => {
      // CRITICAL FIX: Prevent concurrent navigation handlers
      if (navigationHandlerRunning) {
        logger.log('⏸️ Navigation handler already running, skipping')
        return
      }
      navigationHandlerRunning = true

      try {
        const currentUrl = location.href
        navigationLastHref = currentUrl  // Update shared variable
      logger.log('🔄 Navigation detected:', currentUrl)

      // CRITICAL FIX: Stop observers immediately to prevent stale work
      if (wolMutationObserver) {
        wolMutationObserver.disconnect()
        wolMutationObserver = null
        logger.log('✋ Stopped mutation observer')
      }
      if (wolChannelScrollHandler) {
        window.removeEventListener('scroll', wolChannelScrollHandler)
        wolChannelScrollHandler = null
        logger.log('✋ Stopped channel scroll handler')
      }

      // CRITICAL FIX: Clear all scheduled tasks to prevent race conditions
      const taskCount = scheduledTasks.size
      for (const timer of scheduledTasks.values()) {
        clearTimeout(timer)
      }
      scheduledTasks.clear()
      logger.log('🗑️ Cleared', taskCount, 'scheduled tasks')

      // Bump generation BEFORE cleanup so cleanup operations can check it
      overlayGeneration++
      overlayGenerationBumpedAt = Date.now()
      logger.log('⬆️ Bumped generation to', overlayGeneration)

      // Reset per-results caches/maps to avoid stale chips/buttons across channel/search changes
      try {
        resolvedLocal.clear()
      } catch {}
      try {
        initialDataMapCache = null
      } catch {}
      try {
        // Reset bounded retry tracking for channel renderers
        // Recreate the WeakMap to drop previous entries
        // @ts-ignore - reassignment is intentional for cache reset
        channelRendererRetryCount = new WeakMap<HTMLElement, number>()
      } catch {}
      try {
        // Clear any remembered overlay anchor preferences across pages
        overlayAnchorPrefs.clear()
      } catch {}
      try {
        // Clear page-level resolution cache to avoid cross-page leakage
        lastResolved = {}
        lastResolveSig = null
        lastResolveAt = 0
        lastVideoPageChannelId = null
        lastShortsChannelId = null
        // DON'T clear ucResolvePageCache, handleResolvePageCache, and ytUrlResolvePageCache - these are cross-page caches
        // that help speed up repeated searches. They're keyed by globally-unique UC/handle IDs or YT URLs.
        // Only trim them if they get too large (memory management)
        if (ucResolvePageCache.size > 100) {
          // Keep the 50 most recently accessed entries
          const entries = Array.from(ucResolvePageCache.entries())
          ucResolvePageCache.clear()
          entries.slice(-50).forEach(([k, v]) => ucResolvePageCache.set(k, v))
          logger.log('🗑️ Trimmed ucResolvePageCache from', entries.length, 'to 50 entries')
        }
        if (handleResolvePageCache.size > 100) {
          const entries = Array.from(handleResolvePageCache.entries())
          handleResolvePageCache.clear()
          entries.slice(-50).forEach(([k, v]) => handleResolvePageCache.set(k, v))
          logger.log('🗑️ Trimmed handleResolvePageCache from', entries.length, 'to 50 entries')
        }
        if (ytUrlResolvePageCache.size > 100) {
          const entries = Array.from(ytUrlResolvePageCache.entries())
          ytUrlResolvePageCache.clear()
          entries.slice(-50).forEach(([k, v]) => ytUrlResolvePageCache.set(k, v))
          logger.log('🗑️ Trimmed ytUrlResolvePageCache from', entries.length, 'to 50 entries')
        }
        logger.log('💾 Preserved caches: UC=', ucResolvePageCache.size, 'handles=', handleResolvePageCache.size, 'ytUrls=', ytUrlResolvePageCache.size)
      } catch {}
      logger.log('🧽 Cleared results caches (resolvedLocal, initialData mappings, retries)')

      // CRITICAL FIX: Don't await cleanup - let it run async to avoid blocking navigation
      // The generation bump will cause any running enhancement to exit early
      triggerCleanupOverlays().catch(e => logger.error('Cleanup overlays failed:', e))
      triggerCleanupResultsChannelButtons().catch(e => logger.error('Cleanup channel buttons failed:', e))
      // Full cleanup of inline chips on navigation to avoid stale channel links
      triggerCleanupResultsVideoChips().catch(e => logger.error('Cleanup chips failed:', e))

      // Immediately clear any page-level buttons to avoid showing stale targets during nav
      try { updateButtons(null) } catch {}

      // Clear enhanced flags so anchors can be re-processed on the new page
      document.querySelectorAll('a[data-wol-enhanced="done"]').forEach(el => {
        (el as HTMLElement).removeAttribute('data-wol-enhanced')
      })

      logger.log('🧹 Cleanup triggered (async)')

      resetRelatedBatch()
      lastEnhanceTime = 0; lastEnhanceUrl = ''

      // Now schedule enhancement - longer delay for channel pages to let YouTube render all videos
      // Channel pages with many videos need more time for initial render
      const isChannelPage = currentUrl.includes('/@') || currentUrl.includes('/channel/') ||
                            currentUrl.includes('/c/') || currentUrl.includes('/user/')
      const enhanceDelay = isChannelPage ? 800 : 300

      // Schedule overlay enhancement if overlays are enabled
      if (settings.buttonOverlay) {
        scheduleEnhanceListings(enhanceDelay)
        // Only call ensureOverlayEnhancementActive on non-channel pages
        // On channel pages, observers are disabled to prevent lockups
        if (!isChannelPage) {
          ensureOverlayEnhancementActive()
        } else {
          logger.log('⚠️ Skipping ensureOverlayEnhancementActive on channel page')
        }
        logger.log('🔍 Restarted overlay enhancement')
      } else {
        logger.log('⚠️ Button overlay disabled, skipping enhancement')
      }

      // Run chips a bit earlier, then overlays/buttons
      scheduleRefreshResultsChips(220)
      // Also refresh page-level buttons/redirects once per navigation
      scheduleProcessCurrentPage(100)
      logger.log('📅 Scheduled enhancement tasks')

        // Ensure results pills visibility reflects current setting on navigation
        try { ensureResultsPillsVisibility() } catch {}

        logger.log('✅ Navigation handler complete, returning control to browser')
      } finally {
        navigationHandlerRunning = false
      }
    }
    document.addEventListener('yt-navigate-finish', bumpGen as EventListener)
    document.addEventListener('yt-page-data-updated', bumpGen as EventListener)
    logger.log('✅ Navigation handlers installed')
  } catch (e) {
    logger.error('❌ Failed to setup navigation handlers:', e)
  }

  // Listen Settings Change
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    try {
      if (areaName !== 'local') return
      Object.assign(settings, Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue])))
      settingsDirty = true

      // Handle overlay setting changes
      let needsButtonUpdate = false
      let needsOverlayUpdate = false
      let buttonOverlayNewValue: boolean | undefined = undefined

      let needsResultsEnforcementUpdate = false
      for (const [key, change] of Object.entries(changes)) {
        if (key === 'buttonOverlay') {
          needsOverlayUpdate = true
          buttonOverlayNewValue = change.newValue as boolean
          if (!change.newValue) {
            // Clear all scheduled tasks to prevent pending enhancements from running
            const taskCount = scheduledTasks.size
            for (const timer of scheduledTasks.values()) {
              clearTimeout(timer)
            }
            scheduledTasks.clear()
            dbg('Watch on Odysee: Cleared', taskCount, 'scheduled tasks')

            // Disable mutation observer when overlay setting is turned off
            if (wolMutationObserver) {
              wolMutationObserver.disconnect()
              wolMutationObserver = null
              dbg('Watch on Odysee: Disconnected mutation observer')
            }
            // Use the comprehensive cleanup function - await it to ensure completion
            dbg('Watch on Odysee: Overlay setting disabled, cleaning up overlays')
            await cleanupOverlays()
          }
        }
        // Apply/unapply results inline UI immediately on relevant toggle flips
        if (key === 'resultsApplySelections' || key === 'buttonVideoSub' || key === 'buttonChannelSub') {
          if (location.pathname === '/results') {
            try {
              // Ensure nothing is hidden by our extension; we no longer hide result tiles
              document.querySelectorAll('ytd-video-renderer[data-wol-hidden], .ytGridShelfViewModelGridShelfItem[data-wol-hidden], ytd-channel-renderer[data-wol-hidden]')
                .forEach(el => { try { el.removeAttribute('data-wol-hidden'); (el as HTMLElement).style.removeProperty('display') } catch {} })
              // If results application disabled, remove any existing inline pills immediately
              if (key === 'resultsApplySelections' && (change as any)?.newValue === false) {
                document.querySelectorAll('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch]').forEach(el => el.remove())
                document.querySelectorAll('a[data-wol-inline-channel], [data-wol-results-channel-btn]').forEach(el => el.remove())
                document.querySelectorAll('ytd-channel-renderer[data-wol-channel-button]')
                  .forEach(el => (el as HTMLElement).removeAttribute('data-wol-channel-button'))
                // Disconnect per-renderer observers and clear state to prevent reinsertion from old observers
                triggerCleanupResultsChannelButtons()
                triggerCleanupResultsVideoChips()
              }
              // Enforce on every toggle flip
              enforceResultsChannelChipVisibility()
              // If results application was turned on, clear enhanced flags so reinjection can occur
              if (key === 'resultsApplySelections' && (change as any)?.newValue === true) {
                try {
                  document.querySelectorAll('ytd-video-renderer a[data-wol-enhanced], ytd-channel-renderer a[data-wol-enhanced], .ytGridShelfViewModelGridShelfItem a[data-wol-enhanced]')
                    .forEach(el => el.removeAttribute('data-wol-enhanced'))
                  // Also clear any per-renderer state and disconnect stale observers before reinjecting
                  triggerCleanupResultsChannelButtons()
                  triggerCleanupResultsVideoChips({ disconnectOnly: true })
                } catch {}
                // Immediately re-run chip refresher; then run again shortly to catch late DOM
                scheduleRefreshResultsChips(50)
                scheduleRefreshResultsChips(120)
                scheduleRefreshChannelButtons(150)
              }
              // Update CSS guard
              try { ensureResultsPillsVisibility() } catch {}
            } catch {}
            needsResultsEnforcementUpdate = true
          }
        }
        
       // Handle button setting changes that require immediate UI updates
       if (key === 'buttonChannelSub' || key === 'buttonVideoSub' || key === 'buttonVideoPlayer') {
          needsButtonUpdate = true
          // Proactively clean or (re)inject inline UI on results when settings flip
          try {
            if (key === 'buttonVideoSub') {
              if (change?.newValue === false) {
                document.querySelectorAll('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch]').forEach(el => el.remove())
                // Shorts compact mount cleanup
                try { render(<WatchOnOdyseeButtons />, shortsSideButtonMountPoint) } catch {}
              } else {
                // Re-enabled: first clean up any existing buttons to prevent duplicates
                document.querySelectorAll('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch]').forEach(el => el.remove())
                
                // Then clear enhanced flags so videos get re-processed
                document.querySelectorAll('ytd-video-renderer a[data-wol-enhanced="done"]')
                  .forEach(el => (el as any).dataset.wolEnhanced = '')
                document.querySelectorAll('.ytGridShelfViewModelGridShelfItem a[data-wol-enhanced="done"]')
                  .forEach(el => (el as any).dataset.wolEnhanced = '')
                // Bypass enhancement throttling and immediately re-run for results
                try { lastEnhanceTime = 0; lastEnhanceUrl = '' } catch {}
                if (location.pathname === '/results') {
                  scheduleEnhanceListings(50)
                }
              }
            }
            if (key === 'buttonChannelSub') {
              if (change?.newValue === false) {
                document.querySelectorAll('a[data-wol-inline-channel]').forEach(el => el.remove())
                document.querySelectorAll('[data-wol-results-channel-btn]').forEach(el => el.remove())
                document.querySelectorAll('ytd-channel-renderer[data-wol-channel-button]')
                  .forEach(el => (el as HTMLElement).removeAttribute('data-wol-channel-button'))
                // Disconnect any observers tied to channel renderers; clear state
                triggerCleanupResultsChannelButtons()
                triggerCleanupResultsVideoChips()
                // Shorts subscribe mount cleanup
                try { render(<WatchOnOdyseeButtons />, shortsSubscribeMountPoint) } catch {}
                // Strict enforcement: remove any stray chips
                enforceResultsChannelChipVisibility()
              } else {
                // Ensure results pills are not hidden by a lingering CSS guard
                try { ensureResultsPillsVisibility() } catch {}
                // Re-enabled: first clean up any existing buttons to prevent duplicates
                document.querySelectorAll('a[data-wol-inline-channel]').forEach(el => el.remove())
                document.querySelectorAll('[data-wol-results-channel-btn]').forEach(el => el.remove())
                document.querySelectorAll('ytd-channel-renderer[data-wol-channel-button]')
                  .forEach(el => (el as HTMLElement).removeAttribute('data-wol-channel-button'))
                // Disconnect old observers so they don't reinsert stale buttons
                triggerCleanupResultsChannelButtons({ disconnectOnly: true })
                triggerCleanupResultsVideoChips({ disconnectOnly: true })
                
                // Then clear enhanced flags so channels get re-processed
                document.querySelectorAll('ytd-channel-renderer a[data-wol-enhanced="done"]')
                  .forEach(el => (el as any).dataset.wolEnhanced = '')
                document.querySelectorAll('ytd-video-renderer a[data-wol-enhanced="done"]')
                  .forEach(el => (el as any).dataset.wolEnhanced = '')
                // Bypass enhancement throttling and immediately re-run for results
                try { lastEnhanceTime = 0; lastEnhanceUrl = '' } catch {}
                if (location.pathname === '/results') {
                  setTimeout(() => {
                    // Run both the regular enhance pass and the direct channel-chip refresh
                    scheduleEnhanceListings(0)
                    scheduleRefreshResultsChips(0)
                  }, 50)
                }
              }
            }
            if (key === 'buttonVideoPlayer' && change?.newValue === false) {
              try { render(<WatchOnOdyseePlayerButton />, playerButtonMountPoint) } catch {}
            }
          } catch {}
        }
        
        // Handle redirect setting changes that may affect current page
        if (key === 'redirectVideo' || key === 'redirectChannel') {
          needsButtonUpdate = true
          // Clear redirect tracking when settings are enabled to allow immediate redirect
          if ((change as any)?.newValue === true) {
            try { lastRedirectTime = 0; redirectedUrls.clear() } catch {}
          }
          // Force next enhancement pass to run immediately (bypass throttling)
          try { lastEnhanceTime = 0; lastEnhanceUrl = '' } catch {}
        }
      }
      
      // Apply updates immediately
      if (needsOverlayUpdate && buttonOverlayNewValue) {
        // Re-enable overlays when setting is turned on
        ensureOverlayEnhancementActive()
      }
      
       if (needsButtonUpdate) {
         // Force immediate button update by triggering current page processing
         scheduleProcessCurrentPage(0)
         // Also trigger immediate overlay enhancement to re-process /results page inline buttons
         if (location.pathname === '/results') {
           try {
             // Force a slightly longer delay to ensure cleanup is complete first
             setTimeout(() => {
               scheduleEnhanceListings(0)
               scheduleRefreshResultsChips(0)
               scheduleRefreshChannelButtons(0)
             }, 100)
           } catch {}
         }
      }

      // If only resultsApplySelections changed (and no button toggles), still re-run processing on /results
      if (needsResultsEnforcementUpdate && location.pathname === '/results' && !needsButtonUpdate) {
        // Reset throttling and force an immediate pass
        try { lastEnhanceTime = 0; lastEnhanceUrl = '' } catch {}
        scheduleProcessCurrentPage(0)
        try { setTimeout(() => {
          scheduleEnhanceListings(0)
          scheduleRefreshResultsChips(0)
        }, 50) } catch {}
      }

      // Try to immediately reflect settings changes without waiting for next loop
      if (lastRenderContext) {
        const src = lastRenderContext.source
        let newButtonTargets: Target[] | null = null
        if (src.type === 'channel') {
          newButtonTargets = settings.buttonChannelSub ? (lastResolved[src.id] ? [lastResolved[src.id]!] : []) : []
        } else if (src.type === 'video') {
          if (settings.buttonVideoSub) {
            const isShorts = src.url.pathname.startsWith('/shorts/')
            const vidTarget = lastResolved[src.id] ?? null
            const chTarget = lastVideoPageChannelId ? (lastResolved[lastVideoPageChannelId] ?? null) : null
            newButtonTargets = []
            if (isShorts) {
              if (vidTarget) newButtonTargets.push(vidTarget)
            } else {
              if (chTarget) newButtonTargets.push(chTarget)
              if (vidTarget) newButtonTargets.push(vidTarget)
            }
          } else {
            newButtonTargets = []
          }
        }
        updateButtons({ source: src, buttonTargets: newButtonTargets, playerTarget: lastRenderContext.playerTarget })
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Extension context invalidated')) {
        logger.warn('Extension context invalidated in settings listener')
        extensionContextInvalidated = true
      } else {
        logger.error('Error in settings change listener:', error)
      }
    }
  })

  const buttonMountPoint = document.createElement('div')
  buttonMountPoint.style.display = 'inline-flex'

  const playerButtonMountPoint = document.createElement('div')
  // Wrapper reused in multiple contexts; style set contextually
  const shortsSideButtonMountPoint = document.createElement('div')
  shortsSideButtonMountPoint.style.position = 'absolute'
  shortsSideButtonMountPoint.style.right = '12px'
  shortsSideButtonMountPoint.style.top = '80px'
  shortsSideButtonMountPoint.style.zIndex = '10'
  const shortsSubscribeMountPoint = document.createElement('div')
  shortsSubscribeMountPoint.style.display = 'inline-flex'

  // Default pill height used as a safe fallback when reference height is not yet measurable
  const DEFAULT_PILL_HEIGHT = 36

  // Sync our wrapper and inner anchors to the height of a reference element (e.g., Subscribe)
  function syncHeightToReference(refEl: HTMLElement | null) {
    if (!refEl) return
    const apply = (h: number) => {
      const use = (!h || h <= 0) ? DEFAULT_PILL_HEIGHT : Math.max(h, DEFAULT_PILL_HEIGHT)
      const hpx = `${Math.round(use)}px`
      buttonMountPoint.style.height = hpx
      try {
        const anchors = buttonMountPoint.querySelectorAll('a[role="button"], a') as unknown as HTMLElement[]
        anchors.forEach(a => {
          a.style.height = hpx
          a.style.lineHeight = 'normal'
          a.style.display = 'inline-flex'
          a.style.alignItems = 'center'
          a.style.boxSizing = 'border-box'
        })
      } catch {}
    }
    // Apply immediately if we have some size, but also observe for subsequent growth
    let last = 0
    const h0 = refEl.offsetHeight || refEl.clientHeight || 0
    if (h0 > 0) { last = h0; apply(h0) } else { apply(DEFAULT_PILL_HEIGHT) }
    // Defer until YouTube finishes laying out the Subscribe control; update on any growth
    try {
      const ro = new ResizeObserver(() => {
        const h = refEl.offsetHeight || refEl.clientHeight || 0
        if (h > 0 && Math.round(h) !== Math.round(last)) {
          last = h
          apply(h)
        }
      })
      ro.observe(refEl)
      // Safety disconnect after a short period to avoid keeping observers around forever
      setTimeout(() => { try { ro.disconnect() } catch {} }, 4000)
    } catch {
      // Fallback: a few animation frames
      let attempts = 12
      const tick = () => {
        const h = refEl.offsetHeight || refEl.clientHeight || 0
        if (h > 0 && Math.round(h) !== Math.round(last)) { last = h; apply(h) }
        if (attempts-- > 0) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }
  }

  // Generic: sync an arbitrary container (and its anchors) to match a reference element's height
  // Optional min allows shrinking below DEFAULT_PILL_HEIGHT when needed (e.g., watch title line ~28px)
  function syncContainerHeightToReference(container: HTMLElement, refEl: HTMLElement | null, min: number = DEFAULT_PILL_HEIGHT) {
    if (!refEl) return
    // Avoid showing a too-small pill: keep container hidden until we apply a non-zero height at least once
    let revealed = false
    let lastApplied = 0
    let stableCount = 0
    // Safety: reveal after a short settle window even if no further size events arrive
    const settleMs = 500
    const revealTimer = setTimeout(() => { if (!revealed) { try { container.style.visibility = '' } catch {}; revealed = true } }, settleMs)
    const hideIfNeeded = () => {
      try {
        const ch = container.offsetHeight || container.clientHeight || 0
        if (ch === 0) container.style.visibility = 'hidden'
      } catch {}
    }
    hideIfNeeded()
    const apply = (h: number) => {
      const floor = typeof min === 'number' ? min : DEFAULT_PILL_HEIGHT
      const use = (!h || h <= 0) ? floor : Math.max(h, floor)
      const hpx = `${Math.round(use)}px`
      container.style.height = hpx
      container.style.minHeight = `${DEFAULT_PILL_HEIGHT}px`
      try {
        const anchors = container.querySelectorAll('a[role="button"], a') as unknown as HTMLElement[]
        anchors.forEach(a => {
          a.style.height = hpx
          a.style.lineHeight = 'normal'
          a.style.display = 'inline-flex'
          a.style.alignItems = 'center'
          a.style.boxSizing = 'border-box'
        })
      } catch {}
      // Only reveal once height appears stable across at least two consecutive applies
      if (Math.round(use) === Math.round(lastApplied)) stableCount++
      else stableCount = 0
      lastApplied = use
      if (!revealed && stableCount >= 1) { // two consecutive matches
        try { container.style.visibility = '' } catch {}
        revealed = true
        try { clearTimeout(revealTimer) } catch {}
      }
    }
    let last = 0
    const h0 = refEl.offsetHeight || refEl.clientHeight || 0
    if (h0 > 0) { last = h0; apply(h0) } else { apply(DEFAULT_PILL_HEIGHT) }
    try {
      const ro = new ResizeObserver(() => {
        const h = refEl.offsetHeight || refEl.clientHeight || 0
        if (h > 0 && Math.round(h) !== Math.round(last)) { last = h; apply(h) }
      })
      ro.observe(refEl)
      setTimeout(() => { try { ro.disconnect() } catch {} }, 4000)
    } catch {
      let attempts = 12
      const tick = () => {
        const h = refEl.offsetHeight || refEl.clientHeight || 0
        if (h > 0 && Math.round(h) !== Math.round(last)) { last = h; apply(h) }
        if (attempts-- > 0) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }
  }

  // Lock widths of our rendered action anchors to prevent post-load reflow
  function lockButtonWidthsIn(container: HTMLElement) {
    try {
      const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[role="button"]'))
      for (const a of anchors) {
        if ((a as any).dataset?.wolWidthLocked === '1') continue
        // Ensure minimum width for Channel and Watch buttons
        const isChannelButton = a.textContent?.includes('Channel')
        const isWatchButton = a.textContent?.includes('Watch')
        if (isChannelButton) {
          a.style.minWidth = '100px'
          a.style.width = 'auto'
        } else if (isWatchButton) {
          a.style.minWidth = '85px'
          a.style.width = 'auto'
        } else {
          const rect = a.getBoundingClientRect()
          if (rect && rect.width > 0) {
            const w = Math.round(rect.width)
            a.style.width = `${w}px`
            a.style.minWidth = `${w}px`
          }
        }
        ;(a as any).dataset.wolWidthLocked = '1'
      }
    } catch {}
  }

  // Compute a reasonable single-line height for a heading element
  function getLineHeightPx(el: HTMLElement | null): number | null {
    if (!el) return null
    try {
      const cs = getComputedStyle(el)
      const lh = cs.lineHeight
      if (lh && lh.endsWith('px')) {
        const v = parseFloat(lh)
        return Number.isFinite(v) && v > 0 ? Math.round(v) : null
      }
      const fs = parseFloat(cs.fontSize || '0') || 0
      if (fs > 0) return Math.round(fs * 1.3)
    } catch {}
    return null
  }

  // Ensure the watch-page buttons (Channel/Watch) match the title height precisely
  function ensureWatchButtonsMatchTitleHeight() {
    try {
      const h1 = (document.querySelector('ytd-watch-metadata #title h1') as HTMLElement | null)
        || (document.querySelector('ytd-watch-metadata h1') as HTMLElement | null)
      if (!h1) return
      const apply = () => {
        try {
          const lh = getLineHeightPx(h1) || (h1.clientHeight || h1.offsetHeight || DEFAULT_PILL_HEIGHT)
          const h = Math.max(1, Math.round(lh))
          // Set group container height and inner anchors heights directly
          buttonMountPoint.style.height = `${h}px`
          const anchors = buttonMountPoint.querySelectorAll('a[role="button"], a') as unknown as HTMLElement[]
          anchors.forEach(a => {
            a.style.height = `${h}px`
            a.style.lineHeight = 'normal'
            a.style.display = 'inline-flex'
            a.style.alignItems = 'center'
            a.style.boxSizing = 'border-box'
          })
        } catch {}
      }
      apply()
      try {
        const ro = new ResizeObserver(() => apply())
        ro.observe(h1)
        setTimeout(() => { try { ro.disconnect() } catch {} }, 4000)
      } catch {}
      // Double-tap after paint in case fonts settle late
      try { setTimeout(apply, 0); setTimeout(apply, 160) } catch {}
    } catch {}
  }

  // Find the actual Subscribe button element (not just the host) for reliable height
  function findSubscribeRefButton(from: Element | null): HTMLElement | null {
    if (!from) return null
    const q = (
      from.querySelector('.ytSubscribeButtonViewModelContainer > button') as HTMLElement | null
    ) || (
      from.querySelector('button.yt-spec-button-shape-next') as HTMLElement | null
    ) || (
      from.querySelector('yt-animated-action .ytSubscribeButtonViewModelContainer button') as HTMLElement | null
    ) || (
      from.querySelector('button[aria-label^="Subscribe"], button[aria-label*="Subscribe"]') as HTMLElement | null
    )
    return q
  }

  function WatchOnOdyseeButtons({ source, targets, compact, fillHeight }: { source?: Source, targets?: Target[], compact?: boolean, fillHeight?: boolean }) {
    if (!source || !targets || targets.length === 0) return null
    return <div style={{ display: 'inline-flex' }}>
      {targets.map((target) => {
    const url = getOdyseeUrlByTarget(target)
        const isChannel = target.type === 'channel'
        return (
          <div style={{ display: 'flex', height: '100%', alignItems: fillHeight ? 'stretch' : 'center', alignContent: 'center', minWidth: 'fit-content', marginRight: '6px'}}>
      <a href={`${url.href}`} target='_blank' role='button'
        style={{
                display: 'flex', alignItems: 'center', gap: compact ? '0' : '6px', borderRadius: '16px', padding: compact ? '0 4px' : '0 12px', ...(fillHeight ? {} : { minHeight: '36px' }),
                // Match YouTube subscribe control sizing
                boxSizing: 'border-box',
                lineHeight: 'normal',
                fontWeight: 500, border: '0', color: 'whitesmoke', fontSize: compact ? '0' : '14px', textDecoration: 'none',
                backgroundColor: target.platform.theme, backgroundImage: target.platform.theme,
                minWidth: isChannel ? '115px' : '100px',
                width: 'auto',
          ...target.platform.button.style?.button,
        }}
              onClick={(e: any) => { e.preventDefault(); e.stopPropagation(); openNewTab(url, 'user'); findVideoElementAwait(source).then((videoElement) => { videoElement.pause() }) }}
            >
              {isChannel ? (
                h(Fragment, null,
                  h('img', { src: target.platform.button.icon, height: 20, style: { display: 'block', ...(target.platform.button.style?.icon || {}) } } as any),
                  !compact && h('span', { style: { minWidth: 'fit-content', whiteSpace: 'nowrap' } as any }, 'Channel')
                )
              ) : (
                h(Fragment, null,
                  !compact && h('span', { style: { minWidth: 'fit-content', whiteSpace: 'nowrap' } as any }, 'Watch'),
                  h('img', { src: target.platform.button.icon, height: 20, style: { display: 'block', ...(target.platform.button.style?.icon || {}) } } as any)
                )
              )}
            </a>
          </div>
        )
      })}
    </div>
  }

  function WatchOnOdyseePlayerButton({ source, target, minimized }: { source?: Source, target?: Target, minimized?: boolean }) {
    if (!target || !source) return null
    const url = getOdyseeUrlByTarget(target)

    // Minimized control-bar button (e.g., YouTube control bar)
    if (minimized) {
      return <button
        className="ytp-button"
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', border: 0, background: 'transparent', verticalAlign: 'middle', cursor: 'pointer' }}
        onClick={(e: any) => { e.preventDefault(); e.stopPropagation(); openNewTab(url, 'user'); findVideoElementAwait(source).then(v => v.pause()) }}
        aria-label={`Watch on ${target.platform.button.platformNameText}`}
        title={`Watch on ${target.platform.button.platformNameText}`}
      >
        <img src={target.platform.button.icon} height={20} style={{ display: 'block', ...target.platform.button.style?.icon }} />
      </button>
    }

    // Non-minimized: simple bar with logo (original working style)
    return <div style={{ display: 'flex', height: '48px', alignContent: 'center', justifyContent: 'center' }}>
      <a href={`${url.href}`} target='_blank' role='button'
        style={{ display: 'flex', alignItems: 'center', gap: '7px', borderRadius: '2px', paddingRight: '10px', fontWeight: 'bold', border: '0', color: 'whitesmoke', fontSize: '14px', textDecoration: 'none', ...target.platform.button.style?.button }}
        onClick={(e: any) => { e.preventDefault(); e.stopPropagation(); openNewTab(url, 'user'); findVideoElementAwait(source).then((videoElement) => { videoElement.pause() }) }}
      >
        <img src={target.platform.button.icon} height={24} style={{ ...target.platform.button.style?.icon }} />
      </a>
    </div>
  }

  function updateButtons(params: { source: Source, buttonTargets: Target[] | null, playerTarget: Target | null } | null): void {
    const updateButtonsStartTime = performance.now()
    try {
      const info = params ? { path: location.pathname, type: params.source?.type, targets: params.buttonTargets?.length || 0 } : { path: location.pathname, type: 'none', targets: 0 }
      logger.log('Watch on Odysee: updateButtons', info)
      dbg(`[CHANNEL-DEBUG] updateButtons called with:`, info)
    } catch {}
    if (!params) {
      dbg(`[CHANNEL-DEBUG] updateButtons: clearing buttons (no params)`)
      render(<WatchOnOdyseeButtons />, buttonMountPoint)
      render(<WatchOnOdyseePlayerButton />, playerButtonMountPoint)
      return
    }

    {
      // Render player button using original stable approach
      if (settings.buttonVideoPlayer && params.playerTarget) {
        const isShorts = params.source.url.pathname.startsWith('/shorts/')
        if (isShorts) {
          // Prefer anchoring directly to the Shorts video container, bottom-right inside the video
          const playerHost = (
            document.querySelector('ytd-reel-video-renderer #player-container') as HTMLElement | null
          ) || (
            document.querySelector('ytd-reel-player-overlay-renderer #player-container') as HTMLElement | null
          ) || (
            document.querySelector('ytd-reel-player-overlay-renderer #player') as HTMLElement | null
          ) || (
            document.querySelector('#player.skeleton.shorts #player-wrap') as HTMLElement | null
          )

          if (playerHost) {
            const cs = getComputedStyle(playerHost)
            if (cs.position === 'static') playerHost.style.position = 'relative'
            Object.assign(playerButtonMountPoint.style, {
              position: 'absolute',
              right: '12px',
              bottom: '12px',
              display: 'inline-flex',
              alignItems: 'center',
              zIndex: '1002',
              pointerEvents: 'auto'
            })
            if (playerButtonMountPoint.getAttribute('data-id') !== params.source.id || playerButtonMountPoint.parentElement !== playerHost) {
              playerButtonMountPoint.setAttribute('data-id', params.source.id)
              playerHost.appendChild(playerButtonMountPoint)
            }
            render(<WatchOnOdyseePlayerButton minimized target={params.playerTarget ?? undefined} source={params.source} />, playerButtonMountPoint)
          } else {
            render(<WatchOnOdyseePlayerButton />, playerButtonMountPoint)
          }
        } else {
          const mountPlayerButtonBefore = settings.buttonVideoPlayer ? document.querySelector(params.source.platform.htmlQueries.mountPoints.mountPlayerButtonBefore) : null
      if (!mountPlayerButtonBefore) render(<WatchOnOdyseePlayerButton />, playerButtonMountPoint)
      else {
        if (playerButtonMountPoint.getAttribute('data-id') !== params.source.id) {
          mountPlayerButtonBefore.parentElement?.insertBefore(playerButtonMountPoint, mountPlayerButtonBefore)
          playerButtonMountPoint.setAttribute('data-id', params.source.id)
        }
            render(<WatchOnOdyseePlayerButton target={params.playerTarget ?? undefined} source={params.source} />, playerButtonMountPoint)
          }
        }
      } else {
        render(<WatchOnOdyseePlayerButton />, playerButtonMountPoint)
      }
    }

    {
      // Decide if we should show buttons in the subscribe area for the current page
      const selector = params.source.platform.htmlQueries.mountPoints.mountButtonBefore[params.source.type]
      const allowVideoButtons = settings.buttonVideoSub
      const allowChannelButtons = settings.buttonChannelSub
      const shouldShowOnThisPage = params.source.type === 'video'
        ? (allowVideoButtons || allowChannelButtons)
        : allowChannelButtons
      let mountBefore: Element | null = shouldShowOnThisPage ? document.querySelector(selector) : null
      if (!mountBefore) {
        // Fallbacks: try to place near subscribe controls
        mountBefore = document.querySelector('yt-flexible-actions-view-model yt-subscribe-button-view-model') ||
          document.querySelector('yt-subscribe-button-view-model') ||
          document.querySelector('ytd-c4-tabbed-header-renderer #buttons ytd-subscribe-button-renderer') ||
          document.querySelector('ytd-page-header-renderer #buttons ytd-subscribe-button-renderer') ||
          document.querySelector('ytd-subscribe-button-renderer') ||
          document.querySelector('#owner #subscribe-button')
      }
      // Shorts: place in side action rail above like/dislike (only render Watch button)
      if (!mountBefore && params.source.url.pathname.startsWith('/shorts/')) {
        mountBefore = document.querySelector('ytd-reel-player-overlay-renderer #actions ytd-toggle-button-renderer') ||
          document.querySelector('ytd-reel-player-overlay-renderer #actions')
      }
      if (!mountBefore) {
        // Shorts: prefer menu button area at bottom
        if (params.source.url.pathname.startsWith('/shorts/')) {
          const menuBottom = (document.querySelector('ytd-reel-player-overlay-renderer #menu-button #top-level-buttons-computed') as HTMLElement | null)
            || (document.querySelector('ytd-reel-player-overlay-renderer #menu-button') as HTMLElement | null)
          if (menuBottom) {
            if (shortsSideButtonMountPoint.parentElement !== menuBottom) menuBottom.appendChild(shortsSideButtonMountPoint)
            shortsSideButtonMountPoint.style.position = 'relative'
            shortsSideButtonMountPoint.style.marginTop = '8px'
            render(<WatchOnOdyseeButtons compact targets={params.buttonTargets ?? undefined} source={params.source} />, shortsSideButtonMountPoint)
            lastRenderContext = params
            return
          }
          // Fallback: side actions / overlay container
          const overlay = (document.querySelector('ytd-reel-player-overlay-renderer #actions') as HTMLElement | null)
            || (document.querySelector('ytd-reel-player-overlay-renderer') as HTMLElement | null)
            || (document.querySelector('#player.skeleton.shorts #player-wrap') as HTMLElement | null)
          if (overlay) {
            overlay.style.position = overlay.style.position || 'relative'
            if (shortsSideButtonMountPoint.parentElement !== overlay) overlay.appendChild(shortsSideButtonMountPoint)
            render(<WatchOnOdyseeButtons compact targets={params.buttonTargets ?? undefined} source={params.source} />, shortsSideButtonMountPoint)
            lastRenderContext = params
            return
          }
        }
        // Last resort: render detached to keep VDOM stable
        render(<WatchOnOdyseeButtons />, buttonMountPoint)
      } else {
        // Shorts-specific subscribe placement (channel button to the right of channel name)
        if (params.source.url.pathname.startsWith('/shorts/')) {
          if (settings.buttonChannelSub) {
            const channelBar = document.querySelector('ytd-reel-player-overlay-renderer yt-reel-channel-bar-view-model') as HTMLElement | null
            const channelName = channelBar?.querySelector('.ytReelChannelBarViewModelChannelName') as HTMLElement | null
            // Try to locate the Shorts subscribe control to height-match (button inside the view-model)
            const shortsSubscribe = (channelBar?.querySelector('yt-subscribe-button-view-model') as HTMLElement | null)
              || (document.querySelector('ytd-reel-player-overlay-renderer yt-subscribe-button-view-model') as HTMLElement | null)

            if (channelBar && channelName) {
              if (shortsSubscribeMountPoint.getAttribute('data-id') !== params.source.id || shortsSubscribeMountPoint.parentElement !== channelBar) {
                shortsSubscribeMountPoint.setAttribute('data-id', params.source.id)
                // Insert to the right of channel name
                channelName.insertAdjacentElement('afterend', shortsSubscribeMountPoint)
              }
              // Keep layout consistent and height synced to Shorts Subscribe
              shortsSubscribeMountPoint.style.display = 'inline-flex'
              shortsSubscribeMountPoint.style.alignItems = 'center'
              shortsSubscribeMountPoint.style.marginLeft = '8px'
              shortsSubscribeMountPoint.style.marginRight = '0'
              // Sync height to the actual subscribe element when it settles
              try { syncContainerHeightToReference(shortsSubscribeMountPoint, shortsSubscribe || channelName) } catch {}
              const channelTargets = (params.buttonTargets ?? []).filter(t => t.type === 'channel')
              if (channelTargets.length > 0) {
                render(<WatchOnOdyseeButtons targets={channelTargets} source={params.source} />, shortsSubscribeMountPoint)
                try { lockButtonWidthsIn(shortsSubscribeMountPoint) } catch {}
              }
            }
          }
          // Done with shorts subscribe handling
          return
        }
        // Video page: prefer placing buttons inline with the title (top area under the video)
        if (params.source.type === 'video') {
          const isShorts = params.source.url.pathname.startsWith('/shorts/')
          if (!isShorts) {
            const titleHost = (document.querySelector('ytd-watch-metadata #title') as HTMLElement | null)
              || (document.querySelector('ytd-watch-metadata h1')?.parentElement as HTMLElement | null)
            const h1 = (document.querySelector('ytd-watch-metadata #title h1') as HTMLElement | null)
              || (document.querySelector('ytd-watch-metadata h1') as HTMLElement | null)
            if (titleHost && h1) {
              const cs = getComputedStyle(titleHost)
              if (cs.position === 'static') titleHost.style.position = 'relative'
              let titleMount = titleHost.querySelector('div[data-wol-title-buttons="1"]') as HTMLElement | null
              if (!titleMount) {
                titleMount = document.createElement('div')
                titleMount.setAttribute('data-wol-title-buttons', '1')
                titleMount.style.position = 'absolute'
                titleMount.style.right = '0'
                titleMount.style.top = '0'
                titleMount.style.display = 'inline-flex'
                titleMount.style.alignItems = 'center'
                titleMount.style.pointerEvents = 'auto'
                titleMount.style.zIndex = '4'
                titleHost.appendChild(titleMount)
              }
              // Match the actual h1 height including padding
              // Prefer the title's visual first-line height and align from the title's own padding/margin
              const lh = getLineHeightPx(h1) || DEFAULT_PILL_HEIGHT
              const h1Styles = getComputedStyle(h1)
              const h1PaddingTop = parseFloat(h1Styles.paddingTop) || 0
              const h1MarginTop = parseFloat(h1Styles.marginTop) || 0
              // Set the strip height to the title line-height so chips align with the first text line (allow < 36px)
              titleMount.style.height = `${Math.round(lh)}px`
              // Offset by the padding and margin that sit above the first line
              titleMount.style.top = `${h1PaddingTop + h1MarginTop}px`

              // Render buttons
              if (buttonMountPoint.parentElement !== titleMount) {
                titleMount.appendChild(buttonMountPoint)
              }
              buttonMountPoint.style.display = 'inline-flex'
              buttonMountPoint.style.alignItems = 'stretch'
              buttonMountPoint.style.height = '100%'
              buttonMountPoint.style.marginLeft = '8px'
              buttonMountPoint.style.marginRight = '0'
              ;(buttonMountPoint.style as any).order = '1000'
              buttonMountPoint.style.flex = '0 0 auto'
              buttonMountPoint.setAttribute('data-id', params.source.id)
              render(<WatchOnOdyseeButtons fillHeight targets={params.buttonTargets ?? undefined} source={params.source} />, buttonMountPoint)
              try { lockButtonWidthsIn(buttonMountPoint) } catch {}
              ensureWatchButtonsMatchTitleHeight()

              // Add padding to h1 to prevent text from going behind buttons
              // Wait for buttons to render to get accurate width
              setTimeout(() => {
                const buttonWidth = titleMount.offsetWidth
                if (buttonWidth > 0 && h1) {
                  h1.style.paddingRight = `${buttonWidth + 12}px`
                }
              }, 0)

              // Done with preferred title placement
              return
            }
          }
          // Fallback: place our buttons in a right-aligned action wrapper so the channel name keeps space
          const subscribeAction = (mountBefore.closest('.yt-flexible-actions-view-model-wiz__action, .ytFlexibleActionsViewModelAction') as HTMLElement | null)
          const actionsContainer = (
            document.querySelector('#actions #top-level-buttons-computed') as HTMLElement | null
          ) || (subscribeAction?.parentElement as HTMLElement | null)
          if (actionsContainer) {
            // Use a dedicated right-aligned action wrapper so we don't compete with the channel name area
            let rightWrapper = actionsContainer.querySelector('div[data-wol-action-wrapper-right="1"]') as HTMLElement | null
            if (!rightWrapper) {
              rightWrapper = document.createElement('div')
              rightWrapper.setAttribute('data-wol-action-wrapper-right', '1')
              // Match YouTube action item class for consistent spacing
              rightWrapper.className = 'yt-flexible-actions-view-model-wiz__action'
              rightWrapper.style.display = 'inline-flex'
              rightWrapper.style.alignItems = 'center'
              rightWrapper.style.margin = '0'
              // Key trick: push this wrapper to the far right of the row
              rightWrapper.style.marginLeft = 'auto'
              // Ensure our wrapper doesn't flex-grow and eat channel-name width
              rightWrapper.style.flex = '0 0 auto'
              // Force order to the far right even if more actions are added later
              ;(rightWrapper.style as any).order = '9999'
            }
            if (!rightWrapper.contains(buttonMountPoint)) rightWrapper.appendChild(buttonMountPoint)
            if (rightWrapper.parentElement !== actionsContainer) actionsContainer.appendChild(rightWrapper)

            // Height sync: prefer matching the title (H1) height even if we aren't mounted under it
            try {
              const h1Ref = (document.querySelector('ytd-watch-metadata #title h1') as HTMLElement | null)
                || (document.querySelector('ytd-watch-metadata h1') as HTMLElement | null)
              if (h1Ref) syncContainerHeightToReference(buttonMountPoint, h1Ref, 0)
              else syncHeightToReference(mountBefore as HTMLElement)
            } catch {}
            buttonMountPoint.style.display = 'inline-flex'
            buttonMountPoint.style.alignItems = 'center'
            buttonMountPoint.style.alignSelf = 'center'
            buttonMountPoint.style.marginLeft = '12px'
            buttonMountPoint.style.marginRight = '0'
            buttonMountPoint.style.marginTop = '0'
            buttonMountPoint.style.flex = '0 0 auto'
            ;(buttonMountPoint.style as any).order = '1000'
            buttonMountPoint.setAttribute('data-id', params.source.id)
            render(<WatchOnOdyseeButtons fillHeight targets={params.buttonTargets ?? undefined} source={params.source} />, buttonMountPoint)
            try { lockButtonWidthsIn(buttonMountPoint) } catch {}
            ensureWatchButtonsMatchTitleHeight()

            // Precise vertical alignment: match the visual center of the first action icon
            const alignToRow = () => {
              try {
                // Prefer the title height for overall group height, even when mounted in actions row
                const h1Ref = (document.querySelector('ytd-watch-metadata #title h1') as HTMLElement | null)
                  || (document.querySelector('ytd-watch-metadata h1') as HTMLElement | null)
                // Also read a reference action button to fine tune baseline alignment
                const row = document.querySelector('#actions #top-level-buttons-computed') as HTMLElement | null
                const refBtn = (row?.querySelector('button, a, yt-button-shape button, yt-button-shape a, ytd-toggle-button-renderer button, segmented-like-dislike-button-view-model button, ytd-segmented-like-dislike-button-renderer button') as HTMLElement | null)
                  || (actionsContainer.querySelector('button, a') as HTMLElement | null)
                if (!refBtn && !h1Ref) return
                const refRect = (h1Ref || refBtn)!.getBoundingClientRect()
                const ourRect = buttonMountPoint.getBoundingClientRect()
                if (refRect.height > 0 && ourRect.height > 0) {
                  const h = Math.round(refRect.height)
                  // Set group and chip heights to exactly match the row
                  buttonMountPoint.style.height = `${h}px`
                  const anchors = buttonMountPoint.querySelectorAll('a[role="button"], a') as unknown as HTMLElement[]
                  anchors.forEach(a => {
                    a.style.height = `${h}px`
                    a.style.lineHeight = 'normal'
                    a.style.display = 'inline-flex'
                    a.style.alignItems = 'center'
                  })
                  // Rely on flex centering and add a tiny downward bias for perfect baseline alignment
                  buttonMountPoint.style.position = ''
                  buttonMountPoint.style.top = ''
                  buttonMountPoint.style.alignSelf = 'center'
                  buttonMountPoint.style.transform = 'translateY(5px)'
                }
              } catch {}
            }
            try { setTimeout(alignToRow, 0); setTimeout(alignToRow, 120) } catch {}
          } else {
            // Fallback: keep after Subscribe but still avoid shrinking
            const parent = (mountBefore as HTMLElement).parentElement
            if (parent) {
              if (buttonMountPoint.getAttribute('data-id') !== params.source.id || buttonMountPoint.parentElement !== parent) {
                buttonMountPoint.setAttribute('data-id', params.source.id)
                ;(mountBefore as HTMLElement).insertAdjacentElement('afterend', buttonMountPoint)
              }
              try {
                const h1Ref = (document.querySelector('ytd-watch-metadata #title h1') as HTMLElement | null)
                  || (document.querySelector('ytd-watch-metadata h1') as HTMLElement | null)
                if (h1Ref) syncContainerHeightToReference(buttonMountPoint, h1Ref, 0)
                else syncHeightToReference(mountBefore as HTMLElement)
              } catch {}
              buttonMountPoint.style.display = 'inline-flex'
              buttonMountPoint.style.alignItems = 'center'
              buttonMountPoint.style.alignSelf = 'center'
              buttonMountPoint.style.marginLeft = '12px'
              buttonMountPoint.style.marginRight = '0'
              buttonMountPoint.style.marginTop = '0'
              buttonMountPoint.style.flex = '0 0 auto'
              ;(buttonMountPoint.style as any).order = '1000'
              render(<WatchOnOdyseeButtons fillHeight targets={params.buttonTargets ?? undefined} source={params.source} />, buttonMountPoint)
              try { lockButtonWidthsIn(buttonMountPoint) } catch {}
              ensureWatchButtonsMatchTitleHeight()

              // Fallback alignment relative to Subscribe element
              const alignToSub = () => {
                try {
                  const h1Ref = (document.querySelector('ytd-watch-metadata #title h1') as HTMLElement | null)
                    || (document.querySelector('ytd-watch-metadata h1') as HTMLElement | null)
                  const refRect = (h1Ref || (mountBefore as HTMLElement)).getBoundingClientRect()
                  const ourRect = buttonMountPoint.getBoundingClientRect()
                  if (refRect.height > 0 && ourRect.height > 0) {
                    const h = Math.round(refRect.height)
                    buttonMountPoint.style.height = `${h}px`
                    const anchors = buttonMountPoint.querySelectorAll('a[role="button"], a') as unknown as HTMLElement[]
                    anchors.forEach(a => {
                      a.style.height = `${h}px`
                      a.style.lineHeight = 'normal'
                      a.style.display = 'inline-flex'
                      a.style.alignItems = 'center'
                    })
                    buttonMountPoint.style.position = ''
                    buttonMountPoint.style.top = ''
                    buttonMountPoint.style.alignSelf = 'center'
                    buttonMountPoint.style.transform = 'translateY(5px)'
                  }
                } catch {}
              }
              try { setTimeout(alignToSub, 0); setTimeout(alignToSub, 120) } catch {}
            }
          }
        } else {
          // Channel and other pages: try creating a dedicated action item right next to Subscribe (preferred)
          dbg(`[CHANNEL-DEBUG] Rendering channel page buttons`)
          {
            const subscribeActionBlock = (mountBefore.closest('.ytFlexibleActionsViewModelAction') as HTMLElement | null)
              || (document.querySelector('yt-flexible-actions-view-model .ytFlexibleActionsViewModelAction') as HTMLElement | null)
            dbg(`[CHANNEL-DEBUG] Found subscribeActionBlock:`, !!subscribeActionBlock)
            if (subscribeActionBlock) {
              // Schedule placement until a reliable height is available
              const myVersion = (++channelMainActionVersion)
              const maxAttempts = 40
              dbg(`[CHANNEL-DEBUG] Starting button placement attempts (version ${myVersion})`)
              const attemptDelay = 60
              const tryPlace = (attempt: number) => {
                if (myVersion !== channelMainActionVersion) {
                  dbg(`[CHANNEL-DEBUG] tryPlace cancelled - version mismatch`)
                  return
                }
                let channelAction = subscribeActionBlock.parentElement?.querySelector('div[data-wol-channel-action="1"]') as HTMLElement | null
                if (!channelAction) {
                  dbg(`[CHANNEL-DEBUG] Creating new channelAction container`)
                  channelAction = document.createElement('div')
                  channelAction.setAttribute('data-wol-channel-action', '1')
                  channelAction.className = 'ytFlexibleActionsViewModelAction'
                  channelAction.style.display = 'inline-flex'
                  channelAction.style.alignItems = 'center'
                  channelAction.style.margin = '0'
                  subscribeActionBlock.insertAdjacentElement('afterend', channelAction)
                }
                if (!channelAction.contains(buttonMountPoint)) channelAction.appendChild(buttonMountPoint)
                buttonMountPoint.setAttribute('data-id', params.source.id)

                const refBtn = findSubscribeRefButton(mountBefore as HTMLElement)
                const refH = refBtn ? (refBtn.offsetHeight || refBtn.clientHeight || 0) : 0
                dbg(`[CHANNEL-DEBUG] tryPlace attempt ${attempt}: refBtn height = ${refH}`)
                if (refH < 30 && attempt < maxAttempts) {
                  // Wait a bit longer for the VM to finish sizing the inner button
                  dbg(`[CHANNEL-DEBUG] Height too small (${refH}px), retrying in ${attemptDelay}ms (attempt ${attempt + 1}/${maxAttempts})`)
                  setTimeout(() => tryPlace(attempt + 1), attemptDelay)
                  return
                }
                // Height sync and render
                dbg(`[CHANNEL-DEBUG] Rendering button (attempt ${attempt}, height ${refH}px)`)
                try { syncContainerHeightToReference(channelAction!, refBtn || (mountBefore as HTMLElement)) } catch {}
                buttonMountPoint.style.display = 'inline-flex'
                buttonMountPoint.style.alignItems = 'center'
                // Channel main: slightly closer to Subscribe
                buttonMountPoint.style.marginLeft = '8px'
                buttonMountPoint.style.marginRight = '0'
                ;(buttonMountPoint.style as any).order = '1000'
                buttonMountPoint.style.flex = '0 0 auto'
                render(<WatchOnOdyseeButtons targets={params.buttonTargets ?? undefined} source={params.source} />, buttonMountPoint)
                try { lockButtonWidthsIn(buttonMountPoint) } catch {}
                const renderEndTime = performance.now()
                dbg(`[CHANNEL-DEBUG] Button rendered successfully in ${(renderEndTime - updateButtonsStartTime).toFixed(2)}ms`)
              }
              tryPlace(0)
              // Skip legacy fallback paths; scheduled placement will handle it
              return
            }
          }
          // Channel and other pages: position immediately after the Subscribe control inside the same action block
          const actionBlock = (mountBefore.closest('.ytFlexibleActionsViewModelAction') as HTMLElement | null)
            || (mountBefore.closest('.yt-flexible-actions-view-model-wiz__action') as HTMLElement | null)
            || (mountBefore.parentElement as HTMLElement | null)
          if (actionBlock) {
            if (buttonMountPoint.getAttribute('data-id') !== params.source.id || buttonMountPoint.parentElement !== actionBlock) {
              (mountBefore as HTMLElement).insertAdjacentElement('afterend', buttonMountPoint)
              buttonMountPoint.setAttribute('data-id', params.source.id)
            }
          } else {
            // Watch page fallback: insert strictly after the actual Subscribe button element
            const subscribeEl = (
              mountBefore.closest('ytd-subscribe-button-renderer') as Element | null
            ) || (
              document.querySelector('#owner ytd-subscribe-button-renderer') as Element | null
            ) || (
              document.querySelector('yt-subscribe-button-view-model') as Element | null
            ) || mountBefore
            if (buttonMountPoint.getAttribute('data-id') !== params.source.id || buttonMountPoint.parentElement !== subscribeEl.parentElement) {
              subscribeEl.insertAdjacentElement('afterend', buttonMountPoint)
              buttonMountPoint.setAttribute('data-id', params.source.id)
            }
            // If not visible (container doesn't render light DOM), try known visible buttons containers
            try {
              if (!buttonMountPoint.offsetParent) {
                const fallbackButtons = (
                  document.querySelector('ytd-page-header-renderer #buttons') as HTMLElement | null
                ) || (
                  document.querySelector('ytd-c4-tabbed-header-renderer #buttons') as HTMLElement | null
                ) || (
                  document.querySelector('#channel-header-container #buttons') as HTMLElement | null
                ) || (
                  document.querySelector('#channel-header #buttons') as HTMLElement | null
                )
                if (fallbackButtons && buttonMountPoint.parentElement !== fallbackButtons) {
                  fallbackButtons.appendChild(buttonMountPoint)
                }
              }
            } catch {}
          }
          // Apply height sync (works even if Subscribe isn’t yet measured)
          syncHeightToReference(mountBefore as HTMLElement)
          buttonMountPoint.style.display = 'inline-flex'
          buttonMountPoint.style.alignItems = 'center'
          // Give the channel name more room and keep our buttons to the far right
          buttonMountPoint.style.marginLeft = '12px'
          buttonMountPoint.style.marginRight = '0'
          ;(buttonMountPoint.style as any).order = '1000'
          buttonMountPoint.style.flex = '0 0 auto'
          render(<WatchOnOdyseeButtons targets={params.buttonTargets ?? undefined} source={params.source} />, buttonMountPoint)
        }
      }
    }
    lastRenderContext = params
  }

  async function findVideoElementAwait(source: Source) {
    let videoElement: HTMLVideoElement | null = null
    while (!(videoElement = document.querySelector(source.platform.htmlQueries.videoPlayer))) await sleep(200)
    return videoElement
  }

  async function getSourceByUrl(url: URL): Promise<Source | null> {
    const platform = getSourcePlatfromSettingsFromHostname(new URL(location.href).hostname)
    if (!platform) return null
    // Store channel id early from ytInitialPlayerResponse if present on watch pages
    if (url.pathname === '/watch') {
      const pr = (window as any)?.ytInitialPlayerResponse?.videoDetails
      if (pr?.channelId) document.documentElement.setAttribute('data-wol-channel-id', pr.channelId)
      if (lastLoggedHref !== url.href) logger.log('ytInitialPlayerResponse.videoDetails present:', !!pr)
    }
    // Also capture channelId early on Shorts pages
    if (url.pathname.startsWith('/shorts/')) {
      const pr = (window as any)?.ytInitialPlayerResponse?.videoDetails
      if (pr?.channelId) document.documentElement.setAttribute('data-wol-channel-id', pr.channelId)
    }
    if (url.pathname === '/watch' && url.searchParams.has('v')) {
      // Try multiple strategies and cache as a data- attribute
      let cid: string | null = null
      const pr = (window as any)?.ytInitialPlayerResponse?.videoDetails
      if (pr?.channelId) cid = pr.channelId
      if (!cid) cid = document.querySelector<HTMLMetaElement>('meta[itemprop="channelId"]')?.content || null
      if (!cid) cid = await getWatchPageChannelId()
      if (cid) document.documentElement.setAttribute('data-wol-channel-id', cid)
      if (lastLoggedHref !== url.href) logger.log('Initial watch page channel ID (any method):', cid)

      // IMPORTANT: Populate persistent cache with verified UC from watch page
      // This is ACCURATE because it's the actual channel of the video being watched
      if (cid && cid.startsWith('UC')) {
        try {
          // Also try to get the channel handle from the page
          let channelHandle: string | null = null

          // Try to find handle from channel link
          const channelLink = document.querySelector('#owner #channel-name a[href^="/@"], ytd-channel-name#channel-name a[href^="/@"]') as HTMLAnchorElement | null
          if (channelLink) {
            const handleMatch = channelLink.href.match(/\/@([^\/]+)/)
            if (handleMatch) {
              channelHandle = handleMatch[1]
            }
          }

          // Also check ytInitialPlayerResponse for author
          if (!channelHandle && pr?.author) {
            // Sometimes author is "@handle" format
            if (pr.author.startsWith('@')) {
              channelHandle = pr.author.slice(1)
            }
          }

          if (channelHandle) {
            // Persist the verified mapping silently
            (async () => {
              try {
                await channelCache.putHandle(channelHandle!, cid)
                await channelCache.putYtUrl(`/@${channelHandle}`, cid)
                await channelCache.putYtUrl(`/channel/${cid}`, cid)

                // Also update in-memory caches for immediate use
                const srcPlatform = getSourcePlatfromSettingsFromHostname(location.hostname)!
                const srcs = [{ platform: srcPlatform, id: cid, type: 'channel' as const, url: new URL(location.href), time: null }]
                const resolved = await getTargetsBySources(...srcs)
                const target = resolved[cid] || null
                if (target) {
                  ucResolvePageCache.set(cid, target)
                  handleResolvePageCache.set(channelHandle!, target)
                  ytUrlResolvePageCache.set(`/@${channelHandle}`, target)
                  ytUrlResolvePageCache.set(`/channel/${cid}`, target)
                }
              } catch (err) {
                // Silently fail - cache population is best-effort
              }
            })()
          }
        } catch {
          // Silently fail - cache extraction is best-effort
        }
      }

      // Build video source from the watch URL
      const videoId = url.searchParams.get('v')!
      const timeParam = url.searchParams.get('t')
      const time = timeParam ? parseYouTubeURLTimeString(timeParam) : null
      if (lastLoggedHref !== url.href) logger.log('Watch page video id:', videoId)
      return { platform, id: videoId, type: 'video', url, time }
    }
    else if (url.pathname.startsWith('/channel/')) {
      return {
        id: url.pathname.substring("/channel/".length),
        platform,
        time: null,
        type: 'channel',
        url
      }
    }
    // Shorts video pages
    else if (url.pathname.startsWith('/shorts/')) {
      const id = url.pathname.split('/')[2]
      if (id) {
      return {
          id,
        platform,
        time: null,
          type: 'video',
        url
      }
    }
    }
    else if (url.pathname.startsWith('/c/') || url.pathname.startsWith('/user/') || url.pathname.startsWith('/@')) {
      // Prefer DOM link element with feeds/videos.xml (present on channel pages)
      const altRss = document.querySelector('link[rel="alternate"][href*="feeds/videos.xml?channel_id="]') as HTMLLinkElement | null
      let id: string | null = null
      if (altRss?.href) {
        try { id = new URL(altRss.href).searchParams.get('channel_id') } catch { }
      }
      // Fallback: fetch page HTML and parse
      if (!id) {
      const content = await (await fetch(location.href)).text()
      const prefix = `https://www.youtube.com/feeds/videos.xml?channel_id=`
      const suffix = `"`
        const startsAt = content.indexOf(prefix)
        if (startsAt >= 0) {
          const after = startsAt + prefix.length
          const endsAt = content.indexOf(suffix, after)
          if (endsAt > after) id = content.substring(after, endsAt)
        }
      }
      if (!id) return null
      return {
        id,
        platform,
        time: null,
        type: 'channel',
        url
      }
    }

    return null
  }

  async function getWatchPageChannelId(): Promise<string | null> {
    // 1) Fast path: meta tag
    const meta = document.querySelector('meta[itemprop="channelId"]') as HTMLMetaElement | null
    if (meta?.content) return meta.content

    // 2) LD+JSON: look for VideoObject.author.channelId
    for (const s of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'))) {
      try {
        const j = JSON.parse(s.textContent || 'null')
        if (!j) continue
        // Sometimes it's an array; sometimes a single object
        const arr = Array.isArray(j) ? j : [j]
        for (const o of arr) {
          if (o?.['@type'] === 'VideoObject') {
            const ch = o?.author?.channelId || o?.author?.identifier || o?.author?.url
            if (typeof ch === 'string' && ch.startsWith('UC')) return ch
          }
        }
      } catch { }
    }

    // 3) From an @handle on the page -> fetch and parse channel id
    const handleSel = [
      'ytd-channel-name#channel-name a[href^="/@"]',      // current watch layout
      '#owner #channel-name a[href^="/@"]',
      'ytd-video-owner-renderer a[href^="/@"]',
      // Shorts channel bar
      'ytd-reel-player-overlay-renderer yt-reel-channel-bar-view-model a[href^="/@"]'
    ]
    for (const sel of handleSel) {
      const href = document.querySelector<HTMLAnchorElement>(sel)?.getAttribute('href')
      if (!href) continue
      try {
        const pageUrl = new URL(href, location.origin).href
        const text = await (await fetch(pageUrl, { credentials: 'same-origin' })).text()
        // Reuse your existing parsing trick
        const prefix = 'https://www.youtube.com/feeds/videos.xml?channel_id='
        const i = text.indexOf(prefix)
        if (i >= 0) {
          const after = i + prefix.length
          const end = text.indexOf('"', after)
          if (end > after) {
            const id = text.substring(after, end)
            if (id.startsWith('UC')) return id
          }
        }
        // Secondary scrape: look for "channelId":"UC..."
        const m = text.match(/"channelId"\s*:\s*"([^"]+)"/)
        if (m?.[1]?.startsWith('UC')) return m[1]
      } catch { }
    }

    return null
  }

  async function getTargetsBySources(...sources: Source[]) {
    const params: Parameters<typeof requestResolveById>[0] = sources.map((source) => ({ id: source.id, type: source.type }))
    const platform = targetPlatformSettings[settings.targetPlatform]
    const results = await requestResolveById(params)
    if (!results) {
      // Extension context invalidated or other error
      return Object.fromEntries(sources.map(source => [source.id, null]))
    }

    const targets: Record<string, Target | null> = Object.fromEntries(
      sources.map((source) => {
        const result = results[source.id]
        if (!result) return [
          source.id,
          null
        ]

        return [
          source.id,
          {
            type: result.type,
            odyseePathname: result.id,
            platform,
            time: source.time
          }
        ]
      })
    )

    return targets
  }
  // We should get this from background, so the caching works and we don't get errors in the future if yt decides to impliment CORS
  async function requestResolveById(...params: Parameters<typeof resolveById>): Promise<ReturnType<typeof resolveById> | null> {
    try {
      const response = await new Promise<string | null | 'error'>((resolve, reject) => {
        chrome.runtime.sendMessage({ method: 'resolveUrl', data: JSON.stringify(params) }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            resolve(response)
          }
        })
      })
    if (response?.startsWith('error:')) {
        logger.error("Background error on:", params)
      throw new Error(`Background error. ${response ?? ''}`)
    }
    return response ? JSON.parse(response) : null
    } catch (error) {
      if (error instanceof Error && error.message.includes('Extension context invalidated')) {
        logger.warn('Extension context invalidated - please reload the page to re-enable Watch on Odysee functionality')
        extensionContextInvalidated = true
        return null
      }
      logger.error("Error communicating with background script:", error)
      throw error
    }
  }

  // Request new tab
  // Guards to prevent multiple tab opens from rapid clicks or duplicate triggers
  const openedOdyseeGuard = new Map<string, number>() // href -> lastOpenTs
  const SUPPRESS_AUTO_MS = 15000
  const OPEN_DEBOUNCE_MS = 1200
  const autoRedirectSuppressByUrl = new Map<string, number>() // youtubeHref -> suppressUntilTs

  // Helper to clear redirect tracking when settings are toggled
  async function resetAutoRedirectSuppress() {
    try { lastRedirectTime = 0 } catch {}
    try { redirectedUrls.clear() } catch {}
  }

  async function openNewTab(url: URL, reason: 'user' | 'auto' = 'user') {
    const now = Date.now()

    if (reason === 'user') {
      // Debounce identical opens for a short window
      const last = openedOdyseeGuard.get(url.href) || 0
      if (now - last < OPEN_DEBOUNCE_MS) return
      openedOdyseeGuard.set(url.href, now)
      setTimeout(() => { openedOdyseeGuard.delete(url.href) }, Math.max(OPEN_DEBOUNCE_MS * 5, 8000))

      // Suppress any auto-redirects for the current YouTube page for a bit to prevent immediate re-redirect
      try { autoRedirectSuppressByUrl.set(location.href, now + SUPPRESS_AUTO_MS) } catch {}

      // Do not record here; background will mark successful opens
    } else {
      // Auto: honor basic suppression window for this page to prevent rapid redirects
      const supMem = autoRedirectSuppressByUrl.get(location.href) || 0
      if (now < supMem) return
    }

    try {
      chrome.runtime.sendMessage({ method: 'openTab', data: JSON.stringify({ href: url.href, reason, clickedAt: now }) }, () => {
        if (chrome.runtime.lastError) {
          // Background/service worker not available. Do not directly open.
          // Suppress silently to avoid duplicate opens after reload.
          return
        }
      })
    } catch (error) {
      // Background unavailable; do not directly open. Suppress silently.
      return
    }
  }

  function findTargetFromSourcePage(source: Source): Target | null {
    const linksContainer =
      source.type === 'video' ?
        document.querySelector(source.platform.htmlQueries.videoDescription) :
        source.platform.htmlQueries.channelLinks ? document.querySelector(source.platform.htmlQueries.channelLinks) : null

    if (linksContainer) {
      const anchors = Array.from(linksContainer.querySelectorAll<HTMLAnchorElement>('a'))

      for (const anchor of anchors) {
        if (!anchor.href) continue
        const url = new URL(anchor.href)
        let odyseeURL: URL | null = null

        // Extract real link from youtube's redirect link
        if (source.platform === sourcePlatfromSettings['youtube.com']) {
          if (!targetPlatforms.some(([key, platform]) => url.searchParams.get('q')?.startsWith(platform.domainPrefix))) continue
          odyseeURL = new URL(url.searchParams.get('q')!)
        }
        // Just directly use the link itself on other platforms
        else {
          if (!targetPlatforms.some(([key, platform]) => url.href.startsWith(platform.domainPrefix))) continue
          odyseeURL = new URL(url.href)
        }

        if (odyseeURL) {
          return {
            odyseePathname: odyseeURL.pathname.substring(1),
            time: null,
            type: odyseeURL.pathname.substring(1).includes('/') ? 'video' : 'channel',
            platform: targetPlatformSettings[settings.targetPlatform]
          }
        }
      }
    }
    return null
  }

  function getOdyseeUrlByTarget(target: Target) {
    const url = new URL(`${target.platform.domainPrefix}${target.odyseePathname}`)
    if (target.time) url.searchParams.set('t', target.time.toFixed(0))

    return url
  }

  // Clean up all existing overlays
  async function cleanupOverlays() {
    const existingOverlays = document.querySelectorAll('[data-wol-overlay]')
    const pinnedOverlays = document.querySelectorAll('[data-wol-overlay][data-wol-pinned="1"]')
    const bodyOverlays = Array.from(existingOverlays).filter(el => el.parentElement === document.body)
    dbg('Watch on Odysee: Cleaning up', existingOverlays.length, 'overlays (', pinnedOverlays.length, 'pinned,', bodyOverlays.length, 'on body)')

    // CRITICAL FIX: Disconnect all observers FIRST to prevent them from recreating overlays
    for (const [, ov] of overlayState.entries()) {
      try { ov.observer?.disconnect() } catch {}
    }
    // Clear the entire overlayState map to release all references
    overlayState.clear()
    dbg('Watch on Odysee: Cleared overlayState, disconnected', overlayState.size, 'observers')

    // Cleanup hover observers/timers that might recreate overlays
    // Note: WeakMap is not iterable, so we can't loop over it
    // We'll just create a new one to clear references
    // The old cleanup functions will be garbage collected
    hoverFloatCleanupMap = new WeakMap()
    hoverMoMap = new WeakMap()
    hoverMoTimerMap = new WeakMap()

    // CRITICAL FIX: Remove all overlays synchronously to prevent observer race conditions
    // The async batch remove was too slow, allowing observers to recreate overlays
    existingOverlays.forEach(el => {
      try { el.remove() } catch {}
    })

    // Double-check: if any overlays still exist (race condition), remove them again
    const remainingOverlays = document.querySelectorAll('[data-wol-overlay]')
    if (remainingOverlays.length > 0) {
      dbg('Watch on Odysee: Found', remainingOverlays.length, 'remaining overlays after cleanup, removing again...')
      remainingOverlays.forEach(el => {
        try { el.remove() } catch {}
      })
    }

    // AGGRESSIVE CLEANUP: Also remove any orphaned overlay buttons without data attributes
    // These might be old overlays that lost their attributes somehow
    const suspectOverlays = Array.from(document.querySelectorAll('div[role="button"][aria-label="Watch on Odysee"]')).filter(el => {
      // Only remove if it doesn't have the data attribute (to avoid removing newly created ones)
      return !el.hasAttribute('data-wol-overlay')
    })
    if (suspectOverlays.length > 0) {
      dbg('Watch on Odysee: Found', suspectOverlays.length, 'suspect overlays without data attributes, removing...')
      suspectOverlays.forEach(el => {
        try { el.remove() } catch {}
      })
    }

    // Clear enhanced flags so they can be re-enhanced if setting is re-enabled
    await asyncBatchProcess<HTMLElement>(
      'a[data-wol-enhanced]',
      el => el.removeAttribute('data-wol-enhanced')
    )

    // Reset global overlay state to avoid re-attaching stale overlays across navigations
    overlayState.clear()
    resetRelatedBatch()

    // Also clear local resolved cache to force fresh resolution
    resolvedLocal.clear()

    dbg('Watch on Odysee: Cleanup complete')
  }

  // Clean up stale overlays that no longer have corresponding videos
  async function cleanupStaleOverlays() {
    const allOverlays = Array.from(document.querySelectorAll('[data-wol-overlay]'))
    const toRemove: Element[] = []
    for (const overlay of allOverlays) {
      const overlayVideoId = overlay.getAttribute('data-wol-overlay')
      if (overlayVideoId) {
        // Check if there's still a video link for this ID
        const videoExists = document.querySelector(`a[href*="${overlayVideoId}"]`)
        if (!videoExists) {
          toRemove.push(overlay)
        }
      }
    }
    // Batch remove with yielding
    for (let i = 0; i < toRemove.length; i++) {
      toRemove[i].remove()
      if ((i + 1) % 10 === 0) await idleYield(30)
    }
  }

  // Global overlay state tracking
  const overlayState = new Map<string, {
    videoId: string,
    element: HTMLElement,
    host: HTMLElement,
    url: string,
    lastSeen: number,
    generation: number,
    observer?: MutationObserver | null
  }>()
  // Hover-scoped observers (used outside results only)
  let hoverMoMap = new WeakMap<HTMLElement, MutationObserver>()
  let hoverMoTimerMap = new WeakMap<HTMLElement, number>()
  let hoverFloatCleanupMap = new WeakMap<HTMLElement, () => void>()
  // Results page: track channel renderer button + observer to avoid duplicates across toggles
  // Use Map (not WeakMap) so we can iterate and reliably disconnect observers during cleanup
  const channelRendererState = new Map<HTMLElement, { btn: HTMLElement, mo: MutationObserver | null }>()
  // Retry guard for channel renderer button injection (per-renderer bounded retries)
  var channelRendererRetryCount = new WeakMap<HTMLElement, number>()
  // Version counter to invalidate old observers for channel renderers (prevents duplicate reinserts)
  let channelRendererButtonVersion = 0
  let channelRendererButtonRunning = false
  // Results page: track per-video renderer compact channel chip + observer
  // Use Map (not WeakMap) for the same reason as above
  const resultsVideoChipState = new Map<HTMLElement, { chip: HTMLElement, mo: MutationObserver | null }>()
  // Concurrency/throttle for results video chip refresher
  let resultsVideoChipRunning = false
  let resultsVideoChipPendingRerun = false
  let lastResultsChipsSig = ''
  let lastResultsChipsAt = 0
  let resultsChipsQuietUntil = 0
  let resultsChipsBackoffMs = 0
  let resultsChipsRetryKey: string | null = null
  // Cross-refresh tracking to prevent ping-pong loops between CR and VR refreshers
  let lastChipsToButtonsNudge = 0
  let lastButtonsToChipsNudge = 0
  const MIN_CROSS_NUDGE_INTERVAL = 2000 // Don't ping-pong more than once every 2 seconds
  // Local resolve cache for listing pages (video/channel -> Target|null)
  const resolvedLocal = new Map<string, Target | null>()
  // Per-page UC -> Target cache shared between VR chips and CR buttons
  const ucResolvePageCache = new Map<string, Target | null>()
  // Per-page @handle (without @) -> Target cache to enable fast chip injection without UC
  const handleResolvePageCache = new Map<string, Target | null>()
  // Per-page YouTube channel URL -> Target cache (e.g., "/@veritasium" or "/channel/UCHnyfMqiRRG1u-2MsSQLbXA")
  const ytUrlResolvePageCache = new Map<string, Target | null>()
  // Persist preferred anchor per video id to keep overlay in the same area across re-renders
  const overlayAnchorPrefs = new Map<string, { anchor: 'top-left' | 'bottom-left', x: number, y: number }>()
  // Channel main page action placement version guard (prevents stale scheduled attempts)
  let channelMainActionVersion = 0

  // Cached mappings from ytInitialData on results pages
  let initialDataMapCache: {
    url: string,
    handleToUC: Map<string, string>,
    videoToUC: Map<string, string>,
    collectedAt: number
  } | null = null

  function getYtInitialData(): any | null {
    try {
      const anyWin = (window as any)
      if (anyWin?.ytInitialData) return anyWin.ytInitialData
      // Fallback: scrape from script tags
      const scripts = Array.from(document.querySelectorAll('script'))
      for (const s of scripts) {
        const txt = s.textContent || ''
        const idx = txt.indexOf('ytInitialData')
        if (idx >= 0) {
          // Try to locate assignment pattern: ytInitialData = {...};
          const m = txt.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});/)
          if (m && m[1]) {
            try { return JSON.parse(m[1]) } catch {}
          }
        }
      }
    } catch {}
    return null
  }

  function collectMappingsFromInitialData(data: any): { handleToUC: Map<string, string>, videoToUC: Map<string, string> } {
    const handleToUC = new Map<string, string>()
    const videoToUC = new Map<string, string>()

    const pushHandle = (h?: string | null, uc?: string | null) => {
      if (!h || !uc) return
      const norm = h.startsWith('@') ? h.slice(1) : h
      if (uc.startsWith('UC') && !handleToUC.has(norm)) handleToUC.set(norm, uc)
    }
    const pushVideo = (vid?: string | null, uc?: string | null) => {
      if (!vid || !uc) return
      if (uc.startsWith('UC') && !videoToUC.has(vid)) videoToUC.set(vid, uc)
    }

    const stack: any[] = [data]
    while (stack.length) {
      const node = stack.pop()
      if (!node || typeof node !== 'object') continue
      try {
        if (node.videoRenderer) {
          const vr = node.videoRenderer
          const vid = vr?.videoId || null
          const run = (vr?.ownerText?.runs?.[0]) || (vr?.shortBylineText?.runs?.[0]) || (vr?.longBylineText?.runs?.[0]) || null
          const handleText: string | null = (run?.text && String(run.text).startsWith('@')) ? run.text : null
          const uc = run?.navigationEndpoint?.browseEndpoint?.browseId || null
          pushHandle(handleText, uc)
          pushVideo(vid, uc)
        }
        if (node.channelRenderer) {
          const cr = node.channelRenderer
          const uc = cr?.channelId || cr?.navigationEndpoint?.browseEndpoint?.browseId || null
          // canonicalBaseUrl: "/@handle"
          const cbu = cr?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || ''
          const handleFromCbu = (typeof cbu === 'string' && cbu.startsWith('/@')) ? cbu.slice(1) : null
          // Some variants store handle under "handleText" / "@handle"
          const handleText = cr?.handleText || null
          const titleRun = cr?.title?.runs?.[0]?.text || null
          const guessHandle = (h?: string | null) => { if (h && h.startsWith('@')) pushHandle(h, uc) }
          guessHandle(handleFromCbu)
          guessHandle(handleText)
          guessHandle(titleRun && String(titleRun).startsWith('@') ? titleRun : null)
        }
      } catch {}
      try {
        for (const k of Object.keys(node)) {
          const v = node[k]
          if (v && typeof v === 'object') stack.push(v)
        }
      } catch {}
    }
    return { handleToUC, videoToUC }
  }

  function getInitialDataMappings(force = false) {
    const href = location.href
    if (!force && initialDataMapCache && initialDataMapCache.url === href) return initialDataMapCache
    try {
      const data = getYtInitialData()
      if (!data) { initialDataMapCache = { url: href, handleToUC: new Map(), videoToUC: new Map(), collectedAt: Date.now() }; return initialDataMapCache }
      const maps = collectMappingsFromInitialData(data)
      initialDataMapCache = { url: href, handleToUC: maps.handleToUC, videoToUC: maps.videoToUC, collectedAt: Date.now() }
      if (WOL_DEBUG) {
        dbg('[RESULTS][MAP] collected from initialData: handles=', maps.handleToUC.size, 'videos=', maps.videoToUC.size)
        // Log all handle mappings to see what YouTube provided
        for (const [handle, uc] of maps.handleToUC.entries()) {
          dbg('[RESULTS][MAP] handle mapping:', '@' + handle, '->', uc)
        }
      }
    } catch { initialDataMapCache = { url: href, handleToUC: new Map(), videoToUC: new Map(), collectedAt: Date.now() } }
    return initialDataMapCache
  }

  // Enhanced cleanup for specific page contexts only
  async function cleanupOverlaysByPageContext() {
    const currentPath = window.location.pathname
    // Only clear on the dedicated Shorts player page; keep overlays on /watch for related content
    if ((currentPath.startsWith('/shorts/') && currentPath.split('/').length === 3)) {
      await cleanupOverlays()
    }
  }

  // Cleanup helper for channel buttons on results page to avoid duplicate reinsertion
  async function cleanupResultsChannelButtons(options?: { disconnectOnly?: boolean }) {
    try {
      // Phase 1: disconnect and remove based on tracked state (covers stale nodes across navigations)
      let idx = 0
      for (const [cr, st] of channelRendererState.entries()) {
        try { st?.mo?.disconnect() } catch {}
        if (!options?.disconnectOnly) {
          try { st?.btn?.remove() } catch {}
          try { cr.removeAttribute('data-wol-channel-button') } catch {}
        }
        channelRendererState.delete(cr)
        if ((++idx) % 10 === 0) await idleYield(30)
      }

      // Phase 2: sweep DOM (handles any wrappers that were not tracked for any reason)
      const renderers = Array.from(document.querySelectorAll('ytd-channel-renderer')) as HTMLElement[]
      for (let i = 0; i < renderers.length; i++) {
        const cr = renderers[i]
        if (!options?.disconnectOnly) {
          try {
            cr.querySelectorAll('[data-wol-results-channel-btn]').forEach(el => el.remove())
            cr.removeAttribute('data-wol-channel-button')
            cr.removeAttribute('data-wol-channel-button-pending')
          } catch {}
        }
        if ((i + 1) % 12 === 0) await idleYield(25)
      }
    } catch {}
  }

  // Cleanup helper for inline channel chips in video results to avoid stale observers
  async function cleanupResultsVideoChips(options?: { disconnectOnly?: boolean }) {
    try {
      // Phase 1: disconnect and clear from tracked state
      let idx = 0
      for (const [vr, st] of resultsVideoChipState.entries()) {
        try { st?.mo?.disconnect() } catch {}
        if (!options?.disconnectOnly) {
          try { st?.chip?.remove() } catch {}
        }
        resultsVideoChipState.delete(vr)
        if ((++idx) % 15 === 0) await idleYield(30)
      }

      // Phase 2: sweep DOM for any leftover chips
      const vrs = Array.from(document.querySelectorAll('ytd-video-renderer')) as HTMLElement[]
      for (let i = 0; i < vrs.length; i++) {
        const vr = vrs[i]
        if (!options?.disconnectOnly) {
          try { vr.querySelectorAll('[data-wol-inline-channel]').forEach(el => el.remove()) } catch {}
        }
        if ((i + 1) % 15 === 0) await idleYield(30)
      }
    } catch {}
  }

  // Strict visibility enforcement for results channel chips
  function enforceResultsChannelChipVisibility() {
    try {
      const allow = (location.pathname === '/results') && !!settings.resultsApplySelections && !!settings.buttonChannelSub
      if (!allow) {
        triggerCleanupResultsVideoChips()
      }
    } catch {}
  }

  // Helper: Extract UC mappings from ytInitialData on search results page
  function extractSearchResultsUCMappings(): Map<string, string> {
    const mappings = new Map<string, string>()

    try {
      // Try to get ytInitialData from window
      const initialData = (window as any).ytInitialData || (window as any).ytcfg?.data_?.INITIAL_DATA
      if (!initialData) {
        return mappings
      }

      // Recursively search for channel info in the data
      const findChannels = (obj: any, depth = 0): void => {
        if (!obj || typeof obj !== 'object' || depth > 10) return

        // Look for channel renderer objects
        if (obj.channelRenderer) {
          const cr = obj.channelRenderer
          const channelId = cr.channelId
          const vanityUrl = cr.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
                          cr.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url

          if (channelId && channelId.startsWith('UC') && vanityUrl) {
            // Extract handle from URL like "/@veritasium" or "/c/veritasium"
            const handleMatch = vanityUrl.match(/\/@([^\/]+)/)
            if (handleMatch) {
              const handle = handleMatch[1]
              mappings.set(handle, channelId)
            }
          }
        }

        // Look for video renderer objects with channel info
        if (obj.videoRenderer) {
          const vr = obj.videoRenderer
          const channelId = vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
                          vr.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
          const channelUrl = vr.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ||
                           vr.longBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url

          if (channelId && channelId.startsWith('UC') && channelUrl) {
            const handleMatch = channelUrl.match(/\/@([^\/]+)/)
            if (handleMatch) {
              const handle = handleMatch[1]
              if (!mappings.has(handle)) {
                mappings.set(handle, channelId)
              }
            }
          }
        }

        // Recurse through object properties
        for (const key in obj) {
          if (Array.isArray(obj[key])) {
            for (const item of obj[key]) {
              findChannels(item, depth + 1)
            }
          } else {
            findChannels(obj[key], depth + 1)
          }
        }
      }

      findChannels(initialData)
    } catch {
      // Silently fail
    }

    return mappings
  }

  // Ensure channel renderer buttons (top channel section on results) are present
  async function refreshResultsChannelRendererButtons() {
    try {
      if (location.pathname !== '/results') return
      if (!settings.resultsApplySelections || !settings.buttonChannelSub) return

      // Guard: avoid running with stale ytInitialData immediately after SPA navigation
      const myGen = overlayGeneration
      const navDiff = Date.now() - overlayGenerationBumpedAt
      if (navDiff < 150) {
        await new Promise(r => setTimeout(r, 150 - navDiff))
      }
      if (myGen !== overlayGeneration) return

      // If already running, reschedule once shortly after to pick up newly-resolved UC cache
      if (channelRendererButtonRunning) {
        scheduleRefreshChannelButtons(150)
        return
      }

      if (WOL_DEBUG) dbg('[RESULTS][CR] begin, selections:', settings.resultsApplySelections, 'buttonChannelSub:', settings.buttonChannelSub)

      // Prevent concurrent executions
      if (channelRendererButtonRunning) return
      channelRendererButtonRunning = true

      const platform = targetPlatformSettings[settings.targetPlatform]
      const renderers = Array.from(document.querySelectorAll('ytd-channel-renderer')) as HTMLElement[]
      if (WOL_DEBUG) dbg('[RESULTS][CR] renderers:', renderers.length)

      // Early return if no channel renderers to process
      if (renderers.length === 0) {
        channelRendererButtonRunning = false
        return
      }

      // Extract UC mappings from ytInitialData on search results
      const ucMappingsFromInitialData = extractSearchResultsUCMappings()
      if (WOL_DEBUG && ucMappingsFromInitialData.size > 0) {
        dbg('[RESULTS][CR] Using UC mappings from ytInitialData:', Array.from(ucMappingsFromInitialData.entries()))
      }

      let injectedCount = 0
      // Helper: upgrade @handle to UC via lightweight fetch (fallback)
      async function upgradeHandleToUC_CR(handle: string): Promise<string | null> {
        try {
          const h = handle.startsWith('@') ? handle : ('@' + handle)
          const ytPath = `/${h}`

          // First check if we have this handle's URL cached
          if (ytUrlResolvePageCache.has(ytPath)) {
            const target = ytUrlResolvePageCache.get(ytPath)
            if (target) {
              // Look for corresponding UC in ucResolvePageCache
              for (const [uc, cachedTarget] of ucResolvePageCache.entries()) {
                if (cachedTarget === target && uc.startsWith('UC')) {
                  if (WOL_DEBUG) dbg('[RESULTS][CR] Upgraded handle to UC from ytUrl cache:', uc)
                  return uc
                }
              }
            }
          }

          // Check if we have this handle in the ytInitialData mappings
          const normalizedHandle = h.startsWith('@') ? h.slice(1) : h
          if (ucMappingsFromInitialData.has(normalizedHandle)) {
            const uc = ucMappingsFromInitialData.get(normalizedHandle)!
            return uc
          }

          // Check persistent cache
          try {
            const persistedUC = await channelCache.getHandle(normalizedHandle)
            if (persistedUC && persistedUC.startsWith('UC')) {
              return persistedUC
            }
          } catch {
            // Silently fail
          }

          // CRITICAL: NEVER use fetch on search results pages - it returns personalized/wrong data
          if (location.pathname === '/results' || location.pathname.startsWith('/results')) {
            if (WOL_DEBUG) dbg('[RESULTS][CR] Skipping fetch on search results page for handle:', handle)
            return null
          }

          // Not cached, fetch it
          const href = `/${encodeURIComponent(h)}`
          const controller = new AbortController()
          const tid = setTimeout(() => controller.abort(), 1500)
          const resp = await fetch(href, { credentials: 'same-origin', signal: controller.signal })
          clearTimeout(tid)
          if (resp.ok) {
            const text = await resp.text()
            const m = text.match(/\"channelId\"\s*:\s*\"(UC[^\"]+)\"/)
            if (m && m[1]) return m[1]
          }
        } catch {}
        return null
      }

      for (let i = 0; i < renderers.length; i++) {
        const cr = renderers[i]
        if (myGen !== overlayGeneration) return
        // CRITICAL FIX: Yield before processing each renderer to prevent freezing
        await new Promise(resolve => setTimeout(resolve, 0))

        // Bump version to invalidate any old observers tied to this renderer
        const ver = String(++channelRendererButtonVersion)
        cr.setAttribute('data-wol-channel-btn-ver', ver)
        // Skip if already injected
        // First, hard de-dupe any existing wrappers (keep first)
        try {
          const all = Array.from(cr.querySelectorAll('[data-wol-results-channel-btn]')) as HTMLElement[]
          if (all.length > 1) all.slice(1).forEach(x => x.remove())
          if (all.length === 1) {
            cr.setAttribute('data-wol-channel-button','1')
            // Update href on existing link and re-size to match Subscribe
            const link = all[0].querySelector('a') as HTMLAnchorElement | null
            // Derive channel URL below and then update link if present
          }
        } catch {}

        if (cr.getAttribute('data-wol-channel-button') === '1' && cr.querySelector('[data-wol-results-channel-btn]')) {
          // Already present; ensure size/href are updated below and continue sizing
        } else if (cr.getAttribute('data-wol-channel-button-pending') === '1') {
          // Another pass is injecting; skip to avoid duplicates
          continue
        } else {
          // Mark pending to prevent concurrent duplicate injections
          cr.setAttribute('data-wol-channel-button-pending','1')
        }
        // Derive URL: prefer /channel/UC..., else map /@handle via initialData; no search fallback
        let chUrl: URL | null = null
        let handle: string | null = null
        let ucid: string | null = null
        let ytUrl: string | null = null
        try {
          // Try multiple selectors to find channel ID
          const chA = cr.querySelector('a[href^="/channel/"]') as HTMLAnchorElement | null
          const hA = cr.querySelector('a[href^="/@"]') as HTMLAnchorElement | null

          // Extract channel ID from /channel/ URL
          if (chA) {
            const u = new URL(chA.getAttribute('href') || chA.href, location.origin)
            const id = u.pathname.split('/')[2]
            if (id && id.startsWith('UC')) {
              ucid = id
              ytUrl = u.pathname // Store YT URL
            }
          }

          // If no channel ID found, try to extract from data attributes or other sources
          if (!ucid) {
            // Check for channel ID in data attributes
            const channelId = cr.getAttribute('channel-id') ||
                            cr.querySelector('[channel-id]')?.getAttribute('channel-id') ||
                            cr.querySelector('ytd-channel-name')?.getAttribute('channel-id')
            if (channelId && channelId.startsWith('UC')) ucid = channelId
          }

          // Extract handle if still no channel ID
          if (!ucid && hA) {
            try {
              const u = new URL(hA.getAttribute('href') || hA.href, location.origin)
              handle = u.pathname.substring(1)
              ytUrl = u.pathname // Store YT URL
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'extracted handle+ytUrl from hA:', handle, ytUrl)
            } catch {}
          }
          // If no explicit /@ anchor, attempt to read handle text anywhere in the renderer
          if (!ucid && !handle) {
            try {
              const txt = cr.textContent || ''
              const m = txt.match(/@[A-Za-z0-9_\.\-]+/)
              if (m) {
                handle = m[0]
                if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'extracted handle from text:', handle)
              }
            } catch {}
          }
          // Deep scan: endpoint-like attributes on the renderer
          // IMPORTANT: Check data attributes BEFORE initialData mapping because data attributes
          // come from the actual rendered DOM and are more reliable than YouTube's personalized initialData
          if (!ucid) {
            // Try ALL elements with any data attribute, not just specific ones
            const allElements = Array.from(cr.querySelectorAll('*'))
            let foundUCs: string[] = []

            for (const el of allElements) {
              try {
                // Check all data- attributes
                for (const attr of Array.from(el.attributes)) {
                  if (!attr.name.startsWith('data-')) continue
                  try {
                    const data = JSON.parse(attr.value)
                    // Recursively search for browseId in the JSON
                    const findBrowseId = (obj: any): string | null => {
                      if (!obj || typeof obj !== 'object') return null
                      if (obj.browseId && typeof obj.browseId === 'string' && obj.browseId.startsWith('UC')) {
                        return obj.browseId
                      }
                      for (const key in obj) {
                        const result = findBrowseId(obj[key])
                        if (result) return result
                      }
                      return null
                    }
                    const bid = findBrowseId(data)
                    if (bid) {
                      foundUCs.push(bid)
                      if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'found UC in', attr.name, ':', bid)
                    }
                  } catch {}
                }
              } catch {}
            }

            if (foundUCs.length > 0) {
              // Use the FIRST UC found, as it's usually the channel's own ID
              // (later UCs might be related/suggested channels)
              ucid = foundUCs[0]
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, '✅ using FIRST UC from DOM scan:', ucid, 'total found:', foundUCs.length, foundUCs)
            }
          }
          // DISABLED: Do NOT use initialData mapping for handle→UC conversion on results pages
          // YouTube's initialData can contain personalized/wrong UC IDs that don't match what's visually displayed
          // Instead, we'll rely on direct DOM extraction above or fetch upgrade below
          //
          // // Map handle -> UC via initialData if UC still missing
          // if (!ucid && handle) {
          //   try {
          //     const maps = getInitialDataMappings()
          //     const norm = handle.startsWith('@') ? handle.slice(1) : handle
          //     const mapped = maps.handleToUC.get(norm)
          //     if (mapped && mapped.startsWith('UC')) {
          //       ucid = mapped
          //       if (WOL_DEBUG) dbg('[RESULTS][CR]', i, '⚠️ MAPPED handle', norm, 'to UC via initialData:', ucid, '(THIS MAY BE WRONG)')
          //     }
          //   } catch {}
          // }
        } catch {}

        // BEFORE trying to upgrade handle via fetch, check if we have this handle cached from previous visits
        // This prevents using YouTube's personalized fetch response
        if (!ucid && handle && ytUrl) {
          const normHandle = handle.startsWith('@') ? handle.slice(1) : handle

          // Step 1: Check in-memory ytUrl cache first (fastest)
          if (ytUrlResolvePageCache.has(ytUrl)) {
            const target = ytUrlResolvePageCache.get(ytUrl)
            if (target) {
              // Found in ytUrl cache, now get the UC from UC cache
              for (const [uc, cachedTarget] of ucResolvePageCache.entries()) {
                if (cachedTarget === target && uc.startsWith('UC')) {
                  ucid = uc
                  if (WOL_DEBUG) dbg('[RESULTS][CR]', i, '✅ found UC via in-memory ytUrl cache:', ucid, 'for', ytUrl)
                  break
                }
              }
            }
          }

          // Step 2: Check in-memory handle cache
          if (!ucid && handleResolvePageCache.has(normHandle)) {
            const target = handleResolvePageCache.get(normHandle)
            if (target) {
              // Found in handle cache, now get the UC from UC cache
              for (const [uc, cachedTarget] of ucResolvePageCache.entries()) {
                if (cachedTarget === target && uc.startsWith('UC')) {
                  ucid = uc
                  if (WOL_DEBUG) dbg('[RESULTS][CR]', i, '✅ found UC via in-memory handle cache:', ucid, 'for @' + normHandle)
                  break
                }
              }
            }
          }

          // Step 3: Check persistent ytUrl cache (survives page reloads)
          if (!ucid) {
            try {
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'checking PERSISTENT ytUrl cache for:', ytUrl)
              const persistedUC = await channelCache.getYtUrl(ytUrl)
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'PERSISTENT ytUrl cache result:', persistedUC === undefined ? 'MISS (undefined)' : (persistedUC === null ? 'null' : persistedUC))
              if (persistedUC && persistedUC.startsWith('UC')) {
                ucid = persistedUC
                if (WOL_DEBUG) dbg('[RESULTS][CR]', i, '✅ found UC via PERSISTENT ytUrl cache:', ucid, 'for', ytUrl)
              }
            } catch (err) {
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, '❌ ERROR checking persistent ytUrl cache:', err)
            }
          }

          // Step 4: Check persistent handle cache (survives page reloads)
          if (!ucid) {
            try {
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'checking PERSISTENT handle cache for:', normHandle)
              const persistedUC = await channelCache.getHandle(normHandle)
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'PERSISTENT handle cache result:', persistedUC === undefined ? 'MISS (undefined)' : (persistedUC === null ? 'null' : persistedUC))
              if (persistedUC && persistedUC.startsWith('UC')) {
                ucid = persistedUC
                if (WOL_DEBUG) dbg('[RESULTS][CR]', i, '✅ found UC via PERSISTENT handle cache:', ucid, 'for @' + normHandle)
              }
            } catch (err) {
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, '❌ ERROR checking persistent handle cache:', err)
            }
          }
        }

        // As last resort, upgrade handle to UC via fetch (guarded)
        // This may return wrong UC due to YouTube personalization
        if (!ucid && handle) {
          if (WOL_DEBUG) dbg('[RESULTS][CR]', i, '⚠️ NO CACHE HIT - upgrading handle to UC via fetch (may be wrong due to YT personalization):', handle)
          ucid = await upgradeHandleToUC_CR(handle)
          if (WOL_DEBUG && ucid) dbg('[RESULTS][CR]', i, '⚠️ upgraded handle to UC via fetch:', ucid, '(THIS MAY BE WRONG)')
          if (myGen !== overlayGeneration) return
        }

        if (ucid) {
          if (myGen !== overlayGeneration) return
          if (WOL_DEBUG) {
            dbg('[RESULTS][CR]', i, 'ucid:', ucid, 'handle:', handle || '-', 'ytUrl:', ytUrl || '-')
            // Log what's in the caches to understand why lookup is failing
            dbg('[RESULTS][CR]', i, 'Cache status - ytUrls:', ytUrlResolvePageCache.size, 'handles:', handleResolvePageCache.size, 'UCs:', ucResolvePageCache.size)
            if (handleResolvePageCache.size > 0) {
              dbg('[RESULTS][CR]', i, 'Handle cache contents:', Array.from(handleResolvePageCache.keys()))
            }
            if (ytUrl && ytUrlResolvePageCache.size > 0) {
              dbg('[RESULTS][CR]', i, 'YtUrl cache contents:', Array.from(ytUrlResolvePageCache.keys()))
            }
          }
          try {
            // First try ytUrl cache (most direct - no UC/handle mismatch issues)
            if (!chUrl && ytUrl && ytUrlResolvePageCache.has(ytUrl)) {
              const t = ytUrlResolvePageCache.get(ytUrl)
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'found ytUrl in cache:', ytUrl, 'target:', t ? 'valid' : 'null')
              if (t) {
                chUrl = getOdyseeUrlByTarget(t)
                if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'resolved from ytUrl cache ->', chUrl.href)
              }
            }

            // Then try handle cache (more reliable than UC since YouTube shows different UCs for same channel)
            if (!chUrl && handle) {
              const normHandle = handle.startsWith('@') ? handle.slice(1) : handle
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'checking handle cache for:', normHandle)
              if (handleResolvePageCache.has(normHandle)) {
                const t = handleResolvePageCache.get(normHandle)
                if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'found handle in cache:', normHandle, 'target:', t ? 'valid' : 'null')
                if (t) {
                  chUrl = getOdyseeUrlByTarget(t)
                  if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'resolved from handle cache ->', chUrl.href)
                  // Populate UC and ytUrl caches for this mapping
                  try {
                    ucResolvePageCache.set(ucid, t)
                    if (ytUrl) ytUrlResolvePageCache.set(ytUrl, t)
                  } catch {}
                }
              }
            }

            // Finally try UC cache
            if (!chUrl && ucResolvePageCache.has(ucid)) {
              const t = ucResolvePageCache.get(ucid)
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'found UC in cache:', ucid, 'target:', t ? 'valid' : 'null')
              if (t) {
                chUrl = getOdyseeUrlByTarget(t)
                if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'resolved from UC cache ->', chUrl.href)
                // Populate all caches for quick VR injection
                try {
                  if (handle) handleResolvePageCache.set(handle.startsWith('@') ? handle.slice(1) : handle, t)
                  if (ytUrl && !ytUrlResolvePageCache.has(ytUrl)) ytUrlResolvePageCache.set(ytUrl, t)
                } catch {}
              }
            }

            // If resolved from any cache, nudge chips refresher
            if (chUrl) {
              const now = Date.now()
              if (now - lastButtonsToChipsNudge > MIN_CROSS_NUDGE_INTERVAL) {
                lastButtonsToChipsNudge = now
                scheduleRefreshResultsChips(50)
                if (WOL_DEBUG) dbg('[RESULTS][CR] nudging chips refresher (cache hit)')
              } else if (WOL_DEBUG) {
                dbg('[RESULTS][CR] skipping chips nudge (too soon,', now - lastButtonsToChipsNudge, 'ms ago)')
              }
            }

            // If not cached anywhere, resolve via API
            if (!chUrl) {
              const srcPlatform = getSourcePlatfromSettingsFromHostname(location.hostname)!
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'calling API to resolve UC:', ucid)
              const res = await getTargetsBySources({ platform: srcPlatform, id: ucid, type: 'channel', url: new URL(location.href), time: null })
              // Yield after API call to prevent blocking
              await new Promise(resolve => setTimeout(resolve, 0))
              if (myGen !== overlayGeneration) return
              const t = res[ucid] || null
              if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'API returned:', t ? 'valid target' : 'null', 'for UC:', ucid)
              // Populate all page caches for future CR/VR usage
              try {
                ucResolvePageCache.set(ucid, t ?? null)
                // IMPORTANT: Only cache handle/ytUrl mappings for successful resolutions
                // YouTube sometimes shows wrong handles (e.g., @veritasium for both main and FR channels)
                // so we should only cache when we have a valid target to avoid blocking correct lookups
                if (t) {
                  if (handle) {
                    const normHandle = handle.startsWith('@') ? handle.slice(1) : handle
                    handleResolvePageCache.set(normHandle, t)
                    // Also persist to IndexedDB for cross-reload cache
                    channelCache.putHandle(normHandle, ucid).catch(err => {
                      if (WOL_DEBUG) dbg('[CACHE] Error persisting handle:', err)
                    })
                    if (WOL_DEBUG) dbg('[CACHE] Stored handle', normHandle, '→', ucid, 'from CR resolution (in-memory + persistent)')
                  }
                  if (ytUrl) {
                    ytUrlResolvePageCache.set(ytUrl, t)
                    // Also persist to IndexedDB for cross-reload cache
                    channelCache.putYtUrl(ytUrl, ucid).catch(err => {
                      if (WOL_DEBUG) dbg('[CACHE] Error persisting ytUrl:', err)
                    })
                    if (WOL_DEBUG) dbg('[CACHE] Stored YT URL', ytUrl, '→', ucid, 'from CR resolution (in-memory + persistent)')
                  }
                  // Persist UC → Target mapping
                  channelCache.putUC(ucid, t).catch(err => {
                    if (WOL_DEBUG) dbg('[CACHE] Error persisting UC:', err)
                  })
                }
              } catch {}
              if (t) {
                chUrl = getOdyseeUrlByTarget(t)
                if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'resolved ->', chUrl.href)
                // Nudge chips refresher now that mapping is known (with anti-ping-pong guard)
                const now = Date.now()
                if (now - lastButtonsToChipsNudge > MIN_CROSS_NUDGE_INTERVAL) {
                  lastButtonsToChipsNudge = now
                  scheduleRefreshResultsChips(50)
                  if (WOL_DEBUG) dbg('[RESULTS][CR] nudging chips refresher (new resolution)')
                } else if (WOL_DEBUG) {
                  dbg('[RESULTS][CR] skipping chips nudge (too soon,', now - lastButtonsToChipsNudge, 'ms ago)')
                }
              } else {
                if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'resolver returned null')
              }
            }
          } catch {}
        }
        // On results page, only inject a channel button when resolver returns a unique Odysee URL
        if (!chUrl) {
          if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'skip inject (no chUrl)')
          cr.removeAttribute('data-wol-channel-button-pending')
          try { cr.querySelectorAll('[data-wol-results-channel-btn]').forEach(el => el.remove()) } catch {}
          try { const st = channelRendererState.get(cr); st?.mo?.disconnect(); channelRendererState.delete(cr) } catch {}
          cr.removeAttribute('data-wol-channel-button')
          // bounded retry to avoid infinite loop
          const prev = (channelRendererRetryCount.get(cr) || 0)
          if (prev < 3) {
            channelRendererRetryCount.set(cr, prev + 1)
            if (WOL_DEBUG) dbg('[RESULTS][CR] scheduling bounded retry #', prev + 1)
            scheduleRefreshChannelButtons(500 + prev * 400)
          } else {
            if (WOL_DEBUG) dbg('[RESULTS][CR] giving up on this pass (no chUrl after retries)')
            try {
              const since = Date.now() - overlayGenerationBumpedAt
              logger.log(`[TIMING] CR give-up after retries +${since}ms (gen ${myGen})`)
            } catch {}
          }
          continue
        }

        // Inject compact button next to subscribe row
        const buttonsContainer = (cr.querySelector('#buttons') as HTMLElement | null)
          || (cr.querySelector('#action-buttons') as HTMLElement | null)
          || (cr.querySelector('#subscribe-button')?.parentElement as HTMLElement | null)
          || cr
        const subscribeButton = cr.querySelector('#subscribe-button') as HTMLElement | null

        // Reuse existing wrapper if present
        let wrapper = cr.querySelector('[data-wol-results-channel-btn]') as HTMLElement | null
        let link: HTMLAnchorElement | null = wrapper ? (wrapper.querySelector('a') as HTMLAnchorElement | null) : null
        if (!wrapper) {
          wrapper = document.createElement('div')
          wrapper.setAttribute('data-wol-results-channel-btn','1')
          wrapper.style.display = 'inline-flex'
          wrapper.style.alignItems = 'center'
          wrapper.style.marginRight = '6px'
          link = document.createElement('a')
          link.style.display = 'flex'
          link.style.alignItems = 'center'
          link.style.gap = '6px'
          link.style.borderRadius = '14px'
          link.style.padding = '0 6px'
          link.style.height = '28px'
          link.style.lineHeight = '28px'
          link.style.fontWeight = '500'
          link.style.fontSize = '12px'
          link.style.textDecoration = 'none'
          link.style.color = 'whitesmoke'
          link.style.backgroundImage = platform.theme
          link.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation() } catch {}; openNewTab(chUrl!, 'user') })
          const icon = document.createElement('img')
          icon.src = platform.button.icon
          icon.style.height = '20px'
          icon.style.width = '20px'
          icon.style.pointerEvents = 'none'
          const text = document.createElement('span')
          text.textContent = 'Channel'
          text.style.whiteSpace = 'nowrap'
          link.appendChild(icon)
          link.appendChild(text)
          wrapper.appendChild(link)
        }
        // Update href every pass
        if (myGen !== overlayGeneration) return
        if (link) link.href = chUrl.href
        if (WOL_DEBUG) dbg('[RESULTS][CR]', i, 'href set', chUrl.href)

        if (buttonsContainer) {
          if (subscribeButton && subscribeButton.parentElement === buttonsContainer) buttonsContainer.insertBefore(wrapper, subscribeButton)
          else buttonsContainer.appendChild(wrapper)
        } else {
          cr.appendChild(wrapper)
        }
        cr.setAttribute('data-wol-channel-button','1')
        cr.removeAttribute('data-wol-channel-button-pending')
        injectedCount++

        // Timing: first CR button injection since navigation
        try {
          const since = Date.now() - overlayGenerationBumpedAt
          const m = navGenMetrics.get(myGen) || {}
          if (!m.crFirstAt) {
            m.crFirstAt = since
            navGenMetrics.set(myGen, m)
            logger.log(`[TIMING] CR button injected +${since}ms (gen ${myGen})`)
          }
        } catch {}

        // Match Subscribe button sizing for a native look
        try {
          const subBtnEl = (subscribeButton?.querySelector('button, a, yt-button-shape button, yt-button-shape a, ytd-subscribe-button-renderer button') as HTMLElement | null) || subscribeButton
          if (subBtnEl) {
            let sbh = subBtnEl.getBoundingClientRect().height || (subBtnEl as any).offsetHeight || 0
            if (!sbh) {
              const elems = Array.from(subBtnEl.querySelectorAll('*')) as HTMLElement[]
              for (const el of elems) {
                const r = el.getBoundingClientRect()
                if (r.height > 0) { sbh = r.height; break }
              }
            }
            const h = Math.max(24, Math.round(sbh || 36))
            wrapper.style.height = `${h}px`
            wrapper.style.alignItems = 'center'
            link.style.height = `${h}px`
            link.style.lineHeight = `${h}px`
            const subscribeStyle = window.getComputedStyle(subBtnEl)
            if (subscribeStyle?.fontSize) link.style.fontSize = subscribeStyle.fontSize
            if (subscribeStyle?.borderRadius) link.style.borderRadius = subscribeStyle.borderRadius
            if (subscribeStyle?.paddingLeft && subscribeStyle?.paddingRight) {
              link.style.paddingLeft = subscribeStyle.paddingLeft
              link.style.paddingRight = subscribeStyle.paddingRight
            }
            const mb = subscribeStyle?.marginBottom || '0px'
            wrapper.style.marginBottom = (mb === '0px') ? '8px' : mb
          }
        } catch {}

        // Yield after expensive DOM/style calculations
        await new Promise(resolve => setTimeout(resolve, 0))

        // Keep present during renderer churn
        try {
          let mo: MutationObserver | null = null
          const ensure = () => {
            if (overlayGeneration !== myGen) { try { mo?.disconnect() } catch {}; return }
            // If version changed since this observer was attached, stop and exit
            if (cr.getAttribute('data-wol-channel-btn-ver') !== ver) { try { mo?.disconnect() } catch {}; return }
            if (!settings.resultsApplySelections || !settings.buttonChannelSub) { try { wrapper.remove() } catch {}; return }
            const stillThere = wrapper.isConnected && cr.contains(wrapper)
            const subBtn = cr.querySelector('#subscribe-button') as HTMLElement | null
            const btns = (cr.querySelector('#buttons') as HTMLElement | null)
              || (cr.querySelector('#action-buttons') as HTMLElement | null)
              || (subBtn?.parentElement as HTMLElement | null)
              || cr
            if (!stillThere && btns) {
              if (subBtn && subBtn.parentElement === btns) btns.insertBefore(wrapper, subBtn)
              else btns.appendChild(wrapper)
            }
          }
          mo = new MutationObserver(() => ensure())
          mo.observe(cr, { childList: true, subtree: true })
          // Track in shared state to avoid duplicate injections
          try { channelRendererState.set(cr, { btn: wrapper, mo }) } catch {}
        } catch {}
      }
      // No global retry loop here; bounded per-renderer retries are scheduled above
    } catch {}
    finally {
      channelRendererButtonRunning = false
    }
  }

  // Proactively (re)inject compact channel chips beside each video result on /results
  async function refreshResultsVideoChannelChips() {
    try {
      if (location.pathname !== '/results') return
      // Ensure CSS guard matches settings so we don't invisibly inject
      try { ensureResultsPillsVisibility() } catch {}
      if (!settings.resultsApplySelections || !settings.buttonChannelSub) {
        enforceResultsChannelChipVisibility()
        return
      }

      // Prevent concurrent runs; queue a single rerun if invoked while running
      if (resultsVideoChipRunning) { resultsVideoChipPendingRerun = true; return }
      resultsVideoChipRunning = true

      // Guard: avoid running with stale ytInitialData immediately after SPA navigation
      const myGen = overlayGeneration
      const navDiff = Date.now() - overlayGenerationBumpedAt
      if (navDiff < 150) {
        await new Promise(r => setTimeout(r, 150 - navDiff))
      }
      if (myGen !== overlayGeneration) { resultsVideoChipRunning = false; return }

      // Ensure initialData mappings are loaded for handle→UC and video→UC lookups
      const maps = getInitialDataMappings()
      if (myGen !== overlayGeneration) { resultsVideoChipRunning = false; return }

      // Compute a simple signature of what's on the page and already known
      try {
        const now0 = Date.now()
        if (now0 < resultsChipsQuietUntil) { resultsVideoChipRunning = false; return }
        const ucids = new Set(items.map(x => x.ucid).filter((x): x is string => !!x))
        let ucResolved = 0
        for (const uc of ucids) { const t = ucResolvePageCache.get(uc); if (t) ucResolved++ }
        let handleMatches = 0
        for (const it of items) { const h = it.handle ? (it.handle.startsWith('@') ? it.handle.slice(1) : it.handle) : null; if (h && handleResolvePageCache.has(h)) handleMatches++ }
        const sig = `${location.href}|${ucids.size}|${ucResolved}|${handleMatches}`
        const now = Date.now()
        if (lastResultsChipsSig === sig && (now - lastResultsChipsAt) < 1200) {
          resultsVideoChipRunning = false
          return
        }
        lastResultsChipsSig = sig
      } catch {}

      // Collect channel anchors from video result renderers
      const vrs = Array.from(document.querySelectorAll('ytd-video-renderer')) as HTMLElement[]
      if (WOL_DEBUG) dbg('[RESULTS][VR] video renderers:', vrs.length)
      type VRCtx = { vr: HTMLElement, nameAnchor: HTMLAnchorElement | null, handle: string | null, ucid: string | null, ytUrl: string | null }
      const items: VRCtx[] = vrs.map(vr => {
        const nameAnchor = vr.querySelector('#channel-info #channel-name a[href], ytd-channel-name#channel-name a[href]') as HTMLAnchorElement | null
        let handle: string | null = null
        let ucid: string | null = null
        let ytUrl: string | null = null
        if (nameAnchor) {
          try {
            const href = nameAnchor.getAttribute('href') || nameAnchor.href || ''
            const u = new URL(href, location.origin)
            ytUrl = u.pathname // Store the full YT pathname for cache lookups
            if (u.pathname.startsWith('/channel/')) ucid = u.pathname.split('/')[2] || null
            else if (u.pathname.startsWith('/@')) handle = u.pathname.substring(1)
          } catch {}
        }
        if (!ucid && !handle) {
          const fb = vr.querySelector('a[href^="/channel/"]') as HTMLAnchorElement | null
          if (fb) {
            try {
              const u = new URL(fb.getAttribute('href') || fb.href, location.origin)
              const uc = u.pathname.split('/')[2]
              if (uc) {
                ucid = uc
                ytUrl = u.pathname
              }
            } catch {}
          }
        }
        // Try to derive videoId for mapping lookup
        let videoId: string | null = null
        try {
          const a = vr.querySelector('a[href^="/watch?v="]') as HTMLAnchorElement | null
          if (a) {
            const u = new URL(a.getAttribute('href') || a.href, location.origin)
            videoId = u.searchParams.get('v')
          }
        } catch {}
        return { vr, nameAnchor, handle, ucid, videoId, ytUrl } as any
      })
      if (myGen !== overlayGeneration) return

      // Robust UC extraction helpers
      function extractUCFromAttrs(el: Element | null): string | null {
        if (!el) return null
        const attrs = ['data-serialized-endpoint','data-innertube-command','data-endpoint','endpoint'] as const
        for (const a of attrs) {
          const raw = (el as HTMLElement).getAttribute(a as any)
          if (!raw) continue
          try {
            const data = JSON.parse(raw)
            const bid = data?.browseEndpoint?.browseId
              || data?.commandMetadata?.webCommandMetadata?.browseEndpoint?.browseId
              || data?.webCommandMetadata?.browseEndpoint?.browseId
              || data?.browseId
            if (typeof bid === 'string' && bid.startsWith('UC')) return bid
          } catch {}
        }
        return null
      }
      function extractUCFromAny(vr: HTMLElement): string | null {
        // Check any element in renderer with endpoint-like JSON
        const candidates = vr.querySelectorAll('[data-serialized-endpoint],[data-innertube-command],[data-endpoint],[endpoint]')
        for (const el of Array.from(candidates)) {
          const id = extractUCFromAttrs(el)
          if (id) return id
        }
        // As a last resort, scan text content for UC… pattern (cheap compared to innerHTML)
        try {
          const m = (vr.textContent || '').match(/UC[a-zA-Z0-9_-]{22}/)
          if (m) return m[0]
        } catch {}
        return null
      }

      // Attempt to upgrade @handles to UC ids when possible (DOM hints only; no network)
      async function upgradeHandleToUC(ctx: VRCtx): Promise<string | null> {
        const vr = ctx.vr
        // First check if we have this handle's URL cached
        if (ctx.ytUrl && ytUrlResolvePageCache.has(ctx.ytUrl)) {
          // We have the target cached; try to find the UC ID
          const target = ytUrlResolvePageCache.get(ctx.ytUrl)
          if (target) {
            // Look for corresponding UC in ucResolvePageCache
            for (const [uc, cachedTarget] of ucResolvePageCache.entries()) {
              if (cachedTarget === target && uc.startsWith('UC')) {
                if (WOL_DEBUG) dbg('[RESULTS][VR] Upgraded handle to UC from ytUrl cache:', uc)
                return uc
              }
            }
          }
        }

        // Check persistent cache first if we have a handle
        if (ctx.handle) {
          try {
            const normalizedHandle = ctx.handle.startsWith('@') ? ctx.handle.slice(1) : ctx.handle
            const persistedUC = await channelCache.getHandle(normalizedHandle)
            if (persistedUC && persistedUC.startsWith('UC')) {
              return persistedUC
            }
          } catch {
            // Silently fail
          }
        }

        // AGGRESSIVE DOM EXTRACTION: Look for UC in ALL data attributes in the renderer
        try {
          const allElements = Array.from(vr.querySelectorAll('*'))
          for (const el of allElements) {
            for (const attr of Array.from(el.attributes)) {
              if (!attr.name.startsWith('data-')) continue
              try {
                const data = JSON.parse(attr.value)
                // Recursively search for browseId in the JSON
                const findBrowseId = (obj: any): string | null => {
                  if (!obj || typeof obj !== 'object') return null
                  if (obj.browseId && typeof obj.browseId === 'string' && obj.browseId.startsWith('UC')) {
                    return obj.browseId
                  }
                  if (obj.channelId && typeof obj.channelId === 'string' && obj.channelId.startsWith('UC')) {
                    return obj.channelId
                  }
                  for (const key in obj) {
                    const result = findBrowseId(obj[key])
                    if (result) return result
                  }
                  return null
                }
                const bid = findBrowseId(data)
                if (bid) {
                  return bid
                }
              } catch {}
            }
          }
        } catch {}

        // DOM hint: serialized endpoints may contain browseId
        try {
          const epEl = vr.querySelector('[data-serialized-endpoint]') as HTMLElement | null
          if (epEl) {
            try {
              const data = JSON.parse(epEl.getAttribute('data-serialized-endpoint') || '{}')
              const browseId = data?.browseEndpoint?.browseId
              if (typeof browseId === 'string' && browseId.startsWith('UC')) return browseId
            } catch {}
          }
          // Newer attributes
          const ucFromAttrs = extractUCFromAttrs(vr)
          if (ucFromAttrs) return ucFromAttrs

          // CRITICAL: NEVER use fetch on search results pages - it returns personalized/wrong data
          if (location.pathname === '/results' || location.pathname.startsWith('/results')) {
            if (WOL_DEBUG) dbg('[RESULTS][VR] Skipping fetch on search results page for handle:', ctx.handle)
            return null
          }

          // Fallback: fetch mapped handle page to discover UC when available
          if (ctx.handle) {
            try {
              // Always fetch using the @handle form; non-@ path may 404
              const h = ctx.handle.startsWith('@') ? ctx.handle : ('@' + ctx.handle)
              const href = `/${encodeURIComponent(h)}`
              const controller = new AbortController()
              const tid = setTimeout(() => controller.abort(), 1500)
              const resp = await fetch(href, { credentials: 'same-origin', signal: controller.signal })
              clearTimeout(tid)
              if (resp.ok) {
                const text = await resp.text()
                const m = text.match(/\"channelId\"\s*:\s*\"(UC[^\"]+)\"/)
                if (m && m[1]) return m[1]
              }
            } catch {}
          }
        } catch {}
        return null
      }

      let vrDbgCount = 0
      for (const it of items as any[]) {
        try {
          if (myGen !== overlayGeneration) return
          if (!it.ucid && it.videoId && maps.videoToUC.has(it.videoId)) it.ucid = maps.videoToUC.get(it.videoId)
          if (!it.ucid && it.handle) {
            const norm = it.handle.startsWith('@') ? it.handle.slice(1) : it.handle
            if (maps.handleToUC.has(norm)) it.ucid = maps.handleToUC.get(norm)
            else it.ucid = await upgradeHandleToUC(it)
          }
          if (!it.ucid) it.ucid = extractUCFromAny(it.vr)
          if (WOL_DEBUG) {
            if (vrDbgCount < 20) dbg('[RESULTS][VR] renderer uc/handle:', it.ucid || '-', '/', it.handle || '-')
            else if (vrDbgCount === 20) dbg('[RESULTS][VR] ... more renderers omitted')
            vrDbgCount++
          }
        } catch {}
      }

      // Quick path: inject immediately for items we can resolve from page caches (YT URL/UC/handle)
      const platform = targetPlatformSettings[settings.targetPlatform]
      const quickInjected = new Set<HTMLElement>()
      try {
        for (const it of items) {
          if (myGen !== overlayGeneration) break
          let url: URL | null = null
          let target: Target | null = null

          // First try YouTube URL cache (most direct - no normalization needed)
          if (!target && it.ytUrl && ytUrlResolvePageCache.has(it.ytUrl)) {
            const cached = ytUrlResolvePageCache.get(it.ytUrl)
            // Only use if it's a valid target (not null)
            if (cached) {
              target = cached
              url = getOdyseeUrlByTarget(target)
            }
          }

          // Then try UC cache
          if (!target && it.ucid && ucResolvePageCache.has(it.ucid)) {
            const cached = ucResolvePageCache.get(it.ucid)
            // Only use if it's a valid target (not null)
            if (cached) {
              target = cached
              url = getOdyseeUrlByTarget(target)
              // Populate ytUrl cache for next time
              try {
                if (it.ytUrl && !ytUrlResolvePageCache.has(it.ytUrl)) ytUrlResolvePageCache.set(it.ytUrl, target)
              } catch {}
              // Also update handle cache if available
              try {
                if (it.handle) {
                  const normH = it.handle.startsWith('@') ? it.handle.slice(1) : it.handle
                  if (!handleResolvePageCache.has(normH)) handleResolvePageCache.set(normH, target)
                }
              } catch {}
            }
          }

          // Finally try handle cache
          if (!target && it.handle) {
            const norm = it.handle.startsWith('@') ? it.handle.slice(1) : it.handle
            if (handleResolvePageCache.has(norm)) {
              const cached = handleResolvePageCache.get(norm)
              // Only use if it's a valid target (not null)
              if (cached) {
                target = cached
                url = getOdyseeUrlByTarget(target)
                // Populate ytUrl cache for next time
                try {
                  if (it.ytUrl && !ytUrlResolvePageCache.has(it.ytUrl)) ytUrlResolvePageCache.set(it.ytUrl, target)
                } catch {}
              }
            }
          }
          if (url) {
            // Extract video ID from the renderer for debugging
            const videoLink = it.vr.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]') as HTMLAnchorElement | null
            let videoId = 'unknown'
            if (videoLink) {
              try {
                const match = videoLink.href.match(/[?&]v=([^&]+)/) || videoLink.href.match(/\/shorts\/([^?&\/]+)/)
                if (match) videoId = match[1]
              } catch {}
            }

            if (WOL_DEBUG) {
              dbg('[RESULTS][VR] QUICK inject:', {
                videoId: videoId,
                url: url.href,
                ucid: it.ucid,
                handle: it.handle,
                ytUrl: it.ytUrl,
                target: target,
                cacheSource: !target ? 'none' : (it.ytUrl && ytUrlResolvePageCache.has(it.ytUrl)) ? 'ytUrl' :
                            (it.ucid && ucResolvePageCache.has(it.ucid)) ? 'uc' : 'handle'
              })
            }

            // Debug specific problematic videos
            if (videoId === '-zDqghyM_H0' || videoId === '_b4uZhW-wYI' || videoId === 'RDZxYZkz20lYA') {
              logger.log(`[VR CHIP DEBUG] Video ${videoId} getting channel chip:`, {
                videoId,
                channelUrl: url.href,
                ucid: it.ucid,
                handle: it.handle,
                ytUrl: it.ytUrl,
                target,
                cacheSource: !target ? 'none' : (it.ytUrl && ytUrlResolvePageCache.has(it.ytUrl)) ? 'ytUrl' :
                            (it.ucid && ucResolvePageCache.has(it.ucid)) ? 'uc' : 'handle'
              })
            }
            // Minimal injection to show chip quickly; full ensure logic runs later too
            const vr = it.vr
            const channelInfo = vr.querySelector('#channel-info') as HTMLElement | null
            const thumbA = channelInfo?.querySelector('#channel-thumbnail') as HTMLElement | null
            if (channelInfo) {
              try { const cs = getComputedStyle(channelInfo); if (cs.display !== 'flex' && cs.display !== 'inline-flex') channelInfo.style.display = 'flex'; channelInfo.style.alignItems = 'center' } catch {}
              const existing = channelInfo.querySelector('a[data-wol-inline-channel]') as HTMLElement | null
              const inline = (resultsVideoChipState.get(vr)?.chip as HTMLElement) || existing || document.createElement('a')
              if (!inline.hasAttribute('data-wol-inline-channel')) inline.setAttribute('data-wol-inline-channel', '1')
              inline.href = url.href
              inline.target = '_blank'
              inline.title = `Open channel on ${platform.button.platformNameText}`
              inline.style.display = 'inline-flex'
              inline.style.alignItems = 'center'
              inline.style.justifyContent = 'center'
              inline.style.flex = '0 0 auto'
              inline.style.marginRight = '6px'
              inline.style.width = '22px'
              inline.style.height = '22px'
              inline.style.borderRadius = '11px'
              inline.style.background = 'transparent'
              inline.style.overflow = 'hidden'
              inline.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation() } catch {}; openNewTab(url!, 'user') })
              let icon = inline.querySelector('img') as HTMLImageElement | null
              if (!icon) { icon = document.createElement('img'); inline.appendChild(icon) }
              icon.src = platform.button.icon
              icon.style.width = '22px'
              icon.style.height = '22px'
              icon.style.display = 'block'
              icon.style.pointerEvents = 'none'
              if (thumbA && thumbA.parentElement === channelInfo) {
                if (inline.parentElement !== channelInfo || inline.nextElementSibling !== thumbA) channelInfo.insertBefore(inline, thumbA)
              } else {
                if (inline.parentElement !== channelInfo || inline !== channelInfo.firstElementChild) channelInfo.insertBefore(inline, channelInfo.firstChild)
              }
              const prev = resultsVideoChipState.get(vr)
              try { prev?.mo?.disconnect() } catch {}
              try {
                const mo = new MutationObserver(() => {
                  if (overlayGeneration !== myGen) { try { mo.disconnect() } catch {}; return }
                  if (!settings.resultsApplySelections || !settings.buttonChannelSub) return
                  const cci = vr.querySelector('#channel-info') as HTMLElement | null
                  const tta = cci?.querySelector('#channel-thumbnail') as HTMLElement | null
                  if (!cci) return
                  if (!inline.isConnected || inline.parentElement !== cci || (tta && inline.nextElementSibling !== tta)) {
                    if (tta && tta.parentElement === cci) cci.insertBefore(inline, tta)
                    else cci.insertBefore(inline, cci.firstChild)
                  }
                })
                mo.observe(channelInfo, { childList: true, subtree: false })
                resultsVideoChipState.set(vr, { chip: inline, mo })
              } catch {}
              quickInjected.add(vr)
            }
          }
        }
      } catch {}

      // Resolve unique UC channel ids in one call (skip already cached ones)
      const uniqueUC = Array.from(new Set(
        items
          .filter(x => !quickInjected.has(x.vr))
          .map(x => x.ucid)
          .filter((x): x is string => !!x && x.startsWith('UC') && !ucResolvePageCache.has(x))
      ))
      if (WOL_DEBUG) dbg('[RESULTS][VR] unique UC ids to resolve:', uniqueUC.length, 'cached:', items.filter(x => x.ucid && ucResolvePageCache.has(x.ucid)).length)
      let resolved: Record<string, Target | null> = {}
      if (uniqueUC.length > 0) {
        const srcPlatform = getSourcePlatfromSettingsFromHostname(location.hostname)!
        const srcs = uniqueUC.map(id => ({ platform: srcPlatform, id, type: 'channel' as const, url: new URL(location.href), time: null }))
        resolved = await getTargetsBySources(...srcs)
        if (myGen !== overlayGeneration) return
        // Timing: batch UC resolution completed
        try {
          const since = Date.now() - overlayGenerationBumpedAt
          const m = navGenMetrics.get(myGen) || {}
          if (!m.ucBatchAt) {
            m.ucBatchAt = since
            navGenMetrics.set(myGen, m)
            logger.log(`[TIMING] UC batch resolved +${since}ms (gen ${myGen})`)
          }
        } catch {}
        // Share resolved UC targets with the page-level cache for CR reuse
        try {
          uniqueUC.forEach(uc => {
            const target = resolved[uc] ?? null
            ucResolvePageCache.set(uc, target)
            // Also populate ytUrl cache for /channel/UC... URLs
            const channelUrl = `/channel/${uc}`
            ytUrlResolvePageCache.set(channelUrl, target)
          })
          // Nudge CR to update quickly now that UC targets are known (with anti-ping-pong guard)
          const now = Date.now()
          if (now - lastChipsToButtonsNudge > MIN_CROSS_NUDGE_INTERVAL) {
            lastChipsToButtonsNudge = now
            scheduleRefreshChannelButtons(50)
            scheduleRefreshChannelButtons(220)
            if (WOL_DEBUG) dbg('[RESULTS][VR] nudging channel buttons after UC batch resolve')
          } else if (WOL_DEBUG) {
            dbg('[RESULTS][VR] skipping buttons nudge (too soon,', now - lastChipsToButtonsNudge, 'ms ago)')
          }
        } catch {}
      }

      // IMPORTANT: Populate persistent cache with verified UC-handle mappings from results page
      // These are ACCURATE because they come from the actual DOM, not from fetch
      try {
        const verifiedMappings = new Map<string, string>()

        // Collect all verified UC-handle pairs from the items
        for (const it of items) {
          if (it.ucid && it.handle && it.ucid.startsWith('UC')) {
            const normalizedHandle = it.handle.startsWith('@') ? it.handle.slice(1) : it.handle
            // Only add if we successfully resolved this UC (meaning it's a real channel)
            if (ucResolvePageCache.has(it.ucid) || resolved[it.ucid]) {
              verifiedMappings.set(normalizedHandle, it.ucid)
            }
          }
        }

        // Persist these verified mappings
        if (verifiedMappings.size > 0) {
          for (const [handle, ucid] of verifiedMappings.entries()) {
            // Store in persistent cache asynchronously
            (async () => {
              try {
                await channelCache.putHandle(handle, ucid)
                await channelCache.putYtUrl(`/@${handle}`, ucid)
                await channelCache.putYtUrl(`/channel/${ucid}`, ucid)
              } catch {
                // Silently fail - cache population is best-effort
              }
            })()
          }
        }
      } catch {
        // Silently fail
      }

      // If none of the channels resolved, schedule controlled retries with exponential backoff
      let gotAny = false
      try { gotAny = Object.values(resolved).some(Boolean) } catch {}
      try {
        const key = `${overlayGeneration}|${location.href}`
        if (!gotAny && uniqueUC.length > 0) {
          if (resultsChipsRetryKey !== key) {
            resultsChipsRetryKey = key
            resultsChipsBackoffMs = 1000
          } else {
            resultsChipsBackoffMs = Math.min(resultsChipsBackoffMs ? resultsChipsBackoffMs * 2 : 1000, 15000)
          }
          const delay1 = resultsChipsBackoffMs
          const delay2 = Math.min(resultsChipsBackoffMs + 1500, 18000)
          scheduleRefreshResultsChips(delay1)
          scheduleRefreshResultsChips(delay2)
        } else {
          // Progress made; reset backoff
          resultsChipsBackoffMs = 0
          resultsChipsRetryKey = null
        }
      } catch {}
      // Inject or ensure an inline chip in each renderer
      let skipDbgCount = 0
      for (const it of items) {
        try {
          if (quickInjected.has(it.vr)) continue
          if (myGen !== overlayGeneration) { resultsVideoChipRunning = false; return }
          const vr = it.vr
          const channelInfo = vr.querySelector('#channel-info') as HTMLElement | null
          const thumbA = channelInfo?.querySelector('#channel-thumbnail') as HTMLElement | null
          // If we already manage a chip for this renderer, update and ensure placement
          const managed = resultsVideoChipState.get(vr)
          // Compute target URL for channel: check both batch resolution and page cache
          let chUrl: URL | null = null
          let resolveSource: string | null = null  // Track where we got the resolution from

          if (it.ucid) {
            // First check if we just resolved it in this batch
            let t = resolved[it.ucid] || null
            if (t) {
              resolveSource = 'batch'
            } else if (ucResolvePageCache.has(it.ucid)) {
              // If not in batch, check page cache
              const cached = ucResolvePageCache.get(it.ucid)
              // Only use if it's a valid target (not null)
              if (cached) {
                t = cached
                resolveSource = 'ucCache'
              }
            }

            if (t) {
              chUrl = getOdyseeUrlByTarget(t)
              // Populate all caches for faster lookups next time
              try {
                if (it.handle) {
                  const normH = it.handle.startsWith('@') ? it.handle.slice(1) : it.handle
                  if (!handleResolvePageCache.has(normH)) handleResolvePageCache.set(normH, t)
                }
                if (it.ytUrl && !ytUrlResolvePageCache.has(it.ytUrl)) ytUrlResolvePageCache.set(it.ytUrl, t)
              } catch {}
            }
          }

          if (!chUrl && it.handle) {
            try {
              const normH = it.handle.startsWith('@') ? it.handle.slice(1) : it.handle
              if (handleResolvePageCache.has(normH)) {
                const cached = handleResolvePageCache.get(normH)
                // Only use if it's a valid target (not null)
                if (cached) {
                  chUrl = getOdyseeUrlByTarget(cached)
                  resolveSource = 'handleCache'
                  // Populate ytUrl cache for next time
                  try {
                    if (it.ytUrl && !ytUrlResolvePageCache.has(it.ytUrl)) ytUrlResolvePageCache.set(it.ytUrl, cached)
                  } catch {}
                }
              }
            } catch {}
          }

          if (!chUrl) {
            if (WOL_DEBUG && skipDbgCount < 8) {
              dbg('[RESULTS][VR] skip chip - no resolution for:', {
                ucid: it.ucid,
                handle: it.handle,
                ytUrl: it.ytUrl
              })
              skipDbgCount++
            }
            // Remove any previous chip we might have injected for this renderer
            try { resultsVideoChipState.get(vr)?.chip?.remove() } catch {}
            try { resultsVideoChipState.delete(vr) } catch {}
            // Also sweep and remove any leftover chips in the renderer (e.g., from previous page)
            try { vr.querySelectorAll('a[data-wol-inline-channel]').forEach(el => el.remove()) } catch {}
            continue
          } else {
            // Extract video ID from the renderer for debugging
            const videoLink = vr.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]') as HTMLAnchorElement | null
            let videoId = 'unknown'
            if (videoLink) {
              try {
                const match = videoLink.href.match(/[?&]v=([^&]+)/) || videoLink.href.match(/\/shorts\/([^?&\/]+)/)
                if (match) videoId = match[1]
              } catch {}
            }

            if (WOL_DEBUG) {
              dbg('[RESULTS][VR] INJECTING chip:', {
                videoId: videoId,
                url: chUrl.href,
                source: resolveSource,
                ucid: it.ucid,
                handle: it.handle,
                ytUrl: it.ytUrl
              })
            }

            // Debug specific problematic videos
            if (videoId === '-zDqghyM_H0' || videoId === '_b4uZhW-wYI' || videoId === 'RDZxYZkz20lYA') {
              logger.log(`[VR CHIP DEBUG FULL] Video ${videoId} getting channel chip:`, {
                videoId,
                channelUrl: chUrl.href,
                source: resolveSource,
                ucid: it.ucid,
                handle: it.handle,
                ytUrl: it.ytUrl,
                batchResolved: resolved[it.ucid || ''],
                ucCacheHas: it.ucid ? ucResolvePageCache.has(it.ucid) : false,
                ucCacheValue: it.ucid ? ucResolvePageCache.get(it.ucid) : null,
                generation: myGen
              })
            }
            // Timing: first chip injection since navigation
            try {
              const since = Date.now() - overlayGenerationBumpedAt
              const m = navGenMetrics.get(myGen) || {}
              if (!m.chipsFirstAt) {
                m.chipsFirstAt = since
                navGenMetrics.set(myGen, m)
                logger.log(`[TIMING] Chips first injection +${since}ms (gen ${myGen})`)
              }
            } catch {}
          }

          // Helper to (re)mount the chip once the host nodes exist
          const ensureMount = () => {
            const ci = vr.querySelector('#channel-info') as HTMLElement | null
            const ta = ci?.querySelector('#channel-thumbnail') as HTMLElement | null
            if (!ci || !ta) return false
            try {
              const cs = window.getComputedStyle(ci)
              if (cs.display !== 'flex' && cs.display !== 'inline-flex') ci.style.display = 'flex'
              ci.style.alignItems = 'center'
            } catch {}

            // Reuse existing DOM chip if present to avoid duplication
            const existing = ci.querySelector('a[data-wol-inline-channel]') as HTMLElement | null
            // Remove extras if any
            try {
              const all = Array.from(ci.querySelectorAll('a[data-wol-inline-channel]')) as HTMLElement[]
              if (all.length > 1) all.slice(1).forEach(x => x.remove())
            } catch {}
            const inline = (resultsVideoChipState.get(vr)?.chip as HTMLElement) || (existing as HTMLElement) || document.createElement('a')
            if (!inline.hasAttribute('data-wol-inline-channel')) inline.setAttribute('data-wol-inline-channel', '1')
            inline.href = chUrl!.href
            inline.target = '_blank'
            inline.title = `Open channel on ${platform.button.platformNameText}`
            inline.style.display = 'inline-flex'
            inline.style.alignItems = 'center'
            inline.style.justifyContent = 'center'
            inline.style.flex = '0 0 auto'
            inline.style.marginRight = '6px'
            inline.style.marginTop = '-2px'
            inline.style.width = '23px'
            inline.style.height = '23px'
            inline.style.borderRadius = '11.5px'
            inline.style.background = 'transparent'
            inline.style.overflow = 'hidden'
            inline.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation() } catch {}; openNewTab(chUrl!, 'user') })
            let icon = inline.querySelector('img') as HTMLImageElement | null
            if (!icon) { icon = document.createElement('img'); inline.appendChild(icon) }
            icon.src = platform.button.icon
            icon.style.width = '22px'
            icon.style.height = '22px'
            icon.style.display = 'block'
            icon.style.pointerEvents = 'none'

            // Ensure position before the avatar
            if (ta.parentElement === ci) {
              if (inline.parentElement !== ci || inline.nextElementSibling !== ta) {
                ci.insertBefore(inline, ta)
              }
            } else {
              if (inline.parentElement !== ci || inline !== ci.firstElementChild) {
                ci.insertBefore(inline, ci.firstChild)
              }
            }
            // Remove stale guard if hiding
            try {
              const cs2 = getComputedStyle(inline)
              if (cs2.display === 'none') {
                inline.style.setProperty('display', 'inline-flex', 'important')
                inline.style.setProperty('visibility', 'visible', 'important')
                const guard = document.getElementById('wol-results-pills-visibility')
                if (guard) guard.remove()
              }
            } catch {}

            // Persist state and observer
            const prev = resultsVideoChipState.get(vr)
            try { prev?.mo?.disconnect() } catch {}
            try {
              const mo = new MutationObserver(() => {
                if (overlayGeneration !== myGen) { try { mo.disconnect() } catch {}; return }
                // Keep chip present and before avatar as row churns
                if (!settings.resultsApplySelections || !settings.buttonChannelSub) return
                const cci = vr.querySelector('#channel-info') as HTMLElement | null
                const tta = cci?.querySelector('#channel-thumbnail') as HTMLElement | null
                if (!cci || !tta) return
                if (!inline.isConnected || inline.parentElement !== cci || inline.nextElementSibling !== tta) {
                  if (tta.parentElement === cci) cci.insertBefore(inline, tta)
                  else cci.insertBefore(inline, cci.firstChild)
                }
              })
              mo.observe(ci, { childList: true, subtree: false })
              resultsVideoChipState.set(vr, { chip: inline, mo })
            } catch {}
            return true
          }

          // If host nodes are not ready yet, observe the renderer until they appear
          if (!channelInfo || !thumbA) {
            const prev = resultsVideoChipState.get(vr)
            try { prev?.mo?.disconnect() } catch {}
            try {
              const mo = new MutationObserver(() => {
                if (overlayGeneration !== myGen) { try { mo.disconnect() } catch {}; return }
                if (!settings.resultsApplySelections || !settings.buttonChannelSub) return
                if (ensureMount()) { try { mo.disconnect() } catch {} }
              })
              mo.observe(vr, { childList: true, subtree: true })
              resultsVideoChipState.set(vr, { chip: (prev?.chip as HTMLElement) || document.createElement('a'), mo })
            } catch {}
            continue
          }

          // Host exists now, mount immediately
          ensureMount()

          // Reuse existing DOM chip if present to avoid duplication
          const existing = channelInfo.querySelector('a[data-wol-inline-channel]') as HTMLElement | null
          const inline = (managed?.chip as HTMLElement) || (existing as HTMLElement) || document.createElement('a')
          if (!managed?.chip) inline.setAttribute('data-wol-inline-channel', '1')
          inline.href = chUrl.href
          inline.target = '_blank'
          inline.title = `Open channel on ${platform.button.platformNameText}`
          inline.style.display = 'inline-flex'
          inline.style.alignItems = 'center'
          inline.style.justifyContent = 'center'
          inline.style.flex = '0 0 auto'
          inline.style.marginRight = '6px'
          inline.style.width = '22px'
          inline.style.height = '22px'
          inline.style.borderRadius = '11px'
          // Transparent background; let the icon fill the chip
          inline.style.background = 'transparent'
          inline.style.overflow = 'hidden'
          inline.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation() } catch {}; openNewTab(chUrl!, 'user') })
          // Ensure we have a single icon child, sized to fill
          let icon = inline.querySelector('img') as HTMLImageElement | null
          if (!icon) {
            icon = document.createElement('img')
            inline.appendChild(icon)
          }
          icon.src = platform.button.icon
          icon.style.width = '22px'
          icon.style.height = '22px'
          icon.style.display = 'block'
          icon.style.pointerEvents = 'none'
          // Ensure position before the avatar
          if (thumbA.parentElement === channelInfo) {
            if (inline.parentElement !== channelInfo || inline.nextElementSibling !== thumbA) {
              channelInfo.insertBefore(inline, thumbA)
            }
          } else {
            // Fallback: prepend into channelInfo
            if (inline.parentElement !== channelInfo || inline !== channelInfo.firstElementChild) {
              channelInfo.insertBefore(inline, channelInfo.firstChild)
            }
          }
          // If a stale CSS guard is still hiding pills, override and remove it
          try {
            const cs = getComputedStyle(inline)
            if (cs.display === 'none') {
              inline.style.setProperty('display', 'inline-flex', 'important')
              inline.style.setProperty('visibility', 'visible', 'important')
              const guard = document.getElementById('wol-results-pills-visibility')
              if (guard) guard.remove()
            }
          } catch {}
          // Observer already set inside ensureMount()
        } catch {}
      }
    } catch {}
    finally {
      lastResultsChipsAt = Date.now()
      // Quiet window after unchanged/no-progress runs
      try {
        if (resultsChipsBackoffMs > 0) {
          resultsChipsQuietUntil = Date.now() + Math.max(800, Math.min(resultsChipsBackoffMs, 5000))
        } else {
          resultsChipsQuietUntil = 0
        }
      } catch {}
      resultsVideoChipRunning = false
      if (resultsVideoChipPendingRerun && overlayGeneration === overlayGeneration) {
        resultsVideoChipPendingRerun = false
        scheduleRefreshResultsChips(120)
      }
    }
  }

  // Smart overlay management that preserves existing overlays when possible
  function manageOverlaysIntelligently() {
    const currentTime = Date.now()
    const currentUrl = window.location.href

    // Clean up overlays that are very old (reduced from 5 minutes to 90 seconds for better performance)
    for (const [overlayId, overlayData] of overlayState.entries()) {
      if (currentTime - overlayData.lastSeen > 90000) { // 90 seconds (reduced from 300000ms/5 minutes)
        overlayData.element.remove()
        overlayState.delete(overlayId)
      }
    }
  }

  // Throttling for enhancement function to prevent spam
  let lastEnhanceTime = 0
  let lastEnhanceUrl = ''

  // Ensure overlay enhancement scheduling and observers are active when buttonOverlay is enabled
  function ensureOverlayEnhancementActive() {
    // CRITICAL FIX: Capture current generation for observer lifetime
    const currentGen = overlayGeneration
    logger.log('🎬 ensureOverlayEnhancementActive called, gen:', currentGen, 'buttonOverlay:', settings.buttonOverlay)

    // Keep overlays cleaned when disabled, but do not short-circuit observers needed for results chips
    if (!settings.buttonOverlay) {
      triggerCleanupOverlays()
      logger.log('⚠️ Button overlay disabled, cleaning up')
    } else {
      ensureOverlayCssInjected()
      // Run overlay enhancement immediately when enabled
      scheduleEnhanceListings(0)
      logger.log('✨ Scheduled immediate enhancement')
    }

    // CRITICAL FIX: Always recreate observer to bind to current generation
    // Disconnect old observer if exists
    if (wolMutationObserver) {
      wolMutationObserver.disconnect()
      wolMutationObserver = null
    }

    // CRITICAL FIX: Skip global mutation observer on channel pages to prevent lockups
    // Channel pages with many videos cause hundreds of mutations that lock up the browser
    const isChannelPageForObserver = location.pathname.includes('/@') || location.pathname.includes('/channel/')

    if (!isChannelPageForObserver) {
      // Maintain a global observer to handle dynamic results content (watch pages, search results, etc)
      wolMutationObserver = new MutationObserver((mutations) => {
        // CRITICAL FIX: Check if generation changed (observer is stale)
        if (currentGen !== overlayGeneration) {
          logger.log('⚠️ Stale observer detected, gen:', currentGen, 'current:', overlayGeneration)
          if (wolMutationObserver) {
            wolMutationObserver.disconnect()
            wolMutationObserver = null
          }
          return
        }

        let shouldEnhance = false
        let shouldRefreshChips = false

        // CRITICAL FIX: Limit how many mutations we process to prevent lockups on pages with many videos
        const maxMutationsToCheck = 50
        const mutationsToCheck = mutations.slice(0, maxMutationsToCheck)

        for (const mutation of mutationsToCheck) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            // CRITICAL FIX: Limit how many nodes we check per mutation
            const maxNodesToCheck = 10
            const nodesToCheck = Math.min(mutation.addedNodes.length, maxNodesToCheck)

            for (let i = 0; i < nodesToCheck; i++) {
              const node = mutation.addedNodes[i]
              if (node.nodeType === Node.ELEMENT_NODE) {
                const element = node as Element
                if (element.querySelector && (
                  element.querySelector('a[href*="/watch?v="]') ||
                  element.querySelector('a[href*="/shorts/"]')
                )) {
                  shouldEnhance = true
                  if (location.pathname === '/results') shouldRefreshChips = true
                  break
                }
              }
            }
            if (shouldEnhance) break // Early exit once we know we need to enhance
          }
        }

        if (shouldEnhance && settings.buttonOverlay) {
          try { ensureResultsPillsVisibility() } catch {}
          // Use longer delays for mutation-triggered updates to batch more changes
          const enhanceDelay = location.pathname === '/watch' ? 200 : 100
          overlayDbg(`[DEBUG] Mutation observer detected new videos, scheduling enhancement with ${enhanceDelay}ms delay`)
          scheduleEnhanceListings(enhanceDelay)
        }
        if (shouldRefreshChips && settings.resultsApplySelections && settings.buttonChannelSub) {
          scheduleRefreshResultsChips(150)
          scheduleRefreshChannelButtons(200)
        }

        // Only enforce chip visibility on results pages, and do it less frequently
        if (location.pathname === '/results') {
          enforceResultsChannelChipVisibility()
        }
      })
      wolMutationObserver.observe(document.body, { childList: true, subtree: true })
      logger.log('✅ Global mutation observer enabled')
    } else {
      logger.log('⚠️ Skipping global mutation observer on channel page to prevent lockups')
      // On channel pages, use scroll-based re-enhancement to catch newly loaded videos
      scheduleEnhanceListings(1000) // Initial enhancement
      scheduleEnhanceListings(2500) // Retry for slow-loading initial videos

      // Clean up old scroll handler if exists
      if (wolChannelScrollHandler) {
        window.removeEventListener('scroll', wolChannelScrollHandler)
        wolChannelScrollHandler = null
      }

      // Set up scroll listener to re-enhance when user scrolls (debounced)
      let scrollTimer: number | null = null
      wolChannelScrollHandler = () => {
        if (scrollTimer !== null) clearTimeout(scrollTimer)
        scrollTimer = window.setTimeout(() => {
          if (location.pathname.includes('/@') || location.pathname.includes('/channel/') ||
              location.pathname.includes('/c/') || location.pathname.includes('/user/')) {
            scheduleEnhanceListings(300)
          }
        }, 500)
      }
      window.addEventListener('scroll', wolChannelScrollHandler, { passive: true })
      logger.log('✅ Scroll-based enhancement enabled for channel page')
    }

    // CRITICAL FIX: Poll for SPA navigation changes, but DON'T duplicate cleanup
    // The main bumpGen handler already handles this via yt-navigate events
    // Clear any existing interval to prevent duplicates
    if (wolNavigationPollInterval !== null) {
      clearInterval(wolNavigationPollInterval)
      wolNavigationPollInterval = null
    }

    // CRITICAL FIX: Skip navigation polling on channel pages to prevent lockups
    if (!isChannelPageForObserver) {
      wolNavigationPollInterval = window.setInterval(() => {
          const currentHref = window.location.href
          if (currentHref !== navigationLastHref) {
            navigationLastHref = currentHref
            dbg('Watch on Odysee: Detected location change (fallback polling) to', currentHref)

            // Don't call cleanup here - let the main navigation handler do it
            // Just trigger a re-enhancement to catch any missed updates
            lastEnhanceTime = 0; lastEnhanceUrl = ''

            if (settings.buttonOverlay) {
              scheduleEnhanceListings(400)  // Longer delay since main handler already ran
            }
            // Refresh results chips on nav as well
            if (location.pathname === '/results' && settings.resultsApplySelections && settings.buttonChannelSub) {
              scheduleRefreshResultsChips(120)
              scheduleRefreshChannelButtons(150)
            }
            scheduleProcessCurrentPage(50)
            try { ensureResultsPillsVisibility() } catch {}
            // A single immediate pass is enough; observers will catch late content
          }
      }, 1000) as unknown as number
      logger.log('✅ Navigation polling interval enabled')
    } else {
      logger.log('⚠️ Skipping navigation polling on channel page')
    }

    // CRITICAL FIX: Only observe tab container if we created a mutation observer (not on channel pages)
    if (wolMutationObserver && (window.location.pathname.includes('/@') || window.location.pathname.includes('/channel/'))) {
      const tabContainer = document.querySelector('ytd-c4-tabbed-header-renderer') ||
        document.querySelector('ytd-page-header-renderer')
      if (tabContainer) try { wolMutationObserver.observe(tabContainer, { childList: true, subtree: true }) } catch {}
    }
  }

  // Track retry attempts for initial load
  let lastEnhanceAttempt = { gen: 0, videoCount: 0, attempts: 0 }

  // Enhance video tiles on listing pages (e.g., /videos, related content) with an Odysee logo link
  async function enhanceVideoTilesOnListings(bypassThrottle: boolean = false) {
    // CRITICAL FIX: Prevent concurrent runs
    if (enhancementRunning) {
      logger.log('⏸️ Enhancement already running, skipping')
      return
    }
    enhancementRunning = true

    try {
      const gen = overlayGeneration
      logger.log('🎨 enhanceVideoTilesOnListings START, gen:', gen, 'url:', location.href)

      // Safety: prune any overlays from prior generations
      let prunedCount = 0
      for (const [key, ov] of overlayState.entries()) {
        if (ov.generation !== gen) {
          ov.element.remove()
          overlayState.delete(key)
          prunedCount++
        }
      }
      if (prunedCount > 0) {
        logger.log('🗑️ Pruned', prunedCount, 'overlays from old generation')
      }

       // Throttle calls to prevent excessive processing (unless bypassed for retries)
       const now = Date.now()
       const currentUrl = window.location.href
       if (!bypassThrottle) {
         const isResults = location.pathname === '/results'
         const isWatch = location.pathname === '/watch'
         // CRITICAL FIX: Measure time between completion of enhancements, not start
         // This allows mutation observer to trigger re-enhancement after initial work finishes
         const minGap = isWatch ? 600 : (isResults ? 400 : 300)
         // Allow immediate re-processing if URL changed
         if (now - lastEnhanceTime < minGap && currentUrl === lastEnhanceUrl) {
           logger.log('⏳ Enhancement throttled, last run completed', now - lastEnhanceTime, 'ms ago')
           enhancementRunning = false
           return
         }
       }
      // Update URL tracking at start to detect navigation
      lastEnhanceUrl = currentUrl
      logger.log('✅ Enhancement running for', currentUrl, bypassThrottle ? '(bypass throttle)' : '')

      // Check if overlay buttons are enabled - clean up overlays if disabled but continue for inline buttons
      if (!settings.buttonOverlay) {
        // Clean up any existing overlays when setting is disabled
        triggerCleanupOverlays()
        // But continue processing for /results page inline buttons which are controlled by other settings
        if (location.pathname !== '/results') {
          enhancementRunning = false
          return
        }
      }

      // If on results and the setting is disabled, remove any inline UI and stop
      if (location.pathname === '/results' && !settings.resultsApplySelections) {
        try {
          document.querySelectorAll('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch]').forEach(el => el.remove())
          document.querySelectorAll('a[data-wol-inline-channel], [data-wol-results-channel-btn]').forEach(el => el.remove())
          document.querySelectorAll('ytd-channel-renderer[data-wol-channel-button]')
            .forEach(el => (el as HTMLElement).removeAttribute('data-wol-channel-button'))
          document.querySelectorAll('[data-wol-overlay]').forEach(el => el.remove())
        } catch {}
        enhancementRunning = false
        return
      }

    // Debug logging for search pages
    if (WOL_DEBUG && window.location.pathname === '/results') {
      dbg('Watch on Odysee: Processing search results page:', window.location.href)
    }
    // CSS guard for results pills visibility
    try { ensureResultsPillsVisibility() } catch {}

    // Use intelligent overlay management instead of blind cleanup
    manageOverlaysIntelligently()

    // Clean up any context-inappropriate overlays before creating new ones
    cleanupOverlaysByPageContext()

    // On search results, remove any existing overlays entirely (we only keep channel renderer buttons)
    if (location.pathname === '/results') {
      try {
        document.querySelectorAll('[data-wol-overlay]').forEach(el => el.remove())
        // Also clear any pinned/hide attributes left over from earlier passes
        document.querySelectorAll('[data-wol-overlay]').forEach(el => {
          (el as HTMLElement).removeAttribute('data-wol-pinned')
          ;(el as HTMLElement).removeAttribute('data-wol-tile-pinned')
          ;(el as HTMLElement).removeAttribute('data-wol-hidden')
        })
        // Enforce current toggles by cleaning up inline pills when disabled or results application disabled
        if (!settings.resultsApplySelections || !settings.buttonVideoSub) {
          document.querySelectorAll('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch]').forEach(el => el.remove())
        }
        if (!settings.resultsApplySelections || !settings.buttonChannelSub) {
          document.querySelectorAll('a[data-wol-inline-channel], [data-wol-results-channel-btn]').forEach(el => el.remove())
          document.querySelectorAll('ytd-channel-renderer[data-wol-channel-button]')
            .forEach(el => (el as HTMLElement).removeAttribute('data-wol-channel-button'))
        }
      } catch {}
    }


    // Don't add overlays on playlist pages - they don't work well
    if (window.location.pathname.includes('/playlist') || window.location.pathname.includes('/podcasts')) {
      return
    }

    // Don't add overlays on the main Shorts player page; allow on watch pages for related content
    if ((window.location.pathname.startsWith('/shorts/') && window.location.pathname.split('/').length === 3)) {
      return
    }

    // Debug logging for Shorts pages (only log once per URL change)
    if (WOL_DEBUG && window.location.pathname.startsWith('/shorts') && currentUrl !== lastLoggedHref) {
      dbg('Watch on Odysee: Processing Shorts page for overlays, URL:', window.location.href)
      dbg('Watch on Odysee: Pathname:', window.location.pathname)

      // Check if this is a specific shorts video page or a shorts listing page
      const isSpecificShortsVideo = window.location.pathname.match(/^\/shorts\/[a-zA-Z0-9_-]+$/)
      if (isSpecificShortsVideo) {
        dbg('Watch on Odysee: This is a specific Shorts video page, not a listing page')
        return // Don't add overlays on the main Shorts player page
      }
    }

    // If generation changed during debounce, abort and let the next pass handle it
    if (gen !== overlayGeneration) return

    // On watch page, prepare container-level batch gating for related rail
    const isWatchPageForBatch = window.location.pathname === '/watch'
    if (isWatchPageForBatch && !relatedBatchRevealed) {
      const cont = getRelatedContainer()
      if (cont) {
        ensureRelatedBatchCssInjected()
        if (!cont.hasAttribute('data-wol-waiting-reveal')) cont.setAttribute('data-wol-waiting-reveal', '1')
        if (!relatedBatchStartAt) relatedBatchStartAt = Date.now()
      }
    }

    // Multiple selectors to catch different types of video tiles, but exclude main video area
    const selectors = [
      // Related videos and sidebar content (right side of watch page)
      '#secondary a[href*="/watch?v="]',                   // Secondary content (related videos)
      '#related a[href*="/watch?v="]',                     // Legacy/alternate related container
      'ytd-watch-next-secondary-results-renderer a[href*="/watch?v="]', // Watch next results
      'ytd-compact-video-renderer a[href*="/watch?v="]',  // Compact video renderers (related videos)

      // Channel page content (homepage, videos, shorts, live tabs)
      'ytd-c4-tabbed-header-renderer ~ * a[href*="/watch?v="]', // Content below channel header
      'ytd-section-list-renderer a[href*="/watch?v="]',   // Section list on channel pages
      'ytd-grid-video-renderer a[href*="/watch?v="]',     // Grid video renderers (channel pages)

      // Rich grid (channel pages, home feed) - use parent container for complete matching
      'ytd-rich-grid-renderer ytd-rich-item-renderer a[href*="/watch?v="]', // All anchors in rich grid items
      'ytd-rich-grid-renderer ytd-rich-grid-media a[href*="/watch?v="]',    // Rich grid media items
      'ytd-rich-grid-renderer a[href*="/shorts/"]',                         // Shorts in rich grid
      'ytd-channel-video-player-renderer a[href*="/watch?v="]', // Channel video players

      // General page content (home, search, trending, etc.) - fallback for non-grid layouts
      'ytd-rich-item-renderer a[href*="/watch?v="]',      // Rich item renderers (home page)
      'ytd-rich-item-renderer a[href*="/shorts/"]',       // Rich item renderers (shorts)
      'ytd-video-renderer a[href*="/watch?v="]',          // Video renderers (search results)
      'ytd-video-renderer a[href*="/shorts/"]',           // Video renderers (shorts in search)
      'ytd-reel-item-renderer a[href*="/watch?v="]',      // Reel item renderers (shorts)
      'ytd-reel-item-renderer a[href*="/shorts/"]',       // Reel item renderers (shorts)
      'ytd-rich-section-renderer a[href*="/watch?v="]',   // Rich section renderers
      'ytd-rich-section-renderer a[href*="/shorts/"]',    // Rich section renderers (shorts)

      // Shorts and live content
      'ytd-reel-shelf-renderer a[href*="/watch?v="]',     // Reel shelf renderers
      'ytd-rich-shelf-renderer a[href*="/watch?v="]',     // Rich shelf renderers

      // YouTube Shorts specific selectors (for Shorts shelves and listings)
      'ytd-shorts a[href*="/shorts/"]',                    // Direct Shorts links (note: shorts URLs don't use /watch?v=)
      'ytd-reel-shelf-renderer a[href*="/shorts/"]',       // Shorts shelf renderers
      'ytd-shorts ytd-rich-item-renderer a[href*="/shorts/"]', // Shorts rich items
      'ytd-shorts ytd-video-renderer a[href*="/shorts/"]',     // Shorts video renderers
      'ytd-shorts ytd-grid-video-renderer a[href*="/shorts/"]', // Shorts grid videos
      'ytd-shorts ytd-rich-grid-renderer a[href*="/shorts/"]',  // Shorts rich grid
      'ytd-shorts ytd-rich-grid-media a[href*="/shorts/"]',     // Shorts rich grid media

      // New grid shelf view model (Shorts in results)
      'yt-grid-shelf-view-model-wiz a[href*="/shorts/"]',
      '.ytGridShelfViewModelGridShelfItem a[href*="/shorts/"]',

      // Additional Shorts shelf selectors
      'ytd-rich-shelf-renderer[is-shorts] a[href*="/shorts/"]', // Rich shelf for Shorts
      'ytd-horizontal-card-list-renderer a[href*="/shorts/"]',  // Horizontal Shorts cards
      'ytd-horizontal-card-list-renderer ytd-grid-video-renderer a[href*="/shorts/"]',
      'ytd-horizontal-card-list-renderer ytd-grid-video-renderer a[href*="/watch?v="]',
      'ytd-item-section-renderer .ytGridShelfViewModelGridShelfRow a[href*="/shorts/"]',
      'ytd-item-section-renderer .ytGridShelfViewModelGridShelfRow a[href*="/watch?v="]',
      'ytd-carousel-shelf-renderer a[href*="/watch?v="]',
      'ytd-carousel-shelf-renderer a[href*="/shorts/"]',
      'yt-grid-shelf-view-model-wiz a[href*="/watch?v="]',

      // Live streams and live content
      'ytd-video-renderer[is-live] a[href*="/watch?v="]', // Live video renderers
      'ytd-rich-item-renderer[is-live] a[href*="/watch?v="]', // Live rich items
      'ytd-grid-video-renderer[is-live] a[href*="/watch?v="]', // Live grid videos

      // Search results and channel discovery
      'ytd-channel-renderer a[href*="/channel/"]',         // Channel renderers in search results
      'ytd-channel-renderer a[href*="/@"]',                // Channel renderers with @ handles
      'ytd-channel-renderer a[href*="/c/"]',               // Channel renderers with /c/ URLs
      'ytd-channel-renderer a[href*="/user/"]',            // Channel renderers with /user/ URLs

      // Fallback for other thumbnail areas, but exclude primary content
      'ytd-thumbnail a[href*="/watch?v="]',               // Thumbnail containers
      'ytd-thumbnail a[href*="/shorts/"]',                // Shorts in thumbnail containers
      '#contents a[href*="/watch?v="]',                   // Contents area (broad fallback)
      '#contents a[href*="/shorts/"]',                    // Shorts in contents area (broad fallback)
    ]

    const allAnchors: HTMLAnchorElement[] = []
    const selectorCounts: Record<string, number> = {}
    for (const selector of selectors) {
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector))
      if (anchors.length > 0) {
        selectorCounts[selector] = anchors.length
      }
      allAnchors.push(...anchors)
    }
    overlayDbg(`[DEBUG] Selectors that matched:`, selectorCounts)
    overlayDbg(`[DEBUG] Total anchors found: ${allAnchors.length}`)

    // Exclude anchors that belong to the featured channel player or playlist-only links
    let filteredCount = { total: 0, hero: 0, playlist: 0, playlistOnly: 0 }
    const filteredAnchors = allAnchors.filter(a => {
      try {
        const href = a.getAttribute('href') || ''
        const u = new URL(href, location.origin)
        filteredCount.total++
        // Skip anchors inside channel hero player
        if (a.closest('ytd-channel-video-player-renderer')) {
          filteredCount.hero++
          return false
        }
        // Skip playlist/Play All controls and playlist renderers
        if (a.closest('ytd-playlist-renderer, ytd-grid-playlist-renderer, ytd-compact-playlist-renderer, ytd-playlist-panel-video-renderer, ytd-playlist-thumbnail')) {
          filteredCount.playlist++
          return false
        }
        const label = (a.getAttribute('aria-label') || a.textContent || '').trim().toLowerCase()
        if (label === 'play all' || label.startsWith('play all')) return false
        if (u.pathname === '/playlist') return false
        // Skip playlist-only links (no explicit video id in href)
        const hasVideo = (u.pathname === '/watch' && !!u.searchParams.get('v')) || u.pathname.startsWith('/shorts/')
        if (!hasVideo && u.searchParams.has('list')) {
          filteredCount.playlistOnly++
          return false
        }
        return true
      } catch {
        return true
      }
    })

    // Debug logging for Shorts pages and search pages
    if (WOL_DEBUG && (window.location.pathname.startsWith('/shorts') || window.location.pathname === '/results')) {
      dbg('Watch on Odysee: Found', allAnchors.length, 'total anchors before filtering')
      dbg('Watch on Odysee: Selectors that found anchors:', selectors.filter((selector, i) => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector))
        return anchors.length > 0
      }))

      // For search pages, also log what channel renderers we find
      if (window.location.pathname === '/results') {
        const channelRenderers = document.querySelectorAll('ytd-channel-renderer')
        dbg('Watch on Odysee: Found', channelRenderers.length, 'channel renderers on search page')
        const videoRenderers = document.querySelectorAll('ytd-video-renderer')
        dbg('Watch on Odysee: Found', videoRenderers.length, 'video renderers on search page')
      }
    }

    // Exclude non-visible or main video area (but keep duplicates for scoring later)
    const uniqueAnchors = filteredAnchors.filter((anchor) => {
      // Exclude if this anchor is part of the main video area on watch pages
      const isMainVideo = anchor.closest('#ytd-player') &&
        !anchor.closest('#secondary') &&
        !anchor.closest('#related') &&
        !anchor.closest('ytd-watch-next-secondary-results-renderer') &&
        !anchor.closest('ytd-compact-video-renderer')

      // Also exclude if it's in the main video info area (title, description, etc.)
      const isMainVideoInfo = anchor.closest('#primary-inner') &&
        !anchor.closest('#secondary') &&
        anchor.closest('#above-the-fold, #below-the-fold')

      // Exclude comments and comment headers entirely on watch pages
      const isInComments = !!anchor.closest('#comments, ytd-comments, ytd-item-section-renderer#sections, ytd-comment-thread-renderer, ytd-comments-header-renderer')

      return !isMainVideo && !isMainVideoInfo && !isInComments
    })

    overlayDbg(`[DEBUG] Found ${allAnchors.length} total anchors, ${filteredAnchors.length} after filtering, ${uniqueAnchors.length} unique anchors`)
    overlayDbg(`[DEBUG] Filtered out: hero=${filteredCount.hero}, playlist=${filteredCount.playlist}, playlistOnly=${filteredCount.playlistOnly}`)

    const toProcess: { a: HTMLAnchorElement, id: string, type: 'video' | 'channel' }[] = []
    let skippedAlreadyEnhanced = 0
    const currentWatchVid = (() => { try { const u = new URL(location.href); return (location.pathname === '/watch') ? (u.searchParams.get('v') || null) : null } catch { return null } })()
    for (const a of uniqueAnchors) {
      // Skip anchors we already enhanced to avoid duplicate listeners/overlays
      if ((a as any).dataset && (a as any).dataset.wolEnhanced === 'done') {
        skippedAlreadyEnhanced++
        continue
      }
      const href = a.getAttribute('href') || ''
      const u = new URL(href, location.origin)

      // Extract video ID from either /watch?v= or /shorts/ URLs
      let vid: string | null = null
      let type: 'video' | 'channel' = 'video'

      if (u.pathname === '/watch') {
        vid = u.searchParams.get('v')
        type = 'video'
      } else if (u.pathname.startsWith('/shorts/')) {
        vid = u.pathname.split('/')[2] // Extract ID from /shorts/VIDEO_ID
        type = 'video'
      } else if (u.pathname.startsWith('/live/')) {
        vid = u.pathname.split('/')[2] // Extract ID from /live/VIDEO_ID
        type = 'video'
      } else if (u.pathname.startsWith('/channel/')) {
        vid = u.pathname.split('/')[2] // Extract ID from /channel/CHANNEL_ID
        type = 'channel'
      } else if (u.pathname.startsWith('/@')) {
        // For @ handles, extract the handle and treat as channel
        const handle = u.pathname.substring(1) // Remove leading /
        if (handle) {
          vid = handle
          type = 'channel'
        }
      } else if (u.pathname.startsWith('/c/') || u.pathname.startsWith('/user/')) {
        // For /c/ and /user/ URLs, extract the identifier and treat as channel
        const identifier = u.pathname.split('/')[2]
        if (identifier) {
          vid = identifier
          type = 'channel'
        }
      }

      // Skip rendering overlays for the same video as the current watch page
      if (currentWatchVid && type === 'video' && vid === currentWatchVid) {
        continue
      }

      // Upgrade channel @handle to channelId (UC...) when available in the same renderer
      if (type === 'channel' && vid && !vid.startsWith('UC')) {
        const channelRenderer = a.closest('ytd-channel-renderer') as HTMLElement | null
        const chAnchor = channelRenderer?.querySelector('a[href^="/channel/"]') as HTMLAnchorElement | null
        if (chAnchor) {
          try {
            const cu = new URL(chAnchor.getAttribute('href') || chAnchor.href, location.origin)
            const ucid = cu.pathname.split('/')[2]
            if (ucid && ucid.startsWith('UC')) vid = ucid
          } catch { }
        } else if (channelRenderer) {
          // Attempt to parse any serialized endpoint for browseId
          const epEl = channelRenderer.querySelector('[data-serialized-endpoint]') as HTMLElement | null
          if (epEl) {
            try {
              const ep = JSON.parse(epEl.getAttribute('data-serialized-endpoint') || '{}')
              const bid = ep?.browseEndpoint?.browseId
              if (typeof bid === 'string' && bid.startsWith('UC')) vid = bid
            } catch { }
          }
        }
      }

      if (!vid) {
        // Debug: log anchors that didn't match any pattern
        if (toProcess.length < 10) {  // Only log for first few to avoid spam
          overlayDbg(`[DEBUG] Skipped anchor with href: ${href} (pathname: ${u.pathname})`)
        }
        continue
      }
      if (WOL_DEBUG && (vid === '-zDqghyM_H0' || vid === '_b4uZhW-wYI' || vid === 'RDZxYZkz20lYA')) {
        logger.log(`[TOPROCESS DEBUG] Found video ${vid}:`, {
          vid,
          type,
          href,
          pathname: u.pathname,
          generation: gen
        })
      }
      toProcess.push({ a, id: vid, type })
    }

    overlayDbg(`[DEBUG] After processing: ${toProcess.length} items to process, skipped ${skippedAlreadyEnhanced} already enhanced`)

    if (toProcess.length === 0) return

    // De-duplicate by resolved id to avoid processing the same video twice (thumbnail + title, etc.)
    const scoreAnchor = (a: HTMLAnchorElement): number => {
      let s = 0
      // Highest priority: anchors in secondary/related sections ONLY on watch pages
      const isWatchPage = location.pathname === '/watch'
      const inSecondary = !!(a.closest('#secondary') || a.closest('#related'))
      if (isWatchPage && inSecondary) s += 100
      // Prioritize lockup UI anchors in secondary/related sections on watch pages
      if (isWatchPage && a.closest('yt-lockup-view-model') && inSecondary) s += 25
      if (a.matches('a#thumbnail, a#thumbnail.yt-simple-endpoint, a.yt-simple-endpoint.inline-block.style-scope.ytd-thumbnail')) s += 20
      if (a.closest('ytd-thumbnail')) s += 15
      if (a.closest('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer')) s += 10
      if (a.closest('#dismissible')) s += 4
      return s
    }
    const byId = new Map<string, { a: HTMLAnchorElement, id: string, type: 'video' | 'channel' }>()
    for (const item of toProcess) {
      // CRITICAL FIX: Check generation during dedup to abort if navigation happened
      if (gen !== overlayGeneration) {
        overlayDbg(`[DEBUG] Aborting dedup - generation changed from ${gen} to ${overlayGeneration}`)
        enhancementRunning = false
        return
      }

      const prev = byId.get(item.id)
      if (!prev) {
        byId.set(item.id, item)
      } else {
        const ns = scoreAnchor(item.a)
        const ps = scoreAnchor(prev.a)
        const inSecNew = !!(item.a.closest('#secondary') || item.a.closest('#related'))
        const inSecPrev = !!(prev.a.closest('#secondary') || prev.a.closest('#related'))
        overlayDbg(`[DEBUG] Dedup for ${item.id}: new score=${ns} (inSec=${inSecNew}) vs old score=${ps} (inSec=${inSecPrev})`)
        if (ns > ps) {
          overlayDbg(`[DEBUG] Dedup replaced for ${item.id}: new score=${ns} (inSec=${inSecNew}) vs old score=${ps} (inSec=${inSecPrev})`)
          byId.set(item.id, item)
        }
      }
    }
    let dedupedToProcess = Array.from(byId.values())

    // Filter out videos where the best anchor is in #secondary on non-watch pages
    // These are likely from a hidden sidebar and shouldn't be processed
    const isWatchPage = location.pathname === '/watch'
    if (!isWatchPage) {
      const beforeFilter = dedupedToProcess.length
      dedupedToProcess = dedupedToProcess.filter(item => {
        const inSecondary = !!(item.a.closest('#secondary') || item.a.closest('#related'))
        if (inSecondary) {
          overlayDbg(`[DEBUG] Filtering out ${item.id} - best anchor is in #secondary on non-watch page`)
          return false
        }
        return true
      })
      if (beforeFilter !== dedupedToProcess.length) {
        overlayDbg(`[DEBUG] Filtered out ${beforeFilter - dedupedToProcess.length} videos with #secondary anchors on non-watch page`)
      }
    }

    overlayDbg(`[DEBUG] Deduplication: ${toProcess.length} anchors -> ${dedupedToProcess.length} unique video IDs`)
    if (dedupedToProcess.length <= 10) {
      overlayDbg(`[DEBUG] Unique video IDs:`, Array.from(byId.keys()))
    } else {
      overlayDbg(`[DEBUG] First 10 video IDs:`, Array.from(byId.keys()).slice(0, 10))
    }

    // OPTIMIZATION: On /results pages, we already know which videos have Odysee targets from resolvedLocal
    // Filter to only process videos that have targets - no point processing videos that don't exist on Odysee
    if (location.pathname === '/results') {
      const beforeFilter = dedupedToProcess.length
      dedupedToProcess = dedupedToProcess.filter(item => {
        const key = `${item.type}:${item.id}`
        return resolvedLocal.has(key) && resolvedLocal.get(key) !== null
      })
      if (beforeFilter !== dedupedToProcess.length) {
        overlayDbg(`[DEBUG] Filtered out ${beforeFilter - dedupedToProcess.length} videos with no Odysee targets`)
      }
    }

    dbg(`Enhancing ${toProcess.length} tiles with Odysee overlays (videos and channels)`)

     // Upgrade channel handles (@...) to UC ids when possible before resolving
     async function upgradeChannelIdFromRenderer(anchor: HTMLAnchorElement, id: string): Promise<string> {
       if (id.startsWith('UC')) return id
       const channelRenderer = anchor.closest('ytd-channel-renderer') as HTMLElement | null
       const chAnchor = channelRenderer?.querySelector('a[href^="/channel/"]') as HTMLAnchorElement | null
       if (chAnchor) {
         try {
           const cu = new URL(chAnchor.getAttribute('href') || chAnchor.href, location.origin)
           const ucid = cu.pathname.split('/')[2]
           if (ucid && ucid.startsWith('UC')) return ucid
         } catch { }
       }
       
       // For results page, be more aggressive about finding UC IDs from existing DOM before fetching
       if (location.pathname === '/results' && channelRenderer) {
         try {
           // Look for serialized endpoints or other DOM hints first
           const endpoints = channelRenderer.querySelectorAll('[data-serialized-endpoint]')
           for (const ep of Array.from(endpoints)) {
             try {
               const data = JSON.parse((ep as HTMLElement).getAttribute('data-serialized-endpoint') || '{}')
               const browseId = data?.browseEndpoint?.browseId
               if (browseId && browseId.startsWith('UC')) return browseId
             } catch {}
           }
           
           // Look for any UC channel IDs in text content or data attributes
           const allText = channelRenderer.textContent || ''
           const ucMatch = allText.match(/UC[a-zA-Z0-9_-]{22}/)
           if (ucMatch) return ucMatch[0]
         } catch {}
       }
       
       // Only fetch as last resort, and with timeout
       try {
         const href = anchor.getAttribute('href') || anchor.href
         if (href && href.startsWith('/@')) {
           const controller = new AbortController()
           const timeoutId = setTimeout(() => controller.abort(), 2000) // 2 second timeout
           
           const response = await fetch(href, { 
             credentials: 'same-origin',
             signal: controller.signal
           })
           clearTimeout(timeoutId)
           
           const html = await response.text()
           const m = html.match(/\"channelId\"\s*:\s*\"([^\"]+)\"/) || html.match(/feeds\/videos\.xml\?channel_id=([A-Za-z0-9_-]+)/)
           if (m?.[1]?.startsWith('UC')) return m[1]
         }
       } catch { }
       return id
     }

    let normalizedToProcess = await Promise.all(dedupedToProcess.map(async (x) => {
      if (x.type === 'channel' && x.id && !x.id.startsWith('UC')) {
        const upgraded = await upgradeChannelIdFromRenderer(x.a, x.id)
        return { ...x, id: upgraded }
      }
      return x
    }))
    // Drop any channel entries that are not UC... after upgrade to avoid invalid resolver calls
    normalizedToProcess = normalizedToProcess.filter(x => x.type !== 'channel' || x.id.startsWith('UC'))

    const platform = targetPlatformSettings[settings.targetPlatform]
    // Resolve only keys not in local cache
    const keyOf = (x: {id: string, type: 'video'|'channel'}) => `${x.type}:${x.id}`
    const toResolveItems = normalizedToProcess.filter(x => !resolvedLocal.has(keyOf(x)))
    if (toResolveItems.length > 0) {
      if (gen !== overlayGeneration) return
      const srcPlatform = getSourcePlatfromSettingsFromHostname(location.hostname)!
      const sources = toResolveItems.map(x => ({ platform: srcPlatform, id: x.id, type: x.type, url: new URL(location.href), time: null }))
      const results = await getTargetsBySources(...sources)
      if (gen !== overlayGeneration) return
      for (const x of toResolveItems) {
        const t = results[x.id] ?? null
        resolvedLocal.set(keyOf(x), t)
        if (WOL_DEBUG && (x.id === '-zDqghyM_H0' || x.id === '_b4uZhW-wYI' || x.id === 'RDZxYZkz20lYA')) {
          logger.log(`[RESOLVED DEBUG] Adding to resolvedLocal:`, {
            id: x.id,
            type: x.type,
            key: keyOf(x),
            target: t,
            generation: gen
          })
        }
      }
    }

    // Process anchors with yielding to prevent blocking
    let processedCount = 0
    // Detect if we're on a channel page (which can have many videos)
    const isChannelPage = location.pathname.includes('/@') || location.pathname.includes('/channel/') ||
                          location.pathname.includes('/c/') || location.pathname.includes('/user/')

    // When on a channel page, populate persistent cache with the correct UC mapping
    if (isChannelPage) {
      try {
        let channelHandle: string | null = null
        let channelUC: string | null = null

        // Extract handle from URL
        const handleMatch = location.pathname.match(/\/@([^\/]+)/)
        if (handleMatch) {
          channelHandle = handleMatch[1]
        }

        // Extract UC from URL
        const ucMatch = location.pathname.match(/\/channel\/(UC[^\/]+)/)
        if (ucMatch) {
          channelUC = ucMatch[1]
        }

        // Try to get UC from the page if we only have handle
        if (channelHandle && !channelUC) {
          // Look for channel ID in meta tags or page data
          const metaChannelId = document.querySelector('meta[itemprop="channelId"]')?.getAttribute('content') ||
                              document.querySelector('meta[property="og:url"]')?.getAttribute('content')?.match(/\/channel\/(UC[^\/]+)/)?.[1]
          if (metaChannelId && metaChannelId.startsWith('UC')) {
            channelUC = metaChannelId
          }

          // Also try ytInitialData
          if (!channelUC) {
            const initialData = (window as any).ytInitialData || (window as any).ytcfg?.data_?.INITIAL_DATA
            if (initialData?.header?.c4TabbedHeaderRenderer?.channelId) {
              channelUC = initialData.header.c4TabbedHeaderRenderer.channelId
            } else if (initialData?.metadata?.channelMetadataRenderer?.externalId) {
              channelUC = initialData.metadata.channelMetadataRenderer.externalId
            }
          }
        }

        // If we have both handle and UC, update caches
        if (channelHandle && channelUC && channelUC.startsWith('UC')) {
          // Update in-memory caches
          const normalizedHandle = channelHandle.startsWith('@') ? channelHandle.slice(1) : channelHandle

          // Store in persistent cache for future use - wrap in async function
          (async () => {
            try {
              await channelCache.putHandle(normalizedHandle, channelUC)
              await channelCache.putYtUrl(`/@${normalizedHandle}`, channelUC)
              await channelCache.putYtUrl(`/channel/${channelUC}`, channelUC)

              // Also update in-memory caches for immediate use
              const srcPlatform = getSourcePlatfromSettingsFromHostname(location.hostname)!
              const srcs = [{ platform: srcPlatform, id: channelUC, type: 'channel' as const, url: new URL(location.href), time: null }]
              const resolved = await getTargetsBySources(...srcs)
              const target = resolved[channelUC] || null
              if (target) {
                ucResolvePageCache.set(channelUC, target)
                handleResolvePageCache.set(normalizedHandle, target)
                ytUrlResolvePageCache.set(`/@${normalizedHandle}`, target)
                ytUrlResolvePageCache.set(`/channel/${channelUC}`, target)
              }
            } catch {
              // Silently fail - cache population is best-effort
            }
          })()
        }
      } catch {
        // Silently fail - cache extraction is best-effort
      }
    }

    // CRITICAL: Clean up stale overlays for videos that don't have Odysee targets
    // Do this once before processing to avoid expensive per-video querySelectorAll calls
    try {
      const allExistingOverlays = document.querySelectorAll('[data-wol-overlay]')
      const validVideoIds = new Set<string>()
      for (const [key, target] of resolvedLocal.entries()) {
        if (target && key.startsWith('video:')) {
          validVideoIds.add(key.substring(6)) // Remove 'video:' prefix
        }
      }
      let removedCount = 0
      for (const overlay of allExistingOverlays) {
        const videoId = overlay.getAttribute('data-wol-overlay')
        if (videoId && !validVideoIds.has(videoId)) {
          try { overlay.remove(); removedCount++ } catch {}
          try { overlayState.delete(videoId) } catch {}
        }
      }
      if (removedCount > 0) {
        logger.log(`🗑️ Removed ${removedCount} stale overlay(s) with no Odysee target`)
      }
    } catch (e) {
      logger.error('Error cleaning stale overlays:', e)
    }

    // CRITICAL: On channel pages, process in smaller batches to prevent freezing
    const batchSize = isChannelPage ? 2 : 10

    overlayDbg(`[DEBUG] Starting processing loop for ${normalizedToProcess.length} items (channel page: ${isChannelPage}, batch size: ${batchSize})`)

    for (const { a, id, type } of normalizedToProcess) {
      // CRITICAL: Check generation at start of EVERY iteration for fast cancellation
      if (gen !== overlayGeneration) {
        overlayDbg(`[DEBUG] Breaking processing loop - generation changed from ${gen} to ${overlayGeneration}`)
        break
      }

      // Yield control back to the browser after every batch
      processedCount++
      if (processedCount % batchSize === 0) {
        overlayDbg(`[DEBUG] Processing progress: ${processedCount}/${normalizedToProcess.length} items (yielding)`)
        await idleYield(0)
        if (gen !== overlayGeneration) break
      } else if (processedCount % 10 === 0) {
        overlayDbg(`[DEBUG] Processing progress: ${processedCount}/${normalizedToProcess.length} items`)
      }

      const res = resolvedLocal.get(`${type}:${id}`) ?? null
      // Results page: do not hide or remove result tiles. Settings only control overlay/button UI.
      // Any attributes previously used to hide are cleared elsewhere when toggles change.
      // For non-results pages we require a resolved target; for results page we may still
      // inject channel chips for video tiles even when the video itself did not resolve.
      let url: URL | null = null
      if (res) {
        url = getOdyseeUrlByTarget(res)
        if (WOL_DEBUG && (id === '-zDqghyM_H0' || id === '_b4uZhW-wYI' || id === 'RDZxYZkz20lYA')) {
          logger.log(`[OVERLAY URL DEBUG] Video ${id} resolved to:`, {
            type,
            id,
            res,
            url: url?.href,
            resolvedLocalKey: `${type}:${id}`,
            resolvedLocalHas: resolvedLocal.has(`${type}:${id}`),
            generation: gen
          })
        }
      }
      if (!res && location.pathname !== '/results') {
        continue
      }

      // On /results, render inline buttons instead of overlays for video tiles
      if (location.pathname === '/results') {
        // If results application is disabled, never inject any pills on results
        if (!settings.resultsApplySelections) {
          ;(a as any).dataset.wolEnhanced = 'done'
          continue
        }
        if (type === 'video') {
          try {
            const videoRenderer = a.closest('ytd-video-renderer') as HTMLElement | null
            if (videoRenderer) {
              // 1) Inline "Watch on Odysee" pill to the right of the title/menu
              if (settings.buttonVideoSub && url && !videoRenderer.querySelector('[data-wol-inline-watch]')) {
                const titleWrapper = (videoRenderer.querySelector('#title-wrapper') as HTMLElement | null) || (videoRenderer.querySelector('#meta') as HTMLElement | null) || videoRenderer
                const menu = videoRenderer.querySelector('#menu') as HTMLElement | null
                const btn = document.createElement('a')
                btn.setAttribute('data-wol-inline-watch', '1')
                btn.href = url.href
                btn.target = '_blank'
                btn.title = `Watch on ${platform.button.platformNameText}`
                btn.style.display = 'inline-flex'
                btn.style.alignItems = 'center'
                btn.style.justifyContent = 'center'
                btn.style.gap = '6px'
                // Keep a small gap from the title; align with menu
                btn.style.marginLeft = '8px'
                // Uniform size similar to channel pill
                btn.style.height = '28px'
                btn.style.lineHeight = '28px'
                btn.style.padding = '0 10px'
                btn.style.borderRadius = '14px'
                btn.style.fontSize = '12px'
                btn.style.fontWeight = '500'
                btn.style.boxSizing = 'border-box'
                btn.style.letterSpacing = '0.2px'
                // Align with title/menu row
                btn.style.alignSelf = 'center'
                btn.style.verticalAlign = 'middle'
                btn.style.border = '0'
                // Slight nudge down to align with 3‑dot menu
                btn.style.marginTop = '3px'
                btn.style.whiteSpace = 'nowrap'
                btn.style.textDecoration = 'none'
                btn.style.color = 'whitesmoke'
                btn.style.background = platform.theme
                const i = document.createElement('img')
                i.src = platform.button.icon
                i.style.width = '20px'
                i.style.height = '20px'
                i.style.pointerEvents = 'none'
                const t = document.createElement('span')
                t.textContent = 'Watch'
                btn.appendChild(i)
                btn.appendChild(t)
                btn.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation() } catch {}; openNewTab(url, 'user') })
                // Prefer to mount inside the right-side menu so it stays flush-right
                const menuRenderer = (videoRenderer.querySelector('#menu ytd-menu-renderer') as HTMLElement | null)
                const menuButtons = (menuRenderer?.querySelector('#flexible-item-buttons') as HTMLElement | null)
                  || (menuRenderer?.querySelector('#top-level-buttons-computed') as HTMLElement | null)
                const threeDots = (menuRenderer?.querySelector('yt-icon-button#button') as HTMLElement | null)
                let mounted = false
                try {
                  if (menuButtons) { menuButtons.insertAdjacentElement('afterbegin', btn); mounted = true }
                  else if (menuRenderer && threeDots) { menuRenderer.insertBefore(btn, threeDots); mounted = true }
                } catch {}
                if (!mounted) {
                  const parent = (menu && menu.parentElement) || titleWrapper
                  if (parent) {
                    if (menu && menu.parentElement === parent) parent.insertBefore(btn, menu)
                    else parent.appendChild(btn)
                  }
                }
                if (WOL_DEBUG) dbg('WOL results inline watch injected', { videoId: id })
              }
              
              // Channel chips beside video results are handled by refreshResultsVideoChannelChips()
            }
            // Handle Shorts in grid shelf rows: add a bottom-right Watch pill
            // Shorts grid shelf tiles: place pill inside the larger tile container (not the anchor) to avoid autoplay overlap
            const gridItem = a.closest('.ytGridShelfViewModelGridShelfItem') as HTMLElement | null
            if (settings.buttonVideoSub && url && gridItem && !gridItem.querySelector('[data-wol-inline-shorts-watch]')) {
              try {
                // Ensure grid item can host an absolute child
                const hostEl = gridItem
                const cs = window.getComputedStyle(hostEl)
                if (cs.position === 'static') hostEl.style.position = 'relative'
                const sbtn = document.createElement('a')
                sbtn.setAttribute('data-wol-inline-shorts-watch', '1')
                sbtn.href = url.href
                sbtn.target = '_blank'
                sbtn.title = `Watch on ${platform.button.platformNameText}`
                sbtn.style.position = 'absolute'
                sbtn.style.right = '8px'
                // Place at bottom-right of the OUTER tile (grid item), opposite the view count
                // Avoid aligning to the thumbnail to prevent drifting into the autoplay region
                sbtn.style.bottom = '4px'
                sbtn.style.zIndex = '5'
                sbtn.style.display = 'inline-flex'
                sbtn.style.alignItems = 'center'
                sbtn.style.justifyContent = 'center'
                sbtn.style.gap = '4px'
                sbtn.style.height = '22px'
                sbtn.style.lineHeight = '22px'
                sbtn.style.padding = '0 8px'
                sbtn.style.borderRadius = '11px'
                sbtn.style.fontSize = '11px'
                sbtn.style.fontWeight = '500'
                sbtn.style.color = 'whitesmoke'
                sbtn.style.textDecoration = 'none'
                sbtn.style.background = platform.theme
                const si = document.createElement('img')
                si.src = platform.button.icon
                si.style.width = '12px'
                si.style.height = '12px'
                si.style.pointerEvents = 'none'
                const st = document.createElement('span')
                st.textContent = 'Watch'
                sbtn.appendChild(si)
                sbtn.appendChild(st)
                sbtn.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation() } catch {}; openNewTab(url, 'user') })
                hostEl.appendChild(sbtn)
                if (WOL_DEBUG) dbg('WOL results shorts shelf watch added (grid item container)', { videoId: id })
              } catch (e) { if (WOL_DEBUG) dbg('WOL results shorts shelf watch error', e) }
            }
          } catch (e) { logger.warn('WOL results inline inject failed', e) }
          ;(a as any).dataset.wolEnhanced = 'done'
          continue
        }
        // For channel items on results we keep existing channel renderer injection below
      }

      // For channels, we need to find a different host element (subscribe button area)
      if (type === 'channel') {
        dbg('Watch on Odysee: Processing channel type for', id)
        // Case A: channel search result card
        const channelRenderer = a.closest('ytd-channel-renderer') as HTMLElement | null
        // Case B: channel link inside a video result item
        const videoResult = a.closest('ytd-video-renderer') as HTMLElement | null
        dbg('Watch on Odysee: Channel renderer found:', !!channelRenderer, 'Inside video result:', !!videoResult)
        if (channelRenderer) {
          // Defer all /results channel-renderer buttons to the dedicated refresher
          if (location.pathname === '/results') {
            ;(a as any).dataset.wolEnhanced = 'done'
            continue
          }
          // Skip channel renderer buttons on channel pages - they're not needed and the styling is expensive
          const isChannelPageNow = location.pathname.includes('/@') || location.pathname.includes('/channel/') ||
                                   location.pathname.includes('/c/') || location.pathname.includes('/user/')
          if (isChannelPageNow) {
            ;(a as any).dataset.wolEnhanced = 'done'
            continue
          }
          if (!settings.resultsApplySelections || !settings.buttonChannelSub) {
            // If disabled, ensure any injected channel buttons are removed and observers disconnected
            try { triggerCleanupResultsChannelButtons() } catch {}
            continue
          }
          // Reuse existing managed button for this renderer if present; just update the href and ensure attached
          const existingState = channelRendererState.get(channelRenderer)
          if (existingState?.btn) {
            try {
              // Do not set href here (URL computed below). Ensure node is attached; sizing updated later.
              if (!existingState.btn.isConnected) {
                const subBtn = channelRenderer.querySelector('#subscribe-button') as HTMLElement | null
                const btns = (channelRenderer.querySelector('#buttons') as HTMLElement | null)
                  || (channelRenderer.querySelector('#action-buttons') as HTMLElement | null)
                  || (subBtn?.parentElement as HTMLElement | null)
                  || channelRenderer
                if (btns) {
                  if (subBtn && subBtn.parentElement === btns) btns.insertBefore(existingState.btn, subBtn)
                  else btns.appendChild(existingState.btn)
                }
              }
              channelRenderer.setAttribute('data-wol-channel-button', '1')
              // Do not continue; href + sizing will be set once chUrl is computed below
            } catch {}
          }
          // Look for potential action containers in various layouts (search results, channel lists)
          const buttonsContainer = (channelRenderer.querySelector('#buttons') as HTMLElement | null)
            || (channelRenderer.querySelector('#action-buttons') as HTMLElement | null)
            || (channelRenderer.querySelector('#subscribe-button')?.parentElement as HTMLElement | null)
            || channelRenderer
          const subscribeButton = channelRenderer.querySelector('#subscribe-button') as HTMLElement | null

                     // Create channel redirect button (compact)
           const channelButton = document.createElement('div')
           channelButton.setAttribute('data-wol-results-channel-btn','1')
           channelButton.style.display = 'inline-flex'
           channelButton.style.alignItems = 'center'
           channelButton.style.marginRight = '6px'
           channelButton.style.height = '28px'

          const channelLink = document.createElement('a')
          channelLink.href = url.href
          channelLink.target = '_blank'
          channelLink.style.display = 'flex'
          channelLink.style.alignItems = 'center'
          channelLink.style.gap = '6px'
          channelLink.style.borderRadius = '14px'
          channelLink.style.padding = '0 6px'
          channelLink.style.height = '28px'
          channelLink.style.lineHeight = '28px'
          channelLink.style.fontWeight = '500'
          channelLink.style.border = '0'
          channelLink.style.color = 'whitesmoke'
          channelLink.style.fontSize = '12px'
          channelLink.style.textDecoration = 'none'
          channelLink.style.backgroundColor = platform.theme
          channelLink.style.backgroundImage = platform.theme

          // Ensure clicks use our openNewTab handler so suppression is recorded
          channelLink.addEventListener('click', (e) => {
            try { e.preventDefault() } catch {}
            try { e.stopPropagation() } catch {}
            openNewTab(url, 'user')
          })

          const icon = document.createElement('img')
          icon.src = platform.button.icon
          icon.style.height = '20px'
          icon.style.width = '20px'

          const text = document.createElement('span')
          text.textContent = 'Channel'
          text.style.minWidth = 'fit-content'
          text.style.whiteSpace = 'nowrap'

          channelLink.appendChild(icon)
          channelLink.appendChild(text)
          channelButton.appendChild(channelLink)

          let injected = false
          if (buttonsContainer && subscribeButton) {
            dbg('Watch on Odysee: Taking adaptive styling path')
            if (subscribeButton.parentElement === buttonsContainer) {
              buttonsContainer.insertBefore(channelButton, subscribeButton)
            } else {
              buttonsContainer.appendChild(channelButton)
            }
            // Match Subscribe button size and paddings for a native look
            try {
              // CRITICAL FIX: Check generation before expensive DOM operations
              if (gen !== overlayGeneration) {
                dbg('Watch on Odysee: Aborting channel button styling - generation changed')
                return
              }

              // Prefer an actual clickable button within the subscribe container for accurate metrics
              const subBtnEl = (subscribeButton.querySelector('button, a, yt-button-shape button, yt-button-shape a, ytd-subscribe-button-renderer button') as HTMLElement | null) || subscribeButton
              let sbh = subBtnEl.getBoundingClientRect().height || (subBtnEl as any).offsetHeight || 0
              if (!sbh) {
                // CRITICAL FIX: Removed expensive querySelectorAll('*') fallback that blocks during navigation
                // Just use a reasonable default height instead
                sbh = 36
              }
              const h = Math.max(24, Math.round(sbh || 36))
              channelButton.style.height = `${h}px`
              channelButton.style.alignItems = 'center'
              channelLink.style.height = `${h}px`
              channelButton.style.verticalAlign = 'center'
              channelLink.style.verticalAlign = 'center'
              // Mirror subscribe button computed styles where sensible
              const subscribeStyle = window.getComputedStyle(subBtnEl)
              if (subscribeStyle?.fontSize) channelLink.style.fontSize = subscribeStyle.fontSize
              if (subscribeStyle?.borderRadius) channelLink.style.borderRadius = subscribeStyle.borderRadius
              if (subscribeStyle?.lineHeight && subscribeStyle.lineHeight !== 'normal') {
                channelLink.style.lineHeight = subscribeStyle.lineHeight
              } else {
                channelLink.style.lineHeight = `${h}px`
              }
              // Respect horizontal paddings; keep compact look if unavailable
              if (subscribeStyle?.paddingLeft && subscribeStyle?.paddingRight) {
                channelLink.style.paddingLeft = subscribeStyle.paddingLeft
                channelLink.style.paddingRight = subscribeStyle.paddingRight
              }
              // Center align within the actions row and reset vertical margins
              channelButton.style.marginTop = subscribeStyle?.marginTop || '0'
              // Ensure we always have some bottom margin, even if subscribe button doesn't
              const subMarginBottom = subscribeStyle?.marginBottom || '0px'
              channelButton.style.marginBottom = (subMarginBottom === '0px') ? '8px' : subMarginBottom
              channelButton.style.alignSelf = 'center'
              channelLink.style.alignSelf = 'center'
              channelButton.style.verticalAlign = 'center'
              channelLink.style.verticalAlign = 'center'
              // Keep a comfortable internal gap
              channelLink.style.gap = '6px'
            } catch {}
            injected = true
          }

          // Fallback: inject in a simple way if adaptive styling didn't work
          if (!injected && buttonsContainer) {
            buttonsContainer.appendChild(channelButton)
            // Apply manual margin-bottom for spacing
            channelButton.style.marginBottom = '8px'
            injected = true
          }

          if (injected) {
            // Mark renderer and manage via a single observer per renderer to prevent duplicates
            channelRenderer.setAttribute('data-wol-channel-button', '1')
            try {
              const ensurePresent = () => {
                if (!settings.resultsApplySelections || !settings.buttonChannelSub) {
                  try { channelButton.remove() } catch {}
                  return
                }
                const stillThere = channelButton.isConnected && channelRenderer.contains(channelButton)
                const subBtn = channelRenderer.querySelector('#subscribe-button') as HTMLElement | null
                const btns = (channelRenderer.querySelector('#buttons') as HTMLElement | null)
                  || (channelRenderer.querySelector('#action-buttons') as HTMLElement | null)
                  || (subBtn?.parentElement as HTMLElement | null)
                  || channelRenderer
                if (!stillThere && btns) {
                  if (subBtn && subBtn.parentElement === btns) btns.insertBefore(channelButton, subBtn)
                  else btns.appendChild(channelButton)
                }
              }
              const prev = channelRendererState.get(channelRenderer)
              try { prev?.mo?.disconnect() } catch {}
              const crMo = new MutationObserver(() => { ensurePresent() })
              crMo.observe(channelRenderer, { childList: true, subtree: true })
              channelRendererState.set(channelRenderer, { btn: channelButton, mo: crMo })
            } catch {}
          }

            // Mark as enhanced
            ; (a as any).dataset.wolEnhanced = 'done'
          continue
        }

        // Inline channel icon beside channel name on results page was causing extra DOM churn.
        // It has been removed to reduce CPU overhead on large result sets.
      }

       // Only create overlays if buttonOverlay setting is enabled
       if (!settings.buttonOverlay) {
         ; (a as any).dataset.wolEnhanced = 'done'
         continue
       }

       // If a pinned overlay for this id is already active anywhere (e.g., during hover), skip
       try {
         const pinnedExisting = document.querySelector(`[data-wol-overlay="${id}"][data-wol-pinned="1"]`)
       if (pinnedExisting) { (a as any).dataset.wolEnhanced = 'done'; continue }
      } catch {}

      // Hard de-dupe: if multiple overlays with the same id exist (e.g., from hover/floating races),
      // keep the one attached to a thumbnail-like container and remove the rest before proceeding.
      try {
        const dups = Array.from(document.querySelectorAll(`[data-wol-overlay="${id}"]`)) as HTMLElement[]
        if (dups.length > 1) {
          const preferred = dups.find(el => !!(el.closest('ytd-thumbnail, yt-thumbnail-view-model, a#thumbnail, .yt-lockup-view-model-wiz__content-image, .ytThumbnailViewModelImage')))
            || dups[0]
          for (const el of dups) {
            if (el !== preferred) { try { el.remove() } catch {} }
          }
        }
      } catch {}

      // Find the best host element for the overlay - prioritize the actual thumbnail/video area
      const thumb = a.closest('ytd-thumbnail') as HTMLElement | null
      const compactVideo = a.closest('ytd-compact-video-renderer') as HTMLElement | null
      const richItem = a.closest('ytd-rich-item-renderer') as HTMLElement | null
      const videoRenderer = a.closest('ytd-video-renderer') as HTMLElement | null
      const gridVideo = a.closest('ytd-grid-video-renderer') as HTMLElement | null
      const richGridMedia = a.closest('ytd-rich-grid-media') as HTMLElement | null
      const reelItem = a.closest('ytd-reel-item-renderer') as HTMLElement | null
      const shortsLockup = a.closest('ytd-shorts-lockup-view-model') as HTMLElement | null

      // Detect if this tile is a Shorts tile regardless of current page path
      let isShortsHref = false
      try {
        const hrefStr = a.getAttribute('href') || a.href || ''
        const parsed = new URL(hrefStr, location.origin)
        isShortsHref = parsed.pathname.startsWith('/shorts/')
      } catch { }
      const isShortsTile = isShortsHref
        || !!(reelItem || shortsLockup || a.closest('ytd-shorts')
          || a.closest('ytd-rich-shelf-renderer[is-shorts]') || a.closest('ytd-reel-shelf-renderer'))

      // Try to find the actual thumbnail image container for better positioning
      let host: HTMLElement | null = null
      // Stable tile container for observation and re-attach on preview/autoplay
      let tileContainer = (videoRenderer || gridVideo || richGridMedia || reelItem || shortsLockup || richItem || compactVideo || thumb) as HTMLElement | null

      // 1. For Shorts tiles, prioritize the actual thumbnail image container
      if (isShortsTile && thumb) {
        // Prefer the inner #thumbnail so the button sits inside the image
        const innerThumb = thumb.querySelector('#thumbnail') as HTMLElement | null
        host = innerThumb || thumb
      }
      // Shorts reels without ytd-thumbnail: target reel item thumbnail or the reel item itself
      if (isShortsTile && !host && reelItem) {
        host = (reelItem.querySelector('#thumbnail') as HTMLElement | null)
          || (reelItem.querySelector('a#thumbnail') as HTMLElement | null)
          || (reelItem.querySelector('[id*="thumbnail"], .ytReelItemRendererThumbnail') as HTMLElement | null)
          || reelItem
      }
      // 2. Standard thumbnail handling for non-Shorts pages
      else if (thumb) {
        // For regular pages, use standard logic
        const thumbnailImg = thumb.querySelector('#thumbnail') as HTMLElement
        if (thumbnailImg) {
          host = thumbnailImg
        } else {
          host = thumb
        }
      }

      // Keep host anchored to the actual thumbnail even on /results; hover logic will re-attach if YT swaps DOM

      // 2. For compact videos, try to find the thumbnail area
      if (!host && compactVideo) {
        const compactThumb = compactVideo.querySelector('ytd-thumbnail #thumbnail') as HTMLElement
        if (compactThumb) {
          host = compactThumb
        } else {
          host = compactVideo.querySelector('ytd-thumbnail') as HTMLElement || compactVideo
        }
      }

      // 3. For rich items (homepage/feed), find the thumbnail area
      if (!host && richItem) {
        // Try multiple selectors for homepage rich items
        const richThumb = (richItem.querySelector('ytd-thumbnail #thumbnail') as HTMLElement)
          || (richItem.querySelector('a#thumbnail') as HTMLElement)
          || (richItem.querySelector('ytd-thumbnail a') as HTMLElement)
          || (richItem.querySelector('ytd-thumbnail') as HTMLElement)
        if (richThumb) {
          host = richThumb
        }
        // Do NOT fall back to the entire rich item container here; allow the
        // lockup-based selectors (3.5) to pick the actual image container on
        // the new homepage markup. Fallback to tile container happens later.
      }

      // 3.5. New lockup-based UI (yt-lockup-view-model + yt-thumbnail-view-model)
      if (!host) {
        const lockupAnchor = (a.matches('.yt-lockup-view-model-wiz__content-image') ? (a as unknown as HTMLElement) : (a.closest('.yt-lockup-view-model-wiz__content-image') as HTMLElement | null))
        const ytThumbVM = (lockupAnchor?.querySelector('yt-thumbnail-view-model') as HTMLElement | null) || (a.closest('yt-thumbnail-view-model') as HTMLElement | null)
        const ytThumbImg = ytThumbVM?.querySelector('.ytThumbnailViewModelImage') as HTMLElement | null
        // New homepage image host (img.ytCoreImageHost)
        const ytCoreImg = (lockupAnchor?.querySelector('img.ytCoreImageHost') as HTMLElement | null)
          || ((a.closest('ytd-rich-item-renderer') as HTMLElement | null)?.querySelector('img.ytCoreImageHost') as HTMLElement | null)
        // Prefer stable anchor container first so overlay persists across inline preview DOM rewrites
        if (lockupAnchor) host = lockupAnchor
        else if (ytThumbVM) host = ytThumbVM
        else if (ytThumbImg) host = ytThumbImg
        else if (ytCoreImg) {
          // Prefer an ancestor that represents the clickable thumbnail area
          const container = (ytCoreImg.closest('a#thumbnail, .yt-lockup-view-model-wiz__content-image, yt-thumbnail-view-model, ytd-thumbnail, .yt-img-shadow, .yt-image') as HTMLElement | null)
          host = container || (ytCoreImg.parentElement as HTMLElement | null)
        }
        const lockupVm = a.closest('yt-lockup-view-model') as HTMLElement | null
        const lockupWiz = a.closest('.yt-lockup-view-model-wiz') as HTMLElement | null
        if (!tileContainer) tileContainer = (lockupVm || lockupWiz || lockupAnchor || ytThumbVM || host) as HTMLElement | null
      }

             // Prefer stable containers on /results page that survive hover autoplay
       if (!host && location.pathname === '/results' && (videoRenderer || gridVideo)) {
         const stableContainer = videoRenderer || gridVideo
         // First try to find a stable thumbnail container
         const thumbContainer = stableContainer!.querySelector('#dismissible') as HTMLElement | null
         const resultsThumbAnchor = (stableContainer!.querySelector('a.yt-simple-endpoint.inline-block.style-scope.ytd-thumbnail') as HTMLElement | null)
           || (stableContainer!.querySelector('a#thumbnail.yt-simple-endpoint') as HTMLElement | null)
           || (stableContainer!.querySelector('a#thumbnail') as HTMLElement | null)
         
         // Prefer dismissible container if available, otherwise use thumbnail anchor
         if (thumbContainer) {
           host = thumbContainer
           if (!tileContainer) tileContainer = stableContainer
         } else if (resultsThumbAnchor) {
           host = resultsThumbAnchor
           if (!tileContainer) tileContainer = stableContainer
         }
       }

      // 4. For other video containers, find thumbnail
      if (!host && (videoRenderer || gridVideo || richGridMedia || reelItem || shortsLockup)) {
        const container = videoRenderer || gridVideo || richGridMedia || reelItem || shortsLockup
        const containerThumb = container?.querySelector('ytd-thumbnail #thumbnail') as HTMLElement
        if (containerThumb) {
          host = containerThumb
        } else {
          host = container?.querySelector('ytd-thumbnail') as HTMLElement || container
        }
      }

       // 5. No safe host found; skip to avoid misplacement (e.g., Play All)
       if (!host) {
         // Last-resort fallback: prefer visible tile container vs. anchor to avoid text spill
         const gridShelfItem = a.closest('[class*="ytGridShelfViewModelGridShelfItem"]') as HTMLElement | null
         const gridShelf = a.closest('yt-grid-shelf-view-model-wiz') as HTMLElement | null
         host = gridShelfItem || gridShelf || (a.closest('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-grid-media') as HTMLElement | null) || (a as unknown as HTMLElement)
         if (!host) {
           overlayDbg(`[DEBUG] Skipping ${id} - no host element found for anchor:`, a.href, a.closest('*')?.tagName)
           continue
         }
       }

      // Debug logging for Shorts positioning
      if (WOL_DEBUG && window.location.pathname.startsWith('/shorts') && currentUrl !== lastLoggedHref) {
        dbg('Watch on Odysee: Selected host element for overlay:', host.tagName, host.id, host.className)
        dbg('Watch on Odysee: Host element dimensions:', host.offsetWidth, 'x', host.offsetHeight)
      }

      // Create the overlay button (div to avoid nested anchor issues)
      const mount = document.createElement('div')
      mount.setAttribute('role', 'button')
      mount.setAttribute('aria-label', `Watch on ${platform.button.platformNameText}`)
      mount.title = `Watch on ${platform.button.platformNameText}`
      mount.style.position = 'absolute'
      mount.style.zIndex = '2147483647' // Stay above previews and overlays
      mount.style.display = 'inline-block'
      mount.style.cursor = 'pointer'
      mount.style.pointerEvents = 'auto'
      mount.style.backgroundColor = 'transparent' // No background for cleaner look
      mount.style.borderRadius = '4px'
      // Keep padding zero on results; use small padding elsewhere (restores prior look)
      mount.style.padding = (location.pathname === '/results') ? '0' : '2px'
      // Enlarge hit area only on results; keep default elsewhere
      try {
        if (location.pathname === '/results') {
          const size = 32
          mount.style.width = `${size}px`
          mount.style.height = `${size}px`
          mount.style.display = 'block'
          mount.style.borderRadius = `${Math.round(size/2)}px`
        } else {
          mount.style.removeProperty('width')
          mount.style.removeProperty('height')
          mount.style.display = 'inline-block'
        }
      } catch { }
      mount.style.transition = 'opacity 0.12s ease'
      mount.style.opacity = '1'
      // Prevent any stray text nodes from rendering alongside the icon
      mount.style.fontSize = '0'
      mount.style.lineHeight = '0'
      mount.style.color = 'transparent'

      // Adjust positioning based on the type of video container
      const isRelatedContext = !!(a.closest('#secondary') || a.closest('#related') || a.closest('ytd-watch-next-secondary-results-renderer') || a.closest('ytd-compact-video-renderer'))
      // Try to reuse a saved anchor preference to keep visual position consistent across re-renders
      const applySavedAnchor = () => {
        const pref = overlayAnchorPrefs.get(id)
        if (!pref) return false
        try {
          if (pref.anchor === 'top-left') {
            mount.style.top = `${pref.y}px`
            mount.style.left = `${pref.x}px`
            mount.style.bottom = 'auto'
          } else {
            mount.style.bottom = `${pref.y}px`
            mount.style.left = `${pref.x}px`
            mount.style.top = ''
          }
          return true
        } catch {
          return false
        }
      }

      if (isShortsTile) {
        // For Shorts tiles, position inside the thumbnail at top-left
        if (!applySavedAnchor()) {
          mount.style.top = '6px'
          mount.style.left = '6px'
          mount.style.bottom = 'auto'
          overlayAnchorPrefs.set(id, { anchor: 'top-left', x: 6, y: 6 })
        }
        // Keep icon size stable; avoid scaling on results
        if (location.pathname !== '/results') {
          mount.style.transform = 'scale(0.8)'
          mount.style.transformOrigin = 'top left'
        } else {
          mount.style.transform = 'none'
          mount.style.transformOrigin = ''
        }
      } else {
        // On related/compact tiles, always bottom-left for consistency
        if (isRelatedContext) {
          if (!applySavedAnchor()) {
            mount.style.bottom = '6px'
            mount.style.left = '6px'
            mount.style.top = ''
            overlayAnchorPrefs.set(id, { anchor: 'bottom-left', x: 6, y: 6 })
          }
          // Use a slightly smaller icon on related (like Shorts)
          if (location.pathname !== '/results') {
            mount.style.transform = 'scale(0.8)'
            mount.style.transformOrigin = 'bottom left'
          } else {
            mount.style.transform = 'none'
            mount.style.transformOrigin = ''
          }
        } else {
          // Default for non-related tiles (keep bottom-left on results)
          if (!applySavedAnchor()) {
            mount.style.bottom = '6px'
            mount.style.left = '6px'
            mount.style.top = ''
            overlayAnchorPrefs.set(id, { anchor: 'bottom-left', x: 6, y: 6 })
          }
        }
      }

      // Prevent the overlay from interfering with the underlying YouTube link
      mount.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        openNewTab(url, 'user')
      })

      // Add hover handling to ensure overlay stays visible during video preview
      const ensureOverlayVisibility = () => {
        try { mount.style.setProperty('opacity', '1', 'important') } catch { mount.style.opacity = '1' }
        try { mount.style.setProperty('z-index', '2147483647', 'important') } catch { mount.style.zIndex = '2147483647' }
        try { mount.style.setProperty('display', 'inline-block', 'important') } catch { mount.style.display = 'inline-block' }
        try { mount.style.setProperty('visibility', 'visible', 'important') } catch { mount.style.visibility = 'visible' }
        try { mount.style.setProperty('background-color', 'transparent', 'important') } catch { mount.style.backgroundColor = 'transparent' }
        try { mount.style.setProperty('pointer-events', 'auto', 'important') } catch { mount.style.pointerEvents = 'auto' }
      }

      // Enhanced hover handling for /results page and general stability
      const isResultsPage = location.pathname === '/results'
      
      host.addEventListener('mouseenter', () => {
        if (!settings.buttonOverlay) return
        if (gen !== overlayGeneration) return
        try {
          // If already pinned (e.g., user is hovering the button or tile), skip any floating/retargeting logic
          try { if (mount.getAttribute('data-wol-pinned') === '1' || mount.getAttribute('data-wol-tile-pinned') === '1') { ensureOverlayVisibility(); return } } catch {}
          // On results, avoid any floating logic here; rely on tile hover pinning below
          if (isResultsPage) {
            ensureOverlayVisibility()
            return
          }
          // For other pages, use more aggressive positioning when needed
          if (!isResultsPage) {
            // Keep position static on results: attach to the thumbnail host and avoid floating
            try {
              const stableContainer = (a.closest('ytd-video-renderer') as HTMLElement | null)
                || (a.closest('ytd-grid-video-renderer') as HTMLElement | null)
                || (a.closest('ytd-rich-item-renderer') as HTMLElement | null)
                || host
              const preferredHost = (stableContainer && (
                (stableContainer.querySelector('ytd-thumbnail #thumbnail') as HTMLElement | null)
                || (stableContainer.querySelector('a#thumbnail.yt-simple-endpoint') as HTMLElement | null)
                || (stableContainer.querySelector('#thumbnail') as HTMLElement | null)
              )) || stableContainer || host
              if (preferredHost && getComputedStyle(preferredHost).position === 'static') {
                preferredHost.style.position = 'relative'
              }
              if (preferredHost && mount.parentElement !== preferredHost) {
                preferredHost.appendChild(mount)
              }
              ensureOverlayVisibility()
              return
            } catch {}
            // Ensure we're positioned relative to a stable container
            const stableContainer = (a.closest('ytd-video-renderer') as HTMLElement | null)
              || (a.closest('ytd-grid-video-renderer') as HTMLElement | null)
              || (a.closest('ytd-rich-item-renderer') as HTMLElement | null)
              || host
            if (stableContainer) {
              // Avoid double-activating the floating logic for this mount
              if ((mount as any)._wolFloatingActive) { ensureOverlayVisibility(); return }
              ;(mount as any)._wolFloatingActive = true
              stableContainer.style.position = stableContainer.style.position || 'relative'
              if (mount.parentElement !== stableContainer) {
                try { stableContainer.appendChild(mount) } catch {}
              }
              // Setup a short-lived MutationObserver while hovered to keep overlay on top
              const startHoverObserver = () => {
                if (hoverMoMap.get(mount)) return
                let lastEnsure = 0
                const mo = new MutationObserver(() => {
                  const now = (window.performance && performance.now) ? performance.now() : Date.now()
                  if (now - lastEnsure < 60) return
                  lastEnsure = now
                  try {
                    if (mount.parentElement !== stableContainer) stableContainer.appendChild(mount)
                  } catch {}
                  ensureOverlayVisibility()
                })
                try { mo.observe(stableContainer, { childList: true, subtree: true }) } catch {}
                hoverMoMap.set(mount, mo)
                if (WOL_DEBUG) dbg('WOL results hover: observer started for tile')
                // Auto-stop is scheduled alongside floating overlay below and extended on pointer activity
              }
              startHoverObserver()

              // While on results, float the overlay as a fixed element so it stays above
              // the autoplay preview regardless of DOM reparenting.
              const preferred = (stableContainer.querySelector('a.yt-simple-endpoint.inline-block.style-scope.ytd-thumbnail, a#thumbnail.yt-simple-endpoint, ytd-thumbnail #thumbnail, #thumbnail') as HTMLElement | null) || host
              // Compute frozen screen position once to prevent visible shifting during preview animation
              let frozenTop = 0, frozenLeft = 0
              const computeFrozen = () => {
                try {
                  const baseEl = (preferred && (preferred.offsetWidth || preferred.offsetHeight)) ? preferred : stableContainer
                  const r = baseEl.getBoundingClientRect()
                  frozenTop = Math.max(0, r.bottom - 26)
                  frozenLeft = Math.max(0, r.left + 6)
                } catch {}
              }
              computeFrozen()
              const reposition = () => {
                try {
                  mount.style.setProperty('position', 'fixed', 'important')
                  mount.style.top = `${frozenTop}px`
                  mount.style.left = `${frozenLeft}px`
                  mount.style.bottom = 'auto'
                } catch {}
              }
              if (mount.parentElement !== document.body) document.body.appendChild(mount)
              reposition()
              const onScroll = () => updateOnViewportChange()
              try { window.addEventListener('scroll', onScroll, true) } catch {}
              try { window.addEventListener('resize', onScroll, true) } catch {}
              if (WOL_DEBUG) dbg('WOL results hover: floating overlay started')
              // Keep hover alive while pointer remains over tile; extend timer on activity
              const scheduleStop = (ms = 5000) => {
                const existing = hoverMoTimerMap.get(mount)
                if (existing) { try { clearTimeout(existing) } catch {} }
                const tid = setTimeout(() => {
                  try { hoverMoMap.get(mount)?.disconnect() } catch {}
                  hoverMoMap.delete(mount)
                  hoverMoTimerMap.delete(mount)
                  // Also stop floating overlay if still active
                  try { const fn = hoverFloatCleanupMap.get(mount); if (fn) fn() } catch {}
                  if (WOL_DEBUG) dbg('WOL results hover: observer auto-stopped')
                }, ms) as unknown as number
                hoverMoTimerMap.set(mount, tid)
              }
              scheduleStop(5000)
              // Only recompute on viewport changes (scroll/resize), not every frame
              const updateOnViewportChange = () => { computeFrozen(); reposition() }
              const refresh = () => scheduleStop(5000)
              try { stableContainer.addEventListener('pointerenter', refresh) } catch {}
              try { stableContainer.addEventListener('pointermove', refresh) } catch {}
              hoverFloatCleanupMap.set(mount, () => {
                try { window.removeEventListener('scroll', onScroll, true) } catch {}
                try { window.removeEventListener('resize', onScroll, true) } catch {}
                // No RAF to cancel since we freeze position
                try { stableContainer.removeEventListener('pointerenter', refresh) } catch {}
                try { stableContainer.removeEventListener('pointermove', refresh) } catch {}
                // Reattach back to the tile host and restore absolute positioning
                try {
                  mount.style.setProperty('position', 'absolute', 'important')
                  mount.style.top = ''
                  mount.style.left = ''
                  mount.style.bottom = isRelatedContext ? 'auto' : '6px'
                  if (mount.parentElement !== host) host.appendChild(mount)
                } catch {}
                ;(mount as any)._wolFloatingActive = false
                if (WOL_DEBUG) dbg('WOL results hover: floating overlay cleaned')
              })
              // Cleanup is driven by the hover end timer above
            }
          }
          
          // Raise stack order during hover previews
          ;(host as HTMLElement).style.zIndex = (host as HTMLElement).style.zIndex || '2147483646'
          if (mount.parentElement !== host && !isResultsPage) host.appendChild(mount)
        } catch {}
        ensureOverlayVisibility()
      })

      // Removed tile-level container listener to avoid double activation

      // Ensure empty container (avoid stray text nodes)
      mount.textContent = ''
      if (location.pathname === '/results') {
        // Place the 20px icon at the container's anchored corner explicitly (no flex)
        const iconWrap = document.createElement('div')
        iconWrap.style.position = 'absolute'
        iconWrap.style.width = '20px'
        iconWrap.style.height = '20px'
        iconWrap.style.pointerEvents = 'none'
        const anchorIsTopLeft = !!(mount.style.top && mount.style.top !== '')
        if (anchorIsTopLeft) {
          iconWrap.style.top = '0'
          iconWrap.style.left = '0'
        } else {
          iconWrap.style.bottom = '0'
          iconWrap.style.left = '0'
        }
        const logoImg = document.createElement('img')
        logoImg.alt = ''
        logoImg.src = platform.button.icon
        logoImg.style.width = '100%'
        logoImg.style.height = '100%'
        logoImg.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
        logoImg.style.pointerEvents = 'none'
        iconWrap.appendChild(logoImg)
        mount.appendChild(iconWrap)
      } else {
        // Restore prior behavior elsewhere
        const logoImg = document.createElement('img')
        logoImg.alt = ''
        logoImg.src = platform.button.icon
        logoImg.style.height = '20px'
        logoImg.style.width = '20px'
        logoImg.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
        logoImg.style.pointerEvents = 'none'
        mount.appendChild(logoImg)
      }

      // When hovering the button itself, pin it in place so it never shifts.
      // Also support pinning while hovering the entire tile on /results.
      let wolPinned = false
      // Shield handlers to stop YouTube's hover-preview event propagation while pinned
      const stopHoverEvent = (e: Event) => {
        try { (e as any).stopImmediatePropagation?.() } catch {}
        try { e.stopPropagation() } catch {}
      }
      const shieldEvents = ['pointerover','pointerenter','pointermove','mouseover','mousemove','mouseenter'] as const
      const addShield = () => {
        try { shieldEvents.forEach(t => mount.addEventListener(t as unknown as string, stopHoverEvent, { capture: true })) } catch {}
      }
      const removeShield = () => {
        try { shieldEvents.forEach(t => mount.removeEventListener(t as unknown as string, stopHoverEvent, { capture: true } as any)) } catch {}
      }
      const pinOverlay = () => {
        if (wolPinned) return
        wolPinned = true
        try {
          // Cancel any in-flight floating logic/timers/observers for this mount
          try { const t = hoverMoTimerMap.get(mount); if (t) { clearTimeout(t as any) } } catch {}
          try { hoverMoTimerMap.delete(mount) } catch {}
          try { const mo = hoverMoMap.get(mount); mo?.disconnect() } catch {}
          try { hoverMoMap.delete(mount) } catch {}
          try { hoverFloatCleanupMap.delete(mount) } catch {}

          const r = mount.getBoundingClientRect()
          // Reparent to body and freeze exact geometry to avoid any shift
          if (mount.parentElement !== document.body) document.body.appendChild(mount)
          mount.style.setProperty('position', 'fixed', 'important')
          mount.style.setProperty('top', `${r.top.toFixed(2)}px`, 'important')
          mount.style.setProperty('left', `${r.left.toFixed(2)}px`, 'important')
          mount.style.setProperty('width', `${r.width.toFixed(2)}px`, 'important')
          mount.style.setProperty('height', `${r.height.toFixed(2)}px`, 'important')
          mount.style.setProperty('bottom', 'auto', 'important')
          mount.style.setProperty('margin', '0', 'important')
          mount.style.setProperty('box-sizing', 'border-box', 'important')
          mount.style.setProperty('transform', 'none', 'important')
          mount.style.setProperty('z-index', '2147483647', 'important')
          mount.style.setProperty('opacity', '1', 'important')
          mount.style.setProperty('visibility', 'visible', 'important')
          mount.style.setProperty('pointer-events', 'auto', 'important')
          mount.setAttribute('data-wol-pinned', '1')
          // Mark the tile to suppress inline preview while pinned
          try {
            const tileRoot = (a.closest('ytd-video-renderer') as HTMLElement | null)
              || (a.closest('ytd-grid-video-renderer') as HTMLElement | null)
              || (a.closest('ytd-rich-item-renderer') as HTMLElement | null)
              || null
            if (tileRoot) {
              tileRoot.setAttribute('data-wol-preview-block', '1')
              // Also disable pointer events on the tile so :hover and JS hover logic won't trigger
              const prev = tileRoot.style.pointerEvents || ''
              tileRoot.setAttribute('data-wol-prev-pe', prev || '__empty__')
              tileRoot.style.setProperty('pointer-events', 'none', 'important')
            }
          } catch {}
          // Stop hover events from bubbling to YouTube while pinned
          addShield()
        } catch {}
      }
      const unpinOverlay = () => {
        if (!wolPinned) return
        wolPinned = false
        try {
          // Remove frozen geometry and reattach to host
          mount.style.removeProperty('width')
          mount.style.removeProperty('height')
          mount.style.removeProperty('top')
          mount.style.removeProperty('left')
          mount.style.removeProperty('margin')
          mount.style.setProperty('position', 'absolute', 'important')
          if (mount.parentElement !== host) host.appendChild(mount)
          // Restore default offsets for non-related tiles
          if (!isRelatedContext) {
            mount.style.bottom = '6px'
            mount.style.top = ''
            mount.style.left = '6px'
          }
          mount.removeAttribute('data-wol-pinned')
          try {
            const tileRoot = (a.closest('ytd-video-renderer') as HTMLElement | null)
              || (a.closest('ytd-grid-video-renderer') as HTMLElement | null)
              || (a.closest('ytd-rich-item-renderer') as HTMLElement | null)
              || null
            if (tileRoot) {
              tileRoot.removeAttribute('data-wol-preview-block')
              // Restore previous pointer-events
              const prev = tileRoot.getAttribute('data-wol-prev-pe')
              if (prev !== null) {
                if (prev === '__empty__') tileRoot.style.removeProperty('pointer-events')
                else tileRoot.style.pointerEvents = prev
                tileRoot.removeAttribute('data-wol-prev-pe')
              }
            }
          } catch {}
          // Remove event shield
          removeShield()
        } catch {}
      }
      // Pin when hovering the button itself (results page only)
      if (location.pathname === '/results') {
        try { mount.addEventListener('pointerenter', (e) => { if (!settings.buttonOverlay) return; try { e.stopPropagation() } catch {} ; pinOverlay() }, { passive: true }) } catch {}
        try {
          mount.addEventListener('pointerleave', (e) => {
            try {
              const pe = e as PointerEvent
              const rel = (e as any).relatedTarget as Node | null
              const tileRoot = (a.closest('ytd-video-renderer') as HTMLElement | null)
                || (a.closest('ytd-grid-video-renderer') as HTMLElement | null)
                || (a.closest('ytd-rich-item-renderer') as HTMLElement | null)
                || (mount.parentElement as HTMLElement | null)
              const immediateInside = !!(tileRoot && rel && tileRoot.contains(rel))
              if (immediateInside) return
              setTimeout(() => {
                try {
                  const el = document.elementFromPoint(pe.clientX, pe.clientY)
                  if (el && (mount.contains(el) || (tileRoot && tileRoot.contains(el as Node)))) return
                } catch {}
                try { e.stopPropagation() } catch {}
                unpinOverlay()
              }, 80)
            } catch {
              try { e.stopPropagation() } catch {}
              unpinOverlay()
            }
          }, { passive: true })
        } catch {}
      }

      // No special behavior on /results here; video overlays are disabled for results

      // Ensure host has relative positioning
      if (getComputedStyle(host).position === 'static') {
        host.style.position = 'relative'
      }

      // Check if we already have an overlay for this video ID (key by video id only)
      const existingOverlayId = id
      const existingOverlay = overlayState.get(id)

      if (existingOverlay && existingOverlay.element.parentElement === host) {
        // Update the existing overlay's lastSeen timestamp
        existingOverlay.lastSeen = Date.now()
          ; (a as any).dataset.wolEnhanced = 'done'
        continue
      }

      // Avoid removing an existing overlay during hover; only proceed to create if none exists
      try {
        const already = host.querySelector(`[data-wol-overlay="${id}"]`) as HTMLElement | null
        if (already) {
          // Check if the existing overlay is properly connected and visible
          const isProperlyAttached = already.isConnected &&
                                     already.parentElement === host &&
                                     already.offsetWidth > 0 &&
                                     already.offsetHeight > 0

          if (isProperlyAttached) {
            // Overlay is good, skip recreation
            overlayDbg(`[DEBUG] Overlay ${id} already exists on this host, skipping`)
            ; (a as any).dataset.wolEnhanced = 'done'; continue
          } else {
            // Overlay exists but is disconnected or not visible - remove it and recreate
            already.remove()
            // Continue to create a new one
          }
        }

        // CRITICAL: Check if overlay exists elsewhere in the document (prevents duplicates from multiple anchors)
        // This can happen when YouTube has multiple anchor elements for the same video
        const existingGlobal = document.querySelector(`[data-wol-overlay="${id}"]`) as HTMLElement | null
        if (existingGlobal && existingGlobal !== already) {
          if (existingGlobal.isConnected) {
            // If a global overlay exists but is attached to a different host, reattach it here
            try {
              if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
              if (existingGlobal.parentElement !== host) {
                overlayDbg(`[DEBUG] Moving existing global overlay ${id} to correct host`)
                host.appendChild(existingGlobal)
              }
              ; (a as any).dataset.wolEnhanced = 'done'
              // Also update state to point at the current host
              const st = overlayState.get(id)
              if (st) {
                st.host = host
                st.element = existingGlobal as HTMLElement
                st.lastSeen = Date.now()
                st.generation = gen
                overlayState.set(id, st)
              }
              // Dedupe: if any extra nodes exist with the same id, remove them now
              try {
                const also = Array.from(document.querySelectorAll(`[data-wol-overlay="${id}"]`)) as HTMLElement[]
                for (const el of also) { if (el !== existingGlobal) try { el.remove() } catch {} }
              } catch {}
              continue
            } catch {}
          } else {
            // Existing global overlay is disconnected or invisible, remove it
            overlayDbg(`[DEBUG] Removing disconnected global overlay ${id}`)
            try { existingGlobal.remove() } catch {}
          }
        }

        // Also check overlayState to see if we already have an overlay for this video
        const existingState = overlayState.get(id)
        if (existingState && existingState.generation === gen) {
          if (existingState.element.isConnected && existingState.element.offsetWidth > 0) {
            overlayDbg(`[DEBUG] Overlay ${id} already in overlayState, skipping duplicate`)
            ; (a as any).dataset.wolEnhanced = 'done'; continue
          }
        }
      } catch {}

      // Add data attribute for identification
      mount.setAttribute('data-wol-overlay', id)
      mount.setAttribute('data-wol-id', id)
      mount.setAttribute('data-wol-type', type)
      mount.setAttribute('data-wol-gen', String(gen))

      // Mark Shorts overlays for easier identification during cleanup
      if (isShortsTile) {
        mount.setAttribute('data-wol-shorts-overlay', 'true')
      }

      // Store this overlay in our global state, and keep it alive during DOM churn
      let mo: MutationObserver | null = null
      // Skip heavy per-tile observers on search results AND channel pages to prevent CPU spikes and lockups
      const skipObserver = isChannelPage || location.pathname === '/results'
      if (!skipObserver) {
        mo = new MutationObserver(() => {
          // CRITICAL: Check generation first and disconnect immediately if stale
          if (gen !== overlayGeneration) { try { mo?.disconnect() } catch {} ; return }
          // Always keep overlay attached to the stable host element
          try {
            // CRITICAL: Check if mount is already properly positioned and visible
            if (mount.isConnected && host.contains(mount)) {
              const box = mount.getBoundingClientRect()
              // If overlay is visible and in correct position, don't touch it
              if (box.width > 0 && box.height > 0) {
                overlayDbg(`[DEBUG] Overlay ${id} already correctly positioned, skipping reattach`)
                ensureOverlayVisibility()
                return
              }
            }

            // CRITICAL: Double-check generation before expensive querySelector operations
            if (gen !== overlayGeneration) { try { mo?.disconnect() } catch {} ; return }

            // If original host is gone or no longer contains mount, try to locate a fresh host within the tile
            const containerRoot = tileContainer || host.parentElement || (a.closest('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-grid-media, ytd-reel-item-renderer, ytd-shorts-lockup-view-model, ytd-rich-item-renderer, ytd-compact-video-renderer') as HTMLElement | null)

            if (!host.isConnected || (containerRoot && !containerRoot.contains(host))) {
              overlayDbg(`[DEBUG] Host disconnected for ${id}, searching for new host`)
              let newHost: HTMLElement | null = null
              const candidates = [
                containerRoot?.querySelector('ytd-thumbnail #thumbnail') as HTMLElement | null,
                containerRoot?.querySelector('#thumbnail') as HTMLElement | null,
                containerRoot?.querySelector('ytd-thumbnail') as HTMLElement | null,
                containerRoot?.querySelector('.ytThumbnailViewModelImage') as HTMLElement | null,
                containerRoot?.querySelector('yt-thumbnail-view-model') as HTMLElement | null,
                containerRoot?.querySelector('a#thumbnail') as HTMLElement | null,
              ].filter(Boolean) as HTMLElement[]
              if (candidates.length > 0) newHost = candidates[0]
              // Shorts-specific candidates
              if (!newHost) {
                newHost = (containerRoot?.querySelector('ytd-reel-item-renderer #thumbnail') as HTMLElement | null)
                  || (containerRoot?.querySelector('ytd-reel-item-renderer a#thumbnail') as HTMLElement | null)
                  || (containerRoot?.querySelector('[id*="thumbnail"], .ytReelItemRendererThumbnail') as HTMLElement | null)
                  || null
              }
              // Fallback: the anchor itself
              if (!newHost) newHost = a as unknown as HTMLElement
              if (newHost) {
                overlayDbg(`[DEBUG] Found new host for ${id}, reattaching`)
                host = newHost
              }
            }

            // Only append if not already in host
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
            if (!host.contains(mount)) {
              overlayDbg(`[DEBUG] Reattaching overlay ${id} to host`)
              host.appendChild(mount)
            }
          } catch {}
          ensureOverlayVisibility()
        })
        try {
          if (tileContainer) mo.observe(tileContainer, { childList: true, subtree: true })
          else mo.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['style','class'] })
        } catch {}
      }

      overlayState.set(id, {
        videoId: id,
        element: mount,
        host: host,
        url: url.href,
        lastSeen: Date.now(),
        generation: gen,
        observer: mo
      })

      // Append to thumbnail host to ensure initial placement inside the thumbnail
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative'

      if (mount.parentElement !== host) {
        host.appendChild(mount)
      }
      // Avoid extra hover listeners on results; rely on host mouseenter handler above

      // Watch-page related sidebar: container-level batch reveal
      if (isWatchPageForBatch && isRelatedContext && !relatedBatchRevealed) {
        relatedBatchOverlayCount++
        const maybeReveal = () => {
          if (relatedBatchRevealed) return
          const enough = relatedBatchOverlayCount >= 8
          const waitedLongEnough = !!relatedBatchStartAt && (Date.now() - relatedBatchStartAt) >= 600
          if (enough || waitedLongEnough) {
            relatedBatchRevealed = true
            try { const cont = getRelatedContainer(); if (cont) cont.removeAttribute('data-wol-waiting-reveal') } catch {}
            if (relatedBatchRevealTimer) { try { clearTimeout(relatedBatchRevealTimer) } catch {} }
            relatedBatchRevealTimer = null
          }
        }
        maybeReveal()
        if (!relatedBatchRevealTimer) relatedBatchRevealTimer = setTimeout(maybeReveal, 800) as unknown as number
      }

      // Ensure visible immediately elsewhere
      ensureOverlayVisibility()

      // Avoid aggressive re-attachment loops; rely on cleanup + re-enhance instead
      ; (a as any).dataset.wolEnhanced = 'done'
    }

    // After rendering, conservatively clean up overlays
    // Do not remove overlays just because the anchor temporarily disappeared during inline preview/hover
    const visibleKeys = new Set(((typeof normalizedToProcess !== 'undefined' ? normalizedToProcess : toProcess) as any[]).map((x: any) => `${x.type}:${x.id}`))
    for (const [key, ov] of overlayState.entries()) {
      const ovType = ov.element.getAttribute('data-wol-type') || 'video'
      const ovIdAttr = ov.element.getAttribute('data-wol-id') || ov.videoId
      const ovKey = `${ovType}:${ovIdAttr}`
      // Remove only if overlay is from a prior generation or detached from DOM
      if (ov.generation !== gen || !ov.element.isConnected) {
        try { ov.observer?.disconnect() } catch {}
        ov.element.remove()
        overlayState.delete(key)
        continue
      }
      // If overlay corresponds to a still-visible tile in this pass, refresh lastSeen
      if (visibleKeys.has(ovKey)) ov.lastSeen = Date.now()
      // Otherwise, keep it alive; separate GC routine will clean up old ones
    }

      // Update throttle timer AFTER work completes (not at start)
      // This allows mutation observer to trigger re-enhancement soon after initial processing
      lastEnhanceTime = Date.now()

      // Retry logic for channel pages: if we found very few videos on initial load,
      // YouTube might still be rendering. Retry a few times with increasing delays.
      const isChannelPageRetry = location.href.includes('/@') || location.href.includes('/channel/') ||
                            location.href.includes('/c/') || location.href.includes('/user/')
      if (isChannelPageRetry) {
        const videoCount = overlayState.size

        // Reset attempts if this is a new generation
        if (lastEnhanceAttempt.gen !== gen) {
          lastEnhanceAttempt = { gen, videoCount: 0, attempts: 0 }
        }

        // If we found suspiciously few videos (< 20) and haven't exceeded max retries
        // YouTube typically renders 24-30 videos initially, so < 20 means page is still loading
        if (videoCount < 20 && lastEnhanceAttempt.attempts < 5) {
          lastEnhanceAttempt.attempts++
          lastEnhanceAttempt.videoCount = videoCount
          const retryDelay = 300 * lastEnhanceAttempt.attempts  // 300ms, 600ms, 900ms, 1200ms, 1500ms
          overlayDbg(`[DEBUG] Found only ${videoCount} videos on channel page, attempt ${lastEnhanceAttempt.attempts}/5. Retrying in ${retryDelay}ms`)
          scheduleEnhanceListings(retryDelay, true)  // Bypass throttle for retry attempts
        } else if (lastEnhanceAttempt.attempts > 0) {
          overlayDbg(`[DEBUG] Channel page enhancement complete after ${lastEnhanceAttempt.attempts} attempts, found ${videoCount} videos`)
        }
      }
    } finally {
      enhancementRunning = false
    }
  }


  // Event-driven page processing (replaces periodic master loop)
  let processPageTimer: number | null = null
  function scheduleProcessCurrentPage(delay = 0) {
    if (processPageTimer) { try { clearTimeout(processPageTimer) } catch {} }
    processPageTimer = setTimeout(() => {
      processPageTimer = null
      processCurrentPage().catch(e => logger.error(e))
    }, delay) as unknown as number
  }

  async function processCurrentPage() {
    if (extensionContextInvalidated) return
    const processStartTime = performance.now()
    logger.log('Watch on Odysee: processCurrentPage() called for URL:', location.href)
    dbg(`[CHANNEL-DEBUG] ========== processCurrentPage START ==========`)
    dbg(`[CHANNEL-DEBUG] URL: ${location.href}`)
    try {
      const urlNow = new URL(location.href)

      // Clean up redirect tracking for old URLs when navigating
      const currentUrl = urlNow.href
      const urlsToKeep = new Set([currentUrl])
      for (const u of redirectedUrls) { if (!urlsToKeep.has(u)) redirectedUrls.delete(u) }

      // Track changes in Shorts/watch to refresh cached channel mirrors
      if (urlNow.pathname.startsWith('/shorts/')) {
        const currentShortsId = urlNow.pathname.split('/')[2]
        if (currentShortsId && currentShortsId !== lastShortsChannelId) {
          lastShortsChannelId = currentShortsId
          lastVideoPageChannelId = null
          document.documentElement.removeAttribute('data-wol-channel-id')
          settingsDirty = true
          lastResolveSig = null
          lastResolved = {}
        }
      } else if (urlNow.pathname === '/watch') {
        const currentVideoId = urlNow.searchParams.get('v')
        if (currentVideoId && currentVideoId !== lastVideoPageChannelId) {
          lastVideoPageChannelId = null
          document.documentElement.removeAttribute('data-wol-channel-id')
          settingsDirty = true
          lastResolveSig = null
          lastResolved = {}
        }
      }

       const source = await getSourceByUrl(urlNow)
       lastLoggedHref = urlNow.href
       if (!source) {
         // No page-level source (e.g., /results). Still refresh overlays and results chips.
         updateButtons(null)
         ensureOverlayEnhancementActive()
         if (location.pathname === '/results' && settings.resultsApplySelections && settings.buttonChannelSub) {
           scheduleRefreshResultsChips(100)
           scheduleRefreshChannelButtons(120)
         }
         return
       }

      // Compute targets: resolve both the primary item and (if video) the channel in a single call
      let subscribeTargets: Target[] = []
      let playerTarget: Target | null = null
      const sourcesToResolve: Source[] = [source]

      // If we are on a video page, also resolve the channel and show a channel button (if present)
      let channelIdForVideoPage: string | null = null
      if (source.type === 'video') {
        let channelId: string | null = (document.documentElement.getAttribute('data-wol-channel-id') || null)
        if (!channelId) {
          channelId = document.querySelector<HTMLMetaElement>('meta[itemprop="channelId"]')?.content || null
          if (!channelId) channelId = await getWatchPageChannelId()
        }
        if (!channelId) {
          const ownerSelectors = [
            'ytd-channel-name#channel-name a[href^="/channel/"]',
            'ytd-channel-name#channel-name a[href^="/@"]',
            'ytd-video-owner-renderer a[href^="/channel/"]',
            'ytd-video-owner-renderer a[href^="/@"]',
            '#owner a[href^="/channel/"]',
            '#owner a[href^="/@"]',
            '#watch-header a[href^="/channel/"]',
            '.ytd-video-owner-renderer a[href^="/channel/"]',
          ]
          for (const selector of ownerSelectors) {
            const ownerHref = document.querySelector<HTMLAnchorElement>(selector)?.href
            if (ownerHref) {
              try {
                const u = new URL(ownerHref, location.origin)
                const ytPath = u.pathname

                // Check if we already have this channel cached by YouTube URL
                if (ytUrlResolvePageCache.has(ytPath)) {
                  // We have the target cached; extract UC ID if it's in the URL
                  const p = ytPath.split('/')
                  if (p[1] === 'channel' && p[2]?.startsWith('UC')) {
                    channelId = p[2]
                    if (WOL_DEBUG) dbg('[VIDEO] Found channel UC from ytUrl cache:', channelId)
                    break
                  }
                  // For handle URLs, we need to upgrade to UC for sourcesToResolve
                  if (p[1]?.startsWith('@')) {
                    // Try handle cache first
                    const handle = p[1].substring(1)
                    if (handleResolvePageCache.has(handle)) {
                      // Look for UC in ucResolvePageCache by iterating (since we need the key)
                      for (const [uc, target] of ucResolvePageCache.entries()) {
                        if (target && handleResolvePageCache.get(handle) === target && uc.startsWith('UC')) {
                          channelId = uc
                          if (WOL_DEBUG) dbg('[VIDEO] Found channel UC from handle cache:', channelId)
                          break
                        }
                      }
                      if (channelId) break
                    }
                  }
                }

                // If not in cache, extract UC ID the normal way
                const p = u.pathname.split('/')
                if (p[1] === 'channel' && p[2]?.startsWith('UC')) { channelId = p[2]; break }
                if (p[1]?.startsWith('@')) {
                  const html = await (await fetch(ownerHref, { credentials: 'same-origin' })).text()
                  const m = html.match(/\"channelId\"\s*:\s*\"([^\"]+)\"/) || html.match(/feeds\/videos\.xml\?channel_id=([A-Za-z0-9_-]+)/)
                  if (m?.[1]?.startsWith('UC')) { channelId = m[1]; break }
                }
              } catch { }
            }
          }
        }
        if (channelId) {
          const channelSource: Source = { platform: source.platform, id: channelId, type: 'channel', url: urlNow, time: null }
          sourcesToResolve.push(channelSource)
          channelIdForVideoPage = channelId
          lastVideoPageChannelId = channelId
        }
      }

      // Resolve all at once (only if signature changed or periodic refresh needed)
      const sig = sourcesToResolve.map(s => `${s.type}:${s.id}`).sort().join(',')
      let resolved: Record<string, Target | null>
      const needsResolve = settingsDirty || sig !== lastResolveSig || (Date.now() - lastResolveAt) > 10000

      const resolveStartTime = performance.now()
      if (needsResolve) {
        if (!resolveLogCache.has(sig)) { resolveLogCache.add(sig); logger.log('Resolving ids:', sig) }
        dbg(`[CHANNEL-DEBUG] Starting API resolution for:`, sig)
        resolved = await getTargetsBySources(...sourcesToResolve)
        const resolveEndTime = performance.now()
        dbg(`[CHANNEL-DEBUG] API resolution completed in ${(resolveEndTime - resolveStartTime).toFixed(2)}ms`)
        lastResolved = resolved
        lastResolveSig = sig
        lastResolveAt = Date.now()
        logger.log('Resolved results for:', sig, Object.keys(resolved))
        settingsDirty = false

        // Populate cross-page caches so channels are available in future searches
        try {
          for (const src of sourcesToResolve) {
            const target = resolved[src.id] || null
            if (src.type === 'channel' && src.id.startsWith('UC')) {
              ucResolvePageCache.set(src.id, target)
              // Persist UC → Target to IndexedDB
              if (target) {
                channelCache.putUC(src.id, target).catch(err => {
                  if (WOL_DEBUG) dbg('[CACHE] Error persisting UC on channel page:', err)
                })
              }
              if (WOL_DEBUG) dbg('[CACHE] Stored UC', src.id, 'in page cache (in-memory + persistent):', !!target)

              // Cache by YouTube channel URL (/channel/UC...)
              const channelUrl = `/channel/${src.id}`
              ytUrlResolvePageCache.set(channelUrl, target)
              // Persist ytUrl → UC to IndexedDB
              if (target) {
                channelCache.putYtUrl(channelUrl, src.id).catch(err => {
                  if (WOL_DEBUG) dbg('[CACHE] Error persisting ytUrl on channel page:', err)
                })
              }
              if (WOL_DEBUG) dbg('[CACHE] Stored YT URL', channelUrl, 'in page cache (in-memory + persistent):', !!target)

              // Also try to cache by handle if we can extract it from the page
              try {
                const handleAnchor = (
                  document.querySelector('ytd-page-header-renderer a[href^="/@"]') as HTMLAnchorElement | null
                ) || (
                  document.querySelector('yt-page-header-view-model a[href^="/@"]') as HTMLAnchorElement | null
                ) || (
                  document.querySelector('#channel-header a[href^="/@"]') as HTMLAnchorElement | null
                ) || (
                  document.querySelector('#channel-header-container a[href^="/@"]') as HTMLAnchorElement | null
                )

                if (WOL_DEBUG) dbg('[CACHE] Looking for handle anchor, found:', !!handleAnchor)
                if (handleAnchor) {
                  const handleHref = handleAnchor.getAttribute('href') || ''
                  const handleText = handleAnchor.textContent?.trim() || ''
                  const handle = (handleHref.startsWith('/@') ? handleHref.substring(2) : '') || (handleText.startsWith('@') ? handleText.substring(1) : '')
                  if (WOL_DEBUG) dbg('[CACHE] Extracted handle from href/text:', handle)
                  if (handle && target) {
                    handleResolvePageCache.set(handle, target)
                    const handleUrl = `/@${handle}`
                    ytUrlResolvePageCache.set(handleUrl, target)
                    // Persist to IndexedDB
                    if (WOL_DEBUG) dbg('[CACHE] 💾 WRITING to persistent cache: handle', handle, '→ UC', src.id)
                    channelCache.putHandle(handle, src.id).catch(err => {
                      if (WOL_DEBUG) dbg('[CACHE] ❌ Error persisting handle on channel page:', err)
                    })
                    if (WOL_DEBUG) dbg('[CACHE] 💾 WRITING to persistent cache: ytUrl', handleUrl, '→ UC', src.id)
                    channelCache.putYtUrl(handleUrl, src.id).catch(err => {
                      if (WOL_DEBUG) dbg('[CACHE] ❌ Error persisting handleUrl on channel page:', err)
                    })
                    if (WOL_DEBUG) dbg('[CACHE] ✅ Stored handle @' + handle, 'and YT URL', handleUrl, 'in page cache (in-memory + persistent):', !!target)
                  } else {
                    if (WOL_DEBUG) dbg('[CACHE] Failed to extract handle from anchor or no target')
                  }
                } else {
                  if (WOL_DEBUG) dbg('[CACHE] No handle anchor found on page')
                }
              } catch (e) {
                if (WOL_DEBUG) dbg('[CACHE] Error caching handle:', e)
              }
            }
          }
        } catch (e) {
          if (WOL_DEBUG) dbg('[CACHE] Error populating page cache:', e)
        }
      } else {
        dbg(`[CHANNEL-DEBUG] Using cached resolution for:`, sig)
        resolved = lastResolved
      }

      let primaryTarget = resolved[source.id] ?? findTargetFromSourcePage(source)
      if (primaryTarget?.type === 'video') playerTarget = primaryTarget

      if (source.type === 'channel') {
        const channelStartTime = performance.now()
        dbg(`[CHANNEL-DEBUG] Processing channel page for ${source.id}`)
        dbg(`[CHANNEL-DEBUG] Has primaryTarget from API:`, !!primaryTarget)

        // If no direct Odysee mapping yet, derive a deterministic fallback target
        if (!primaryTarget) {
          try {
            // Prefer @handle in the header
            const handleAnchor = (
              document.querySelector('ytd-page-header-renderer a[href^="/@"]') as HTMLAnchorElement | null
            ) || (
              document.querySelector('yt-page-header-view-model a[href^="/@"]') as HTMLAnchorElement | null
            ) || (
              document.querySelector('#channel-header a[href^="/@"]') as HTMLAnchorElement | null
            ) || (
              document.querySelector('#channel-header-container a[href^="/@"]') as HTMLAnchorElement | null
            )
            dbg(`[CHANNEL-DEBUG] Found handleAnchor:`, !!handleAnchor, handleAnchor?.getAttribute('href'))

            const handleHref = handleAnchor?.getAttribute('href') || ''
            const handleText = handleAnchor?.textContent?.trim() || ''
            const handle = (handleHref.startsWith('/@') ? handleHref.substring(2) : '') || (handleText.startsWith('@') ? handleText.substring(1) : '')
            dbg(`[CHANNEL-DEBUG] Extracted handle: "${handle}"`)

            const nameEl = (document.querySelector('ytd-page-header-renderer #channel-name #text') as HTMLElement | null)
              || (document.querySelector('yt-page-header-view-model #channel-name #text') as HTMLElement | null)
              || (document.querySelector('#text-container #text') as HTMLElement | null)
            const channelName = nameEl?.textContent?.trim() || ''
            dbg(`[CHANNEL-DEBUG] Channel name: "${channelName}"`)

            const platform = targetPlatformSettings[settings.targetPlatform]
            // Try direct Odysee handle first
            if (handle) {
              primaryTarget = { platform, type: 'channel', odyseePathname: `@${handle}`, time: null }
              dbg(`[CHANNEL-DEBUG] Created primaryTarget with handle: @${handle}`)
            } else {
              // Fallback to search by name or UC id
              const q = channelName || source.id
              primaryTarget = { platform, type: 'channel', odyseePathname: `$/search?q=${encodeURIComponent(q)}` , time: null }
              dbg(`[CHANNEL-DEBUG] Created fallback primaryTarget with query: ${q}`)
            }
          } catch (e) {
            dbg(`[CHANNEL-DEBUG] Error creating fallback target:`, e)
          }
        }

        const channelEndTime = performance.now()
        dbg(`[CHANNEL-DEBUG] Channel processing took ${(channelEndTime - channelStartTime).toFixed(2)}ms`)
        dbg(`[CHANNEL-DEBUG] Final primaryTarget:`, primaryTarget)

        if (settings.buttonChannelSub && primaryTarget) subscribeTargets.push(primaryTarget)
      } else if (source.type === 'video') {
        const vidTarget = resolved[source.id]
        const chTarget = channelIdForVideoPage ? resolved[channelIdForVideoPage] : null
        const isShorts = source.url.pathname.startsWith('/shorts/')
        if (isShorts) {
          if (settings.buttonChannelSub && chTarget) subscribeTargets.push(chTarget)
          if (settings.buttonVideoSub && vidTarget) subscribeTargets.push(vidTarget)
        } else {
          if (settings.buttonChannelSub && chTarget) subscribeTargets.push(chTarget)
          if (settings.buttonVideoSub && vidTarget) subscribeTargets.push(vidTarget)
        }
      }

      if (subscribeTargets.length === 0 && !playerTarget) {
        dbg(`[CHANNEL-DEBUG] No targets found, clearing buttons`)
        updateButtons(null)
        if (settings.buttonOverlay) ensureOverlayEnhancementActive()
        // do not return; allow redirect assessment to run
      }

      if (playerTarget?.type === 'video') {
        const videoElement = document.querySelector<HTMLVideoElement>(source.platform.htmlQueries.videoPlayer)
        if (videoElement) playerTarget.time = videoElement.currentTime > 3 && videoElement.currentTime < videoElement.duration - 1 ? videoElement.currentTime : null
      }

      dbg(`[CHANNEL-DEBUG] Calling updateButtons with ${subscribeTargets.length} targets`)
      if (source.type === 'channel' && subscribeTargets.length > 0) {
        dbg(`[CHANNEL-DEBUG] Channel button target:`, subscribeTargets[0])
      }
      updateButtons({ buttonTargets: subscribeTargets, playerTarget, source })
      if (settings.buttonOverlay) ensureOverlayEnhancementActive()
      if (location.pathname === '/results' && settings.resultsApplySelections && settings.buttonChannelSub) {
        scheduleRefreshResultsChips(100)
      }

      // Redirect (guarded)
      let shouldRedirect = false
      let redirectTarget: Target | null = null
      // Prefer resolved video target; do not require playerTarget (timestamp optional)
      logger.log('Watch on Odysee: Checking redirect conditions - redirectVideo:', settings.redirectVideo, 'redirectChannel:', settings.redirectChannel, 'source.type:', source.type, 'source.id:', source.id)
      
      if (settings.redirectVideo && source.type === 'video' && !source.url.searchParams.has('list')) {
        const vidTarget = resolved[source.id] ?? null
        logger.log('Watch on Odysee: Video redirect check - vidTarget:', vidTarget)
        if (vidTarget?.type === 'video') { shouldRedirect = true; redirectTarget = vidTarget }
      }
      if (!shouldRedirect && settings.redirectChannel && source.type === 'channel') {
        const channelRedirect = resolved[source.id] ?? null
        logger.log('Watch on Odysee: Channel redirect check - channelRedirect:', channelRedirect)
        if (channelRedirect) { shouldRedirect = true; redirectTarget = channelRedirect }
      }
      
      logger.log('Watch on Odysee: Redirect decision - shouldRedirect:', shouldRedirect, 'redirectTarget:', redirectTarget)
      if (shouldRedirect && redirectTarget) {
        const now = Date.now()
        logger.log('Watch on Odysee: Final redirect check - currentUrl:', currentUrl, 'redirectedUrls.has(currentUrl):', redirectedUrls.has(currentUrl), 'time since last redirect:', now - lastRedirectTime)
        if (!redirectedUrls.has(currentUrl) && (now - lastRedirectTime >= 3000)) {
          const odyseeURL = getOdyseeUrlByTarget(redirectTarget)
          redirectedUrls.add(currentUrl)
          lastRedirectTime = now
          setTimeout(() => { redirectedUrls.delete(currentUrl) }, 120000)
           if (source && source.type === 'video') findVideoElementAwait(source).then(v => v.pause())
          logger.log('Watch on Odysee: Redirecting to:', odyseeURL.href)
          openNewTab(odyseeURL, 'auto')
          if (window.history.length === 1) window.close(); else window.history.back()
        }
      }

      const processEndTime = performance.now()
      dbg(`[CHANNEL-DEBUG] ========== processCurrentPage END (${(processEndTime - processStartTime).toFixed(2)}ms total) ==========`)
    } catch (error) { logger.error(error) }
  }

  // Initial kick using event-driven flow
  // Add delay for initial load to ensure DOM is fully ready (especially for channel pages)
  scheduleProcessCurrentPage(400)

})()

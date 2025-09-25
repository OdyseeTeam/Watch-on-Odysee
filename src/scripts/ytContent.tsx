import { h, render, Fragment } from 'preact'
import { parseYouTubeURLTimeString } from '../modules/yt'
import type { resolveById, ResolveUrlTypes } from '../modules/yt/urlResolve'
import { getExtensionSettingsAsync, getSourcePlatfromSettingsFromHostname, getTargetPlatfromSettingsEntiries, SourcePlatform, sourcePlatfromSettings, TargetPlatform, targetPlatformSettings } from '../settings';
import { logger } from '../modules/logger'

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

  // Global mutation observer for video tile enhancement
  let wolMutationObserver: MutationObserver | null = null
  // Extension boot tracking (for debugging)
  const EXT_BOOT_AT = Date.now()
  // Batch state for watch-page related sidebar overlays (container-gated)
  let relatedBatchStartAt: number | null = null
  let relatedBatchRevealTimer: number | null = null
  let relatedBatchRevealed = false
  let relatedBatchOverlayCount = 0

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

  // Hook into YouTube SPA navigation events when available
  try {
    const bumpGen = () => {
      overlayGeneration++
      cleanupOverlays()
      // Also clear any managed channel buttons on results to avoid stale observers/elements
      try { cleanupResultsChannelButtons() } catch {}
      try { cleanupResultsVideoChips({ disconnectOnly: true }) } catch {}
      resetRelatedBatch()
      lastEnhanceTime = 0; lastEnhanceUrl = ''
      // Slight delay to allow related tiles to populate so more get overlays at once
      setTimeout(() => enhanceVideoTilesOnListings().catch(e => logger.error(e)), 600)
      setTimeout(() => { try { refreshResultsVideoChannelChips().catch(e => logger.error(e)) } catch {} }, 700)
      // Also refresh page-level buttons/redirects once per navigation
      scheduleProcessCurrentPage(100)
      // Ensure results pills visibility reflects current setting on navigation
      try { ensureResultsPillsVisibility() } catch {}
    }
    document.addEventListener('yt-navigate-finish', bumpGen as EventListener)
    document.addEventListener('yt-page-data-updated', bumpGen as EventListener)
  } catch { }

  // Listen Settings Change
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    try {
      if (areaName !== 'local') return
      Object.assign(settings, Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue])))
      settingsDirty = true

      // Handle overlay setting changes
      let needsButtonUpdate = false
      let needsOverlayUpdate = false
      
      let needsResultsEnforcementUpdate = false
      for (const [key, change] of Object.entries(changes)) {
        if (key === 'buttonOverlay') {
          needsOverlayUpdate = true
          if (!change.newValue) {
            // Disable mutation observer when overlay setting is turned off
            if (wolMutationObserver) {
              wolMutationObserver.disconnect()
              wolMutationObserver = null
            }
            // Use the comprehensive cleanup function
            logger.log('Watch on Odysee: Overlay setting disabled, cleaning up overlays')
            cleanupOverlays()
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
                cleanupResultsChannelButtons()
                cleanupResultsVideoChips()
              }
              // Enforce on every toggle flip
              enforceResultsChannelChipVisibility()
              // If results application was turned on, clear enhanced flags so reinjection can occur
              if (key === 'resultsApplySelections' && (change as any)?.newValue === true) {
                try {
                  document.querySelectorAll('ytd-video-renderer a[data-wol-enhanced], ytd-channel-renderer a[data-wol-enhanced], .ytGridShelfViewModelGridShelfItem a[data-wol-enhanced]')
                    .forEach(el => el.removeAttribute('data-wol-enhanced'))
                  // Also clear any per-renderer state and disconnect stale observers before reinjecting
                  cleanupResultsChannelButtons()
                  cleanupResultsVideoChips({ disconnectOnly: true })
                } catch {}
                // Immediately re-run chip refresher; then run again shortly to catch late DOM
                try { refreshResultsVideoChannelChips().catch(e => logger.error(e)) } catch {}
                try { setTimeout(() => refreshResultsVideoChannelChips().catch(e => logger.error(e)), 120) } catch {}
                try { setTimeout(() => refreshResultsChannelRendererButtons().catch(e => logger.error(e)), 150) } catch {}
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
                  setTimeout(() => enhanceVideoTilesOnListings().catch(e => logger.error(e)), 50)
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
                cleanupResultsChannelButtons()
                cleanupResultsVideoChips()
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
                cleanupResultsChannelButtons({ disconnectOnly: true })
                cleanupResultsVideoChips({ disconnectOnly: true })
                
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
                    try { enhanceVideoTilesOnListings().catch(e => logger.error(e)) } catch {}
                    try { refreshResultsVideoChannelChips().catch(e => logger.error(e)) } catch {}
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
      if (needsOverlayUpdate && settings.buttonOverlay) {
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
               try { enhanceVideoTilesOnListings().catch(e => logger.error(e)) } catch {}
               try { refreshResultsVideoChannelChips().catch(e => logger.error(e)) } catch {}
               try { refreshResultsChannelRendererButtons().catch(e => logger.error(e)) } catch {}
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
          try { enhanceVideoTilesOnListings().catch(e => logger.error(e)) } catch {}
          try { refreshResultsVideoChannelChips().catch(e => logger.error(e)) } catch {}
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

  function WatchOnOdyseeButtons({ source, targets, compact }: { source?: Source, targets?: Target[], compact?: boolean }) {
    if (!source || !targets || targets.length === 0) return null
    return <div style={{ display: 'inline-flex' }}>
      {targets.map((target) => {
    const url = getOdyseeUrlByTarget(target)
        const isChannel = target.type === 'channel'
        return (
          <div style={{ display: 'flex', height: '100%', alignItems: 'center', alignContent: 'center', minWidth: 'fit-content', marginRight: '6px'}}>
      <a href={`${url.href}`} target='_blank' role='button'
        style={{
                display: 'flex', alignItems: 'center', gap: compact ? '0' : '6px', borderRadius: '16px', padding: compact ? '0 4px' : '0 12px', height: '100%',
                fontWeight: 500, border: '0', color: 'whitesmoke', fontSize: compact ? '0' : '13px', textDecoration: 'none',
                backgroundColor: target.platform.theme, backgroundImage: target.platform.theme,
          ...target.platform.button.style?.button,
        }}
              onClick={(e: any) => { e.preventDefault(); e.stopPropagation(); openNewTab(url, 'user'); findVideoElementAwait(source).then((videoElement) => { videoElement.pause() }) }}
            >
              {isChannel ? (
                h(Fragment, null,
                  h('img', { src: target.platform.button.icon, height: 20, style: { ...(target.platform.button.style?.icon || {}) } } as any),
                  !compact && h('span', { style: { minWidth: 'fit-content', whiteSpace: 'nowrap' } as any }, 'Channel')
                )
              ) : (
                h(Fragment, null,
                  !compact && h('span', { style: { minWidth: 'fit-content', whiteSpace: 'nowrap' } as any }, 'Watch'),
                  h('img', { src: target.platform.button.icon, height: 20, style: { ...(target.platform.button.style?.icon || {}) } } as any)
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
    if (!params) {
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

            if (channelBar && channelName) {
              if (shortsSubscribeMountPoint.getAttribute('data-id') !== params.source.id || shortsSubscribeMountPoint.parentElement !== channelBar) {
                shortsSubscribeMountPoint.setAttribute('data-id', params.source.id)
                // Insert to the right of channel name
                channelName.insertAdjacentElement('afterend', shortsSubscribeMountPoint)
              }
              // Match height to channel name
              const hb = (channelName as HTMLElement | null)?.offsetHeight || (channelName as HTMLElement | null)?.clientHeight || 32
              shortsSubscribeMountPoint.style.height = `${hb}px`
              shortsSubscribeMountPoint.style.display = 'inline-flex'
              shortsSubscribeMountPoint.style.alignItems = 'center'
              shortsSubscribeMountPoint.style.marginLeft = '8px'
              shortsSubscribeMountPoint.style.marginRight = '0'
              const channelTargets = (params.buttonTargets ?? []).filter(t => t.type === 'channel')
              if (channelTargets.length > 0) {
                render(<WatchOnOdyseeButtons targets={channelTargets} source={params.source} />, shortsSubscribeMountPoint)
              }
            }
          }
          // Done with shorts subscribe handling
          return
        }
        // Video page: place our buttons in a right-aligned action wrapper so the channel name keeps space
        if (params.source.type === 'video') {
          const subscribeAction = (mountBefore.closest('.yt-flexible-actions-view-model-wiz__action') as HTMLElement | null) || (mountBefore.parentElement as HTMLElement | null)
          const actionsContainer = subscribeAction?.parentElement as HTMLElement | null
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
            }
            if (!rightWrapper.contains(buttonMountPoint)) rightWrapper.appendChild(buttonMountPoint)
            if (rightWrapper.parentElement !== actionsContainer) actionsContainer.appendChild(rightWrapper)

            // Height sync with Subscribe for visual alignment
            try {
              const hb = (mountBefore as HTMLElement)
              const hpx = hb.offsetHeight || hb.clientHeight
              if (hpx) buttonMountPoint.style.height = `${hpx}px`
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
            render(<WatchOnOdyseeButtons targets={params.buttonTargets ?? undefined} source={params.source} />, buttonMountPoint)

            // Precise vertical alignment: match the visual center of the first action icon
            const alignToRow = () => {
              try {
                // Prefer the primary actions row in watch metadata
                const row = document.querySelector('#actions #top-level-buttons-computed') as HTMLElement | null
                const refBtn = (row?.querySelector('button, a, yt-button-shape button, yt-button-shape a, ytd-toggle-button-renderer button, segmented-like-dislike-button-view-model button, ytd-segmented-like-dislike-button-renderer button') as HTMLElement | null)
                  || (actionsContainer.querySelector('button, a') as HTMLElement | null)
                if (!refBtn) return
                const refRect = refBtn.getBoundingClientRect()
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
                const hb = (mountBefore as HTMLElement)
                const hpx = hb.offsetHeight || hb.clientHeight
                if (hpx) buttonMountPoint.style.height = `${hpx}px`
              } catch {}
              buttonMountPoint.style.display = 'inline-flex'
              buttonMountPoint.style.alignItems = 'center'
              buttonMountPoint.style.alignSelf = 'center'
              buttonMountPoint.style.marginLeft = '12px'
              buttonMountPoint.style.marginRight = '0'
              buttonMountPoint.style.marginTop = '0'
              buttonMountPoint.style.flex = '0 0 auto'
              ;(buttonMountPoint.style as any).order = '1000'
              render(<WatchOnOdyseeButtons targets={params.buttonTargets ?? undefined} source={params.source} />, buttonMountPoint)

              // Fallback alignment relative to Subscribe element
              const alignToSub = () => {
                try {
                  const refRect = (mountBefore as HTMLElement).getBoundingClientRect()
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
          // Channel and other pages: keep right-of-Subscribe placement
          const subscribeAction = (mountBefore.closest('.yt-flexible-actions-view-model-wiz__action') as HTMLElement | null) || (mountBefore.parentElement as HTMLElement | null)
          const actionsContainer = subscribeAction?.parentElement
          if (actionsContainer) {
            let wrapper = actionsContainer.querySelector('div[data-wol-action-wrapper="1"]') as HTMLElement | null
            if (!wrapper) {
              wrapper = document.createElement('div')
              wrapper.setAttribute('data-wol-action-wrapper', '1')
              wrapper.className = 'yt-flexible-actions-view-model-wiz__action'
              wrapper.style.display = 'inline-flex'
              wrapper.style.alignItems = 'center'
              wrapper.style.margin = '0'
            }
            if (!wrapper.contains(buttonMountPoint)) wrapper.appendChild(buttonMountPoint)
            if (wrapper.parentElement !== actionsContainer || wrapper.previousElementSibling !== subscribeAction) {
              subscribeAction?.insertAdjacentElement('afterend', wrapper)
            }
            buttonMountPoint.setAttribute('data-id', params.source.id)
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
          }
          try {
            const hb = (mountBefore as HTMLElement)
            const hpx = hb.offsetHeight || hb.clientHeight
            if (hpx) buttonMountPoint.style.height = `${hpx}px`
          } catch { }
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
  function cleanupOverlays() {
    const existingOverlays = document.querySelectorAll('[data-wol-overlay]')
    dbg('Watch on Odysee: Cleaning up', existingOverlays.length, 'overlays')
    existingOverlays.forEach(overlay => overlay.remove())
    // Clear enhanced flags so they can be re-enhanced if setting is re-enabled
    const enhancedAnchors = document.querySelectorAll('a[data-wol-enhanced]')
    enhancedAnchors.forEach(anchor => anchor.removeAttribute('data-wol-enhanced'))
    // Reset global overlay state to avoid re-attaching stale overlays across navigations
    for (const [, ov] of overlayState.entries()) {
      try { ov.observer?.disconnect() } catch {}
    }
    overlayState.clear()
    resetRelatedBatch()
  }

  // Clean up stale overlays that no longer have corresponding videos
  function cleanupStaleOverlays() {
    const allOverlays = document.querySelectorAll('[data-wol-overlay]')
    allOverlays.forEach(overlay => {
      const overlayVideoId = overlay.getAttribute('data-wol-overlay')
      if (overlayVideoId) {
        // Check if there's still a video link for this ID
        const videoExists = document.querySelector(`a[href*="${overlayVideoId}"]`)
        if (!videoExists) {
          overlay.remove()
        }
      }
    })
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
  const hoverMoMap = new WeakMap<HTMLElement, MutationObserver>()
  const hoverMoTimerMap = new WeakMap<HTMLElement, number>()
  const hoverFloatCleanupMap = new WeakMap<HTMLElement, () => void>()
  // Results page: track channel renderer button + observer to avoid duplicates across toggles
  const channelRendererState = new WeakMap<HTMLElement, { btn: HTMLElement, mo: MutationObserver | null }>()
  // Version counter to invalidate old observers for channel renderers (prevents duplicate reinserts)
  let channelRendererButtonVersion = 0
  // Results page: track per-video renderer compact channel chip + observer
  const resultsVideoChipState = new WeakMap<HTMLElement, { chip: HTMLElement, mo: MutationObserver | null }>()
  // Local resolve cache for listing pages (video/channel -> Target|null)
  const resolvedLocal = new Map<string, Target | null>()
  // Persist preferred anchor per video id to keep overlay in the same area across re-renders
  const overlayAnchorPrefs = new Map<string, { anchor: 'top-left' | 'bottom-left', x: number, y: number }>()

  // Enhanced cleanup for specific page contexts only
  function cleanupOverlaysByPageContext() {
    const currentPath = window.location.pathname
    // Only clear on the dedicated Shorts player page; keep overlays on /watch for related content
    if ((currentPath.startsWith('/shorts/') && currentPath.split('/').length === 3)) {
      cleanupOverlays()
    }
  }

  // Cleanup helper for channel buttons on results page to avoid duplicate reinsertion
  function cleanupResultsChannelButtons(options?: { disconnectOnly?: boolean }) {
    try {
      // Remove all injected channel buttons and disconnect observers when asked
      const nodes = Array.from(document.querySelectorAll('ytd-channel-renderer')) as HTMLElement[]
      for (const cr of nodes) {
        const st = channelRendererState.get(cr)
        if (st?.mo) {
          try { st.mo.disconnect() } catch {}
        }
        if (!options?.disconnectOnly) {
          try { st?.btn.remove() } catch {}
          try { cr.querySelectorAll('[data-wol-results-channel-btn]').forEach(el => el.remove()) } catch {}
          try { cr.removeAttribute('data-wol-channel-button') } catch {}
        }
        // Always clear state to avoid stale reinserts
        try { channelRendererState.delete(cr) } catch {}
      }
    } catch {}
  }

  // Cleanup helper for inline channel chips in video results to avoid stale observers
  function cleanupResultsVideoChips(options?: { disconnectOnly?: boolean }) {
    try {
      const vrs = Array.from(document.querySelectorAll('ytd-video-renderer')) as HTMLElement[]
      for (const vr of vrs) {
        const st = resultsVideoChipState.get(vr)
        if (st?.mo) { try { st.mo.disconnect() } catch {} }
        if (!options?.disconnectOnly) {
          try { st?.chip.remove() } catch {}
          try { vr.querySelectorAll('[data-wol-inline-channel]').forEach(el => el.remove()) } catch {}
        }
        try { resultsVideoChipState.delete(vr) } catch {}
      }
    } catch {}
  }

  // Strict visibility enforcement for results channel chips
  function enforceResultsChannelChipVisibility() {
    try {
      const allow = (location.pathname === '/results') && !!settings.resultsApplySelections && !!settings.buttonChannelSub
      if (!allow) {
        cleanupResultsVideoChips()
      }
    } catch {}
  }

  // Ensure channel renderer buttons (top channel section on results) are present
  async function refreshResultsChannelRendererButtons() {
    try {
      if (location.pathname !== '/results') return
      if (!settings.resultsApplySelections || !settings.buttonChannelSub) return

      const platform = targetPlatformSettings[settings.targetPlatform]
      const renderers = Array.from(document.querySelectorAll('ytd-channel-renderer')) as HTMLElement[]
      for (const cr of renderers) {
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
        // Derive URL: prefer /channel/UC..., else /@handle, else search by name
        let chUrl: URL | null = null
        let handle: string | null = null
        let ucid: string | null = null
        try {
          const chA = cr.querySelector('a[href^="/channel/"]') as HTMLAnchorElement | null
          const hA = cr.querySelector('a[href^="/@"]') as HTMLAnchorElement | null
          if (chA) {
            const u = new URL(chA.getAttribute('href') || chA.href, location.origin)
            const id = u.pathname.split('/')[2]
            if (id && id.startsWith('UC')) ucid = id
          }
          if (!ucid && hA) {
            try { const u = new URL(hA.getAttribute('href') || hA.href, location.origin); handle = u.pathname.substring(1) } catch {}
          }
        } catch {}
        if (ucid) {
          try {
            const srcPlatform = getSourcePlatfromSettingsFromHostname(location.hostname)!
            const res = await getTargetsBySources({ platform: srcPlatform, id: ucid, type: 'channel', url: new URL(location.href), time: null })
            const t = res[ucid] || null
            if (t) chUrl = getOdyseeUrlByTarget(t)
          } catch {}
        }
        if (!chUrl && handle) {
          try { chUrl = new URL(`${platform.domainPrefix}/@${handle}`.replace('/@/@','/@')) } catch {}
        }
        if (!chUrl) {
          const nameText = (cr.querySelector('#channel-title')?.textContent || cr.textContent || '').trim()
          const q = encodeURIComponent(nameText)
          try { chUrl = new URL(`${platform.domainPrefix}/$/search?q=${q}`) } catch {}
        }
        if (!chUrl) { cr.removeAttribute('data-wol-channel-button-pending'); continue }

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
          icon.style.height = '14px'
          icon.style.width = '14px'
          icon.style.pointerEvents = 'none'
          const text = document.createElement('span')
          text.textContent = 'Channel'
          text.style.whiteSpace = 'nowrap'
          link.appendChild(icon)
          link.appendChild(text)
          wrapper.appendChild(link)
        }
        // Update href every pass
        if (link) link.href = chUrl.href

        if (buttonsContainer) {
          if (subscribeButton && subscribeButton.parentElement === buttonsContainer) buttonsContainer.insertBefore(wrapper, subscribeButton)
          else buttonsContainer.appendChild(wrapper)
        } else {
          cr.appendChild(wrapper)
        }
        cr.setAttribute('data-wol-channel-button','1')
        cr.removeAttribute('data-wol-channel-button-pending')

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

        // Keep present during renderer churn
        try {
          let mo: MutationObserver | null = null
          const ensure = () => {
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
    } catch {}
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

      // Collect channel anchors from video result renderers
      const vrs = Array.from(document.querySelectorAll('ytd-video-renderer')) as HTMLElement[]
      type VRCtx = { vr: HTMLElement, nameAnchor: HTMLAnchorElement | null, handle: string | null, ucid: string | null }
      const items: VRCtx[] = vrs.map(vr => {
        const nameAnchor = vr.querySelector('#channel-info #channel-name a[href], ytd-channel-name#channel-name a[href]') as HTMLAnchorElement | null
        let handle: string | null = null
        let ucid: string | null = null
        if (nameAnchor) {
          try {
            const href = nameAnchor.getAttribute('href') || nameAnchor.href || ''
            const u = new URL(href, location.origin)
            if (u.pathname.startsWith('/channel/')) ucid = u.pathname.split('/')[2] || null
            else if (u.pathname.startsWith('/@')) handle = u.pathname.substring(1)
          } catch {}
        }
        if (!ucid && !handle) {
          const fb = vr.querySelector('a[href^="/channel/"]') as HTMLAnchorElement | null
          if (fb) {
            try { const u = new URL(fb.getAttribute('href') || fb.href, location.origin); const uc = u.pathname.split('/')[2]; if (uc) ucid = uc } catch {}
          }
        }
        return { vr, nameAnchor, handle, ucid }
      })

      // Attempt to upgrade @handles to UC ids when possible (DOM hints only; no network)
      async function upgradeHandleToUC(ctx: VRCtx): Promise<string | null> {
        const vr = ctx.vr
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
        } catch {}
        return null
      }

      for (const it of items) {
        if (!it.ucid && it.handle) {
          try { it.ucid = await upgradeHandleToUC(it) } catch {}
        }
      }

      // Resolve unique UC channel ids in one call
      const uniqueUC = Array.from(new Set(items.map(x => x.ucid).filter((x): x is string => !!x && x.startsWith('UC'))))
      let resolved: Record<string, Target | null> = {}
      if (uniqueUC.length > 0) {
        const srcPlatform = getSourcePlatfromSettingsFromHostname(location.hostname)!
        const srcs = uniqueUC.map(id => ({ platform: srcPlatform, id, type: 'channel' as const, url: new URL(location.href), time: null }))
        resolved = await getTargetsBySources(...srcs)
      }
      const platform = targetPlatformSettings[settings.targetPlatform]

      // Inject or ensure an inline chip in each renderer
      for (const it of items) {
        try {
          const vr = it.vr
          const channelInfo = vr.querySelector('#channel-info') as HTMLElement | null
          const thumbA = channelInfo?.querySelector('#channel-thumbnail') as HTMLElement | null
          // If we already manage a chip for this renderer, update and ensure placement
          const managed = resultsVideoChipState.get(vr)
          // Compute target URL for channel: prefer resolved UC -> handle -> search
          let chUrl: URL | null = null
          if (it.ucid && resolved[it.ucid]) chUrl = getOdyseeUrlByTarget(resolved[it.ucid]!)
          if (!chUrl && it.handle) {
            try { chUrl = new URL(`${platform.domainPrefix}/@${it.handle}`.replace('/@/@','/@')) } catch {}
          }
          if (!chUrl) {
            const q = encodeURIComponent(it.nameAnchor?.textContent?.trim() || it.handle || it.ucid || '')
            if (q) { try { chUrl = new URL(`${platform.domainPrefix}/$/search?q=${q}`) } catch {} }
          }
          if (!chUrl) continue

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
            inline.style.width = '22px'
            inline.style.height = '22px'
            inline.style.borderRadius = '11px'
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
  }

  // Smart overlay management that preserves existing overlays when possible
  function manageOverlaysIntelligently() {
    const currentTime = Date.now()
    const currentUrl = window.location.href

    // Clean up overlays that are very old (more than 5 minutes) to prevent memory leaks
    for (const [overlayId, overlayData] of overlayState.entries()) {
      if (currentTime - overlayData.lastSeen > 300000) { // 5 minutes
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
    // Keep overlays cleaned when disabled, but do not short-circuit observers needed for results chips
    if (!settings.buttonOverlay) {
      cleanupOverlays()
    } else {
      ensureOverlayCssInjected()
      // Run overlay enhancement immediately when enabled
      enhanceVideoTilesOnListings().catch((e) => logger.error(e))
    }

    // Always maintain a global observer to handle dynamic results content
    if (!wolMutationObserver) {
      wolMutationObserver = new MutationObserver((mutations) => {
        // Strict removal if toggles do not allow chips
        enforceResultsChannelChipVisibility()
        let shouldEnhance = false
        let shouldRefreshChips = false
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            for (let i = 0; i < mutation.addedNodes.length; i++) {
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
          }
        }
        if (shouldEnhance && settings.buttonOverlay) {
          try { ensureResultsPillsVisibility() } catch {}
          enhanceVideoTilesOnListings().catch((e) => logger.error(e))
        }
        if (shouldRefreshChips && settings.resultsApplySelections && settings.buttonChannelSub) {
          try { refreshResultsVideoChannelChips().catch(e => logger.error(e)) } catch {}
          try { refreshResultsChannelRendererButtons().catch(e => logger.error(e)) } catch {}
        }
      })

      // Also poll for SPA navigation changes (tabs/filters)
      let lastHref = window.location.href
      setInterval(() => {
        const currentHref = window.location.href
        if (currentHref !== lastHref) {
          const previousHref = lastHref
          lastHref = currentHref
          dbg('Watch on Odysee: Detected location change from', previousHref, 'to', currentHref)
          overlayGeneration++
          cleanupOverlaysByPageContext()
          cleanupOverlays()
          lastEnhanceTime = 0; lastEnhanceUrl = ''
          if (settings.buttonOverlay) enhanceVideoTilesOnListings().catch((e) => logger.error(e))
          // Refresh results chips on nav as well
          if (location.pathname === '/results' && settings.resultsApplySelections && settings.buttonChannelSub) {
            try { refreshResultsVideoChannelChips().catch(e => logger.error(e)) } catch {}
            try { refreshResultsChannelRendererButtons().catch(e => logger.error(e)) } catch {}
          }
          scheduleProcessCurrentPage(50)
          try { ensureResultsPillsVisibility() } catch {}
          // A single immediate pass is enough; observers will catch late content
        }
      }, 1000)

      try { wolMutationObserver.observe(document.body, { childList: true, subtree: true }) } catch {}

      if (window.location.pathname.includes('/@') || window.location.pathname.includes('/channel/')) {
        const tabContainer = document.querySelector('ytd-c4-tabbed-header-renderer') ||
          document.querySelector('ytd-page-header-renderer')
        if (tabContainer) try { wolMutationObserver.observe(tabContainer, { childList: true, subtree: true }) } catch {}
      }
    }
  }

  // Enhance video tiles on listing pages (e.g., /videos, related content) with an Odysee logo link
  async function enhanceVideoTilesOnListings() {
    const gen = overlayGeneration
    // Safety: prune any overlays from prior generations
    for (const [key, ov] of overlayState.entries()) {
      if (ov.generation !== gen) {
        ov.element.remove()
        overlayState.delete(key)
      }
    }
     // Throttle calls to prevent excessive processing
     const now = Date.now()
     const currentUrl = window.location.href
     const isResults = location.pathname === '/results'
     const minGap = isResults ? 800 : 400
     // Allow immediate re-processing if URL changed or if it's been too soon since last enhancement
     if (now - lastEnhanceTime < minGap && currentUrl === lastEnhanceUrl) {
       return
     }
    lastEnhanceTime = now
    lastEnhanceUrl = currentUrl

    // Check if overlay buttons are enabled - clean up overlays if disabled but continue for inline buttons
    if (!settings.buttonOverlay) {
      // Clean up any existing overlays when setting is disabled
      cleanupOverlays()
      // But continue processing for /results page inline buttons which are controlled by other settings
      if (location.pathname !== '/results') {
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
      'ytd-rich-grid-renderer a[href*="/watch?v="]',      // Rich grid on channel pages
      'ytd-rich-grid-media a[href*="/watch?v="]',         // Rich grid media items
      'ytd-channel-video-player-renderer a[href*="/watch?v="]', // Channel video players

      // General page content (home, search, trending, etc.)
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
    for (const selector of selectors) {
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector))
      allAnchors.push(...anchors)
    }
    // Exclude anchors that belong to the featured channel player or playlist-only links
    const filteredAnchors = allAnchors.filter(a => {
      try {
        const href = a.getAttribute('href') || ''
        const u = new URL(href, location.origin)
        // Skip anchors inside channel hero player
        if (a.closest('ytd-channel-video-player-renderer')) return false
        // Skip playlist/Play All controls and playlist renderers
        if (a.closest('ytd-playlist-renderer, ytd-grid-playlist-renderer, ytd-compact-playlist-renderer, ytd-playlist-panel-video-renderer, ytd-playlist-thumbnail')) return false
        const label = (a.getAttribute('aria-label') || a.textContent || '').trim().toLowerCase()
        if (label === 'play all' || label.startsWith('play all')) return false
        if (u.pathname === '/playlist') return false
        // Skip playlist-only links (no explicit video id in href)
        const hasVideo = (u.pathname === '/watch' && !!u.searchParams.get('v')) || u.pathname.startsWith('/shorts/')
        if (!hasVideo && u.searchParams.has('list')) return false
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

    // Remove duplicates (same href) and exclude non-visible or main video area
    const uniqueAnchors = filteredAnchors.filter((anchor, index, self) => {
      // Remove duplicates
      if (index !== self.findIndex(a => a.href === anchor.href)) return false

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

      return !isMainVideo && !isMainVideoInfo
    })

    const toProcess: { a: HTMLAnchorElement, id: string, type: 'video' | 'channel' }[] = []
    for (const a of uniqueAnchors) {
      // Skip anchors we already enhanced to avoid duplicate listeners/overlays
      if ((a as any).dataset && (a as any).dataset.wolEnhanced === 'done') continue
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

      if (!vid) continue
      toProcess.push({ a, id: vid, type })
    }

    if (toProcess.length === 0) return

    // De-duplicate by resolved id to avoid processing the same video twice (thumbnail + title, etc.)
    const scoreAnchor = (a: HTMLAnchorElement): number => {
      let s = 0
      if (a.matches('a#thumbnail, a#thumbnail.yt-simple-endpoint, a.yt-simple-endpoint.inline-block.style-scope.ytd-thumbnail')) s += 20
      if (a.closest('ytd-thumbnail')) s += 15
      if (a.closest('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer')) s += 10
      if (a.closest('#dismissible')) s += 4
      return s
    }
    const byId = new Map<string, { a: HTMLAnchorElement, id: string, type: 'video' | 'channel' }>()
    for (const item of toProcess) {
      const prev = byId.get(item.id)
      if (!prev) {
        byId.set(item.id, item)
      } else {
        const ns = scoreAnchor(item.a)
        const ps = scoreAnchor(prev.a)
        if (ns > ps) byId.set(item.id, item)
      }
    }
    const dedupedToProcess = Array.from(byId.values())

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
      }
    }

    for (const { a, id, type } of normalizedToProcess) {
      if (gen !== overlayGeneration) break
      const res = resolvedLocal.get(`${type}:${id}`) ?? null
      // Results page: do not hide or remove result tiles. Settings only control overlay/button UI.
      // Any attributes previously used to hide are cleared elsewhere when toggles change.
      // For non-results pages we require a resolved target; for results page we may still
      // inject channel chips for video tiles even when the video itself did not resolve.
      let url: URL | null = null
      if (res) url = getOdyseeUrlByTarget(res)
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
          if (!settings.resultsApplySelections || !settings.buttonChannelSub) {
            // If disabled, ensure any injected channel buttons are removed and observers disconnected
            try { cleanupResultsChannelButtons() } catch {}
            continue
          }
          // Reuse existing managed button for this renderer if present; just update the href and ensure attached
          const existingState = channelRendererState.get(channelRenderer)
          if (existingState?.btn) {
            try {
              const link = existingState.btn.querySelector('a') as HTMLAnchorElement | null
              if (link) link.href = url.href
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
              ;(a as any).dataset.wolEnhanced = 'done'
              continue
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
          icon.style.height = '14px'
          icon.style.width = '14px'

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
              // Prefer an actual clickable button within the subscribe container for accurate metrics
              const subBtnEl = (subscribeButton.querySelector('button, a, yt-button-shape button, yt-button-shape a, ytd-subscribe-button-renderer button') as HTMLElement | null) || subscribeButton
              let sbh = subBtnEl.getBoundingClientRect().height || (subBtnEl as any).offsetHeight || 0
              if (!sbh) {
                // Fallback: scan children for a visible height
                const elems = Array.from(subBtnEl.querySelectorAll('*')) as HTMLElement[]
                for (const el of elems) {
                  const r = el.getBoundingClientRect()
                  if (r.height > 0) { sbh = r.height; break }
                }
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

      // 3. For rich items, find the thumbnail area
      if (!host && richItem) {
        const richThumb = richItem.querySelector('ytd-thumbnail #thumbnail') as HTMLElement
        if (richThumb) {
          host = richThumb
        } else {
          host = richItem.querySelector('ytd-thumbnail') as HTMLElement || richItem
        }
      }

      // 3.5. New lockup-based UI (yt-lockup-view-model + yt-thumbnail-view-model)
      if (!host) {
        const lockupAnchor = (a.matches('.yt-lockup-view-model-wiz__content-image') ? (a as unknown as HTMLElement) : (a.closest('.yt-lockup-view-model-wiz__content-image') as HTMLElement | null))
        const ytThumbVM = (lockupAnchor?.querySelector('yt-thumbnail-view-model') as HTMLElement | null) || (a.closest('yt-thumbnail-view-model') as HTMLElement | null)
        const ytThumbImg = ytThumbVM?.querySelector('.ytThumbnailViewModelImage') as HTMLElement | null
        // Prefer stable anchor container first so overlay persists across inline preview DOM rewrites
        if (lockupAnchor) host = lockupAnchor
        else if (ytThumbVM) host = ytThumbVM
        else if (ytThumbImg) host = ytThumbImg
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
         if (!host) continue
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
        try { mount.addEventListener('pointerenter', (e) => { try { e.stopPropagation() } catch {} ; pinOverlay() }, { passive: true }) } catch {}
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

      // Check if we already have an overlay for this video ID
      const existingOverlayId = `${id}-${host.offsetLeft}-${host.offsetTop}`
      const existingOverlay = overlayState.get(existingOverlayId)

      if (existingOverlay && existingOverlay.element.parentElement === host) {
        // Update the existing overlay's lastSeen timestamp
        existingOverlay.lastSeen = Date.now()
          ; (a as any).dataset.wolEnhanced = 'done'
        continue
      }

      // Avoid removing an existing overlay during hover; only proceed to create if none exists
      try {
        const already = host.querySelector(`[data-wol-overlay="${id}"]`)
        if (already) { (a as any).dataset.wolEnhanced = 'done'; continue }
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
      // Skip heavy per-tile observers on search results to prevent CPU spikes
      if (location.pathname !== '/results') {
        mo = new MutationObserver(() => {
          if (gen !== overlayGeneration) { try { mo?.disconnect() } catch {} ; return }
          // Always keep overlay attached to the stable host element
          try {
            // If original host is gone or no longer contains mount, try to locate a fresh host within the tile
            const containerRoot = tileContainer || host.parentElement || (a.closest('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-grid-media, ytd-reel-item-renderer, ytd-shorts-lockup-view-model, ytd-rich-item-renderer, ytd-compact-video-renderer') as HTMLElement | null)
            
            if (!host.isConnected || (containerRoot && !containerRoot.contains(host))) {
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
              if (newHost) host = newHost
            }
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
            if (!host.contains(mount)) host.appendChild(mount)
          } catch {}
          ensureOverlayVisibility()
        })
        try {
          if (tileContainer) mo.observe(tileContainer, { childList: true, subtree: true })
          else mo.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['style','class'] })
        } catch {}
      }

      overlayState.set(existingOverlayId, {
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
      if (mount.parentElement !== host) host.appendChild(mount)
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
    logger.log('Watch on Odysee: processCurrentPage() called for URL:', location.href)
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
           try { refreshResultsVideoChannelChips().catch(e => logger.error(e)) } catch {}
           try { refreshResultsChannelRendererButtons().catch(e => logger.error(e)) } catch {}
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
                const p = new URL(ownerHref, location.origin).pathname.split('/')
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
      if (needsResolve) {
        if (!resolveLogCache.has(sig)) { resolveLogCache.add(sig); logger.log('Resolving ids:', sig) }
        resolved = await getTargetsBySources(...sourcesToResolve)
        lastResolved = resolved
        lastResolveSig = sig
        lastResolveAt = Date.now()
        logger.log('Resolved results for:', sig, Object.keys(resolved))
        settingsDirty = false
      } else {
        resolved = lastResolved
      }

      const primaryTarget = resolved[source.id] ?? findTargetFromSourcePage(source)
      if (primaryTarget?.type === 'video') playerTarget = primaryTarget

      if (source.type === 'channel') {
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
        updateButtons(null)
        ensureOverlayEnhancementActive()
        // do not return; allow redirect assessment to run
      }

      updateButtons(null)
      if (playerTarget?.type === 'video') {
        const videoElement = document.querySelector<HTMLVideoElement>(source.platform.htmlQueries.videoPlayer)
        if (videoElement) playerTarget.time = videoElement.currentTime > 3 && videoElement.currentTime < videoElement.duration - 1 ? videoElement.currentTime : null
      }
      updateButtons({ buttonTargets: subscribeTargets, playerTarget, source })
      ensureOverlayEnhancementActive()
      if (location.pathname === '/results' && settings.resultsApplySelections && settings.buttonChannelSub) {
        try { refreshResultsVideoChannelChips().catch(e => logger.error(e)) } catch {}
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
    } catch (error) { logger.error(error) }
  }

  // Initial kick using event-driven flow
  scheduleProcessCurrentPage(0)

})()

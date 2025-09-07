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
      resetRelatedBatch()
      lastEnhanceTime = 0; lastEnhanceUrl = ''
      // Slight delay to allow related tiles to populate so more get overlays at once
      setTimeout(() => enhanceVideoTilesOnListings().catch(e => logger.error(e)), 600)
      // Also refresh page-level buttons/redirects once per navigation
      scheduleProcessCurrentPage(100)
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
        
      // Handle button setting changes that require immediate UI updates
        if (key === 'buttonChannelSub' || key === 'buttonVideoSub' || key === 'buttonVideoPlayer') {
          needsButtonUpdate = true
          // Proactively clean or (re)inject inline UI on results when settings flip
          try {
            if (key === 'buttonVideoSub' && change?.newValue === false) {
              document.querySelectorAll('a[data-wol-inline-watch], a[data-wol-inline-shorts-watch]').forEach(el => el.remove())
              // Shorts compact mount cleanup
              try { render(<WatchOnOdyseeButtons />, shortsSideButtonMountPoint) } catch {}
            }
            if (key === 'buttonChannelSub' && change?.newValue === false) {
              document.querySelectorAll('a[data-wol-inline-channel]').forEach(el => el.remove())
              document.querySelectorAll('[data-wol-results-channel-btn]').forEach(el => el.remove())
              document.querySelectorAll('ytd-channel-renderer[data-wol-channel-button]')
                .forEach(el => (el as HTMLElement).removeAttribute('data-wol-channel-button'))
              // Shorts subscribe mount cleanup
              try { render(<WatchOnOdyseeButtons />, shortsSubscribeMountPoint) } catch {}
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
          <div style={{ display: 'flex', height: '36px', alignContent: 'center', minWidth: 'fit-content', marginRight: '6px'}}>
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
                  h('img', { src: target.platform.button.icon, height: 18, style: { ...(target.platform.button.style?.icon || {}) } } as any),
                  !compact && h('span', { style: { minWidth: 'fit-content', whiteSpace: 'nowrap' } as any }, 'Channel')
                )
              ) : (
                h(Fragment, null,
                  !compact && h('span', { style: { minWidth: 'fit-content', whiteSpace: 'nowrap' } as any }, 'Watch'),
                  h('img', { src: target.platform.button.icon, height: 18, style: { ...(target.platform.button.style?.icon || {}) } } as any)
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
          const overlay = (document.querySelector('ytd-reel-player-overlay-renderer') as HTMLElement | null)
            || (document.querySelector('#player.skeleton.shorts #player-wrap') as HTMLElement | null)
          if (overlay) {
            overlay.style.position = overlay.style.position || 'relative'
            Object.assign(playerButtonMountPoint.style, { position: 'absolute', right: '12px', bottom: '12px', display: 'inline-flex', alignItems: 'center', zIndex: '1002', pointerEvents: 'auto' })
            if (playerButtonMountPoint.getAttribute('data-id') !== params.source.id || playerButtonMountPoint.parentElement !== overlay) {
              playerButtonMountPoint.setAttribute('data-id', params.source.id)
              overlay.appendChild(playerButtonMountPoint)
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
        // Video page: place our buttons to the LEFT of Subscribe with minimal spacing
        if (params.source.type === 'video') {
          const parent = (mountBefore as HTMLElement).parentElement
          if (parent) {
            if (buttonMountPoint.getAttribute('data-id') !== params.source.id || buttonMountPoint.parentElement !== parent) {
          buttonMountPoint.setAttribute('data-id', params.source.id)
              parent.insertBefore(buttonMountPoint, mountBefore)
            }
            // Match Subscribe button height precisely and add small spacing to the right
            try {
              const hb = (mountBefore as HTMLElement)
              const hpx = hb.offsetHeight || hb.clientHeight
              if (hpx) buttonMountPoint.style.height = `${hpx}px`
            } catch { }
            buttonMountPoint.style.display = 'inline-flex'
            buttonMountPoint.style.alignItems = 'center'
            buttonMountPoint.style.marginRight = '6px'
            buttonMountPoint.style.marginLeft = '0'
            render(<WatchOnOdyseeButtons targets={params.buttonTargets ?? undefined} source={params.source} />, buttonMountPoint)
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
            if (buttonMountPoint.getAttribute('data-id') !== params.source.id || buttonMountPoint.parentElement !== mountBefore.parentElement) {
              mountBefore.insertAdjacentElement('afterend', buttonMountPoint)
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
          buttonMountPoint.style.marginLeft = '3px'
          buttonMountPoint.style.marginRight = '0'
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
    if (!settings.buttonOverlay) {
      cleanupOverlays()
      return
    }
    ensureOverlayCssInjected()
    // Run enhancement immediately; rely on observers for subsequent DOM churn
    enhanceVideoTilesOnListings().catch((e) => logger.error(e))

    if (!wolMutationObserver) {
      wolMutationObserver = new MutationObserver((mutations) => {
        if (!settings.buttonOverlay) return
        let shouldEnhance = false
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
                  break
                }
              }
            }
          }
        }
        if (shouldEnhance) enhanceVideoTilesOnListings().catch((e) => logger.error(e))
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
          enhanceVideoTilesOnListings().catch((e) => logger.error(e))
          scheduleProcessCurrentPage(50)
          // A single immediate pass is enough; observers will catch late content
        }
      }, 1000)

      wolMutationObserver.observe(document.body, { childList: true, subtree: true })

      if (window.location.pathname.includes('/@') || window.location.pathname.includes('/channel/')) {
        const tabContainer = document.querySelector('ytd-c4-tabbed-header-renderer') ||
          document.querySelector('ytd-page-header-renderer')
        if (tabContainer) wolMutationObserver.observe(tabContainer, { childList: true, subtree: true })
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
    if (now - lastEnhanceTime < minGap && currentUrl === lastEnhanceUrl) {
      return
    }
    lastEnhanceTime = now
    lastEnhanceUrl = currentUrl

    // Check if overlay buttons are enabled
    if (!settings.buttonOverlay) {
      // Clean up any existing overlays when setting is disabled
      cleanupOverlays()
      return
    }

    // Debug logging for search pages
    if (WOL_DEBUG && window.location.pathname === '/results') {
      dbg('Watch on Odysee: Processing search results page:', window.location.href)
    }

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
      try {
        const href = anchor.getAttribute('href') || anchor.href
        if (href && href.startsWith('/@')) {
          const html = await (await fetch(href, { credentials: 'same-origin' })).text()
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
      if (!res) { 
        continue 
      }

      const url = getOdyseeUrlByTarget(res)

      // On /results, render inline buttons instead of overlays for video tiles
      if (location.pathname === '/results') {
        if (type === 'video') {
          try {
            const videoRenderer = a.closest('ytd-video-renderer') as HTMLElement | null
            if (videoRenderer) {
              // 1) Inline "Watch on Odysee" pill to the right of the title/menu
              if (settings.buttonVideoSub && !videoRenderer.querySelector('[data-wol-inline-watch]')) {
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
                i.style.width = '14px'
                i.style.height = '14px'
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

                // Insert compact channel icon to the left of the channel avatar (in channel-info)
                try {
                  if (!videoRenderer.querySelector('[data-wol-inline-channel]')) {
                    // Try to extract channel id from anchors in this renderer
                    let chId: string | null = null
                    const nameA = videoRenderer.querySelector('#channel-info #channel-name a[href], ytd-channel-name#channel-name a[href]') as HTMLAnchorElement | null
                    try {
                      const href = nameA?.getAttribute('href') || nameA?.href || ''
                      if (href) {
                        const cu = new URL(href, location.origin)
                        if (cu.pathname.startsWith('/channel/')) chId = cu.pathname.split('/')[2] || null
                        else if (cu.pathname.startsWith('/@')) chId = await upgradeChannelIdFromRenderer(nameA!, cu.pathname.substring(1))
                      }
                    } catch {}
                    if (!chId) {
                      const fb = videoRenderer.querySelector('a[href^="/channel/"]') as HTMLAnchorElement | null
                      if (fb) {
                        try { const u = new URL(fb.getAttribute('href') || fb.href, location.origin); const uc = u.pathname.split('/')[2]; if (uc) chId = uc } catch {}
                      }
                    }
                    if (chId) {
                      const srcPlatform = getSourcePlatfromSettingsFromHostname(location.hostname)!
                      const chRes = await getTargetsBySources({ platform: srcPlatform, id: chId, type: 'channel', url: new URL(location.href), time: null })
                      const chTarget = chRes[chId] || null
                      let chUrl: URL | null = null
                      if (chTarget) chUrl = getOdyseeUrlByTarget(chTarget)
                      else if (nameA?.href?.includes('/@')) {
                        try { const handle = (new URL(nameA.href, location.origin)).pathname.substring(1); chUrl = new URL(`${platform.domainPrefix}/@${handle}`.replace('/@/@','/@')) } catch {}
                      }
                      if (!chUrl) {
                        const q = encodeURIComponent(nameA?.textContent?.trim() || chId)
                        try { chUrl = new URL(`${platform.domainPrefix}/$/search?q=${q}`) } catch {}
                      }
                      if (chUrl) {
                        const chInfo = videoRenderer.querySelector('#channel-info') as HTMLElement | null
                        const thumbA = chInfo?.querySelector('#channel-thumbnail') as HTMLElement | null
                        const chBtn = document.createElement('a')
                        chBtn.setAttribute('data-wol-inline-channel', '1')
                        chBtn.href = chUrl.href
                        chBtn.target = '_blank'
                        chBtn.title = `Open channel on ${platform.button.platformNameText}`
                        chBtn.style.display = 'inline-flex'
                        chBtn.style.alignItems = 'center'
                        chBtn.style.justifyContent = 'center'
                        chBtn.style.flex = '0 0 auto'
                        chBtn.style.marginRight = '6px'
                        // Slight nudge up to align vertically with avatar (top felt short)
                        chBtn.style.marginTop = '-2px'
                        chBtn.style.width = '22px'
                        chBtn.style.height = '22px'
                        chBtn.style.borderRadius = '11px'
                        // Use full-bleed icon instead of a filled circle background
                        chBtn.style.background = 'transparent'
                        chBtn.style.overflow = 'hidden'
                        const icon = document.createElement('img')
                        icon.src = platform.button.icon
                        icon.style.width = '22px'
                        icon.style.height = '22px'
                        icon.style.pointerEvents = 'none'
                        chBtn.appendChild(icon)
                        chBtn.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation() } catch {}; openNewTab(chUrl!, 'user') })
                        if (chInfo && thumbA && chInfo.contains(thumbA)) {
                          try {
                            const cs = window.getComputedStyle(chInfo)
                            if (cs.display !== 'flex' && cs.display !== 'inline-flex') chInfo.style.display = 'flex'
                            chInfo.style.alignItems = 'center'
                            chInfo.insertBefore(chBtn, thumbA)
                            if (WOL_DEBUG) dbg('WOL results inline channel placed before avatar', { videoId: id, channelId: chId })
                          } catch {
                            chInfo.insertBefore(chBtn, thumbA)
                          }
                        } else {
                          // Fallback: keep next to Watch pill if channel-info missing
                          if (btn.parentElement) btn.parentElement.insertBefore(chBtn, btn)
                          else if (menu && menu.parentElement === titleWrapper) titleWrapper.insertBefore(chBtn, menu)
                          else titleWrapper?.appendChild(chBtn)
                          if (WOL_DEBUG) dbg('WOL results inline channel fallback near watch', { videoId: id, channelId: chId })
                        }
                      }
                    } else if (WOL_DEBUG) dbg('WOL results could not derive channel id for next-to-watch injection')
                  }
                } catch (e) { if (WOL_DEBUG) dbg('WOL results inline channel next-to-watch error', e) }
              }

              // 2) Channel inline icon (results)
              if (settings.buttonChannelSub && !videoRenderer.querySelector('[data-wol-inline-channel]')) {
                const nameAnchor = (videoRenderer.querySelector('#channel-info #channel-name a[href], ytd-channel-name#channel-name a[href]') as HTMLAnchorElement | null)
                const nameContainer = nameAnchor?.closest('#channel-info') as HTMLElement | null
                  || nameAnchor?.closest('ytd-channel-name#channel-name') as HTMLElement | null
                if (nameAnchor && (nameContainer || nameAnchor.parentElement)) {
                  // Resolve channel to target
                  let channelId: string | null = null
                  try {
                    const cu = new URL(nameAnchor.getAttribute('href') || nameAnchor.href, location.origin)
                    if (cu.pathname.startsWith('/channel/')) channelId = cu.pathname.split('/')[2] || null
                    else if (cu.pathname.startsWith('/@')) channelId = await upgradeChannelIdFromRenderer(nameAnchor, cu.pathname.substring(1))
                    else {
                      const fallback = videoRenderer.querySelector('a[href^="/channel/"]') as HTMLAnchorElement | null
                      if (fallback) {
                        try { const fu = new URL(fallback.getAttribute('href') || fallback.href, location.origin); const uc = fu.pathname.split('/')[2]; if (uc) channelId = uc } catch {}
                      }
                    }
                  } catch {}
                  if (channelId) {
                    const srcPlatform = getSourcePlatfromSettingsFromHostname(location.hostname)!
                    const chRes = await getTargetsBySources({ platform: srcPlatform, id: channelId, type: 'channel', url: new URL(location.href), time: null })
                    const chTarget = chRes[channelId] || null
                    // Choose best available target: direct resolve -> handle URL -> search URL
                    let chUrl: URL | null = null
                    if (chTarget) {
                      chUrl = getOdyseeUrlByTarget(chTarget)
                      if (WOL_DEBUG) dbg('WOL results inline channel target: direct', { channelId, url: chUrl.href })
                    } else {
                      // Try handle-based URL
                      let handle: string | null = null
                      try {
                        const cu = new URL(nameAnchor.getAttribute('href') || nameAnchor.href, location.origin)
                        if (cu.pathname.startsWith('/@')) handle = cu.pathname.substring(1)
                      } catch {}
                      if (handle) {
                        try { chUrl = new URL(`${platform.domainPrefix}/@${handle}`.replace('/@/@','/@')) } catch {}
                        if (WOL_DEBUG) dbg('WOL results inline channel target: handle', { handle, url: chUrl?.href })
                      }
                      // Fallback: Odysee search
                      if (!chUrl) {
                        const q = encodeURIComponent(nameAnchor.textContent?.trim() || handle || channelId)
                        try { chUrl = new URL(`${platform.domainPrefix}/$/search?q=${q}`) } catch {}
                        if (WOL_DEBUG) dbg('WOL results inline channel target: search', { q, url: chUrl?.href })
                      }
                    }
                    if (chUrl) {
                      const channelNameEl = (videoRenderer.querySelector('ytd-channel-name#channel-name') as HTMLElement | null)
                      const container = (videoRenderer.querySelector('ytd-channel-name#channel-name #container') as HTMLElement | null)
                        || channelNameEl
                        || (nameAnchor.parentElement as HTMLElement)
                      const ensureInline = () => {
                        try {
                          if (!container) return
                          if (container.querySelector('[data-wol-inline-channel]')) return
                          // Make sure the row can accommodate an inline control
                          try {
                            const cs = window.getComputedStyle(container)
                            if (cs.display !== 'flex' && cs.display !== 'inline-flex') container.style.display = 'inline-flex'
                            container.style.alignItems = 'center'
                            ;(container as HTMLElement).style.gap = (cs.columnGap && cs.columnGap !== 'normal') ? cs.columnGap : '6px'
                            container.style.overflow = 'visible'
                          } catch {}
                          const inline = document.createElement('a')
                          inline.setAttribute('data-wol-inline-channel', '1')
                          inline.href = chUrl!.href
                          inline.target = '_blank'
                          inline.title = `Open channel on ${platform.button.platformNameText}`
                          inline.style.display = 'inline-flex'
                          inline.style.alignItems = 'center'
                          inline.style.justifyContent = 'center'
                          inline.style.marginLeft = '6px'
                          inline.style.flex = '0 0 auto'
                          inline.style.alignSelf = 'center'
                          inline.style.verticalAlign = 'middle'
                          inline.style.width = '22px'
                          inline.style.height = '22px'
                          inline.style.borderRadius = '11px'
                          inline.style.background = platform.theme
                          inline.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation() } catch {}; openNewTab(chUrl!, 'user') })
                          const icon = document.createElement('img')
                          icon.src = platform.button.icon
                          icon.style.width = '14px'
                          icon.style.height = '14px'
                          icon.style.pointerEvents = 'none'
                          inline.appendChild(icon)
                          const textContainer = container.querySelector('#text-container') as HTMLElement | null
                          if (textContainer && textContainer.parentElement === container) {
                            textContainer.insertAdjacentElement('afterend', inline)
                          } else {
                            container.appendChild(inline)
                          }
                          // If still not visible inside #container, fall back to placing after the channel-name element (before badges)
                          setTimeout(() => {
                            try {
                              const r = inline.getBoundingClientRect()
                              const hidden = (r.width < 8 || r.height < 8 || getComputedStyle(inline).display === 'none')
                              if (hidden && channelNameEl && channelNameEl.parentElement) {
                                const siblingBadge = channelNameEl.parentElement.querySelector('ytd-badge-supported-renderer') as HTMLElement | null
                                if (siblingBadge) channelNameEl.parentElement.insertBefore(inline, siblingBadge)
                                else channelNameEl.insertAdjacentElement('afterend', inline)
                                if (WOL_DEBUG) dbg('WOL results inline channel fallback after channel-name', { videoId: id, channelId })
                              }
                            } catch {}
                          }, 50)
                          if (WOL_DEBUG) dbg('WOL results inline channel injected', { videoId: id, channelId, url: chUrl!.href })
                        } catch (err) { if (WOL_DEBUG) dbg('WOL results inline channel inject error', err) }
                      }
                      ensureInline()
                      try { const mo = new MutationObserver(() => ensureInline()); mo.observe(container!, { childList: true, subtree: true }) } catch {}
                    }
                    else if (WOL_DEBUG) dbg('WOL results inline channel resolve failed', { channelId })
                  }
                  else if (WOL_DEBUG) dbg('WOL results could not determine channel id from nameAnchor', { href: nameAnchor?.href })
                }
                else if (WOL_DEBUG) dbg('WOL results channel name anchor not found inside videoRenderer')
              }
            }
            // Handle Shorts in grid shelf rows: add a bottom-right Watch pill
            // Shorts grid shelf tiles: place pill inside the larger tile container (not the anchor) to avoid autoplay overlap
            const gridItem = a.closest('.ytGridShelfViewModelGridShelfItem') as HTMLElement | null
            if (settings.buttonVideoSub && gridItem && !gridItem.querySelector('[data-wol-inline-shorts-watch]')) {
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
                sbtn.style.bottom = '8px'
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
          if (!settings.buttonChannelSub) {
            // If disabled, ensure any injected channel buttons are removed
            try {
              channelRenderer.querySelectorAll('[data-wol-results-channel-btn]').forEach(el => el.remove())
              channelRenderer.removeAttribute('data-wol-channel-button')
            } catch {}
            continue
          }
          // De-dupe: only inject one channel button per renderer
          if (channelRenderer.getAttribute('data-wol-channel-button') === '1') {
            continue
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
            // Mark renderer to prevent duplicate injections
            channelRenderer.setAttribute('data-wol-channel-button', '1')
            // Keep the button present through renderer DOM churn (hover, dynamic updates)
            try {
              const ensurePresent = () => {
                // Respect current setting; do not re-insert when channel buttons are disabled
                if (!settings.buttonChannelSub) {
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
              const crMo = new MutationObserver(() => { ensurePresent() })
              crMo.observe(channelRenderer, { childList: true, subtree: true })
            } catch {}
          }

            // Mark as enhanced
            ; (a as any).dataset.wolEnhanced = 'done'
          continue
        }

        // Inline channel icon beside channel name on results page was causing extra DOM churn.
        // It has been removed to reduce CPU overhead on large result sets.
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
        host = (gridShelfItem || gridShelf || (a.closest('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-grid-media') as HTMLElement | null) || (a as unknown as HTMLElement))
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
      if (!source) { updateButtons(null); return }

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
          if (source.type === 'video') findVideoElementAwait(source).then(v => v.pause())
          logger.log('Watch on Odysee: Redirecting to:', odyseeURL.href)
          openNewTab(odyseeURL, 'auto')
          if (window.history.length === 1) window.close(); else window.history.back()
        }
      }
    } catch (error) { logger.error(error) }
  }

  // Master Loop
  for (
    let url = new URL(location.href),
    urlHrefCache: string | null = null;
    ;
    urlHrefCache = url.href,
    url = new URL(location.href)
  ) {
    // Old periodic loop disabled; rely on event-driven processing
    break

    // Exit early if extension context has been invalidated
    if (extensionContextInvalidated) {
      logger.warn('Watch on Odysee: Extension context invalidated, stopping main loop. Please reload the page.')
      break
    }

    try {
      const urlNow = new URL(location.href)

      // Clean up stale overlays when URL changes
      if (urlNow.href !== urlHrefCache) {
        // Use intelligent cleanup that preserves overlays when possible
        cleanupOverlaysByPageContext()

        // Clean up redirect tracking for old URLs when navigating
        // Keep only the current URL and clear others to prevent memory buildup
        const currentUrl = urlNow.href
        const urlsToKeep = new Set([currentUrl])

        for (const url of redirectedUrls) {
          if (!urlsToKeep.has(url)) {
            redirectedUrls.delete(url)
          }
        }
      }

      // Check if we're on a new video (different from last one)
      if (urlNow.pathname.startsWith('/shorts/')) {
        const currentShortsId = urlNow.pathname.split('/')[2]
        if (currentShortsId && currentShortsId !== lastShortsChannelId) {
          // New shorts video - clear cached channel data
          lastShortsChannelId = currentShortsId
          lastVideoPageChannelId = null
          document.documentElement.removeAttribute('data-wol-channel-id')
          // Force refresh of channel data
          settingsDirty = true
          lastResolveSig = null
          lastResolved = {}
        }
      } else if (urlNow.pathname === '/watch') {
        const currentVideoId = urlNow.searchParams.get('v')
        if (currentVideoId && currentVideoId !== lastVideoPageChannelId) {
          // New watch page video - clear cached channel data
          lastVideoPageChannelId = null
          document.documentElement.removeAttribute('data-wol-channel-id')
          // Force refresh of channel data
          settingsDirty = true
          lastResolveSig = null
          lastResolved = {}
        }
      }

      const source = await getSourceByUrl(urlNow)
      lastLoggedHref = urlNow.href
      if (!source) {
        updateButtons(null)
        continue
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
          // Try meta/LD+JSON/@handle fetch
          channelId = document.querySelector<HTMLMetaElement>('meta[itemprop="channelId"]')?.content || null
          if (!channelId) channelId = await getWatchPageChannelId()
        }

        if (!channelId) {
          // Keep your old selectors, but add @handle variants
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
                // /channel/UC... -> p[2]
                if (p[1] === 'channel' && p[2]?.startsWith('UC')) {
                  channelId = p[2]
                  break
                }
                // /@handle -> resolve via fetch
                if (p[1]?.startsWith('@')) {
                  const html = await (await fetch(ownerHref, { credentials: 'same-origin' })).text()
                  const m = html.match(/"channelId"\s*:\s*"([^"]+)"/) ||
                    html.match(/feeds\/videos\.xml\?channel_id=([A-Za-z0-9_-]+)/)
                  if (m?.[1]?.startsWith('UC')) {
                    channelId = m[1]
                    break
                  }
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
        if (!resolveLogCache.has(sig)) {
          resolveLogCache.add(sig)
          logger.log('Resolving ids:', sig)
        }
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

      // Build subscribe targets based on global toggles, not page-scoped
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
        // No buttons to render now; keep overlays, but still assess redirect below
        updateButtons(null)
        ensureOverlayEnhancementActive()
        // do not continue; allow redirect
      }

      // Update Buttons
      if (urlHrefCache !== url.href || settingsDirty) updateButtons(null)
      // If we have a player target (video), add timestamp
      if (playerTarget?.type === 'video') {
        const videoElement = document.querySelector<HTMLVideoElement>(source.platform.htmlQueries.videoPlayer)
        if (videoElement) playerTarget.time = videoElement.currentTime > 3 && videoElement.currentTime < videoElement.duration - 1 ? videoElement.currentTime : null
      }
      // Render subscribe-area buttons and player button
      updateButtons({ buttonTargets: subscribeTargets, playerTarget, source })

      // Enhance all listing/related grids with Odysee logo on thumbnails
      // Always enhance thumbnails, but exclude the main video area on watch pages
      ensureOverlayEnhancementActive()

      // Redirect
      let shouldRedirect = false
      let redirectTarget: Target | null = null
      if (settings.redirectVideo && source.type === 'video' && !source.url.searchParams.has('list')) {
        const vidTarget = resolved[source.id] ?? null
        if (vidTarget?.type === 'video') { shouldRedirect = true; redirectTarget = vidTarget }
      }
      if (!shouldRedirect && settings.redirectChannel && source.type === 'channel') {
        const channelRedirect = resolved[source.id] ?? null
        if (channelRedirect) {
          shouldRedirect = true
          redirectTarget = channelRedirect
        }
      }

      if (shouldRedirect && redirectTarget) {
        if (url.href === urlHrefCache) continue

        // Prevent multiple redirects for the same URL
        const currentUrl = url.href
        const now = Date.now()

        // Check if we've already redirected this URL recently (within 30 seconds)
        if (redirectedUrls.has(currentUrl)) {
          logger.log('Watch on Odysee: Skipping redirect - already redirected this URL:', currentUrl)
          continue
        }

        // Throttle redirects to prevent rapid-fire redirects
        if (now - lastRedirectTime < 5000) { // Wait at least 5 seconds between any redirects
          logger.log('Watch on Odysee: Throttling redirect - too soon since last redirect')
          continue
        }

        const odyseeURL = getOdyseeUrlByTarget(redirectTarget)

        // Mark this URL as redirected
        redirectedUrls.add(currentUrl)
        lastRedirectTime = now

        // Clean up old entries after 2 minutes to prevent memory buildup
        setTimeout(() => {
          redirectedUrls.delete(currentUrl)
        }, 120000)

        logger.log('Watch on Odysee: Redirecting to:', odyseeURL.href)

        if (source.type === 'video') {
          findVideoElementAwait(source).then((videoElement) => videoElement.pause())
        }

        openNewTab(odyseeURL, 'auto')
        if (window.history.length === 1)
          window.close()
        else
          window.history.back()
      }
    } catch (error) {
      logger.error(error)
    }
  }

  // Initial kick using event-driven flow
  scheduleProcessCurrentPage(0)

})()

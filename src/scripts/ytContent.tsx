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
  // Suppress auto-redirects briefly after extension (content script) boot
  const EXT_BOOT_AT = Date.now()
  const AUTO_BOOT_SUPPRESS_MS = 30000
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
        }
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
      for (const [key, change] of Object.entries(changes)) {
        if (key === 'buttonOverlay') {
          if (!change.newValue) {
            // Disable mutation observer when overlay setting is turned off
            if (wolMutationObserver) {
              wolMutationObserver.disconnect()
              wolMutationObserver = null
            }
            // Remove all existing overlays when setting is disabled
            const existingOverlays = document.querySelectorAll('[data-wol-overlay]')
            existingOverlays.forEach(overlay => overlay.remove())
            // Clear enhanced flags so they can be re-enhanced if setting is re-enabled
            const enhancedAnchors = document.querySelectorAll('a[data-wol-enhanced]')
            enhancedAnchors.forEach(anchor => anchor.removeAttribute('data-wol-enhanced'))
          }
          // Re-enable mutation observer when overlay setting is turned on
          // The observer will be recreated on the next page navigation
        }
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

  function getDomAutoSuppressUntil(): number {
    const v = document.documentElement.getAttribute('data-wol-suppress-auto-until')
    const n = v ? parseInt(v, 10) : 0
    return Number.isFinite(n) ? n : 0
  }
  function setDomAutoSuppress(msFromNow: number) {
    try { document.documentElement.setAttribute('data-wol-suppress-auto-until', String(Date.now() + msFromNow)) } catch {}
  }

  function getLocalAutoSuppressUntil(): number {
    try {
      const v = localStorage.getItem('wol-suppress-auto-until')
      const n = v ? parseInt(v, 10) : 0
      return Number.isFinite(n) ? n : 0
    } catch { return 0 }
  }
  function setLocalAutoSuppress(msFromNow: number) {
    try { localStorage.setItem('wol-suppress-auto-until', String(Date.now() + msFromNow)) } catch {}
  }

  async function getGlobalAutoSuppressUntil(): Promise<number> {
    try {
      return await new Promise<number>((resolve) => {
        chrome.storage.local.get(['wolSuppressAllAutoUntil'], (o) => {
          const n = Number(o?.wolSuppressAllAutoUntil || 0)
          resolve(Number.isFinite(n) ? n : 0)
        })
      })
    } catch { return 0 }
  }
  function setGlobalAutoSuppress(msFromNow: number) {
    try { chrome.storage.local.set({ wolSuppressAllAutoUntil: Date.now() + msFromNow }) } catch {}
  }

  async function openNewTab(url: URL, reason: 'user' | 'auto' = 'user') {
    const now = Date.now()

    if (reason === 'user') {
      // Debounce identical opens for a short window
      const last = openedOdyseeGuard.get(url.href) || 0
      if (now - last < OPEN_DEBOUNCE_MS) return
      openedOdyseeGuard.set(url.href, now)
      setTimeout(() => { openedOdyseeGuard.delete(url.href) }, Math.max(OPEN_DEBOUNCE_MS * 5, 8000))

      // Suppress any auto-redirects for the current YouTube page for a bit
      try { autoRedirectSuppressByUrl.set(location.href, now + SUPPRESS_AUTO_MS) } catch {}
      // Also set a DOM-based suppress that survives extension reload within the same page lifecycle
      setDomAutoSuppress(5 * 60 * 1000) // 5 minutes
      // And persist at origin-level to survive extension reload across tabs
      setLocalAutoSuppress(5 * 60 * 1000)
      // And persist in extension storage across contexts
      setGlobalAutoSuppress(5 * 60 * 1000)

      // Do not record here; background will mark successful opens
    } else {
      // Auto: honor user suppression window for this page
      const supMem = autoRedirectSuppressByUrl.get(location.href) || 0
      const supDom = getDomAutoSuppressUntil()
      const supLocal = getLocalAutoSuppressUntil()
      const sup = Math.max(supMem, supDom, supLocal)
      if (now < sup) return
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
  // Local resolve cache for listing pages (video/channel -> Target|null)
  const resolvedLocal = new Map<string, Target | null>()

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
          logger.log('Watch on Odysee: Detected location change from', previousHref, 'to', currentHref)
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
    if (now - lastEnhanceTime < 400 && currentUrl === lastEnhanceUrl) { // Don't run more than once every 500ms for same URL
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
    if (window.location.pathname === '/results') {
      logger.log('Watch on Odysee: Processing search results page:', window.location.href)
    }

    // Use intelligent overlay management instead of blind cleanup
    manageOverlaysIntelligently()

    // Clean up any context-inappropriate overlays before creating new ones
    cleanupOverlaysByPageContext()

    // Don't add overlays on playlist pages - they don't work well
    if (window.location.pathname.includes('/playlist') || window.location.pathname.includes('/podcasts')) {
      return
    }

    // Don't add overlays on the main Shorts player page; allow on watch pages for related content
    if ((window.location.pathname.startsWith('/shorts/') && window.location.pathname.split('/').length === 3)) {
      return
    }

    // Debug logging for Shorts pages (only log once per URL change)
    if (window.location.pathname.startsWith('/shorts') && currentUrl !== lastLoggedHref) {
      logger.log('Watch on Odysee: Processing Shorts page for overlays, URL:', window.location.href)
      logger.log('Watch on Odysee: Pathname:', window.location.pathname)

      // Check if this is a specific shorts video page or a shorts listing page
      const isSpecificShortsVideo = window.location.pathname.match(/^\/shorts\/[a-zA-Z0-9_-]+$/)
      if (isSpecificShortsVideo) {
        logger.log('Watch on Odysee: This is a specific Shorts video page, not a listing page')
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
    if (window.location.pathname.startsWith('/shorts') || window.location.pathname === '/results') {
      logger.log('Watch on Odysee: Found', allAnchors.length, 'total anchors before filtering')
      logger.log('Watch on Odysee: Selectors that found anchors:', selectors.filter((selector, i) => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector))
        return anchors.length > 0
      }))

      // For search pages, also log what channel renderers we find
      if (window.location.pathname === '/results') {
        const channelRenderers = document.querySelectorAll('ytd-channel-renderer')
        logger.log('Watch on Odysee: Found', channelRenderers.length, 'channel renderers on search page')
        const videoRenderers = document.querySelectorAll('ytd-video-renderer')
        logger.log('Watch on Odysee: Found', videoRenderers.length, 'video renderers on search page')
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

    logger.log(`Enhancing ${toProcess.length} tiles with Odysee overlays (videos and channels)`)

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

    let normalizedToProcess = await Promise.all(toProcess.map(async (x) => {
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

      // For channels, we need to find a different host element (subscribe button area)
      if (type === 'channel') {
        logger.log('Watch on Odysee: Processing channel type for', id)
        // Case A: channel search result card
        const channelRenderer = a.closest('ytd-channel-renderer') as HTMLElement | null
        // Case B: channel link inside a video result item
        const videoResult = a.closest('ytd-video-renderer') as HTMLElement | null
        logger.log('Watch on Odysee: Channel renderer found:', !!channelRenderer, 'Inside video result:', !!videoResult)
        if (channelRenderer) {
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
            logger.log('Watch on Odysee: Taking adaptive styling path')
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

        // Inject compact channel button beside channel name inside video results on search pages
        if (videoResult && !videoResult.hasAttribute('data-wol-channel-inline')) {
          try {
            const nameAnchor = (videoResult.querySelector('#channel-info #channel-name a[href], ytd-channel-name#channel-name a[href]') as HTMLAnchorElement | null)
            const nameContainer = nameAnchor?.closest('#channel-info') as HTMLElement | null
              || nameAnchor?.closest('ytd-channel-name#channel-name') as HTMLElement | null
            if (nameAnchor && (nameContainer || nameAnchor.parentElement)) {
              const container = nameContainer || (nameAnchor.parentElement as HTMLElement)
              if (!container.querySelector('[data-wol-inline-channel]')) {
                const inline = document.createElement('a')
                inline.setAttribute('data-wol-inline-channel', '1')
                inline.href = url.href
                inline.target = '_blank'
                inline.title = `Open channel on ${platform.button.platformNameText}`
                inline.style.display = 'inline-flex'
                inline.style.alignItems = 'center'
                inline.style.justifyContent = 'center'
                inline.style.marginLeft = '6px'
                inline.style.width = '22px'
                inline.style.height = '22px'
                inline.style.borderRadius = '11px'
                inline.style.background = platform.theme
                inline.style.textDecoration = 'none'
                inline.style.verticalAlign = 'middle'
                inline.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openNewTab(url, 'user') })
                const icon = document.createElement('img')
                icon.src = platform.button.icon
                icon.style.width = '14px'
                icon.style.height = '14px'
                icon.style.pointerEvents = 'none'
                inline.appendChild(icon)
                nameAnchor.insertAdjacentElement('afterend', inline)
                try {
                  const h = Math.max(18, Math.round((nameAnchor.getBoundingClientRect().height || 20)))
                  inline.style.width = `${h}px`
                  inline.style.height = `${h}px`
                  inline.style.borderRadius = `${Math.round(h/2)}px`
                } catch {}
                const mo = new MutationObserver(() => {
                  try { if (!inline.isConnected) nameAnchor.insertAdjacentElement('afterend', inline) } catch {}
                })
                mo.observe(container, { childList: true, subtree: true })
                videoResult.setAttribute('data-wol-channel-inline', '1')
              }
            }
          } catch {}
          ;(a as any).dataset.wolEnhanced = 'done'
          continue
        }
      }

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

      // Prefer stable thumbnail anchors on /results page for main results
      if (!host && location.pathname === '/results' && videoRenderer) {
        const resultsThumbAnchor = (videoRenderer.querySelector('a.yt-simple-endpoint.inline-block.style-scope.ytd-thumbnail') as HTMLElement | null)
          || (videoRenderer.querySelector('a#thumbnail.yt-simple-endpoint') as HTMLElement | null)
          || (videoRenderer.querySelector('a#thumbnail') as HTMLElement | null)
        if (resultsThumbAnchor) {
          host = resultsThumbAnchor
          if (!tileContainer) tileContainer = videoRenderer
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
      if (window.location.pathname.startsWith('/shorts') && currentUrl !== lastLoggedHref) {
        logger.log('Watch on Odysee: Selected host element for overlay:', host.tagName, host.id, host.className)
        logger.log('Watch on Odysee: Host element dimensions:', host.offsetWidth, 'x', host.offsetHeight)
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
      mount.style.padding = '2px'
      mount.style.transition = 'opacity 0.12s ease'
      mount.style.opacity = '1'
      // Prevent any stray text nodes from rendering alongside the icon
      mount.style.fontSize = '0'
      mount.style.lineHeight = '0'
      mount.style.color = 'transparent'

      // Adjust positioning based on the type of video container
      const isRelatedContext = !!(a.closest('#secondary') || a.closest('#related') || a.closest('ytd-watch-next-secondary-results-renderer') || a.closest('ytd-compact-video-renderer'))
      if (isShortsTile) {
        // For Shorts tiles, position inside the thumbnail at top-left
        mount.style.top = '6px'
        mount.style.left = '6px'
        mount.style.bottom = 'auto'
        // Make the overlay smaller and more compact for Shorts
        mount.style.transform = 'scale(0.8)'
        mount.style.transformOrigin = 'top left'
      } else {
        // On related/compact tiles, top-left avoids YouTube's time/status overlays
        if (isRelatedContext) {
          mount.style.top = '6px'
          mount.style.left = '6px'
          mount.style.bottom = 'auto'
          mount.style.transform = 'scale(0.8)'
          mount.style.transformOrigin = 'top left'
        } else {
          // Default for non-related tiles
          mount.style.bottom = '6px'
          mount.style.left = '6px'
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
        mount.style.opacity = '1'
        mount.style.zIndex = '2147483647'
        mount.style.display = 'inline-block'
        mount.style.visibility = 'visible'
        mount.style.backgroundColor = 'transparent' // Ensure background stays transparent
      }

      // Minimal hover handling: ensure overlay remains on the stable host
      host.addEventListener('mouseenter', () => {
        if (gen !== overlayGeneration) return
        try {
          // Raise stack order during hover previews
          ;(host as HTMLElement).style.zIndex = (host as HTMLElement).style.zIndex || '2147483646'
          if (mount.parentElement !== host) host.appendChild(mount)
        } catch {}
        ensureOverlayVisibility()
      })

      // Ensure empty container (avoid stray text nodes)
      mount.textContent = ''
      const logoImg = document.createElement('img')
      logoImg.alt = ''
      logoImg.src = platform.button.icon
      logoImg.style.height = '20px'
      logoImg.style.width = '20px'
      logoImg.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))'
      logoImg.style.pointerEvents = 'none'
      mount.appendChild(logoImg)

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

      // Remove any existing overlays for this video in this specific host
      const existingOverlays = host.querySelectorAll(`[data-wol-overlay="${id}"]`)
      existingOverlays.forEach(overlay => overlay.remove())

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
      const mo = new MutationObserver(() => {
        if (gen !== overlayGeneration) { try { mo.disconnect() } catch {} ; return }
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
              // Results page preferred anchor for stability during hover autoplay
              (location.pathname === '/results' ? containerRoot?.querySelector('a.yt-simple-endpoint.inline-block.style-scope.ytd-thumbnail') as HTMLElement | null : null),
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
      // Also listen on the tile container hover to re-assert presence during inline previews
      try {
        const hoverRoot = tileContainer || host
        hoverRoot.addEventListener('mouseenter', () => {
          if (gen !== overlayGeneration) return
          try {
            // On /results, retarget to preferred anchor inside ytd-video-renderer during hover previews
            if ((hoverRoot as HTMLElement).tagName === 'YTD-VIDEO-RENDERER' && location.pathname === '/results') {
              const preferred = (hoverRoot as HTMLElement).querySelector('a.yt-simple-endpoint.inline-block.style-scope.ytd-thumbnail, a#thumbnail.yt-simple-endpoint, ytd-thumbnail #thumbnail, #thumbnail') as HTMLElement | null
              if (preferred) host = preferred
              if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
            }
            if (!host.contains(mount)) host.appendChild(mount)
          } catch {}
          ensureOverlayVisibility()
        })
      } catch {}

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

      if (subscribeTargets.length === 0 && !playerTarget) { updateButtons(null); ensureOverlayEnhancementActive(); return }

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
      if (settings.redirectVideo && source.type === 'video' && !source.url.searchParams.has('list') && playerTarget) { shouldRedirect = true; redirectTarget = playerTarget }
      if (!shouldRedirect && settings.redirectChannel && source.type === 'channel') {
        const channelRedirect = resolved[source.id] ?? null
        if (channelRedirect) { shouldRedirect = true; redirectTarget = channelRedirect }
      }
      if (shouldRedirect && redirectTarget) {
        // Global boot-time suppression to avoid burst opens after extension reload
        if (Date.now() - EXT_BOOT_AT < AUTO_BOOT_SUPPRESS_MS) return
        // Check DOM-based suppression that persists across extension reloads
        const supDom = getDomAutoSuppressUntil()
        if (Date.now() < supDom) return
        // Also honor page localStorage suppression (persists across extension reloads per-origin)
        const supLocal = getLocalAutoSuppressUntil()
        if (Date.now() < supLocal) return
        // Check extension storage-based suppression across contexts
        try { const supGlobal = await getGlobalAutoSuppressUntil(); if (Date.now() < supGlobal) return } catch {}
        const now = Date.now()
        if (!redirectedUrls.has(currentUrl) && (now - lastRedirectTime >= 5000)) {
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
        // Even if there is no player/subscribe target (e.g., current video not resolvable),
        // we still want overlays on related/listing items.
        updateButtons(null)
        ensureOverlayEnhancementActive()
        continue
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
      if (settings.redirectVideo && source.type === 'video' && !source.url.searchParams.has('list') && playerTarget) {
        shouldRedirect = true
        redirectTarget = playerTarget
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

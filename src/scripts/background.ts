import { resolveById, resolveByIdForce } from "../modules/yt/urlResolve"
import { logger } from "../modules/logger"

const onGoingOdyseePathnameRequest: Record<string, ReturnType<typeof resolveById>> = {}
const onGoingOdyseePathnameRequestForce: Record<string, ReturnType<typeof resolveByIdForce>> = {}
const openTabGuard = new Map<string, number>() // href -> lastOpenTs
// Track worker start time to distinguish pre-reload vs post-reload messages
const workerStartAt = Date.now()
try { chrome.storage.local.set({ wolLastWorkerStartAt: workerStartAt }) } catch {}

chrome.runtime.onMessage.addListener(({ method, data }, _sender, sendResponse) => {
  function resolve(result: Awaited<ReturnType<typeof resolveById>>) {
    sendResponse(JSON.stringify(result))
  }
  (async () => {

    switch (method) {
      case 'openTab':
        {
          const { href, reason, clickedAt }: { href: string, reason?: 'user' | 'auto', clickedAt?: number } = JSON.parse(data)
          try {
            // Fetch recent direct-opens and last worker start time
            const recentDirectOpens: Record<string, number> = await new Promise((resolve) => {
              try {
                chrome.storage.local.get(['wolRecentDirectOpens'], (o) => resolve((o?.wolRecentDirectOpens as any) || {}))
              } catch { resolve({}) }
            })
            const lastWorkerStartAt: number = await new Promise((resolve) => {
              try {
                chrome.storage.local.get(['wolLastWorkerStartAt'], (o) => resolve(Number(o?.wolLastWorkerStartAt || workerStartAt)))
              } catch { resolve(workerStartAt) }
            })

            const recentTs = Number(recentDirectOpens[href] || 0)
            const now = Date.now()
            const isLikelyReplay = (
              (typeof clickedAt === 'number' && clickedAt > 0 && clickedAt < lastWorkerStartAt && recentTs && recentTs >= clickedAt)
              || (!clickedAt && recentTs && recentTs < lastWorkerStartAt && (now - recentTs) < 5 * 60 * 1000)
            )
            if (isLikelyReplay) {
              // Clean up the record and skip opening to avoid replay duplicates after reload
              try {
                delete recentDirectOpens[href]
                chrome.storage.local.set({ wolRecentDirectOpens: recentDirectOpens })
              } catch {}
              break
            }

            const last = openTabGuard.get(href) || 0
            if (now - last < 1200) break // debounce duplicate open requests
            openTabGuard.set(href, now)
            setTimeout(() => openTabGuard.delete(href), 10000)
            chrome.tabs.create({ url: href })
            // Record successful open to suppress post-reload replays
            try {
              chrome.storage.local.get(['wolRecentDirectOpens'], (o) => {
                const map = (o?.wolRecentDirectOpens as any) || {}
                map[href] = now
                const cutoff = now - 2 * 60 * 60 * 1000
                for (const k of Object.keys(map)) { if (map[k] < cutoff) delete map[k] }
                chrome.storage.local.set({ wolRecentDirectOpens: map })
              })
            } catch {}
          } catch (e) {
            logger.warn('openTab error', e)
            chrome.tabs.create({ url: href })
          }
        }
        break
      case 'resolveUrl':
        try {
          const params: Parameters<typeof resolveById> = JSON.parse(data)
          // Don't create a new Promise for same ID until on going one is over.
          const promise = onGoingOdyseePathnameRequest[data] ?? (onGoingOdyseePathnameRequest[data] = resolveById(...params))
          resolve(await promise)
        } catch (error) {
          sendResponse(`error: ${(error as any).toString()}`)
          logger.error(error)
        }
        finally {
          delete onGoingOdyseePathnameRequest[data]
        }
        break
      case 'resolveUrlForce':
        try {
          const params: Parameters<typeof resolveByIdForce> = JSON.parse(data)
          const key = `force:${data}`
          const promise = onGoingOdyseePathnameRequestForce[key] ?? (onGoingOdyseePathnameRequestForce[key] = resolveByIdForce(...params))
          resolve(await promise)
        } catch (error) {
          sendResponse(`error: ${(error as any).toString()}`)
          logger.error(error)
        } finally {
          delete onGoingOdyseePathnameRequestForce[`force:${data}`]
        }
        break
    }
  })()

  return true
})

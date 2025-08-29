/**
 * Observer lifecycle management
 * Ensures observers are properly created, tracked, and cleaned up
 */

import { logger } from '../logger'

export interface ObserverCallbacks {
  onDomMutation?: () => void
  onUrlChange?: (newUrl: string, oldUrl: string) => void
}

export class ObserverManager {
  private globalObserver: MutationObserver | null = null
  private tileObservers = new WeakMap<Element, MutationObserver>()
  private urlPollInterval: number | null = null
  private lastUrl: string = ''
  private generation: number = 0

  constructor(private callbacks: ObserverCallbacks = {}) {}

  start(generation: number): void {
    this.stop()
    this.generation = generation
    this.startGlobalObserver()
    this.startUrlMonitoring()
  }

  stop(): void {
    this.stopGlobalObserver()
    this.stopUrlMonitoring()
  }

  private startGlobalObserver(): void {
    if (this.globalObserver) return

    try {
      this.globalObserver = new MutationObserver((mutations) => {
        // Ignore if generation has changed (stale observer)
        if (this.generation !== this.getCurrentGeneration()) {
          this.stop()
          return
        }

        // Check if mutations include video tile additions
        const hasRelevantChanges = mutations.some(m => {
          return Array.from(m.addedNodes).some(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return false
            const el = node as Element
            return el.matches('ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer') ||
                   el.querySelector('ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer')
          })
        })

        if (hasRelevantChanges && this.callbacks.onDomMutation) {
          this.callbacks.onDomMutation()
        }
      })

      this.globalObserver.observe(document.body, {
        childList: true,
        subtree: true
      })
    } catch (e) {
      logger.error('Failed to start global observer:', e)
    }
  }

  private stopGlobalObserver(): void {
    if (this.globalObserver) {
      try {
        this.globalObserver.disconnect()
      } catch {}
      this.globalObserver = null
    }
  }

  private startUrlMonitoring(): void {
    if (this.urlPollInterval) return

    this.lastUrl = location.href
    this.urlPollInterval = window.setInterval(() => {
      const currentUrl = location.href
      if (currentUrl !== this.lastUrl) {
        const oldUrl = this.lastUrl
        this.lastUrl = currentUrl

        if (this.callbacks.onUrlChange) {
          this.callbacks.onUrlChange(currentUrl, oldUrl)
        }
      }
    }, 1000)
  }

  private stopUrlMonitoring(): void {
    if (this.urlPollInterval) {
      try {
        clearInterval(this.urlPollInterval)
      } catch {}
      this.urlPollInterval = null
    }
  }

  // Per-tile observers for overlay persistence
  observeTile(tile: Element, callback: () => void): void {
    if (this.tileObservers.has(tile)) return

    const observer = new MutationObserver(() => {
      // Check if tile still exists
      if (!tile.isConnected) {
        observer.disconnect()
        return
      }
      callback()
    })

    observer.observe(tile, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    })

    this.tileObservers.set(tile, observer)
  }

  disconnectTileObserver(tile: Element): void {
    const observer = this.tileObservers.get(tile)
    if (observer) {
      try {
        observer.disconnect()
      } catch {}
      this.tileObservers.delete(tile)
    }
  }

  // Helper to get current generation (can be overridden)
  private getCurrentGeneration(): number {
    return this.generation
  }

  setCallbacks(callbacks: ObserverCallbacks): void {
    this.callbacks = callbacks
  }
}

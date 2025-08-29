/**
 * Centralized cleanup coordination
 * Ensures cleanup operations complete atomically
 */

import { OverlayState } from './state'
import { ObserverManager } from './observers'
import { logger } from '../logger'

export class CleanupManager {
  constructor(
    private overlayState: OverlayState,
    private observerManager: ObserverManager
  ) {}

  /**
   * Complete cleanup - stops everything and resets all state
   * This is synchronous and atomic
   */
  async cleanup(): Promise<void> {
    try {
      // 1. Stop all observers first (prevents new work from starting)
      this.observerManager.stop()

      // 2. Remove all DOM elements
      await this.removeAllOverlayElements()

      // 3. Clear state
      this.overlayState.reset()

      // 4. Clean up stray elements not tracked in state
      await this.cleanupStrayElements()

    } catch (e) {
      logger.error('Cleanup failed:', e)
    }
  }

  /**
   * Soft cleanup - removes overlays but keeps observers active
   */
  async softCleanup(): Promise<void> {
    try {
      await this.removeAllOverlayElements()
      this.overlayState.clearAllOverlays()
    } catch (e) {
      logger.error('Soft cleanup failed:', e)
    }
  }

  /**
   * Prune old overlays by age
   */
  pruneOldOverlays(maxAgeMs: number): number {
    return this.overlayState.pruneOldOverlays(maxAgeMs)
  }

  /**
   * Clean up overlays that don't match current page context
   */
  async cleanupByPageContext(currentPath: string): Promise<void> {
    // Remove all overlays on results page (uses inline pills instead)
    if (currentPath === '/results') {
      await this.removeAllOverlayElements()
      this.overlayState.clearAllOverlays()
    }
  }

  /**
   * Remove stale overlays whose anchor elements are gone
   */
  cleanupStaleOverlays(): void {
    const allOverlays = this.overlayState.getAllOverlays()

    for (const [id, data] of allOverlays.entries()) {
      // Check if anchor element still exists in DOM
      if (!data.anchorElement.isConnected) {
        this.overlayState.removeOverlay(id)
      }
    }
  }

  private async removeAllOverlayElements(): Promise<void> {
    // Remove from state
    for (const [id] of this.overlayState.getAllOverlays()) {
      this.overlayState.removeOverlay(id)
    }

    // Remove any stray overlay elements not in state
    const overlays = Array.from(document.querySelectorAll('[data-wol-overlay]'))
    for (let i = 0; i < overlays.length; i++) {
      try {
        overlays[i].remove()
      } catch {}

      // Yield every 20 elements to prevent blocking
      if ((i + 1) % 20 === 0) {
        await this.idleYield()
      }
    }
  }

  private async cleanupStrayElements(): Promise<void> {
    const selectors = [
      'a[data-wol-inline-watch]',
      'a[data-wol-inline-shorts-watch]',
      'a[data-wol-inline-channel]',
      '[data-wol-results-channel-btn]',
      '[data-wol-overlay]'
    ]

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector))
      for (let i = 0; i < elements.length; i++) {
        try {
          elements[i].remove()
        } catch {}

        if ((i + 1) % 20 === 0) {
          await this.idleYield()
        }
      }
    }

    // Clear data attributes
    document.querySelectorAll('[data-wol-enhanced]').forEach(el => {
      try {
        el.removeAttribute('data-wol-enhanced')
      } catch {}
    })
  }

  private idleYield(): Promise<void> {
    return new Promise(resolve => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => resolve(), { timeout: 50 })
      } else {
        setTimeout(() => resolve(), 16)
      }
    })
  }
}

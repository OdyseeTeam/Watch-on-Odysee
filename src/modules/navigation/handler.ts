/**
 * Navigation handler - orchestrates cleanup and re-enhancement on page changes
 * This is the key to fixing the disappearing overlay bug
 */

import { OverlayState } from '../overlay/state'
import { ObserverManager } from '../overlay/observers'
import { CleanupManager } from '../overlay/cleanup'
import { TaskQueue } from '../overlay/taskQueue'
import { logger } from '../logger'

export interface NavigationCallbacks {
  onNavigationComplete?: (url: string) => void | Promise<void>
  onBeforeCleanup?: () => void | Promise<void>
  onAfterCleanup?: () => void | Promise<void>
}

export class NavigationHandler {
  private lastUrl: string = ''
  private isNavigating = false

  constructor(
    private overlayState: OverlayState,
    private observerManager: ObserverManager,
    private cleanupManager: CleanupManager,
    private taskQueue: TaskQueue,
    private callbacks: NavigationCallbacks = {}
  ) {
    this.lastUrl = location.href
    this.setupNavigationListeners()
  }

  private setupNavigationListeners(): void {
    // YouTube SPA navigation events
    document.addEventListener('yt-navigate-finish', () => {
      this.handleNavigation('yt-navigate-finish').catch(e =>
        logger.error('Navigation handler error:', e)
      )
    })

    document.addEventListener('yt-page-data-updated', () => {
      this.handleNavigation('yt-page-data-updated').catch(e =>
        logger.error('Navigation handler error:', e)
      )
    })

    // Fallback URL monitoring (handled by ObserverManager)
    this.observerManager.setCallbacks({
      onUrlChange: (newUrl, oldUrl) => {
        this.handleNavigation('url-change').catch(e =>
          logger.error('URL change handler error:', e)
        )
      }
    })
  }

  private async handleNavigation(source: string): Promise<void> {
    const currentUrl = location.href

    // Prevent concurrent navigation handling
    if (this.isNavigating) {
      logger.log(`Skipping ${source} navigation - already handling`)
      return
    }

    // Check if URL actually changed
    if (currentUrl === this.lastUrl) {
      return
    }

    logger.log(`Navigation detected (${source}):`, this.lastUrl, '→', currentUrl)
    this.isNavigating = true
    this.lastUrl = currentUrl

    try {
      // CRITICAL: Complete cleanup before proceeding
      await this.performAtomicCleanup()

      // Bump generation after cleanup
      const newGeneration = this.overlayState.bumpGeneration()
      logger.log('Bumped generation to', newGeneration)

      // Restart observers with new generation
      this.observerManager.start(newGeneration)

      // Notify callback
      if (this.callbacks.onNavigationComplete) {
        await this.callbacks.onNavigationComplete(currentUrl)
      }

    } finally {
      this.isNavigating = false
    }
  }

  /**
   * Atomic cleanup sequence - completes fully before returning
   * This is the KEY to fixing the overlay disappearance bug
   */
  private async performAtomicCleanup(): Promise<void> {
    logger.log('Starting atomic cleanup...')

    // 1. Before cleanup callback
    if (this.callbacks.onBeforeCleanup) {
      await this.callbacks.onBeforeCleanup()
    }

    // 2. Clear ALL pending tasks (prevents stale work)
    this.taskQueue.clear()
    logger.log('Cleared task queue')

    // 3. Stop observers (prevents new work from starting)
    this.observerManager.stop()
    logger.log('Stopped observers')

    // 4. Perform cleanup (removes DOM and state)
    await this.cleanupManager.cleanup()
    logger.log('Cleanup complete')

    // 5. After cleanup callback
    if (this.callbacks.onAfterCleanup) {
      await this.callbacks.onAfterCleanup()
    }

    logger.log('Atomic cleanup finished')
  }

  /**
   * Manually trigger navigation handling (for testing or forced refresh)
   */
  async forceNavigation(): Promise<void> {
    this.lastUrl = '' // Force URL change detection
    await this.handleNavigation('manual')
  }

  /**
   * Get current navigation state
   */
  isCurrentlyNavigating(): boolean {
    return this.isNavigating
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks: NavigationCallbacks): void {
    this.callbacks = callbacks
  }
}

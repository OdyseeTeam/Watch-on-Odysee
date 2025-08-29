/**
 * Centralized state management for overlay system
 * Prevents race conditions by providing atomic operations
 */

export interface OverlayData {
  element: HTMLElement
  videoId: string
  generation: number
  anchorElement: HTMLElement
  createdAt: number
}

export interface OverlayPreference {
  anchor: 'top-left' | 'bottom-left'
  x: number
  y: number
}

export class OverlayState {
  private overlays = new Map<string, OverlayData>()
  private generation = 0
  private anchorPrefs = new Map<string, OverlayPreference>()
  private resolvedCache = new Map<string, any>()

  getCurrentGeneration(): number {
    return this.generation
  }

  bumpGeneration(): number {
    this.generation++
    this.cleanupOldGeneration()
    return this.generation
  }

  private cleanupOldGeneration(): void {
    const currentGen = this.generation
    const toRemove: string[] = []

    for (const [id, data] of this.overlays.entries()) {
      if (data.generation < currentGen - 1) {
        try {
          data.element.remove()
        } catch {}
        toRemove.push(id)
      }
    }

    toRemove.forEach(id => this.overlays.delete(id))
  }

  setOverlay(videoId: string, data: OverlayData): void {
    this.overlays.set(videoId, data)
  }

  getOverlay(videoId: string): OverlayData | undefined {
    return this.overlays.get(videoId)
  }

  hasOverlay(videoId: string): boolean {
    return this.overlays.has(videoId)
  }

  removeOverlay(videoId: string): boolean {
    const data = this.overlays.get(videoId)
    if (data) {
      try {
        data.element.remove()
      } catch {}
      this.overlays.delete(videoId)
      return true
    }
    return false
  }

  getAllOverlays(): Map<string, OverlayData> {
    return new Map(this.overlays)
  }

  clearAllOverlays(): void {
    for (const data of this.overlays.values()) {
      try {
        data.element.remove()
      } catch {}
    }
    this.overlays.clear()
  }

  // Anchor preferences
  setAnchorPref(videoId: string, pref: OverlayPreference): void {
    this.anchorPrefs.set(videoId, pref)
  }

  getAnchorPref(videoId: string): OverlayPreference | undefined {
    return this.anchorPrefs.get(videoId)
  }

  clearAnchorPrefs(): void {
    this.anchorPrefs.clear()
  }

  // Resolution cache
  setResolved(id: string, target: any): void {
    this.resolvedCache.set(id, target)
  }

  getResolved(id: string): any {
    return this.resolvedCache.get(id)
  }

  clearResolved(): void {
    this.resolvedCache.clear()
  }

  // Complete reset
  reset(): void {
    this.clearAllOverlays()
    this.clearAnchorPrefs()
    this.clearResolved()
  }

  // Prune old overlays by age
  pruneOldOverlays(maxAgeMs: number): number {
    const now = Date.now()
    let pruned = 0

    for (const [id, data] of this.overlays.entries()) {
      if (now - data.createdAt > maxAgeMs) {
        this.removeOverlay(id)
        pruned++
      }
    }

    return pruned
  }

  // Get overlay count
  getOverlayCount(): number {
    return this.overlays.size
  }
}

/**
 * Task queue for coordinating async operations
 * Prevents race conditions by ensuring operations complete in order
 */

import { logger } from '../logger'

export type TaskFunction = () => void | Promise<void>

export interface Task {
  name: string
  fn: TaskFunction
  priority: number
  scheduledAt: number
}

export class TaskQueue {
  private queue: Task[] = []
  private running = false
  private currentTask: string | null = null
  private taskTimers = new Map<string, number>()
  private lastTaskRun = new Map<string, number>()

  /**
   * Schedule a task with debouncing
   * If a task with the same name already exists, it will be replaced
   */
  schedule(name: string, fn: TaskFunction, delay: number = 0, priority: number = 0): void {
    // Clear existing timer for this task
    const existingTimer = this.taskTimers.get(name)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Schedule new task
    const timer = window.setTimeout(() => {
      this.taskTimers.delete(name)

      // Remove any existing task with same name
      this.queue = this.queue.filter(t => t.name !== name)

      // Add new task
      this.queue.push({
        name,
        fn,
        priority,
        scheduledAt: Date.now()
      })

      // Sort by priority (higher = first)
      this.queue.sort((a, b) => b.priority - a.priority)

      // Start processing if not already running
      if (!this.running) {
        this.processQueue().catch(e => logger.error('Task queue error:', e))
      }
    }, delay)

    this.taskTimers.set(name, timer)
  }

  /**
   * Schedule a task immediately with throttling
   * Will not run if the task ran recently (within minInterval)
   */
  scheduleThrottled(name: string, fn: TaskFunction, minInterval: number, priority: number = 0): void {
    const now = Date.now()
    const lastRun = this.lastTaskRun.get(name) || 0
    const timeSinceLastRun = now - lastRun

    if (timeSinceLastRun < minInterval) {
      // Schedule after remaining time
      const delay = minInterval - timeSinceLastRun
      this.schedule(name, fn, delay, priority)
    } else {
      // Run immediately
      this.schedule(name, fn, 0, priority)
    }
  }

  /**
   * Clear all pending tasks
   */
  clear(): void {
    // Clear all timers
    for (const timer of this.taskTimers.values()) {
      clearTimeout(timer)
    }
    this.taskTimers.clear()

    // Clear queue
    this.queue = []
  }

  /**
   * Clear a specific task by name
   */
  clearTask(name: string): void {
    const timer = this.taskTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.taskTimers.delete(name)
    }

    this.queue = this.queue.filter(t => t.name !== name)
  }

  /**
   * Wait for all pending tasks to complete
   */
  async waitForIdle(): Promise<void> {
    // Wait for all timers to fire
    while (this.taskTimers.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    // Wait for queue to empty
    while (this.queue.length > 0 || this.running) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  /**
   * Get current task name (for debugging)
   */
  getCurrentTask(): string | null {
    return this.currentTask
  }

  /**
   * Get pending task count
   */
  getPendingCount(): number {
    return this.queue.length + this.taskTimers.size
  }

  private async processQueue(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!
        this.currentTask = task.name

        try {
          const result = task.fn()
          if (result instanceof Promise) {
            await result
          }

          // Record task completion time
          this.lastTaskRun.set(task.name, Date.now())
        } catch (e) {
          logger.error(`Task ${task.name} failed:`, e)
        }
      }
    } finally {
      this.currentTask = null
      this.running = false
    }
  }
}

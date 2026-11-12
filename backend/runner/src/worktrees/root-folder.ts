import { mkdirSync } from "node:fs"

import { worktreesRoot } from "./root.js"

/**
 * The folder agents' worktrees live in (`worktreesRoot()`), which the harness shims pass to
 * an agent as `--add-dir` only if it exists when the agent launches. So it is made while
 * the setting is on, at the runner's start and the moment the setting flips on, and the
 * time this runner first saw it there is kept: an agent that launched earlier can't write
 * in worktrees until its process restarts, and is told so (`worktreesDue`).
 */
export class RootFolder {
  #since: number | null = null

  constructor(
    private readonly host: {
      readonly enabled: () => boolean
      readonly path?: string
      readonly now?: () => number
      readonly make?: (path: string) => void
    },
  ) {}

  /** Makes the folder while the setting is on; a failure leaves it for the next call. */
  ensure(): void {
    if (this.#since !== null || !this.host.enabled()) return
    const path = this.host.path ?? worktreesRoot()
    try {
      ;(this.host.make ?? ((made) => void mkdirSync(made, { recursive: true })))(path)
      this.#since = (this.host.now ?? Date.now)()
    } catch {
      // Agents are then told they can't write there yet; the next turn tries again.
    }
  }

  /** When this runner first saw the folder there, in milliseconds; null before, or while it is off. */
  since(): number | null {
    this.ensure()
    return this.#since
  }
}

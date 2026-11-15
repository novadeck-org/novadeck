import { existsSync, mkdirSync } from "node:fs"

import { worktreesRoot } from "./root.js"

/**
 * The folder agents' worktrees live in (`worktreesRoot()`), and whether an agent process
 * can use them. The harness shims pass the folder as `--add-dir` only if it exists when
 * the agent launches, and Novadeck's MCP server lists the worktree tools only while the
 * setting is on, a list Claude Code and Codex keep for the whole process (Antigravity
 * lists again at each turn). So a process can use worktrees when it started after both the
 * folder was there and, unless its harness lists tools again, the setting last went on.
 * Agent processes don't outlive a runner, so what was there at its start counts from the
 * beginning of time (0).
 *
 * The folder is made while the setting is on: at the runner's start and each time the
 * settings are saved.
 */
export class RootFolder {
  /** When the folder came to be there, in milliseconds; null while it is not. */
  #folder: number | null
  /** When the setting last went on; null while it is off. */
  #on: number | null

  constructor(
    private readonly host: {
      readonly enabled: () => boolean
      readonly path?: string
      readonly now?: () => number
      readonly exists?: (path: string) => boolean
      readonly make?: (path: string) => void
    },
  ) {
    this.#folder = (host.exists ?? existsSync)(this.path) ? 0 : null
    this.#on = host.enabled() ? 0 : null
  }

  private get path(): string {
    return this.host.path ?? worktreesRoot()
  }

  /** Follows the setting, and makes the folder while it is on; a failure is tried again at the next call. */
  ensure(): void {
    const now = (this.host.now ?? Date.now)()
    if (!this.host.enabled()) {
      this.#on = null
      return
    }
    this.#on ??= now
    if (this.#folder !== null) return
    try {
      ;(this.host.make ?? ((made) => void mkdirSync(made, { recursive: true })))(this.path)
      this.#folder = now
    } catch {
      // Agents are then told they can't write there yet.
    }
  }

  /**
   * Whether an agent process that started at `startedAt` (undefined where unknown, which is
   * not ready) can use worktrees; `relists` for a harness that lists tools at each turn.
   */
  ready(startedAt: number | undefined, relists: boolean): boolean {
    this.ensure()
    if (startedAt === undefined || this.#folder === null || startedAt < this.#folder) return false
    return relists || (this.#on !== null && startedAt >= this.#on)
  }
}

import type { TerminalPlace } from "../companions/items.js"
import type { ShowAnswer, ShowRequest } from "../companions/request.js"
import { logs } from "../log.js"
import type { Made } from "./worktrees.js"

const log = logs.for("worktrees")

const unshown = (reason: unknown): void =>
  log.warn("worktrees.changes-unshown", "Novadeck could not show a new worktree's changes", {
    err: reason,
  })

/** What showing new worktrees' changes needs of the runner. */
export type ChangesShownHost = {
  /** Calls the listener each time a worktree starts being tracked; returns what stops it. */
  readonly onMade: (listener: (made: Made) => void) => () => void
  /** Whether the person has agent worktrees on (Preferences, Experimental). */
  readonly enabled: () => boolean
  /** The terminal that owns the tracked worktree at `root`, if one does. */
  readonly owner: (root: string) => string | null | undefined
  readonly place: (terminalId: string) => TerminalPlace | undefined
  readonly show: (place: TerminalPlace, request: ShowRequest) => Promise<ShowAnswer>
}

/**
 * Shows each worktree an agent opens or adopts as its changes on the owner's bar, marked new and
 * not opened, so its work can be followed from the start. Each worktree is its own item (its own
 * repository top), so several stack under one icon. Only while agent worktrees are on. Returns
 * what stops it.
 */
export const showWorktreeChanges = (host: ChangesShownHost): (() => void) =>
  host.onMade(({ root }) => {
    if (!host.enabled()) return
    const owner = host.owner(root)
    const place = owner ? host.place(owner) : undefined
    if (!place) return
    void host
      .show(place, { changes: { path: root } })
      .then((shown) => {
        if (!shown.ok) unshown(shown.reason)
      })
      .catch(unshown)
  })

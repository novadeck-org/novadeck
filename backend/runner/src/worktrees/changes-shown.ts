import type { TerminalPlace } from "../companions/items.js"
import type { ShowAnswer } from "../companions/request.js"
import { logs } from "../log.js"
import type { Made, WorktreeChange } from "./worktrees.js"

const log = logs.for("worktrees")

const unshown = (reason: unknown): void =>
  log.warn("worktrees.changes-unshown", "Novadeck could not show a worktree's changes", {
    err: reason,
  })

/** What keeping worktrees' changes on their owners' bars needs of the runner. */
export type ChangesShownHost = {
  /** Calls the listener each time a worktree starts being tracked; returns what stops it. */
  readonly onMade: (listener: (made: Made) => void) => () => void
  /** Calls the listener each time one changes hands or stops being tracked; returns what stops it. */
  readonly onChanged: (listener: (change: WorktreeChange) => void) => () => void
  /** Whether agent worktrees are on for the terminal (the person's setting, or the tour's own). */
  readonly enabled: (terminalId: string) => boolean
  /** The terminal that owns the tracked worktree at `root`, if one does. */
  readonly owner: (root: string) => string | null | undefined
  readonly place: (terminalId: string) => TerminalPlace | undefined
  /** Shows the worktree's changes on the terminal's bar, unopened, unless its agent did already. */
  readonly show: (place: TerminalPlace, root: string) => Promise<ShowAnswer | undefined>
  /** Closes what the terminal's bar holds of the worktree's changes as its own agent's show. */
  readonly closeOn: (terminalId: string, root: string) => void
  /** Closes every item of the worktree's changes, wherever it is held. */
  readonly closeAll: (root: string) => void
}

/**
 * Keeps each tracked worktree's changes on its owner's bar while agent worktrees are on: shown
 * there, marked new and not opened, as soon as an agent opens or adopts it, so its work can be
 * followed from the start; moved to the new owner's bar when it changes hands; and closed
 * everywhere once it is gone. Each worktree is its own item (its own repository top), so an
 * agent in several has several, which stack under one icon. Returns what stops it.
 */
export const keepWorktreeChanges = (host: ChangesShownHost): (() => void) => {
  const showOn = (terminalId: string | null | undefined, root: string): void => {
    if (!terminalId || !host.enabled(terminalId)) return
    const place = host.place(terminalId)
    if (!place) return
    void host
      .show(place, root)
      .then((shown) => {
        if (shown && !shown.ok) unshown(shown.reason)
      })
      .catch(unshown)
  }
  const stopMade = host.onMade(({ root }) => showOn(host.owner(root), root))
  const stopChanged = host.onChanged((change) => {
    if (change.type === "removed") return host.closeAll(change.root)
    if (change.from !== null) host.closeOn(change.from, change.root)
    showOn(change.to, change.root)
  })
  return () => {
    stopMade()
    stopChanged()
  }
}

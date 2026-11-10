import type { History } from "@novadeck/core/history"
import type { Backend } from "@novadeck/core/port"
import { isWindow } from "@novadeck/core/roster"
import type { Store } from "@novadeck/core/store"
import type { Tile, Workspace } from "@novadeck/core/types"

import { historyShown } from "./routing"
import type { UiStore } from "./ui-store"

// How far before this run began a row may say it closed and still count as landing now: the
// runner's clock and the page's may differ a little.
export const dropSlackMs = 5_000

// Counts each time a terminal of the open project lands in History in `ui`'s `historyDrops`,
// with the one that landed last in `lastDrop`, so the History toggle's dot flares and names it.
// A row lands when History reports an id it didn't hold a moment before, closed since this run
// began: the rows read at startup, on a reconnection or when another project opens have
// closed earlier, or were held already. Rows that land together, as a lead closed with its
// team, flare once, named by the newest. Returns the stop.
export const watchHistoryDrops = (
  history: Pick<History, "state">,
  workspace: Store<Workspace>,
  ui: UiStore,
  now: () => number = Date.now,
): (() => void) => {
  const startedAt = now()
  let held = new Set(history.state.getSnapshot().rows.map((row) => row.id))
  return history.state.subscribe(() => {
    const { rows } = history.state.getSnapshot()
    const { activeProjectId } = workspace.getSnapshot()
    // Newest first, as History keeps them.
    const landed = rows.find(
      (row) =>
        !held.has(row.id) &&
        row.projectId === activeProjectId &&
        row.closedAt >= startedAt - dropSlackMs,
    )
    held = new Set(rows.map((row) => row.id))
    if (!landed) return
    ui.update((state) => ({
      ...state,
      historyDrops: state.historyDrops + 1,
      lastDrop: { title: landed.title, closedBy: landed.closedBy },
    }))
  })
}

// What closing a tile's terminal does, for its × tooltip: one that History keeps says it stays
// there. A companion item's window isn't kept.
export const closeTip = (backend: Pick<Backend, "history">, tile: Tile): string =>
  historyShown(backend) && !isWindow(tile) ? "Close · stays in History" : "Close"

// The words for a landed terminal: who closed it, for the History toggle's tooltip.
export const dropWords = ({
  title,
  closedBy,
}: {
  title: string
  closedBy: string | null
}): string => (closedBy ? `@${closedBy} closed ${title} just now` : `${title} closed just now`)

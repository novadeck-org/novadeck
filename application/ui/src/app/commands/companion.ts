import { sameItem, windowOf, type MovableItem, type Placement } from "../../model/companion-items"
import { addCompactGridTerminal } from "../../model/layout/grid-placement"
import {
  droppedCanvasGeometry,
  dropOnGrid,
  moveOnCanvas,
  type WindowPlace,
} from "../../model/layout/window-place"
import type { WorkspaceAction } from "../../model/state"
import type { TerminalMetadata } from "../../model/types"
import {
  arrivedAgain,
  close,
  hideShowing,
  itemKey,
  movableOf,
  openTab,
  placedKey,
  show,
  type Pane,
} from "../../terminals/companion/pane"
import { titleOf } from "../../terminals/companion/plan-text"
import { currentContext, currentState, currentTarget } from "../selectors"
import type { CommandContext } from "./context"

// What the person does with a terminal's companion items beyond its own pane: undocking
// one into a window of its own and docking it back, placing one on another terminal's
// taskbar and sending it back, and closing one wherever it shows. Terminals are named by
// id in the current session.
export type CompanionCommands = {
  // Undocks terminal `from`'s item into a window of its own beside it, where it was
  // dropped when `place` says, or brings the window it's in forward, moving it there.
  readonly undock: (from: string, item: MovableItem, place?: WindowPlace) => void
  // Closes an undocked window and opens its item in its terminal's pane, selecting it.
  readonly dock: (windowId: string) => void
  // Shows each terminal `from`'s item on terminal `to`'s taskbar, last; on `from`'s, it
  // goes home. One drop of a stack places all of it at once.
  readonly place: (placements: readonly Placement[]) => void
  // Closes an item, by its key in terminal `from`'s pane, from whichever taskbar shows
  // it; it goes home, closed.
  readonly closeItem: (from: string, key: string) => void
}

export type CompanionDependencies = {
  readonly select: (id: string) => void
  readonly setSelected: (id: string) => void
  readonly close: (id: string) => void
  readonly markCreated: (created: { readonly context: string; readonly id: string }) => void
  readonly pulse: () => void
}

// What its window is called: a plan by its title, something shown by its name.
const describe = (
  pane: Pane,
  item: MovableItem,
): Pick<TerminalMetadata, "name" | "companion"> | undefined => {
  if (item.kind === "plan") {
    const plan = pane.plans.find((each) => each.ref === item.ref)
    return (
      plan && {
        name: titleOf(plan.path, plan.text),
        companion: { from: pane.key.terminalId, item },
      }
    )
  }
  const shown = pane.artifacts.find((each) => each.id === item.id)
  if (!shown) return undefined
  const { fresh: _fresh, at: _at, ...artifact } = shown
  return { name: shown.name, companion: { from: pane.key.terminalId, item, artifact } }
}

export const createCompanionCommands = (
  ctx: CommandContext,
  { select, setSelected, close: closeWindow, markCreated, pulse }: CompanionDependencies,
): CompanionCommands => {
  const { workspace, navigation, panes, effects } = ctx
  const paneOf = (terminalId: string) =>
    panes?.of({ ...currentTarget(workspace.getSnapshot()), terminalId })

  // Terminal `from`'s item leaves the bar it's on: its own, or the one it's placed on.
  const leaving = (from: string, item: MovableItem): void => {
    paneOf(from)?.update((pane) => hideShowing(pane, itemKey(item)))
    const placed = currentState(workspace.getSnapshot()).placements.find(
      (each) => each.from === from && sameItem(each.item, item),
    )
    if (placed) paneOf(placed.to)?.update((pane) => hideShowing(pane, placedKey(from, item)))
  }

  const moveTo = (id: string, place: WindowPlace): void => {
    const snapshot = workspace.getSnapshot()
    const target = currentTarget(snapshot)
    const action: WorkspaceAction =
      "canvas" in place
        ? {
            type: "canvas/layout",
            target,
            layout: (canvas) => moveOnCanvas(canvas, id, place.canvas),
          }
        : {
            type: "grid/layouts",
            target,
            layouts: (layouts) => dropOnGrid(layouts, id, place.grid),
          }
    workspace.transact([action])
    // Placed where the person dropped it, in view: selected without moving the camera.
    setSelected(id)
  }

  return {
    undock: (from, item, place) => {
      const snapshot = workspace.getSnapshot()
      const { roster, layout } = currentState(snapshot)
      const open = windowOf(roster.terminals, from, item)
      if (open) return place ? moveTo(open.id, place) : select(open.id)
      const origin = roster.terminals.find((terminal) => terminal.id === from)
      const pane = paneOf(from)?.current()
      const shows = pane && describe(pane, item)
      if (!origin || !shows) return
      // A window, not a shell: nothing runs in it, so it's idle and has no program.
      const terminal: TerminalMetadata = {
        id: effects.newId(),
        directory: origin.directory,
        command: "",
        process: "",
        state: "idle",
        ...shows,
      }
      const grid = addCompactGridTerminal(roster.terminals, layout.grid, terminal)
      leaving(from, item)
      markCreated({ context: currentContext(snapshot), id: terminal.id })
      navigation.navigateWorkspace(
        [
          {
            type: "terminal/add",
            target: currentTarget(snapshot),
            terminal,
            gridLayouts:
              place && "grid" in place ? dropOnGrid(grid, terminal.id, place.grid) : grid,
            anchor: from,
            ...(place && "canvas" in place
              ? { canvasGeometry: droppedCanvasGeometry(place.canvas) }
              : {}),
          },
        ],
        { panel: "terminals" },
      )
      if (!place) pulse()
    },
    dock: (windowId) => {
      const { roster } = currentState(workspace.getSnapshot())
      const window = roster.terminals.find((terminal) => terminal.id === windowId)?.companion
      const pane = window && paneOf(window.from)
      // Its terminal closed: there's nowhere to dock it.
      if (!window || !pane || !roster.terminals.some((terminal) => terminal.id === window.from))
        return
      closeWindow(windowId)
      pane.update((current) =>
        // Something shown its terminal no longer has comes back as the window kept it.
        window.artifact && !current.artifacts.some((each) => each.id === window.artifact?.id)
          ? show(current, window.artifact, true)
          : openTab(current, itemKey(window.item)),
      )
      select(window.from)
    },
    place: (placements) => {
      for (const { from, item } of placements) leaving(from, item)
      const target = currentTarget(workspace.getSnapshot())
      workspace.transact([{ type: "companion/place", target, placements }])
      const now = currentState(workspace.getSnapshot()).placements
      // Each comes last on the bar it's placed on, as anything new does.
      for (const { from, item, to } of placements)
        if (now.some((each) => each.from === from && each.to === to && sameItem(each.item, item)))
          paneOf(to)?.update((pane) => arrivedAgain(pane, placedKey(from, item)))
    },
    closeItem: (from, key) => {
      const item = movableOf(key)
      if (item) {
        leaving(from, item)
        const target = currentTarget(workspace.getSnapshot())
        workspace.transact([
          { type: "companion/place", target, placements: [{ from, item, to: from }] },
        ])
      }
      paneOf(from)?.update((pane) => close(pane, key))
    },
  }
}

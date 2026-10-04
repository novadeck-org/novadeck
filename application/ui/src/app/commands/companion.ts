import { isOnBar, windowOfItem, type ItemId } from "../../model/companion"
import type { BarKey } from "../../model/companion-bar"
import { addCompactGridTerminal } from "../../model/layout/grid-placement"
import {
  droppedCanvasGeometry,
  dropOnGrid,
  moveOnCanvas,
  type WindowPlace,
} from "../../model/layout/window-place"
import { hasTerminal, hasWindow, tilesOf } from "../../model/roster"
import type { WorkspaceAction } from "../../model/state"
import type { CompanionWindowMeta } from "../../model/types"
import { currentContext, currentState, currentTarget } from "../selectors"
import type { CommandContext } from "./context"

// What the person does with companion items and the bars that hold them: undocking an
// item into a window of its own and docking it back, moving items onto another
// terminal's bar, closing one, and arranging a bar. Each is one change to the workspace,
// which the backend makes so; items are named by id, terminals by id in the current
// session.
export type CompanionCommands = {
  // Undocks the item into a window of its own beside its terminal, where it was dropped
  // when `place` says, or brings the window it's in forward, moving it there.
  readonly undock: (itemId: ItemId, place?: WindowPlace) => void
  // Docks a window's item back on the bar of the terminal it was shown from, open there.
  readonly dock: (windowId: string) => void
  // Moves the items onto terminal `terminalId`'s bar, each last.
  readonly place: (itemIds: readonly ItemId[], terminalId: string) => void
  // Closes the item: a plan on its own terminal's bar hides until it's rewritten; anything
  // else is gone, with the window it was in.
  readonly closeItem: (itemId: ItemId) => void
  // The person looked at items without opening them, in a peek: no longer new.
  readonly markSeen: (itemIds: readonly ItemId[]) => void
  // Opens a bar's pane to what it holds, closes it, hides what's on it, or moves an icon,
  // which `slots` gives each by the keys it stands for.
  readonly openBarTab: (terminalId: string, key: BarKey) => void
  readonly closeBarPane: (terminalId: string) => void
  readonly hideOnBar: (terminalId: string, key: BarKey) => void
  readonly moveBarSlot: (
    terminalId: string,
    slots: readonly (readonly BarKey[])[],
    from: number,
    to: number,
  ) => void
}

export type CompanionDependencies = {
  readonly select: (id: string) => void
  readonly setSelected: (id: string) => void
  readonly markCreated: (created: { readonly context: string; readonly id: string }) => void
  readonly pulse: () => void
}

export const createCompanionCommands = (
  ctx: CommandContext,
  { select, setSelected, markCreated, pulse }: CompanionDependencies,
): CompanionCommands => {
  const { workspace, navigation, effects } = ctx
  const itemOf = (id: ItemId) =>
    currentState(workspace.getSnapshot()).items.find((item) => item.id === id)
  const commit = (actions: readonly WorkspaceAction[]): void => void workspace.transact(actions)

  const moveTo = (id: string, place: WindowPlace): void => {
    const target = currentTarget(workspace.getSnapshot())
    commit([
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
          },
    ])
    // Placed where the person dropped it, in view: selected without moving the camera.
    setSelected(id)
  }

  return {
    undock: (itemId, place) => {
      const snapshot = workspace.getSnapshot()
      const { roster, layout } = currentState(snapshot)
      const item = itemOf(itemId)
      if (!item) return
      const open = windowOfItem(item)
      if (open && hasWindow(roster, open)) return place ? moveTo(open, place) : select(open)
      const window: CompanionWindowMeta = {
        id: effects.newId(),
        itemId,
        name: item.name,
        titleSource: { kind: "default" },
      }
      const grid = addCompactGridTerminal(tilesOf(roster), layout.grid, window)
      markCreated({ context: currentContext(snapshot), id: window.id })
      navigation.navigateWorkspace(
        [
          {
            type: "item/undock",
            target: currentTarget(snapshot),
            itemId,
            window,
            gridLayouts: place && "grid" in place ? dropOnGrid(grid, window.id, place.grid) : grid,
            anchor: "terminalId" in item.holder ? item.holder.terminalId : item.from.terminalId,
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
      const snapshot = workspace.getSnapshot()
      const { roster, items } = currentState(snapshot)
      const window = roster.windows.find((each) => each.id === windowId)
      const item = window && items.find((each) => each.id === window.itemId)
      // Its terminal closed: there's nowhere to dock it.
      if (!item || !hasTerminal(roster, item.from.terminalId)) return
      const home = item.from.terminalId
      navigation.navigateWorkspace(
        [
          {
            type: "item/move",
            target: currentTarget(snapshot),
            itemIds: [item.id],
            terminalId: home,
            open: true,
          },
        ],
        { terminal: home },
      )
      pulse()
    },
    place: (itemIds, terminalId) =>
      commit([
        { type: "item/move", target: currentTarget(workspace.getSnapshot()), itemIds, terminalId },
      ]),
    closeItem: (itemId) => {
      const snapshot = workspace.getSnapshot()
      const item = itemOf(itemId)
      if (!item) return
      const target = currentTarget(snapshot)
      const home = item.from.terminalId
      if (item.kind === "plan" && isOnBar(item, home))
        return commit([{ type: "bar/hide", target, terminalId: home, key: itemId }])
      const close: WorkspaceAction = { type: "item/close", target, itemId }
      // Closing a window moves the selection on, so the address follows.
      if (windowOfItem(item)) navigation.navigateWorkspace([close], {}, true)
      else commit([close])
    },
    markSeen: (itemIds) =>
      commit([{ type: "item/seen", target: currentTarget(workspace.getSnapshot()), itemIds }]),
    openBarTab: (terminalId, key) =>
      commit([
        { type: "bar/open", target: currentTarget(workspace.getSnapshot()), terminalId, key },
      ]),
    closeBarPane: (terminalId) =>
      commit([{ type: "bar/close", target: currentTarget(workspace.getSnapshot()), terminalId }]),
    hideOnBar: (terminalId, key) =>
      commit([
        { type: "bar/hide", target: currentTarget(workspace.getSnapshot()), terminalId, key },
      ]),
    moveBarSlot: (terminalId, slots, from, to) =>
      commit([
        {
          type: "bar/move",
          target: currentTarget(workspace.getSnapshot()),
          terminalId,
          slots,
          from,
          to,
        },
      ]),
  }
}

import { isOnBar, kindRules, windowOfItem, type Item, type ItemId } from "@novadeck/core/items"
import { addCompactGridTerminal } from "@novadeck/core/layout/grid-placement"
import {
  droppedCanvasGeometry,
  dropOnGrid,
  moveOnCanvas,
  type WindowPlace,
} from "@novadeck/core/layout/window-place"
import { hasTerminal, hasWindow, tilesOf } from "@novadeck/core/roster"
import type { WorkspaceAction } from "@novadeck/core/state"
import type { CompanionWindowMeta } from "@novadeck/core/types"
import type { CompanionActions } from "@novadeck/items/actions"

import { currentContext, currentState, currentTarget } from "../selectors"
import type { CommandContext } from "./context"

// What the person does with companion items and the bars that hold them: the companion
// package declares the actions, and these commands implement them.
export type CompanionCommands = CompanionActions

type CompanionDependencies = {
  readonly select: (id: string) => void
  readonly setSelected: (id: string) => void
  readonly markCreated: (created: { readonly context: string; readonly id: string }) => void
  readonly pulse: () => void
}

// The terminal an undocked window goes beside: the one it is on, else the one it came from.
const anchorOf = (item: Item): { anchor?: string } => {
  const terminalId = "terminalId" in item.holder ? item.holder.terminalId : item.from?.terminalId
  return terminalId === undefined ? {} : { anchor: terminalId }
}

export const createCompanionCommands = (
  ctx: CommandContext,
  { select, setSelected, markCreated, pulse }: CompanionDependencies,
): CompanionCommands => {
  const { workspace, ui, navigation, effects } = ctx
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
            layout: (canvas) =>
              moveOnCanvas(canvas, id, place.canvas, ui.getSnapshot().canvasWindowSize),
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

  const commands = {
    undock: (itemId, place) => {
      const snapshot = workspace.getSnapshot()
      const { roster, layout } = currentState(snapshot)
      const item = itemOf(itemId)
      if (!item) return
      const open = windowOfItem(item)
      if (open && hasWindow(roster, open)) return place ? moveTo(open, place) : select(open)
      const window: CompanionWindowMeta = {
        id: effects.newId(),
        home: "undocked",
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
            ...anchorOf(item),
            canvasSize: ui.getSnapshot().canvasWindowSize,
            ...(place && "canvas" in place
              ? {
                  canvasGeometry: droppedCanvasGeometry(
                    place.canvas,
                    ui.getSnapshot().canvasWindowSize,
                  ),
                }
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
      if (!item?.from || !hasTerminal(roster, item.from.terminalId)) return
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
      const home = item.from?.terminalId
      if (home !== undefined && kindRules[item.kind].close === "hide" && isOnBar(item, home))
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
    minimizeOnBar: (terminalId, key) =>
      commit([
        { type: "bar/minimize", target: currentTarget(workspace.getSnapshot()), terminalId, key },
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
  } satisfies CompanionActions
  return commands
}

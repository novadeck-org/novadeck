import type { Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import type { ShowBoard, ShowWaiting } from "../inbox/InboxToasts"
import { isDesktop } from "../shell/desktop"
import { mayToast, modalOpen } from "./selectors"
import type { UiStore } from "./ui-store"

// What waits to open now, in every project's open session.
const waitingIn = (workspace: Workspace): ShowWaiting[] =>
  workspace.projects.flatMap((project) => {
    const state = project.history.find((session) => session.id === project.activeSessionId)?.state
    return (state?.waiting ?? []).flatMap((id) => {
      const item = state?.items.find((each) => each.id === id)
      const terminalId = item && "terminalId" in item.holder ? item.holder.terminalId : undefined
      const terminal = state?.roster.terminals.find((each) => each.id === terminalId)
      return item && terminal
        ? [
            {
              itemId: item.id,
              version: item.version,
              itemName: item.name,
              terminalId: terminal.id,
              terminalName: terminal.name,
              handle: terminal.handle || undefined,
              projectName: project.name,
              at: item.shownAt,
            },
          ]
        : []
    })
  })

// Follows what waits to open and tells the person on `board`, quietly: one toast per item,
// while the page has their focus and no dialog stands over it (`mayToast`; else it is told
// once they are back), replaced if the item is shown again, and gone once the item no longer
// waits, as it opens or the person gets to it first. A toast that ran out isn't rung again.
// Returns the stop.
export const watchShowToasts = (
  workspace: Store<Workspace>,
  ui: UiStore,
  board: ShowBoard,
  { desktop = isDesktop }: { desktop?: () => boolean } = {},
): (() => void) => {
  // The version of each item told of.
  const told = new Map<string, number>()
  const follow = (): void => {
    const waiting = waitingIn(workspace.getSnapshot())
    const standing = new Set(waiting.map((each) => each.itemId))
    for (const itemId of told.keys()) {
      if (standing.has(itemId)) continue
      told.delete(itemId)
      board.close(itemId)
    }
    const state = ui.getSnapshot()
    if (!mayToast(state, desktop) || modalOpen(state)) return
    for (const each of waiting) {
      if (told.get(each.itemId) === each.version) continue
      told.set(each.itemId, each.version)
      board.show(each)
    }
  }
  follow()
  const stopWorkspace = workspace.subscribe(follow)
  const stopUi = ui.subscribe(follow)
  return () => {
    stopWorkspace()
    stopUi()
  }
}

// Puts keyboard focus in the terminal's input once it can take it: the view may still be
// moving to it (Focus mounting it, Canvas flying in), so it tries on each frame, for about a
// second, until `focus` says it holds. It gives up once the person puts focus somewhere
// themselves, so it never takes it back from them.
export const focusWhenReady = (
  terminalId: string,
  focus: (id: string) => boolean,
  frame: (next: () => void) => void = requestAnimationFrame,
  active: () => Element | null = () => document.activeElement,
  tries = 60,
): void => {
  // The toast's button, which goes with the toast and leaves focus nowhere: not theirs.
  const from = active()
  const theirs = (): boolean => {
    const now = active()
    return now !== null && now !== from && now !== document.body
  }
  const attempt = (left: number): void => {
    if (theirs() || focus(terminalId) || left <= 1) return
    frame(() => attempt(left - 1))
  }
  frame(() => attempt(tries))
}

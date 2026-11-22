import type { ToldBoard } from "../inbox/InboxToasts"
import type { UiStore } from "./ui-store"

// Tells what Novadeck says of something done elsewhere (`told`), as the session or project the
// person was on being removed in another window. A newer one replaces the toast of the last.
export const watchToldToasts = (ui: UiStore, board: ToldBoard): (() => void) => {
  let shown = ui.getSnapshot().told
  return ui.subscribe(() => {
    const { told } = ui.getSnapshot()
    if (told === shown) return
    shown = told
    if (told) board.show(told)
    else board.close()
  })
}

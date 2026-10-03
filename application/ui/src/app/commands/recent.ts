import { orderedTiles } from "../../model/roster"
import { openRecent, visibleSwitcher, type RecentSwitcher } from "../../terminals/recent"
import { currentContext, currentState } from "../selectors"
import type { CommandContext, FocusTarget } from "./context"

// The button that opened the switcher, which gets focus back when it closes.
export type SwitcherTrigger = FocusTarget

export type RecentCommands = {
  // The current session's terminals, most recently selected first.
  readonly recentIds: () => readonly string[]
  // The switcher as it shows now: in its own session and not above a dialog.
  readonly visibleSwitcher: () => RecentSwitcher | null
  readonly setSwitcher: (switcher: RecentSwitcher | null) => void
  readonly openSwitcher: (id: string, trigger: SwitcherTrigger) => void
  // Closes it and returns focus to the button that opened a click-mode switcher.
  readonly closeSwitcher: () => void
}

export const createRecentCommands = ({
  ui,
  workspace,
  effects,
}: Pick<CommandContext, "ui" | "workspace" | "effects">): RecentCommands => {
  let trigger: SwitcherTrigger | null = null
  const setSwitcher = (switcher: RecentSwitcher | null): void =>
    void ui.update((state) =>
      switcher === state.recent.switcher
        ? state
        : { ...state, recent: { ...state.recent, switcher } },
    )
  const visible = (): RecentSwitcher | null => {
    const { recent, location } = ui.getSnapshot()
    return visibleSwitcher(
      recent.switcher,
      currentContext(workspace.getSnapshot()),
      location.route.dialog,
    )
  }
  return {
    recentIds: () =>
      ui.getSnapshot().recent.byContext[currentContext(workspace.getSnapshot())] ?? [],
    visibleSwitcher: visible,
    setSwitcher,
    openSwitcher: (id, button) => {
      const snapshot = workspace.getSnapshot()
      const context = currentContext(snapshot)
      const ids =
        ui.getSnapshot().recent.byContext[context] ??
        orderedTiles(currentState(snapshot).roster).map((terminal) => terminal.id)
      trigger = button
      setSwitcher(openRecent(context, ids, id))
    },
    closeSwitcher: () => {
      const focus = visible()?.mode === "click" ? trigger : null
      setSwitcher(null)
      if (focus) effects.afterMicrotask(() => effects.refocus(focus))
    },
  }
}

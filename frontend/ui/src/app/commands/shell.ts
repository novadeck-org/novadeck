import type { SidebarPanel } from "@novadeck/core/types"

import {
  bumpNavigation,
  enterZen,
  exitZen,
  hideSidebar,
  showPanel,
  sidebarVisible,
  type FocusPreview,
  type KeyboardFocus,
  type NavigationMove,
  type ShellState,
} from "../../shell/shell-state"
import { currentContext, currentState } from "../selectors"
import { updateShell } from "../ui-store"
import type { CommandContext } from "./context"

export type ShellCommands = {
  readonly showSessions: () => void
  readonly showInbox: () => void
  // Shows the Inbox for one row, as a click on a toast or a notice does, in place of the page
  // the person was on rather than as a step Back goes through. Returns what puts the sidebar
  // back as it was: the same panel, hidden, or Zen, with typing back in the selected terminal.
  // Returns nothing where the Inbox showed already. What it returns does nothing once the
  // Inbox is no longer the panel that shows.
  readonly peekInbox: () => (() => void) | undefined
  readonly hideSidebar: () => void
  // Shows the panel, leaving Zen; when it already shows, goes back to the panel shown just
  // before it, or hides the sidebar when there is none.
  readonly toggleSidebar: (panel: SidebarPanel) => void
  readonly enterZen: () => void
  readonly exitZen: () => void
  // Asks Canvas to move keyboard focus to the terminal's node once it is selected.
  readonly requestCanvasFocus: (id: string) => void
  // Drops a Canvas focus request once it no longer matches what Canvas shows.
  readonly dropCanvasFocus: (request: number) => void
  readonly setKeyboardFocus: (focus: KeyboardFocus | null) => void
  readonly setFocusPreview: (preview: FocusPreview | null) => void
  readonly setNavigate: (navigate: boolean) => void
}

// Shell changes shared by the workspace commands.
type ShellEdits = {
  readonly change: (edit: (shell: ShellState) => ShellState) => void
  readonly set: <K extends keyof ShellState>(key: K, value: ShellState[K]) => void
  readonly pulse: (move?: NavigationMove) => void
}

export const shellEdits = ({ ui }: Pick<CommandContext, "ui">): ShellEdits => {
  const change = (edit: (shell: ShellState) => ShellState): void => updateShell(ui, edit)
  return {
    change,
    set: (key, value) =>
      change((shell) => (Object.is(shell[key], value) ? shell : { ...shell, [key]: value })),
    pulse: (move) => change((shell) => bumpNavigation(shell, move)),
  }
}

export const createShellCommands = (ctx: CommandContext): ShellCommands => {
  const { ui, workspace, navigation, effects } = ctx
  const { change, set } = shellEdits(ctx)
  const panel = (): SidebarPanel => ui.getSnapshot().location.route.panel
  let canvasFocusRequest = 0
  const hide = (): void => {
    change(hideSidebar)
    if (effects.desktop()) effects.focusSidebarToggle(panel())
  }
  const show = (next: SidebarPanel, replace = false): void => {
    const { shell: before } = ui.getSnapshot()
    const inZen = Boolean(before.zen)
    // Switching from an open panel remembers it, for the new panel's toggle to go back to; a
    // sidebar opening remembers none, and showing the open panel again keeps what it had.
    const current = panel()
    const back = !sidebarVisible(before, effects.desktop())
      ? null
      : current === next
        ? before.sidebarBack
        : current
    change((shell) => ({ ...shell, zen: null, sidebarBack: back }))
    navigation.go({ panel: next }, replace)
    change(showPanel)
    // The Zen dock the person pressed is gone; focus follows to the rail.
    if (inZen && effects.desktop())
      effects.afterFrame(() => effects.focusSidebarToggleStranded(next))
  }
  return {
    showSessions: () => show("sessions"),
    showInbox: () => show("inbox"),
    peekInbox: () => {
      const desktop = effects.desktop()
      const { location, shell } = ui.getSnapshot()
      if (location.route.panel === "inbox" && sidebarVisible(shell, desktop)) return undefined
      const was = location.route.panel
      const { sidebar, sidebarCollapsed, sidebarBack, zen } = shell
      show("inbox", true)
      return () => {
        const now = ui.getSnapshot()
        if (now.location.route.panel !== "inbox" || !sidebarVisible(now.shell, effects.desktop()))
          return
        change((edited) => ({ ...edited, sidebar, sidebarCollapsed, sidebarBack, zen }))
        navigation.go({ panel: was }, true)
        if (!effects.desktop()) return
        effects.afterFrame(() => {
          const { selected } = currentState(workspace.getSnapshot())
          if (selected) effects.focusTerminalInput(selected)
        })
      }
    },
    hideSidebar: hide,
    toggleSidebar: (next) => {
      // Visibility before this command: a panel hidden by Zen shows instead of hiding.
      const { shell } = ui.getSnapshot()
      const visible = sidebarVisible(shell, effects.desktop())
      // The open panel's toggle goes back one step, to the panel the person was on before it,
      // so a look at the Inbox or Sessions returns to where they were; back there, or with no
      // step to go back, it hides the sidebar.
      const back = shell.sidebarBack
      if (panel() !== next || !visible) show(next)
      else if (back && back !== next) {
        change((edited) => ({ ...edited, sidebarBack: null }))
        navigation.go({ panel: back })
      } else hide()
    },
    enterZen: () => {
      if (ui.getSnapshot().shell.zen) return
      change((shell) => enterZen(shell, panel()))
      effects.afterFrame(effects.focusZenCreate)
    },
    exitZen: () => {
      const { zen } = ui.getSnapshot().shell
      if (!zen) return
      change(exitZen)
      navigation.go({ panel: zen.panel })
      effects.afterFrame(effects.focusZenEnter)
    },
    requestCanvasFocus: (id) =>
      set("canvasKeyboardFocus", {
        context: currentContext(workspace.getSnapshot()),
        id,
        request: ++canvasFocusRequest,
      }),
    dropCanvasFocus: (request) =>
      change((shell) =>
        shell.canvasKeyboardFocus?.request === request
          ? { ...shell, canvasKeyboardFocus: null }
          : shell,
      ),
    setKeyboardFocus: (focus) => set("keyboardFocus", focus),
    setFocusPreview: (preview) => set("focusPreview", preview),
    setNavigate: (navigate) => set("navigate", navigate),
  }
}

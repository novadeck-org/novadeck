import {
  bumpNavigation,
  enterZen,
  exitZen,
  hideSidebar,
  showPanel,
  sidebarVisible,
  type FocusPreview,
  type KeyboardFocus,
  type ShellState,
  type SidebarPanel,
} from "../../shell/shell-state"
import { currentContext } from "../selectors"
import { updateShell } from "../ui-store"
import type { CommandContext } from "./context"

export type ShellCommands = {
  readonly showSessions: () => void
  readonly hideSidebar: () => void
  // Hides the panel when it already shows; otherwise leaves Zen and shows it.
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
export type ShellEdits = {
  readonly change: (edit: (shell: ShellState) => ShellState) => void
  readonly set: <K extends keyof ShellState>(key: K, value: ShellState[K]) => void
  readonly pulse: (fit?: boolean) => void
}

export const shellEdits = ({ ui }: Pick<CommandContext, "ui">): ShellEdits => {
  const change = (edit: (shell: ShellState) => ShellState): void => updateShell(ui, edit)
  return {
    change,
    set: (key, value) =>
      change((shell) => (Object.is(shell[key], value) ? shell : { ...shell, [key]: value })),
    pulse: (fit = false) => change((shell) => bumpNavigation(shell, fit)),
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
  const show = (next: SidebarPanel): void => {
    change((shell) => ({ ...shell, zen: null }))
    navigation.go({ panel: next })
    change(showPanel)
  }
  return {
    showSessions: () => show("sessions"),
    hideSidebar: hide,
    toggleSidebar: (next) => {
      // Visibility before this command: a panel hidden by Zen shows instead of hiding.
      const visible = sidebarVisible(ui.getSnapshot().shell, effects.desktop())
      if (panel() === next && visible) hide()
      else show(next)
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

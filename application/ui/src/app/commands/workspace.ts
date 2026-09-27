import { addCompactGridTerminal } from "../../model/layout/grid-placement"
import { activeProject, type WorkspaceAction } from "../../model/state"
import type { PreferencesValue, Project, ViewMode, WorkspaceTarget } from "../../model/types"
import { currentContext, currentState, currentTarget, windowedDestination } from "../selectors"
import type { CommandContext } from "./context"
import { createLayoutCommands, type LayoutCommands } from "./layout"
import { createRecentCommands, type RecentCommands } from "./recent"
import { createRenameCommands, type RenameCommands } from "./rename"
import { newWorkspaceSession } from "./sessions"
import { createShellCommands, shellEdits, type ShellCommands } from "./shell"

export type AddTerminalOptions = { fromKeyboard?: boolean; beginRename?: boolean }

// Workspace operations shared by the pointer UI and keyboard shortcuts. Each reads the
// latest stores when it runs, so several in one event keep one another's changes.
export type WorkspaceCommands = ShellCommands &
  RenameCommands &
  RecentCommands &
  LayoutCommands & {
    readonly switchSession: (id: string) => void
    readonly startFresh: () => void
    readonly switchProject: (next: Project) => void
    // Selects a terminal and brings it into view, optionally fitting Canvas around it.
    readonly select: (id: string, fit?: boolean) => void
    readonly setSelected: (terminal: string) => void
    readonly updatePreferences: (next: PreferencesValue) => void
    readonly changeView: (next: ViewMode) => void
    // From Focus, back to the windowed view with this terminal selected.
    readonly openWindowed: (id: string) => void
    // From a windowed view, into Focus on this terminal.
    readonly openFocus: (id: string) => void
    readonly openSearchResult: (id: string) => void
    // Chooses a terminal from the recent switcher.
    readonly chooseRecent: (id: string) => void
    // Returns the new terminal's ID.
    readonly add: (options?: AddTerminalOptions) => string
    readonly close: (terminalId: string) => void
  }

// The terminal created last stays highlighted this long.
const createdHighlight = 900

export const createWorkspaceCommands = (ctx: CommandContext): WorkspaceCommands => {
  const { workspace, ui, navigation, newTerminal, effects } = ctx
  const { go, navigateWorkspace } = navigation
  const { set, pulse } = shellEdits(ctx)
  const shell = createShellCommands(ctx)
  const rename = createRenameCommands(ctx)
  const recent = createRecentCommands(ctx)
  const preferences = (): PreferencesValue => ui.getSnapshot().preferences

  const setSelected = (terminal: string): void => go({ terminal })
  const select = (id: string, fit = false): void => {
    setSelected(id)
    pulse(fit)
    set("sidebar", false)
  }
  const showWindowed = (id: string, target: WorkspaceTarget, destination: ViewMode): void => {
    pulse()
    set("sidebar", false)
    set("revealCanvas", destination === "canvas")
    navigateWorkspace(
      [
        {
          type: "view/change",
          target,
          view: destination,
          enabledViews: preferences().enabledViews,
          rememberWindowed: false,
        },
      ],
      { terminal: id },
    )
  }
  const markCreated = (created: { context: string; id: string }): void => {
    ui.update((state) => ({ ...state, created }))
    effects.after(createdHighlight, () =>
      ui.update((state) => (state.created === created ? { ...state, created: null } : state)),
    )
  }

  return {
    ...shell,
    ...rename,
    ...recent,
    ...createLayoutCommands(ctx),
    setSelected,
    select,
    switchSession: (id) => {
      const project = activeProject(workspace.getSnapshot())!
      if (id === project.activeSessionId) return
      if (!project.history.some((item) => item.id === id)) return
      navigateWorkspace([
        {
          type: "session/select",
          projectId: project.id,
          workspaceSessionId: id,
          now: effects.now(),
          enabledViews: preferences().enabledViews,
        },
      ])
    },
    startFresh: () => {
      const snapshot = workspace.getSnapshot()
      const project = activeProject(snapshot)!
      const next = newWorkspaceSession(currentState(snapshot), {
        id: effects.newId(),
        now: effects.now(),
      })
      const { name } = next
      let suffix = 2
      while (project.history.some((item) => item.name === next.name))
        next.name = `${name} (${suffix++})`
      set("freshSession", next.id)
      set("sidebarCollapsed", false)
      navigateWorkspace([{ type: "session/add", projectId: project.id, session: next }], {
        panel: "sessions",
      })
    },
    switchProject: (next) => {
      if (next.id === workspace.getSnapshot().activeProjectId) return
      navigateWorkspace([
        {
          type: "project/select",
          projectId: next.id,
          now: effects.now(),
          enabledViews: preferences().enabledViews,
        },
      ])
    },
    updatePreferences: (next) => {
      const snapshot = workspace.getSnapshot()
      const { view } = currentState(snapshot)
      effects.cancelTransition()
      ui.update((state) => ({ ...state, preferences: next }))
      workspace.dispatch({
        type: "preferences/reconcile",
        target: currentTarget(snapshot),
        preferences: next,
      })
      if (!next.enabledViews.includes(view)) {
        set("revealCanvas", false)
        set("sidebar", false)
      }
    },
    changeView: (next) => {
      const { enabledViews } = preferences()
      if (!enabledViews.includes(next)) return
      navigateWorkspace([
        {
          type: "view/change",
          target: currentTarget(workspace.getSnapshot()),
          view: next,
          enabledViews,
        },
      ])
      set("revealCanvas", false)
      set("sidebar", false)
    },
    openWindowed: (id) => {
      // A view transition may run the change later; it still belongs to this session.
      const snapshot = workspace.getSnapshot()
      const destination = windowedDestination(
        currentState(snapshot).windowedView,
        preferences().enabledViews,
      )
      if (!destination) return
      const target = currentTarget(snapshot)
      effects.transitionTerminal(id, () => showWindowed(id, target, destination))
    },
    openFocus: (id) =>
      effects.transitionTerminal(id, () => {
        go({ terminal: id, view: "focus" })
        set("revealCanvas", false)
        set("sidebar", false)
      }),
    openSearchResult: (id) => {
      const { view } = currentState(workspace.getSnapshot())
      go({ terminal: id, dialog: null })
      pulse(view === "canvas")
      set("sidebar", false)
    },
    chooseRecent: (id) => {
      const mode = recent.visibleSwitcher()?.mode
      recent.setSwitcher(null)
      if (mode === "click")
        shell.setKeyboardFocus({ id, view: currentState(workspace.getSnapshot()).view })
      select(id)
    },
    add: ({ fromKeyboard = false, beginRename = true } = {}) => {
      recent.setSwitcher(null)
      const snapshot = workspace.getSnapshot()
      const project = activeProject(snapshot)!
      const { roster, layout } = currentState(snapshot)
      const target = currentTarget(snapshot)
      const { zen, sidebarCollapsed } = ui.getSnapshot().shell
      const terminal = newTerminal({ number: roster.nextNumber, directory: project.directory })
      const active = rename.activeRename()
      if (!beginRename && active) rename.finishRename(active, true)
      const origin =
        !zen && effects.desktop() && (fromKeyboard || !sidebarCollapsed) ? "sidebar" : "header"
      markCreated({ context: currentContext(snapshot), id: terminal.id })
      if (beginRename) rename.startRename(terminal, origin)
      const actions: WorkspaceAction[] = [
        {
          type: "terminal/add",
          target,
          terminal,
          gridLayouts: addCompactGridTerminal(roster.terminals, layout.grid, terminal),
        },
      ]
      navigateWorkspace(actions, { panel: "terminals" })
      pulse()
      if (fromKeyboard) set("sidebarCollapsed", false)
      set("sidebar", false)
      return terminal.id
    },
    close: (terminalId) => {
      const snapshot = workspace.getSnapshot()
      const { view, selected } = currentState(snapshot)
      const active = rename.activeRename()
      if (active?.id === terminalId) rename.finishRename(active, false)
      navigateWorkspace(
        [{ type: "terminal/close", target: currentTarget(snapshot), terminalId }],
        {},
        true,
      )
      if (selected === terminalId && view !== "canvas") pulse()
    },
  }
}

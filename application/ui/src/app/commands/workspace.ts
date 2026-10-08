import type { TerminalRequest } from "../../backend/port"
import { addCompactGridTerminal } from "../../model/layout/grid-placement"
import { canvasNewTerminalSize } from "../../model/layout/terminal-size"
import { tilesOf } from "../../model/roster"
import { activeProject, type WorkspaceAction } from "../../model/state"
import type {
  PreferencesValue,
  Project,
  ViewMode,
  Workspace,
  WorkspaceProject,
  WorkspaceSession,
  WorkspaceTarget,
} from "../../model/types"
import { noTerminalAnswers } from "../../terminals/chat/mode-state"
import {
  currentContext,
  currentState,
  currentTarget,
  sameTarget,
  windowedDestination,
} from "../selectors"
import { createChatCommands, type ChatCommands } from "./chat"
import { createCompanionCommands, type CompanionCommands } from "./companion"
import type { CommandContext } from "./context"
import { createLayoutCommands, type LayoutCommands } from "./layout"
import { createRecentCommands, type RecentCommands } from "./recent"
import { createRenameCommands, type RenameCommands } from "./rename"
import { folderProject, newWorkspaceSession } from "./sessions"
import { createShellCommands, shellEdits, type ShellCommands } from "./shell"

export type AddTerminalOptions = { fromKeyboard?: boolean }

// Workspace operations shared by the pointer UI and keyboard shortcuts. Each reads the
// latest stores when it runs, so several in one event keep one another's changes.
export type WorkspaceCommands = ShellCommands &
  CompanionCommands &
  ChatCommands &
  RenameCommands &
  RecentCommands &
  LayoutCommands & {
    readonly switchSession: (id: string) => void
    readonly startFresh: () => void
    readonly switchProject: (next: Project) => void
    // Asks the backend for a folder and opens it as a new project; no-op without one.
    readonly openFolder: () => Promise<void>
    // Removes a project and closes its terminals; the last project stays.
    readonly removeProject: (id: string) => void
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
    // Saves a rename in progress and puts typing focus in the new terminal. Returns its ID.
    readonly add: (options?: AddTerminalOptions) => string
    // Adds the terminal an agent asked for beside its own, in that terminal's session,
    // and answers the request; it comes into view only when the request asks.
    readonly openRequested: (request: TerminalRequest) => void
    // Brings a terminal into view wherever it is, as a click on a notification about it
    // asks: its project and session to the front, the terminal selected.
    readonly reveal: (terminalId: string) => void
    // Closes the terminal, or asks first while a program runs in it.
    readonly close: (terminalId: string) => void
    // Answers the pending close confirmation.
    readonly confirmClose: () => void
    readonly cancelClose: () => void
    // Answers the crash-loop dialog: start the terminals over, or leave it until the
    // next crash loop.
    readonly retryAfterCrashLoop: () => void
    readonly dismissCrashLoop: () => void
  }

// The terminal created last stays highlighted this long.
const createdHighlight = 900

// The project and session holding the terminal, wherever it is.
const holding = (
  workspace: Workspace,
  terminalId: string,
): { project: WorkspaceProject; session: WorkspaceSession } | undefined => {
  for (const project of workspace.projects)
    for (const session of project.history)
      if (session.state.roster.terminals.some((terminal) => terminal.id === terminalId))
        return { project, session }
  return undefined
}

export const createWorkspaceCommands = (ctx: CommandContext): WorkspaceCommands => {
  const { workspace, ui, navigation, newTerminal, pickDirectory, crashLoop, effects } = ctx
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

  const closeNow = (terminalId: string): void => {
    const snapshot = workspace.getSnapshot()
    const { view, selected } = currentState(snapshot)
    const active = rename.activeRename()
    if (active?.id === terminalId) rename.finishRename(active, false)
    // Closing a window closes what it shows; a terminal takes what its bar holds with it.
    const target = currentTarget(snapshot)
    const window = currentState(snapshot).roster.windows.find((each) => each.id === terminalId)
    navigateWorkspace(
      [
        window
          ? { type: "item/close", target, itemId: window.itemId }
          : { type: "terminal/close", target, terminalId },
      ],
      {},
      true,
    )
    if (selected === terminalId && view !== "canvas") pulse()
  }

  const switchProject = (next: Project): void => {
    if (next.id === workspace.getSnapshot().activeProjectId) return
    navigateWorkspace([
      {
        type: "project/select",
        projectId: next.id,
        now: effects.now(),
        enabledViews: preferences().enabledViews,
      },
    ])
  }

  return {
    ...shell,
    ...rename,
    ...recent,
    ...createLayoutCommands(ctx),
    ...createChatCommands(ctx),
    ...createCompanionCommands(ctx, {
      select,
      setSelected,
      markCreated,
      pulse: () => pulse(),
    }),
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
    switchProject,
    openFolder: async () => {
      // A picker that fails leaves the workspace as it was; it has nothing to show.
      const directory = await pickDirectory?.().catch((error: unknown) => {
        console.error("Could not open the folder picker", error)
        return null
      })
      if (!directory) return
      // A folder already open as a project opens that project again.
      const existing = workspace
        .getSnapshot()
        .projects.find((project) => project.directory === directory)
      if (existing) return switchProject(existing)
      const project = folderProject(directory, effects.newId())
      const initialSession = newWorkspaceSession(currentState(workspace.getSnapshot()), {
        id: effects.newId(),
        now: effects.now(),
      })
      navigateWorkspace([
        {
          type: "project/add",
          project,
          activate: true,
          initialSession,
          enabledViews: preferences().enabledViews,
        },
      ])
    },
    removeProject: (id) => {
      if (workspace.getSnapshot().projects.length < 2) return
      navigateWorkspace([
        {
          type: "project/remove",
          projectId: id,
          now: effects.now(),
          enabledViews: preferences().enabledViews,
        },
      ])
    },
    updatePreferences: (next) => {
      const snapshot = workspace.getSnapshot()
      const { view } = currentState(snapshot)
      effects.cancelTransition()
      // Turning the chat view on or off starts every terminal afresh on it.
      ui.update((state) => ({
        ...state,
        preferences: next,
        ...(next.chatView !== state.preferences.chatView && { answering: noTerminalAnswers }),
      }))
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
    add: ({ fromKeyboard = false } = {}) => {
      recent.setSwitcher(null)
      const snapshot = workspace.getSnapshot()
      const project = activeProject(snapshot)!
      const { roster, layout, view } = currentState(snapshot)
      const target = currentTarget(snapshot)
      const terminal = newTerminal({ target, directory: project.directory })
      const active = rename.activeRename()
      if (active) rename.finishRename(active, true)
      markCreated({ context: currentContext(snapshot), id: terminal.id })
      shell.setKeyboardFocus({ id: terminal.id, view })
      const actions: WorkspaceAction[] = [
        {
          type: "terminal/add",
          target,
          terminal,
          gridLayouts: addCompactGridTerminal(tilesOf(roster), layout.grid, terminal),
          canvasSize: canvasNewTerminalSize(effects.stageSize()),
        },
      ]
      navigateWorkspace(actions, { panel: "terminals" })
      pulse()
      if (fromKeyboard) set("sidebarCollapsed", false)
      set("sidebar", false)
      return terminal.id
    },
    openRequested: (request) => {
      const snapshot = workspace.getSnapshot()
      const found = holding(snapshot, request.from)
      if (!found)
        return request.answer({ reason: "The terminal that asked isn't open in Novadeck." })
      const { project, session } = found
      const target = { projectId: project.id, workspaceSessionId: session.id }
      const { roster, layout } = session.state
      const terminal = newTerminal({
        target,
        directory: request.directory,
        launch: request.command === undefined ? {} : { command: request.command },
      })
      const add: WorkspaceAction = {
        type: "terminal/add",
        target,
        terminal,
        gridLayouts: addCompactGridTerminal(tilesOf(roster), layout.grid, terminal),
        canvasSize: canvasNewTerminalSize(effects.stageSize()),
        anchor: request.from,
        select: request.focus,
      }
      const here = sameTarget(target, currentTarget(snapshot))
      if (!request.focus) workspace.transact([add])
      else {
        // Into view: in its session, which comes to the front if it was not already.
        const { enabledViews } = preferences()
        const now = effects.now()
        const switching: WorkspaceAction[] = here
          ? []
          : [
              {
                type: "session/select",
                projectId: project.id,
                workspaceSessionId: session.id,
                now,
                enabledViews,
              },
              ...(project.id === snapshot.activeProjectId
                ? []
                : [{ type: "project/select" as const, projectId: project.id, now, enabledViews }]),
            ]
        navigateWorkspace([add, ...switching], { panel: "terminals" })
        pulse()
        set("sidebar", false)
      }
      if (here || request.focus)
        markCreated({ context: `${project.id}/${session.id}`, id: terminal.id })
      request.answer({ terminalId: terminal.id })
    },
    reveal: (terminalId) => {
      const snapshot = workspace.getSnapshot()
      const found = holding(snapshot, terminalId)
      if (!found) return
      const { project, session } = found
      const target = { projectId: project.id, workspaceSessionId: session.id }
      recent.setSwitcher(null)
      // Out from behind any dialog, as the session's front comes from another one.
      if (sameTarget(target, currentTarget(snapshot))) {
        go({ terminal: terminalId, dialog: null })
        pulse()
        set("sidebar", false)
        return
      }
      const { enabledViews } = preferences()
      const now = effects.now()
      navigateWorkspace(
        [
          {
            type: "session/select",
            projectId: project.id,
            workspaceSessionId: session.id,
            now,
            enabledViews,
          },
          ...(project.id === snapshot.activeProjectId
            ? []
            : [{ type: "project/select" as const, projectId: project.id, now, enabledViews }]),
        ],
        { terminal: terminalId, dialog: null },
      )
      pulse()
      set("sidebar", false)
    },
    close: (terminalId) => {
      const snapshot = workspace.getSnapshot()
      const closing = currentState(snapshot).roster.terminals.find(
        (terminal) => terminal.id === terminalId,
      )
      // Closing ends the shell, so ask first while a program still runs in it; the
      // confirmation dialog renders from this and answers with confirmClose or cancelClose.
      if (closing?.state === "running")
        return void ui.update((state) => ({
          ...state,
          closing: { context: currentContext(snapshot), id: terminalId },
        }))
      closeNow(terminalId)
    },
    confirmClose: () => {
      const pending = ui.getSnapshot().closing
      if (!pending) return
      ui.update((state) => ({ ...state, closing: null }))
      // Only in the session it was asked in; a session change drops it.
      if (pending.context === currentContext(workspace.getSnapshot())) closeNow(pending.id)
    },
    cancelClose: () => ui.update((state) => (state.closing ? { ...state, closing: null } : state)),
    retryAfterCrashLoop: () => {
      ui.update((state) =>
        state.crashLoopDismissed ? { ...state, crashLoopDismissed: false } : state,
      )
      crashLoop?.retry()
    },
    dismissCrashLoop: () => ui.update((state) => ({ ...state, crashLoopDismissed: true })),
  }
}

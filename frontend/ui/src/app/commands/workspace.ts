import { resetAnswering } from "@novadeck/chat/state"
import { descendantsOf } from "@novadeck/core/derivations"
import type { AgentName } from "@novadeck/core/harnesses"
import type { ClosedTerminal } from "@novadeck/core/history"
import type { TerminalRequest } from "@novadeck/core/port"
import { activeProject, type WorkspaceAction } from "@novadeck/core/state"
import { closeReasons } from "@novadeck/core/terminals/closing"
import type {
  PreferencesValue,
  Project,
  SidebarPanel,
  ViewMode,
  Workspace,
  WorkspaceProject,
  WorkspaceSession,
  WorkspaceTarget,
} from "@novadeck/core/types"

import {
  moveProject as arrangeMove,
  pinAt,
  stepProject as arrangeStep,
  togglePin,
  type ProjectArrangement,
} from "../../projects/project-arrangement"
import type { FeatureFlag } from "../feature-flags"
import {
  currentContext,
  currentState,
  currentTarget,
  sameTarget,
  windowedDestination,
} from "../selectors"
import { chatViewOn, notePortableCardShown, type UiState } from "../ui-store"
import { createChatCommands, type ChatCommands } from "./chat"
import { createCompanionCommands, type CompanionCommands } from "./companion"
import type { CommandContext } from "./context"
import { createLayoutCommands, type LayoutCommands } from "./layout"
import { createMoveCommands, type MoveCommands } from "./moves"
import { createRecentCommands, type RecentCommands } from "./recent"
import { createRenameCommands, type RenameCommands } from "./rename"
import { folderProject, newWorkspaceSession } from "./sessions"
import { createShellCommands, shellEdits, type ShellCommands } from "./shell"
import { createSourceCommands, type SourceCommands } from "./source"

type AddTerminalOptions = { fromKeyboard?: boolean }

// Workspace operations shared by the pointer UI and keyboard shortcuts. Each reads the
// latest stores when it runs, so several in one event keep one another's changes.
export type WorkspaceCommands = ShellCommands &
  CompanionCommands &
  MoveCommands &
  SourceCommands &
  ChatCommands &
  RenameCommands &
  RecentCommands &
  LayoutCommands & {
    readonly switchSession: (id: string) => void
    readonly startFresh: () => void
    // Renames a session of the open project; a blank name keeps the old one.
    readonly renameSession: (id: string, name: string) => void
    // Moves a session of the open project to this place in its list.
    readonly moveSession: (id: string, index: number) => void
    // Deletes a session of the open project and closes its terminals; the last one stays.
    readonly removeSession: (id: string) => void
    readonly switchProject: (next: Project) => void
    // Asks the backend for a folder and opens it as a new project; no-op without one.
    readonly openFolder: () => Promise<void>
    // Removes a project and closes its terminals; the last project stays.
    readonly removeProject: (id: string) => void
    // Moves a project to this place in the switcher's list, pinned ones first: pinned
    // when dropped among them, unpinned among the rest.
    readonly moveProject: (id: string, index: number) => void
    // Steps a project one place up or down that list; across the rule it pins or unpins.
    readonly stepProject: (id: string, by: -1 | 1) => void
    // Pins a project, or unpins it if pinned; no more than the limit can be pinned.
    readonly toggleProjectPin: (id: string) => void
    // Pins a project at this place among the pinned ones, or moves it there if pinned.
    readonly pinProjectAt: (id: string, index: number) => void
    // Puts back an arrangement read before, as a canceled drag does.
    readonly restoreProjectArrangement: (arrangement: ProjectArrangement) => void
    // Selects a terminal and brings it into view, optionally fitting Canvas around it.
    readonly select: (id: string, fit?: boolean) => void
    readonly setSelected: (terminal: string) => void
    readonly updatePreferences: (next: PreferencesValue) => void
    // Turns a feature flag on or off; IS_EXPERIMENTAL also shows or hides the chat view.
    readonly setFeatureFlag: (flag: FeatureFlag, on: boolean) => void
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
    // Brings a terminal into view wherever it is, as a click on an Inbox row or a desktop
    // notification about it asks: its project and session to the front, the terminal
    // selected, and on Canvas the camera flown in to it. A panel given turns the sidebar to
    // it in the same step.
    readonly reveal: (terminalId: string, panel?: SidebarPanel) => void
    // Brings a closed terminal back from History as a new terminal in the session on
    // screen, selected; its row leaves the list when the backend says it is restored.
    readonly restoreClosed: (row: ClosedTerminal) => void
    // Brings the open terminal with this id into view, if it is in this project: the session
    // on screen first, then its others.
    readonly revealTerminal: (terminalId: string, projectId: string) => void
    // Opens Preferences where the agents are connected.
    readonly openAgentSettings: (agent: AgentName) => void
    // Closes the terminal, or asks first while closing would lose something: a program
    // running in it, or, where the backend keeps History, an agent mid-turn, one waiting on
    // background work, or one that couldn't be restored. A terminal that leads anyone always
    // asks.
    readonly close: (terminalId: string) => void
    // Answers the pending close confirmation: closes the terminal alone, or, with "team", also
    // everyone it leads, at any depth.
    readonly confirmClose: (scope?: "terminal" | "team") => void
    readonly cancelClose: () => void
    // Answers the crash-loop dialog: start the terminals over, or leave it until the
    // next crash loop.
    readonly retryAfterCrashLoop: () => void
    readonly dismissCrashLoop: () => void
    // Takes this run's one unasked offer for `addon`, which counts it where it is counted
    // (Murmur's, with the runner); false where the other addon took it first.
    readonly takeAddonOffer: (addon: "voice" | "murmur") => boolean
    // Puts Murmur's offer chip on a terminal, or takes it away (null).
    readonly offerNameTo: (target: { readonly context: string; readonly id: string } | null) => void
    // Opens or closes the portable copy's card, which the footer's chip reopens once dismissed.
    readonly setPortableCardOpen: (open: boolean) => void
    // Opens or closes the sandbox notice; opening it closes the update's, which shares its place.
    readonly setSandboxOpen: (open: boolean) => void
    // Notes that the card came up in this run, so it isn't raised by itself again.
    readonly portableCardShown: () => void
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
  const { workspace, ui, chat, navigation, newTerminal, pickDirectory, crashLoop, effects } = ctx
  const { history } = ctx
  const { murmur } = ctx
  const { go, navigateWorkspace } = navigation
  const { set, pulse } = shellEdits(ctx)
  const shell = createShellCommands(ctx)
  const rename = createRenameCommands(ctx)
  const recent = createRecentCommands(ctx)
  // Rearranges the switcher's projects from the latest of both stores.
  const arrange = (
    change: (projects: Workspace["projects"], current: ProjectArrangement) => ProjectArrangement,
  ): void =>
    void ui.update((state) => {
      const projectArrangement = change(workspace.getSnapshot().projects, state.projectArrangement)
      return projectArrangement === state.projectArrangement
        ? state
        : { ...state, projectArrangement }
    })

  const preferences = (): PreferencesValue => ui.getSnapshot().preferences
  // Changes the UI state, starting every terminal afresh on the chat view where the change
  // turns it on or off. It and the terminals answered in are two stores, and no one may see
  // a terminal's chat shown with the old answers: turned off, the UI state goes first, so
  // nothing is shown; turned on, the answers go first, so nothing is shown meanwhile.
  const changeChatView = (change: (state: UiState) => UiState): void => {
    const before = chatViewOn(ui.getSnapshot())
    const after = chatViewOn(change(ui.getSnapshot()))
    if (after && !before) resetAnswering(chat)
    ui.update(change)
    if (before && !after) resetAnswering(chat)
  }

  const setSelected = (terminal: string): void => go({ terminal })
  const select = (id: string, fit = false): void => {
    setSelected(id)
    pulse(fit ? "fit" : "center")
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

  // Rows being restored, by the terminal made for each, from the click until the runner says
  // the row changed (it is restoring, or gone) or the new terminal failed or went. A second
  // click in between would make a second terminal from the same row.
  const restoring = new Map<string, string>()
  const settleRestoring = (): void => {
    if (restoring.size === 0) return
    const rows = history?.state.getSnapshot().rows ?? []
    const terminals = new Map(
      workspace
        .getSnapshot()
        .projects.flatMap((project) =>
          project.history.flatMap((session) =>
            session.state.roster.terminals.map((terminal) => [terminal.id, terminal] as const),
          ),
        ),
    )
    for (const [rowId, terminalId] of restoring) {
      const row = rows.find((each) => each.id === rowId)
      const made = terminals.get(terminalId)
      if (row?.availability.state !== "ready" || !made || made.state === "failed")
        restoring.delete(rowId)
    }
  }
  history?.state.subscribe(settleRestoring)
  workspace.subscribe(settleRestoring)

  const reveal = (terminalId: string, panel?: SidebarPanel): void => {
    const snapshot = workspace.getSnapshot()
    const found = holding(snapshot, terminalId)
    if (!found) return
    const { project, session } = found
    const target = { projectId: project.id, workspaceSessionId: session.id }
    recent.setSwitcher(null)
    // Out from behind any dialog, as the session's front comes from another one.
    if (sameTarget(target, currentTarget(snapshot))) {
      go({ terminal: terminalId, dialog: null, ...(panel && { panel }) })
      pulse("fly")
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
      { terminal: terminalId, dialog: null, ...(panel && { panel }) },
    )
    pulse("fly")
    set("sidebar", false)
  }

  const self: WorkspaceCommands = {
    ...shell,
    ...rename,
    ...recent,
    ...createLayoutCommands(ctx),
    ...createChatCommands(ctx),
    ...createSourceCommands(ctx, { markCreated, pulse }),
    ...createMoveCommands(ctx, {
      peek: shell.peek,
      showTerminals: shell.showTerminals,
      // Bound once the commands are made: going to a moved terminal is revealing it.
      revealTerminal: (terminalId, projectId) => self.revealTerminal(terminalId, projectId),
    }),
    ...createCompanionCommands(ctx, {
      select,
      setSelected,
      markCreated,
      pulse,
    }),
    setSelected,
    select,
    switchSession: (id) => {
      const project = activeProject(workspace.getSnapshot())!
      if (id === project.activeSessionId) return
      if (!project.history.some((session) => session.id === id)) return
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
    renameSession: (id, name) => {
      const project = activeProject(workspace.getSnapshot())!
      workspace.dispatch({
        type: "session/rename",
        projectId: project.id,
        workspaceSessionId: id,
        name,
      })
    },
    moveSession: (id, index) => {
      const project = activeProject(workspace.getSnapshot())!
      workspace.dispatch({
        type: "session/move",
        projectId: project.id,
        workspaceSessionId: id,
        index,
      })
    },
    removeSession: (id) => {
      const project = activeProject(workspace.getSnapshot())!
      if (project.history.length < 2) return
      navigateWorkspace([
        {
          type: "session/remove",
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
      while (project.history.some((session) => session.name === next.name))
        next.name = `${name} (${suffix++})`
      set("freshSession", next.id)
      set("sidebarCollapsed", false)
      // The new session's own terminal tabs, where its first terminal is made.
      navigateWorkspace([{ type: "session/add", projectId: project.id, session: next }], {
        panel: "terminals",
      })
      effects.afterFrame(effects.focusTerminalsCreate)
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
    moveProject: (id, index) =>
      arrange((projects, current) => arrangeMove(projects, current, id, index)),
    stepProject: (id, by) => arrange((projects, current) => arrangeStep(projects, current, id, by)),
    toggleProjectPin: (id) => arrange((projects, current) => togglePin(projects, current, id)),
    pinProjectAt: (id, index) =>
      arrange((projects, current) => pinAt(projects, current, id, index)),
    restoreProjectArrangement: (arrangement) => arrange(() => arrangement),
    updatePreferences: (next) => {
      const snapshot = workspace.getSnapshot()
      const { view } = currentState(snapshot)
      effects.cancelTransition()
      changeChatView((state) => ({ ...state, preferences: next }))
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
    setFeatureFlag: (flag, on) => {
      if (ui.getSnapshot().flags[flag] === on) return
      changeChatView((state) => ({ ...state, flags: { ...state.flags, [flag]: on } }))
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
      pulse(view === "canvas" ? "fit" : "center")
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
      const { view } = currentState(snapshot)
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
          first: true,
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
      const { roster } = session.state
      const opener = roster.terminals.some((each) => each.id === request.from)
        ? request.from
        : undefined
      // Opened by the asking terminal, as its backend will say, so it lists under it at once,
      // after any it opened just before.
      const terminal = {
        ...newTerminal({
          target,
          directory: request.directory,
          launch: request.command === undefined ? {} : { command: request.command },
        }),
        ...(opener !== undefined && { openedBy: opener }),
      }
      const add: WorkspaceAction = {
        type: "terminal/add",
        target,
        terminal,
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
    restoreClosed: (row) => {
      if (restoring.has(row.id)) return
      recent.setSwitcher(null)
      const snapshot = workspace.getSnapshot()
      const { view } = currentState(snapshot)
      const target = currentTarget(snapshot)
      // The backend names and starts it from the row; until it says more the terminal shows
      // the row's folder. No `title`: that would make the row's name the person's own.
      const terminal = newTerminal({ target, directory: row.cwd, closed: row.id })
      restoring.set(row.id, terminal.id)
      const active = rename.activeRename()
      if (active) rename.finishRename(active, true)
      markCreated({ context: currentContext(snapshot), id: terminal.id })
      shell.setKeyboardFocus({ id: terminal.id, view })
      // The sidebar stays on History, where the person is working down the list.
      navigateWorkspace([
        {
          type: "terminal/add",
          target,
          terminal,
          first: true,
        },
      ])
      pulse()
      set("sidebar", false)
    },
    revealTerminal: (terminalId, projectId) => {
      // The row's project holds the one meant, in the session on screen first.
      const snapshot = workspace.getSnapshot()
      const sessions = snapshot.projects.find((project) => project.id === projectId)?.history ?? []
      const current = currentTarget(snapshot).workspaceSessionId
      const ordered = [
        ...sessions.filter((session) => session.id === current),
        ...sessions.filter((session) => session.id !== current),
      ]
      for (const session of ordered) {
        const found = session.state.roster.terminals.find((terminal) => terminal.id === terminalId)
        if (found) return reveal(found.id)
      }
    },
    openAgentSettings: (agent) => {
      recent.setSwitcher(null)
      ui.update((state) => ({ ...state, agentFocus: agent }))
      go({ dialog: "preferences", section: "general" })
    },
    reveal,
    close: (terminalId) => {
      const snapshot = workspace.getSnapshot()
      const closing = currentState(snapshot).roster.terminals.find(
        (terminal) => terminal.id === terminalId,
      )
      // Closing ends the shell, so ask first while it would lose something (see
      // `closeReasons`); the confirmation dialog renders from this and answers with
      // confirmClose or cancelClose.
      if (
        closing &&
        closeReasons(closing, history !== undefined, descendantsOf(snapshot, terminalId).length > 0)
          .length > 0
      )
        return void ui.update((state) => ({
          ...state,
          closing: { context: currentContext(snapshot), id: terminalId },
        }))
      closeNow(terminalId)
    },
    confirmClose: (scope = "terminal") => {
      const pending = ui.getSnapshot().closing
      if (!pending) return
      ui.update((state) => ({ ...state, closing: null }))
      // Only in the session it was asked in; a session change drops it.
      const snapshot = workspace.getSnapshot()
      if (pending.context !== currentContext(snapshot)) return
      // Its team goes first, those furthest down before the lead above them, so each is
      // closed while the one that leads it is still there.
      if (scope === "team")
        for (const id of descendantsOf(snapshot, pending.id).toReversed()) closeNow(id)
      closeNow(pending.id)
    },
    cancelClose: () => ui.update((state) => (state.closing ? { ...state, closing: null } : state)),
    retryAfterCrashLoop: () => {
      ui.update((state) =>
        state.crashLoopDismissed ? { ...state, crashLoopDismissed: false } : state,
      )
      crashLoop?.retry()
    },
    dismissCrashLoop: () => ui.update((state) => ({ ...state, crashLoopDismissed: true })),
    offerNameTo: (nameOffer) => ui.update((state) => ({ ...state, nameOffer })),
    takeAddonOffer: (addon) => {
      const taken = ui.getSnapshot().addonOffer
      if (taken !== null) return taken === addon
      ui.update((state) => ({ ...state, addonOffer: addon }))
      if (addon === "murmur") murmur?.noteOffered()
      return true
    },
    setPortableCardOpen: (portableCardOpen) =>
      ui.update((state) =>
        state.portableCardOpen === portableCardOpen && !(portableCardOpen && state.sandboxOpen)
          ? state
          : {
              ...state,
              portableCardOpen,
              sandboxOpen: portableCardOpen ? false : state.sandboxOpen,
            },
      ),
    setSandboxOpen: (sandboxOpen) =>
      ui.update((state) =>
        state.sandboxOpen === sandboxOpen && !(sandboxOpen && state.portableCardOpen)
          ? state
          : {
              ...state,
              sandboxOpen,
              portableCardOpen: sandboxOpen ? false : state.portableCardOpen,
            },
      ),
    portableCardShown: () => notePortableCardShown(ui.getSnapshot().portable),
  }
  return self
}

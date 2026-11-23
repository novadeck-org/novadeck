import { resetAnswering } from "@novadeck/chat/state"
import { descendantsOf } from "@novadeck/core/derivations"
import type { ProjectWindowTarget } from "@novadeck/core/desktop/project-windows"
import type { AgentName } from "@novadeck/core/harnesses"
import type { ClosedTerminal } from "@novadeck/core/history"
import type { RemovedElsewhere, TerminalRequest, TourRun } from "@novadeck/core/port"
import { hasTile } from "@novadeck/core/roster"
import { activeProject, activeSession, type WorkspaceAction } from "@novadeck/core/state"
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
import {
  answerChatOffer,
  chatViewOn,
  holdChatOffer,
  notePortableCardShown,
  type UiState,
} from "../ui-store"
import { createChatCommands, type ChatCommands } from "./chat"
import { createCompanionCommands, type CompanionCommands } from "./companion"
import type { CommandContext } from "./context"
import { createFileCommands, type FileCommands } from "./files"
import { createLayoutCommands, type LayoutCommands } from "./layout"
import { createMoveCommands, type MoveCommands } from "./moves"
import {
  arrivalWaitMs,
  createProjectWindowCommands,
  type ProjectWindowCommands,
} from "./project-windows"
import { createRecentCommands, type RecentCommands } from "./recent"
import { createRenameCommands, type RenameCommands } from "./rename"
import { folderProject, newWorkspaceSession } from "./sessions"
import { createShellCommands, shellEdits, type ShellCommands } from "./shell"

// `title` and `command` open the terminal named so, running the command at its first prompt,
// as an installer is (see `preferences/installs.ts`).
type AddTerminalOptions = { fromKeyboard?: boolean; title?: string; command?: string }

// Workspace operations shared by the pointer UI and keyboard shortcuts. Each reads the
// latest stores when it runs, so several in one event keep one another's changes.
export type WorkspaceCommands = ShellCommands &
  CompanionCommands &
  MoveCommands &
  FileCommands &
  ChatCommands &
  RenameCommands &
  RecentCommands &
  LayoutCommands &
  ProjectWindowCommands & {
    readonly switchSession: (id: string) => void
    readonly startFresh: () => void
    // Renames a session of the open project; a blank name keeps the old one.
    readonly renameSession: (id: string, name: string) => void
    // Moves a session of the open project to this place in its list.
    readonly moveSession: (id: string, index: number) => void
    // Deletes a session of the open project and closes its terminals; the last one stays.
    readonly removeSession: (id: string) => void
    // What another client removed. Where it was the session or project on screen, the person
    // moves on as their own removal would take them, and is told what went and where they are.
    readonly removedElsewhere: (actions: readonly RemovedElsewhere[]) => void
    // Shows a project: the person's pick. Even one another window shows is shown here, and
    // that window stays as it is.
    readonly switchProject: (next: Project) => void
    // Goes where another window sent this one: the project, and its terminal when it names one,
    // as they are now, with no hand-off back, which only the person's own action makes.
    readonly showProjectHere: (target: ProjectWindowTarget) => Promise<void>
    // Asks the backend for a folder and opens it as a new project; no-op without one.
    readonly openFolder: () => Promise<void>
    // Removes a project and closes its terminals; the last project stays.
    readonly removeProject: (id: string) => void
    // Opens the tour's folder as a project of its own, "Tour", on screen, in place of the
    // projects the backend removed from that folder as it readied the run.
    readonly openTour: (run: Pick<TourRun, "directory" | "removed">) => void
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
    // Saves the preferences. Changing the chat view's setting also answers Agent Chat's offer.
    // `answersOffer: false` is for a change that is no answer to Agent Chat's offer: the welcome
    // dialog's, which answers or holds it as it finishes.
    readonly updatePreferences: (
      next: PreferencesValue,
      options?: { readonly answersOffer?: boolean },
    ) => void
    // Agent Chat's one-time offer: turns the chat view on (which answers it), or answers it
    // with No thanks. Either way it is never made again.
    readonly acceptChatOffer: () => void
    readonly declineChatOffer: () => void
    readonly holdChatOffer: () => void
    // Turns a feature flag on or off.
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
    // Brings a terminal into view wherever it is, as a click on an Inbox entry or a desktop
    // notification about it asks: its project and session to the front, the terminal
    // selected, and on Canvas the camera flown in to it. A panel given turns the sidebar to
    // it in the same step. With project windows on, a terminal of a project another window
    // shows goes to that window, which comes forward; this window stays as it is.
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
  const windows = createProjectWindowCommands(ctx)
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

  const switchHere = (next: Project): void => {
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

  // Counts the moves to a project, so the latest wins over one whose reading is still under way.
  let latestMove = 0
  // The person's pick: this window shows the project, even when another window shows it too,
  // and that window stays as it is.
  const switchProject = (next: Project): void => {
    if (next.id === workspace.getSnapshot().activeProjectId) return
    const pick = ++latestMove
    // With project windows on, a project is read from the runner as it is shown: another
    // window may have changed it since this one loaded it, and the latest pick wins however
    // long its reading took.
    if (!ctx.syncProject || !windows.windowsOn()) return switchHere(next)
    void (async () => {
      await windows.readProject(next.id)
      if (pick === latestMove) switchHere(next)
    })()
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

  const revealHere = (terminalId: string, panel?: SidebarPanel): void => {
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

  // Anything about a project goes to the window that shows it.
  const reveal = (terminalId: string, panel?: SidebarPanel): void => {
    const found = holding(workspace.getSnapshot(), terminalId)
    if (found && windows.shownElsewhere(found.project.id)) {
      windows.handOffTerminal(terminalId)
      return
    }
    revealHere(terminalId, panel)
  }

  // Where another window sent this one. The project is read from the runner first, as it may
  // have changed there, or be one this window never heard of.
  const showProjectHere = async ({ projectId, terminalId }: ProjectWindowTarget): Promise<void> => {
    const move = ++latestMove
    if (ctx.syncProject) await windows.readProject(projectId)
    if (move !== latestMove) return
    const snapshot = workspace.getSnapshot()
    const project = snapshot.projects.find((each) => each.id === projectId)
    if (!project) return
    if (terminalId === undefined) return switchHere(project)
    if (holding(snapshot, terminalId)) return revealHere(terminalId)
    // A terminal this window hasn't heard of yet, as one an agent just opened: the project
    // first, and the terminal once the runner has told of it.
    switchHere(project)
    const stop = workspace.subscribe(() => {
      if (!holding(workspace.getSnapshot(), terminalId)) return
      stop()
      cancel()
      revealHere(terminalId)
    })
    const cancel = effects.after(arrivalWaitMs, stop)
  }

  const self: WorkspaceCommands = {
    ...shell,
    ...windows,
    ...rename,
    ...recent,
    ...createLayoutCommands(ctx),
    ...createChatCommands(ctx),
    ...createFileCommands(ctx, { markCreated, pulse }),
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
    removedElsewhere: (actions) => {
      const before = workspace.getSnapshot()
      const project = activeProject(before)
      const session = activeSession(before)
      const { enabledViews } = preferences()
      const removals = actions.map((action) => ({ ...action, enabledViews }))
      const shown = actions.find((action) =>
        action.type === "project/gone"
          ? action.projectId === project?.id
          : action.workspaceSessionId === session?.id,
      )
      if (!shown) return void workspace.transact(removals)
      // The address follows, as after the person's own removal, in place of the one that went.
      navigateWorkspace(removals, {}, true)
      const after = workspace.getSnapshot()
      const [gone, now] =
        shown.type === "project/gone"
          ? [project?.name, activeProject(after)]
          : [session?.name, activeSession(after)]
      // The last one stays: nothing moved.
      if (!now || now.id === (shown.type === "project/gone" ? project?.id : session?.id)) return
      ui.update((state) => ({
        ...state,
        told: {
          id: effects.newId(),
          said: `“${gone}” was removed elsewhere.`,
          subject: `Showing “${now.name}”.`,
        },
      }))
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
    showProjectHere,
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
    openTour: ({ directory, removed }) => {
      const snapshot = workspace.getSnapshot()
      const project = { id: effects.newId(), name: "Tour", directory }
      const initialSession = newWorkspaceSession(currentState(snapshot), {
        id: effects.newId(),
        now: effects.now(),
      })
      const { enabledViews } = preferences()
      // The removed ones go after the new one is on screen, so the workspace always has one.
      const replaced = snapshot.projects.filter(({ id }) => removed.includes(id))
      navigateWorkspace([
        { type: "project/add", project, activate: true, initialSession, enabledViews },
        ...replaced.map(({ id }): WorkspaceAction => ({
          type: "project/remove",
          projectId: id,
          now: effects.now(),
          enabledViews,
        })),
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
    acceptChatOffer: () => self.updatePreferences({ ...preferences(), chatView: true }),
    declineChatOffer: () => answerChatOffer(ui),
    holdChatOffer: () => holdChatOffer(ui),
    updatePreferences: (next, { answersOffer = true } = {}) => {
      const snapshot = workspace.getSnapshot()
      const { view } = currentState(snapshot)
      effects.cancelTransition()
      // Choosing the chat view's setting in Preferences is an answer to Agent Chat's offer, noted
      // in the same change so no one sees one without the other.
      changeChatView((state) => ({
        ...state,
        preferences: next,
        chatOfferAnswered:
          state.chatOfferAnswered || (answersOffer && next.chatView !== state.preferences.chatView),
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
    setFeatureFlag: (flag, on) => {
      if (ui.getSnapshot().flags[flag] === on) return
      ui.update((state) => ({ ...state, flags: { ...state.flags, [flag]: on } }))
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
      // A terminal that's gone is chosen by no one: the switcher stays for another.
      if (!hasTile(currentState(workspace.getSnapshot()).roster, id)) return
      const mode = recent.visibleSwitcher()?.mode
      recent.setSwitcher(null)
      if (mode === "click")
        shell.setKeyboardFocus({ id, view: currentState(workspace.getSnapshot()).view })
      select(id)
    },
    add: ({ fromKeyboard = false, title, command } = {}) => {
      recent.setSwitcher(null)
      const snapshot = workspace.getSnapshot()
      const project = activeProject(snapshot)!
      const { view } = currentState(snapshot)
      const target = currentTarget(snapshot)
      const terminal = newTerminal({
        target,
        directory: project.directory,
        ...(title !== undefined && { title }),
        ...(command !== undefined && { launch: { command } }),
      })
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
      // A terminal asked to be shown in a project another window shows: it joins its session
      // here, and that window is told to go to it.
      const away = request.focus && windows.shownElsewhere(project.id)
      if (!request.focus || away) workspace.transact([away ? { ...add, select: false } : add])
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
      if (here || (request.focus && !away))
        markCreated({ context: `${project.id}/${session.id}`, id: terminal.id })
      request.answer({ terminalId: terminal.id })
      // An agent's doing: the window goes there, and none comes forward.
      if (away) windows.handOffTerminal(terminal.id, undefined, true)
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
      go({ dialog: "preferences", section: "agents" })
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

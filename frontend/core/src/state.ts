import type { Item, ItemId } from "./items"
import {
  arrive,
  closePane,
  hide,
  minimize,
  moveSlot,
  raise,
  reopen,
  messagesKey,
  topOf,
  type BarKey,
} from "./items/companion-bar"
import {
  closeTerminal,
  moveTerminal,
  dropTile,
  moveItems,
  openInProject,
  openWaiting,
  removeItem,
  undockItem,
  unfresh,
  unwait,
  upsertItem,
  upsertWindow,
  barOf,
  withBar,
} from "./items/transitions"
import { emptyLayout, pruneCanvasLayout, spanTerminal } from "./layout/workspace-layout"
import {
  addTerminal,
  createRoster,
  hasTerminal,
  hasTile,
  hasWindow,
  listFirst,
  listUnderOpener,
  removeWindow,
  renameTerminal,
  reorderTerminals,
  setTerminalProcess,
  setTerminalStatus,
  tilesOf,
  updateTerminal,
} from "./roster"
import type {
  CanvasLayout,
  GridSpan,
  CompanionWindowMeta,
  PreferencesValue,
  Project,
  TerminalLayout,
  TerminalMetadata,
  TerminalRoster,
  TerminalStatus,
  TitleSource,
  ViewMode,
  WindowedView,
  Workspace,
  WorkspaceProject,
  WorkspaceSession,
  WorkspaceState,
  WorkspaceTarget,
} from "./types"

// A terminal that has just come under a lead (its `ledBy` was empty) in the same session
// is listed under that lead, as one spawned with a brief is, so the team's wire spans no
// stranger. Anything else, as a restore or a release, leaves the order alone.
const underNewLead = (
  before: TerminalRoster,
  after: TerminalRoster,
  terminalId: string,
): TerminalRoster => {
  const was = before.terminals.find((each) => each.id === terminalId)
  const now = after.terminals.find((each) => each.id === terminalId)
  if (!was || !now?.ledBy || was.ledBy) return after
  const lead = after.terminals.find((each) => each.id === now.ledBy && each.id !== terminalId)
  return lead ? listUnderOpener(after, terminalId, lead.id) : after
}

export type ValueUpdate<Value> = Value | ((previous: Value) => Value)

type WorkspaceSessionInput = {
  name: string
  state: WorkspaceState
}

type WorkspaceActionMetadata = { id: string; now: number }

export type WorkspaceAction =
  | ({ type: "project/add"; project: Project; enabledViews?: ViewMode[] } & (
      | { activate: true; initialSession: WorkspaceSession }
      | { activate?: false; initialSession?: WorkspaceSession }
    ))
  | {
      type: "project/select"
      projectId: string
      now: number
      initialSession?: WorkspaceSession
      enabledViews?: ViewMode[]
    }
  // The person removes a project, closing its terminals. The last one stays: the
  // workspace always has a project.
  | { type: "project/remove"; projectId: string; now: number; enabledViews?: ViewMode[] }
  | { type: "session/add"; projectId: string; session: WorkspaceSession; activate?: boolean }
  | {
      type: "session/select"
      projectId: string
      workspaceSessionId: string
      now: number
      enabledViews?: ViewMode[]
    }
  // The person renames a session.
  | { type: "session/rename"; projectId: string; workspaceSessionId: string; name: string }
  // The person moves a session to a place in its project's list, as a drag drops it.
  | { type: "session/move"; projectId: string; workspaceSessionId: string; index: number }
  // The person deletes a session, closing its terminals. A project's last one stays: a
  // project always has a session. Deleting the open one opens the one visited last.
  | {
      type: "session/remove"
      projectId: string
      workspaceSessionId: string
      now: number
      enabledViews?: ViewMode[]
    }
  | {
      type: "terminal/add"
      target: WorkspaceTarget
      terminal: TerminalMetadata
      // The terminal that opened it, which it is listed under in the sidebar.
      anchor?: string
      // Listed first in the sidebar, as a terminal the person makes is; without it, or an
      // anchor, it goes last.
      first?: boolean
      // Whether it becomes the session's selection, as it does by default.
      select?: boolean
    }
  // The person renames a terminal; its backend makes it so.
  | { type: "terminal/rename"; target: WorkspaceTarget; terminalId: string; name: string }
  // What the backend says of a terminal now, as its name or directory changed there.
  | {
      type: "terminal/update"
      target: WorkspaceTarget
      terminalId: string
      name?: string
      directory?: string
      handle?: string
      handleGivenAt?: number
      // Null once it has no lead.
      ledBy?: string | null
      openedBy?: string | null
      agentRan?: boolean
      restorable?: boolean
      busy?: boolean
      titleSource?: TitleSource
    }
  | { type: "terminal/close"; target: WorkspaceTarget; terminalId: string }
  // The backend moved a terminal from session `from` to `to` of its project, still running:
  // `terminal` is it as the backend reports it there, with the handle and lead it has now.
  | {
      type: "terminal/move"
      projectId: string
      from: string
      to: string
      terminal: TerminalMetadata
    }
  // The person moves items onto a terminal's bar, each last, docking any from its
  // window; `open` opens the bar's pane to the last of them.
  | {
      type: "item/move"
      target: WorkspaceTarget
      itemIds: readonly ItemId[]
      terminalId: string
      open?: boolean
    }
  // The person undocks an item into a window of its own, placed where it was dropped, if
  // it was.
  | {
      type: "item/undock"
      target: WorkspaceTarget
      itemId: ItemId
      window: CompanionWindowMeta
      canvasGeometry?: CanvasLayout["geometry"][string]
    }
  // The person opened a file in the session's project window, as the backend now has it:
  // the item and the window take its word, and the window is selected.
  | {
      type: "project/open"
      target: WorkspaceTarget
      item: Item
      window: CompanionWindowMeta
      // The session had no such window before this open, so it is placed as asked even if
      // the watch placed it a moment earlier, which the person has not touched.
      made?: boolean
    }
  // The person closes an item, and the window it's in: it's gone.
  | { type: "item/close"; target: WorkspaceTarget; itemId: ItemId }
  // The person looked at items without opening them, as a peek shows them: no longer new.
  | { type: "item/seen"; target: WorkspaceTarget; itemIds: readonly ItemId[] }
  // How the person arranges a terminal's bar: something opened on top of its pane or
  // minimized from it, the pane hidden, something hidden from the bar, its icons
  // reordered. The messages come and come back.
  | { type: "bar/open"; target: WorkspaceTarget; terminalId: string; key: BarKey }
  | { type: "bar/minimize"; target: WorkspaceTarget; terminalId: string; key: BarKey }
  | { type: "bar/close"; target: WorkspaceTarget; terminalId: string }
  | { type: "bar/hide"; target: WorkspaceTarget; terminalId: string; key: BarKey }
  | { type: "bar/arrive"; target: WorkspaceTarget; terminalId: string; key: BarKey }
  | { type: "bar/reopen"; target: WorkspaceTarget; terminalId: string; key: BarKey }
  | {
      type: "bar/move"
      target: WorkspaceTarget
      terminalId: string
      // The bar's icons, each by the keys it stands for.
      slots: readonly (readonly BarKey[])[]
      from: number
      to: number
    }
  // What the backend says of an item now: shown, shown again, moved, renamed.
  | { type: "item/upsert"; target: WorkspaceTarget; item: Item }
  | { type: "item/remove"; target: WorkspaceTarget; itemId: ItemId }
  // What the backend says of a window: there, renamed, or gone.
  | { type: "window/upsert"; target: WorkspaceTarget; window: CompanionWindowMeta }
  | { type: "window/remove"; target: WorkspaceTarget; windowId: string }
  | { type: "terminal/reorder"; target: WorkspaceTarget; tabOrder: string[] }
  | { type: "terminal/status"; target: WorkspaceTarget; terminalId: string; status: TerminalStatus }
  | {
      type: "terminal/process"
      target: WorkspaceTarget
      terminalId: string
      process: string
      argv?: readonly string[]
    }
  | { type: "terminal/select"; target: WorkspaceTarget; terminalId: string }
  | { type: "terminal/visibility"; target: WorkspaceTarget; terminalId: string; hidden: boolean }
  // The person sized a Grid tile to span this many cells.
  | { type: "grid/span"; target: WorkspaceTarget; terminalId: string; span: GridSpan }
  | {
      type: "view/change"
      target: WorkspaceTarget
      view: ViewMode
      enabledViews: ViewMode[]
      rememberWindowed?: boolean
    }
  | { type: "preferences/reconcile"; target: WorkspaceTarget; preferences: PreferencesValue }
  | { type: "canvas/layout"; target: WorkspaceTarget; layout: ValueUpdate<CanvasLayout> }

export const createWorkspaceSession = (
  input: WorkspaceSessionInput,
  metadata: WorkspaceActionMetadata,
): WorkspaceSession => ({
  id: metadata.id,
  name: input.name,
  visitedAt: metadata.now,
  state: input.state,
})

export const createTerminalState = (
  terminals: TerminalMetadata[],
  view: ViewMode,
  windowedView: WindowedView,
  initial: { canvasLayout?: CanvasLayout } = {},
): WorkspaceState => ({
  roster: createRoster(terminals),
  layout: emptyLayout(initial.canvasLayout ? { canvas: initial.canvasLayout } : {}),
  view,
  windowedView,
  selected: terminals[0]?.id ?? "",
  items: [],
  bars: {},
  fresh: {},
  waiting: [],
})

export const createWorkspace = ({
  projects,
  activeProjectId,
}: {
  projects: Project[]
  activeProjectId: string
}): Workspace => ({
  projects: projects.map((project) => ({ ...project, activeSessionId: "", history: [] })),
  activeProjectId,
})

export const activeProject = (workspace: Workspace): WorkspaceProject | undefined =>
  workspace.projects.find((project) => project.id === workspace.activeProjectId)

export const activeSession = (workspace: Workspace): WorkspaceSession | undefined => {
  const project = activeProject(workspace)
  return project?.history.find((session) => session.id === project.activeSessionId)
}

const reconcileView = (state: WorkspaceState, enabledViews: ViewMode[]): WorkspaceState => {
  if (enabledViews.includes(state.view)) return state
  const view = enabledViews.includes(state.windowedView) ? state.windowedView : enabledViews[0]
  return view ? { ...state, view } : state
}

const updateProject = (
  workspace: Workspace,
  projectId: string,
  update: (project: WorkspaceProject) => WorkspaceProject,
): Workspace => {
  const index = workspace.projects.findIndex((project) => project.id === projectId)
  if (index < 0) return workspace
  const project = workspace.projects[index]!
  const next = update(project)
  if (next === project) return workspace
  const projects = [...workspace.projects]
  projects[index] = next
  return { ...workspace, projects }
}

const updateTarget = (
  workspace: Workspace,
  target: WorkspaceTarget,
  update: (state: WorkspaceState) => WorkspaceState,
): Workspace =>
  updateProject(workspace, target.projectId, (project) => {
    const index = project.history.findIndex((session) => session.id === target.workspaceSessionId)
    if (index < 0) return project
    const session = project.history[index]!
    const updated = update(session.state)
    // Whatever selected a terminal, the items waiting for it open.
    const state =
      updated.selected !== session.state.selected && updated.waiting.length
        ? openWaiting(updated)
        : updated
    if (state === session.state) return project
    const history = [...project.history]
    history[index] = { ...session, state }
    return { ...project, history }
  })

const apply = <Value>(value: Value, update: ValueUpdate<Value>): Value =>
  typeof update === "function" ? (update as (previous: Value) => Value)(value) : update

// Every view, in the order the header and arrow keys step through them.
export const viewModes: readonly ViewMode[] = ["focus", "grid", "canvas"]

const enabled = (views?: ViewMode[]): readonly ViewMode[] => (views?.length ? views : viewModes)

const restoreView = (state: WorkspaceState, enabledViews?: ViewMode[]): WorkspaceState => {
  const views = enabled(enabledViews)
  return views.includes(state.view) ? state : { ...state, view: views[0]! }
}

// When the person was last in any of the project's sessions; -Infinity if never.
const lastVisit = (project: WorkspaceProject): number =>
  Math.max(...project.history.map((session) => session.visitedAt ?? -Infinity))

// Visits are stamped in milliseconds, one past what came before, so two never share a time
// and the latest alone says where the person was: the session a project opens, and the
// project the workspace opens. Leaving a session stamps it past its project's visits, and
// arriving stamps the destination past everyone's, the stamp it just left included.
const leaveSession = (project: WorkspaceProject, id: string, now: number): WorkspaceProject =>
  stamp(project, id, Math.max(now, lastVisit(project)) + 1)

const arrival = (projects: readonly WorkspaceProject[], now: number): number =>
  Math.max(now, ...projects.map(lastVisit)) + 1

const stamp = (project: WorkspaceProject, id: string, at: number | null): WorkspaceProject => ({
  ...project,
  history: project.history.map((session) =>
    session.id === id ? { ...session, visitedAt: at } : session,
  ),
})

const updateLayout = (
  state: WorkspaceState,
  change: (layout: TerminalLayout) => TerminalLayout,
): WorkspaceState => {
  const layout = change(state.layout)
  return layout === state.layout ? state : { ...state, layout }
}

export const workspaceReducer = (workspace: Workspace, action: WorkspaceAction): Workspace => {
  switch (action.type) {
    case "project/add": {
      if (action.activate && !action.initialSession) return workspace
      if (workspace.projects.some((project) => project.id === action.project.id)) return workspace
      const initial = action.initialSession
        ? {
            ...action.initialSession,
            state: restoreView(action.initialSession.state, action.enabledViews),
          }
        : undefined
      // A project added in the background isn't visited; one opened leaves the open session.
      const left =
        action.activate && initial
          ? workspace.projects.map((project) =>
              project.id === workspace.activeProjectId
                ? leaveSession(project, project.activeSessionId, initial.visitedAt ?? Date.now())
                : project,
            )
          : workspace.projects
      const arrived = initial && {
        ...initial,
        visitedAt: action.activate ? arrival(left, initial.visitedAt ?? Date.now()) : null,
      }
      return {
        ...workspace,
        activeProjectId: action.activate ? action.project.id : workspace.activeProjectId,
        projects: [
          ...left,
          {
            ...action.project,
            activeSessionId: arrived?.id ?? "",
            history: arrived ? [arrived] : [],
          },
        ],
      }
    }
    case "project/select": {
      const project = workspace.projects.find((item) => item.id === action.projectId)
      if (!project || (!project.history.length && !action.initialSession)) return workspace
      const seeded =
        !project.history.length && action.initialSession
          ? {
              ...project,
              activeSessionId: action.initialSession.id,
              history: [action.initialSession],
            }
          : project
      // The open session of the project being left, unless it is this one.
      const left = workspace.projects.map((item) =>
        item.id !== project.id && item.id === workspace.activeProjectId
          ? leaveSession(item, item.activeSessionId, action.now)
          : item,
      )
      const restored = stamp(seeded, seeded.activeSessionId, arrival(left, action.now))
      const next = {
        ...restored,
        history: restored.history.map((session) =>
          session.id === restored.activeSessionId
            ? { ...session, state: restoreView(session.state, action.enabledViews) }
            : session,
        ),
      }
      const projects = left.map((item) => (item.id === project.id ? next : item))
      return { ...workspace, projects, activeProjectId: action.projectId }
    }
    case "project/remove": {
      const others = workspace.projects.filter((project) => project.id !== action.projectId)
      if (others.length === workspace.projects.length || !others.length) return workspace
      // Removing the open project opens the one visited last, as the switcher would.
      const next =
        action.projectId === workspace.activeProjectId
          ? others
              .filter((project) => project.history.length)
              .toSorted((a, b) => lastVisit(b) - lastVisit(a))[0]
          : undefined
      if (action.projectId === workspace.activeProjectId && !next) return workspace
      const selected = next
        ? workspaceReducer(workspace, {
            type: "project/select",
            projectId: next.id,
            now: action.now,
            ...(action.enabledViews ? { enabledViews: action.enabledViews } : {}),
          })
        : workspace
      return {
        ...selected,
        projects: selected.projects.filter((project) => project.id !== action.projectId),
      }
    }
    case "session/add":
      return updateProject(workspace, action.projectId, (project) => {
        if (project.history.some((session) => session.id === action.session.id)) return project
        // A session added in the background isn't visited; one opened leaves the open one.
        if (action.activate === false)
          return {
            ...project,
            history: [{ ...action.session, visitedAt: null }, ...project.history],
          }
        const now = action.session.visitedAt ?? Date.now()
        const previous = leaveSession(project, project.activeSessionId, now)
        const others = workspace.projects.filter((item) => item.id !== project.id)
        const at = arrival([...others, previous], now)
        return {
          ...previous,
          history: [{ ...action.session, visitedAt: at }, ...previous.history],
          activeSessionId: action.session.id,
        }
      })
    case "session/select":
      return updateProject(workspace, action.projectId, (project) => {
        const session = project.history.find((item) => item.id === action.workspaceSessionId)
        if (!session) return project
        const left =
          project.activeSessionId === session.id
            ? project
            : leaveSession(project, project.activeSessionId, action.now)
        const others = workspace.projects.filter((item) => item.id !== project.id)
        const selected = stamp(left, session.id, arrival([...others, left], action.now))
        return {
          ...selected,
          activeSessionId: session.id,
          history: selected.history.map((item) =>
            item.id === session.id
              ? { ...item, state: restoreView(item.state, action.enabledViews) }
              : item,
          ),
        }
      })
    case "session/rename": {
      const name = action.name.trim()
      if (!name) return workspace
      return updateProject(workspace, action.projectId, (project) =>
        project.history.some(
          (session) => session.id === action.workspaceSessionId && session.name !== name,
        )
          ? {
              ...project,
              history: project.history.map((session) =>
                session.id === action.workspaceSessionId ? { ...session, name } : session,
              ),
            }
          : project,
      )
    }
    case "session/move":
      return updateProject(workspace, action.projectId, (project) => {
        const from = project.history.findIndex(
          (session) => session.id === action.workspaceSessionId,
        )
        if (from < 0) return project
        const to = Math.max(0, Math.min(project.history.length - 1, Math.trunc(action.index)))
        if (to === from) return project
        const history = project.history.toSpliced(from, 1)
        return { ...project, history: history.toSpliced(to, 0, project.history[from]!) }
      })
    case "session/remove": {
      const project = workspace.projects.find((item) => item.id === action.projectId)
      if (!project) return workspace
      const others = project.history.filter((session) => session.id !== action.workspaceSessionId)
      if (others.length === project.history.length || !others.length) return workspace
      // The open session's place goes to the one visited last, else the first listed.
      const next =
        project.activeSessionId === action.workspaceSessionId
          ? (others.toSorted(
              (a, b) => (b.visitedAt ?? -Infinity) - (a.visitedAt ?? -Infinity),
            )[0] ?? others[0]!)
          : undefined
      const selected =
        next && project.id === workspace.activeProjectId
          ? workspaceReducer(workspace, {
              type: "session/select",
              projectId: project.id,
              workspaceSessionId: next.id,
              now: action.now,
              ...(action.enabledViews ? { enabledViews: action.enabledViews } : {}),
            })
          : next
            ? updateProject(workspace, project.id, (item) => ({
                ...item,
                activeSessionId: next.id,
              }))
            : workspace
      return updateProject(selected, project.id, (item) => ({
        ...item,
        history: item.history.filter((session) => session.id !== action.workspaceSessionId),
      }))
    }
    case "terminal/add":
      return updateTarget(workspace, action.target, (state) => {
        const { roster } = state
        if (!action.terminal.id || hasTerminal(roster, action.terminal.id)) return state
        const added = addTerminal(roster, action.terminal)
        return {
          ...state,
          // Under the terminal that opened it in the sidebar; the person's own go first.
          roster:
            action.anchor !== undefined
              ? listUnderOpener(added, action.terminal.id, action.anchor)
              : action.first
                ? listFirst(added, action.terminal.id)
                : added,
          selected: action.select === false ? state.selected : action.terminal.id,
        }
      })
    case "terminal/rename":
      return updateTarget(workspace, action.target, (state) => {
        const roster = renameTerminal(state.roster, action.terminalId, action.name)
        return roster === state.roster ? state : { ...state, roster }
      })
    case "terminal/update":
      return updateTarget(workspace, action.target, (state) => {
        const roster = updateTerminal(state.roster, action.terminalId, {
          ...(action.name !== undefined && { name: action.name }),
          ...(action.directory !== undefined && { directory: action.directory }),
          ...(action.handle !== undefined && { handle: action.handle }),
          ...(action.handleGivenAt !== undefined && { handleGivenAt: action.handleGivenAt }),
          ...(action.ledBy !== undefined && { ledBy: action.ledBy }),
          ...(action.openedBy !== undefined && { openedBy: action.openedBy }),
          ...(action.agentRan !== undefined && { agentRan: action.agentRan }),
          ...(action.restorable !== undefined && { restorable: action.restorable }),
          ...(action.busy !== undefined && { busy: action.busy }),
          ...(action.titleSource !== undefined && { titleSource: action.titleSource }),
        })
        return roster === state.roster
          ? state
          : { ...state, roster: underNewLead(state.roster, roster, action.terminalId) }
      })
    case "terminal/close":
      return updateTarget(workspace, action.target, (state) =>
        closeTerminal(state, action.terminalId),
      )
    case "terminal/move":
      return updateProject(workspace, action.projectId, (project) => {
        const from = project.history.find((session) => session.id === action.from)
        const to = project.history.find((session) => session.id === action.to)
        if (!from || !to || from === to) return project
        const moved = moveTerminal(from.state, to.state, action.terminal)
        if (moved.from === from.state) return project
        return {
          ...project,
          history: project.history.map((session) =>
            session === from
              ? { ...session, state: moved.from }
              : session === to
                ? { ...session, state: moved.to }
                : session,
          ),
        }
      })
    case "item/move":
      return updateTarget(workspace, action.target, (state) => {
        const moved = moveItems(state, action.itemIds, action.terminalId)
        const last = action.itemIds.at(-1)
        const shown = state.items.some((item) => item.id === last)
        return action.open && last && shown
          ? unfresh(
              withBar(moved, action.terminalId, (bar) => raise(bar, last)),
              last,
            )
          : moved
      })
    case "item/undock":
      return updateTarget(workspace, action.target, (state) => undockItem(state, action))
    case "project/open":
      return updateTarget(workspace, action.target, (state) => openInProject(state, action))
    case "item/close":
    case "item/remove":
      return updateTarget(workspace, action.target, (state) => removeItem(state, action.itemId))
    case "item/upsert":
      return updateTarget(workspace, action.target, (state) => upsertItem(state, action.item))
    case "item/seen":
      return updateTarget(workspace, action.target, (state) =>
        action.itemIds.reduce(unfresh, state),
      )
    case "window/upsert":
      return updateTarget(workspace, action.target, (state) => upsertWindow(state, action.window))
    case "window/remove":
      return updateTarget(workspace, action.target, (state) =>
        hasWindow(state.roster, action.windowId)
          ? dropTile(state, action.windowId, removeWindow(state.roster, action.windowId))
          : state,
      )
    case "bar/open":
      return updateTarget(workspace, action.target, (state) => {
        const opened = withBar(state, action.terminalId, (bar) => raise(bar, action.key))
        return action.key === messagesKey ? opened : unfresh(opened, action.key)
      })
    // What the person puts away has had their look: one open where it waits (in Grid) no
    // longer does.
    case "bar/minimize":
      return updateTarget(workspace, action.target, (state) => {
        const minimized = withBar(state, action.terminalId, (bar) => minimize(bar, action.key))
        return action.key === messagesKey ? minimized : unwait(minimized, action.key)
      })
    case "bar/close":
      return updateTarget(workspace, action.target, (state) => {
        const bar = barOf(state, action.terminalId)
        const shown = bar.open ? topOf(bar) : null
        const closed = withBar(state, action.terminalId, closePane)
        return shown === null || shown === messagesKey ? closed : unwait(closed, shown)
      })
    case "bar/hide":
      return updateTarget(workspace, action.target, (state) => {
        const hidden = withBar(state, action.terminalId, (bar) => hide(bar, action.key))
        return action.key === messagesKey ? hidden : unwait(hidden, action.key)
      })
    case "bar/arrive":
      return updateTarget(workspace, action.target, (state) =>
        withBar(state, action.terminalId, (bar) => arrive(bar, action.key)),
      )
    case "bar/reopen":
      return updateTarget(workspace, action.target, (state) =>
        withBar(state, action.terminalId, (bar) => reopen(bar, action.key)),
      )
    case "bar/move":
      return updateTarget(workspace, action.target, (state) =>
        withBar(state, action.terminalId, (bar) =>
          moveSlot(bar, action.slots, action.from, action.to),
        ),
      )
    case "terminal/reorder":
      return updateTarget(workspace, action.target, (state) => {
        const roster = reorderTerminals(state.roster, action.tabOrder)
        return roster === state.roster ? state : { ...state, roster }
      })
    case "terminal/status":
      return updateTarget(workspace, action.target, (state) => {
        const roster = setTerminalStatus(state.roster, action.terminalId, action.status)
        return roster === state.roster ? state : { ...state, roster }
      })
    case "terminal/process":
      return updateTarget(workspace, action.target, (state) => {
        const roster = setTerminalProcess(
          state.roster,
          action.terminalId,
          action.process,
          action.argv,
        )
        return roster === state.roster ? state : { ...state, roster }
      })
    case "terminal/select":
      return updateTarget(workspace, action.target, (state) =>
        (hasTile(state.roster, action.terminalId) || action.terminalId === "") &&
        state.selected !== action.terminalId
          ? { ...state, selected: action.terminalId }
          : state,
      )
    case "terminal/visibility":
      return updateTarget(workspace, action.target, (state) =>
        hasTile(state.roster, action.terminalId) &&
        Boolean(state.layout.hidden[action.terminalId]) !== action.hidden
          ? updateLayout(state, (layout) => ({
              ...layout,
              hidden: { ...layout.hidden, [action.terminalId]: action.hidden },
            }))
          : state,
      )
    case "grid/span":
      return updateTarget(workspace, action.target, (state) =>
        hasTile(state.roster, action.terminalId)
          ? updateLayout(state, (layout) => spanTerminal(layout, action.terminalId, action.span))
          : state,
      )
    case "view/change":
      return updateTarget(workspace, action.target, (state) => {
        if (!action.enabledViews.includes(action.view)) return state
        return {
          ...state,
          view: action.view,
          ...(action.view === "focus" || action.rememberWindowed === false
            ? {}
            : { windowedView: action.view }),
        }
      })
    case "preferences/reconcile":
      return updateTarget(workspace, action.target, (state) =>
        reconcileView(state, action.preferences.enabledViews),
      )
    case "canvas/layout":
      return updateTarget(workspace, action.target, (state) =>
        updateLayout(state, (layout) => {
          const canvas = pruneCanvasLayout(
            apply(layout.canvas, action.layout),
            tilesOf(state.roster),
          )
          return canvas === layout.canvas ? layout : { ...layout, canvas }
        }),
      )
  }
}

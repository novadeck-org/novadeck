import { isOnBar, ownItemWith, windowOfItem, type CompanionItem, type ItemId } from "./companion"
import {
  arrive,
  arriveLast,
  closePane,
  emptyBar,
  hide,
  leave,
  moveSlot,
  openTab,
  reopen,
  messagesKey,
  type Bar,
  type BarKey,
} from "./companion-bar"
import { addCompactGridTerminal } from "./layout/grid-placement"
import {
  emptyLayout,
  placeTerminal,
  pruneCanvasLayout,
  pruneGridLayouts,
  removeFromLayout,
  resizeGridTerminal,
} from "./layout/workspace-layout"
import {
  addTerminal,
  addWindow,
  createRoster,
  hasTerminal,
  hasTile,
  hasWindow,
  orderedTiles,
  removeTerminal,
  removeWindow,
  renameTerminal,
  reorderTerminals,
  setTerminalProcess,
  setTerminalStatus,
  tilesOf,
  updateTerminal,
  updateWindow,
} from "./roster"
import type {
  CanvasLayout,
  CompanionWindowMeta,
  GridLayouts,
  GridRestoreWidths,
  PreferencesValue,
  Project,
  TerminalLayout,
  TerminalMetadata,
  TerminalStatus,
  TitleSource,
  SizePreset,
  ViewMode,
  WindowedView,
  Workspace,
  WorkspaceProject,
  WorkspaceSession,
  WorkspaceState,
  WorkspaceTarget,
} from "./types"

export type ValueUpdate<Value> = Value | ((previous: Value) => Value)

export type WorkspaceSessionInput = {
  name: string
  state: WorkspaceState
}

export type WorkspaceActionMetadata = { id: string; now: number }

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
  | {
      type: "terminal/add"
      target: WorkspaceTarget
      terminal: TerminalMetadata
      gridLayouts?: GridLayouts
      canvasGeometry?: CanvasLayout["geometry"][string]
      // Its size on Canvas, where the caller measured the stage.
      canvasSize?: { width: number; height: number }
      // The terminal to place it beside; the selected one by default.
      anchor?: string
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
      titleSource?: TitleSource
    }
  | { type: "terminal/close"; target: WorkspaceTarget; terminalId: string }
  // The person moves items onto a terminal's bar, each last, docking any from its
  // window; `open` opens the bar's pane to the last of them.
  | {
      type: "item/move"
      target: WorkspaceTarget
      itemIds: readonly ItemId[]
      terminalId: string
      open?: boolean
    }
  // The person undocks an item into a window of its own, placed beside `anchor` (the
  // selected terminal by default) or where it was dropped.
  | {
      type: "item/undock"
      target: WorkspaceTarget
      itemId: ItemId
      window: CompanionWindowMeta
      gridLayouts?: GridLayouts
      canvasGeometry?: CanvasLayout["geometry"][string]
      // Its size on Canvas, where the caller measured the stage.
      canvasSize?: { width: number; height: number }
      anchor?: string
    }
  // The person closes an item, and the window it's in: it's gone.
  | { type: "item/close"; target: WorkspaceTarget; itemId: ItemId }
  // The person looked at items without opening them, as a peek shows them: no longer new.
  | { type: "item/seen"; target: WorkspaceTarget; itemIds: readonly ItemId[] }
  // How the person arranges a terminal's bar: its pane opened to something or closed,
  // something hidden from it, its icons reordered. The messages come and come back.
  | { type: "bar/open"; target: WorkspaceTarget; terminalId: string; key: BarKey }
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
  | { type: "item/upsert"; target: WorkspaceTarget; item: CompanionItem }
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
    }
  | { type: "terminal/select"; target: WorkspaceTarget; terminalId: string }
  | { type: "terminal/visibility"; target: WorkspaceTarget; terminalId: string; hidden: boolean }
  | {
      type: "view/change"
      target: WorkspaceTarget
      view: ViewMode
      enabledViews: ViewMode[]
      rememberWindowed?: boolean
    }
  | { type: "preferences/reconcile"; target: WorkspaceTarget; preferences: PreferencesValue }
  | { type: "canvas/layout"; target: WorkspaceTarget; layout: ValueUpdate<CanvasLayout> }
  | { type: "grid/layouts"; target: WorkspaceTarget; layouts: ValueUpdate<GridLayouts> }
  | {
      type: "grid/size-toggle"
      target: WorkspaceTarget
      terminalId: string
      change: { layouts: GridLayouts; restoreWidths: GridRestoreWidths | null }
    }
  | {
      type: "terminal/size-preset"
      target: WorkspaceTarget
      terminalId: string
      view: WindowedView
      preset: SizePreset
    }

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
  initial: { canvasLayout?: CanvasLayout; gridLayouts?: GridLayouts } = {},
): WorkspaceState => ({
  roster: createRoster(terminals),
  layout: emptyLayout({
    ...(initial.canvasLayout ? { canvas: initial.canvasLayout } : {}),
    ...(initial.gridLayouts ? { grid: initial.gridLayouts } : {}),
  }),
  view,
  windowedView,
  selected: terminals[0]?.id ?? "",
  items: [],
  bars: {},
  fresh: {},
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

export const reconcileView = (state: WorkspaceState, enabledViews: ViewMode[]): WorkspaceState => {
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
    const state = update(session.state)
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

// When the person was last in any of the project's sessions.
const lastVisit = (project: WorkspaceProject): number =>
  Math.max(...project.history.map((session) => session.visitedAt))

const visit = (project: WorkspaceProject, id: string, now: number): WorkspaceProject => ({
  ...project,
  history: project.history.map((session) =>
    session.id === id ? { ...session, visitedAt: now } : session,
  ),
})

const updateLayout = (
  state: WorkspaceState,
  change: (layout: TerminalLayout) => TerminalLayout,
): WorkspaceState => {
  const layout = change(state.layout)
  return layout === state.layout ? state : { ...state, layout }
}

// A terminal or window leaves the session, as `roster` no longer holds it: its layout
// goes, and a selection on it passes to its neighbor in the sidebar.
const dropTile = (state: WorkspaceState, id: string, roster: WorkspaceState["roster"]) => {
  const tiles = orderedTiles(state.roster)
  const index = tiles.findIndex((tile) => tile.id === id)
  if (index < 0) return state
  const remaining = tiles.filter((tile) => tile.id !== id)
  const neighbor =
    state.view === "canvas" ? "" : ((remaining[index] ?? remaining[index - 1])?.id ?? "")
  return {
    ...state,
    roster,
    layout: removeFromLayout(state.layout, id),
    selected: state.selected === id ? neighbor : state.selected,
  }
}

const without = <Value>(record: Readonly<Record<string, Value>>, key: string) => {
  if (!(key in record)) return record
  const { [key]: _gone, ...rest } = record
  return rest
}

const unfresh = (state: WorkspaceState, id: ItemId): WorkspaceState => {
  const fresh = without(state.fresh, id)
  return fresh === state.fresh ? state : { ...state, fresh }
}

const barOf = (state: WorkspaceState, terminalId: string): Bar => state.bars[terminalId] ?? emptyBar

// Changes a terminal's bar, giving one to a terminal that had none.
const withBar = (
  state: WorkspaceState,
  terminalId: string,
  change: (bar: Bar) => Bar,
): WorkspaceState => {
  if (!hasTerminal(state.roster, terminalId)) return state
  const bar = barOf(state, terminalId)
  const next = change(bar)
  return next === bar ? state : { ...state, bars: { ...state.bars, [terminalId]: next } }
}

const barHolding = (item: CompanionItem): string | undefined =>
  "terminalId" in item.holder ? item.holder.terminalId : undefined

const withItem = (state: WorkspaceState, item: CompanionItem): WorkspaceState => ({
  ...state,
  items: state.items.map((each) => (each.id === item.id ? item : each)),
})

// The item leaves its bar, or the window it's in, which closes with it.
const unhold = (state: WorkspaceState, item: CompanionItem): WorkspaceState => {
  const bar = barHolding(item)
  if (bar) return withBar(state, bar, (current) => leave(current, item.id))
  const window = windowOfItem(item)
  return window && hasWindow(state.roster, window)
    ? dropTile(state, window, removeWindow(state.roster, window))
    : state
}

// The item is gone, and the window it was in.
const removeItem = (state: WorkspaceState, id: ItemId): WorkspaceState => {
  const item = state.items.find((each) => each.id === id)
  if (!item) return state
  const left = unhold(unfresh(state, id), item)
  return { ...left, items: left.items.filter((each) => each.id !== id) }
}

const closeTerminal = (state: WorkspaceState, terminalId: string): WorkspaceState => {
  if (!hasTerminal(state.roster, terminalId)) return state
  const closed = dropTile(state, terminalId, removeTerminal(state.roster, terminalId))
  // What its bar held goes with it; what's in windows stays.
  const gone: readonly CompanionItem[] = state.items.filter((item) => isOnBar(item, terminalId))
  return {
    ...gone.reduce((next, item) => unfresh(next, item.id), closed),
    items: gone.length ? state.items.filter((item) => !gone.includes(item)) : state.items,
    bars: without(state.bars, terminalId),
  }
}

// Items moved onto terminal `terminalId`'s bar, each last; one already there keeps its
// place. Something the bar already shows from the same file or page gives way.
const moveItems = (
  state: WorkspaceState,
  ids: readonly ItemId[],
  terminalId: string,
): WorkspaceState => {
  if (!hasTerminal(state.roster, terminalId)) return state
  return ids.reduce((next, id) => {
    const item = next.items.find((each) => each.id === id)
    if (!item || isOnBar(item, terminalId)) return next
    const twin = ownItemWith(
      next.items.filter((each) => each.id !== id),
      terminalId,
      item,
    )
    const cleared = twin ? removeItem(next, twin.id) : next
    const moved = withItem(unhold(cleared, item), { ...item, holder: { terminalId } })
    return withBar(moved, terminalId, (bar) => arriveLast(bar, id))
  }, state)
}

// The person undocks an item into a window of its own, which comes into view selected.
const undockItem = (
  state: WorkspaceState,
  action: Extract<WorkspaceAction, { type: "item/undock" }>,
): WorkspaceState => {
  const { itemId, window, gridLayouts, canvasGeometry, canvasSize } = action
  const item = state.items.find((each) => each.id === itemId)
  if (!item || window.itemId !== itemId || hasTile(state.roster, window.id)) return state
  const left = unhold(unfresh(state, itemId), item)
  const tiles = tilesOf(left.roster)
  const beside = action.anchor ?? left.selected
  return {
    ...withItem(left, { ...item, holder: { windowId: window.id } }),
    roster: addWindow(left.roster, window),
    layout: placeTerminal(left.layout, {
      terminal: window,
      terminals: tiles,
      anchor: tiles.find((tile) => tile.id === beside) ?? tiles.at(-1),
      gridLayouts,
      canvasGeometry,
      canvasSize,
    }),
    selected: window.id,
  }
}

// What the backend says of an item. Something new, or shown again, comes to its bar: it
// opens there when the person asked for it, unless it may hold secrets, and is new
// otherwise, unless the pane is already showing it. A hidden one is back on the bar.
const upsertItem = (state: WorkspaceState, item: CompanionItem): WorkspaceState => {
  const previous = state.items.find((each) => each.id === item.id)
  const listed = previous ? withItem(state, item) : { ...state, items: [...state.items, item] }
  const before = previous && barHolding(previous)
  const after = barHolding(item)
  const moved = previous && before !== after ? unhold(listed, previous) : listed
  const again = !previous || item.version > previous.version
  if (!after) return again ? unfresh(moved, item.id) : moved
  const arrived = withBar(moved, after, (bar) => {
    const here = before === after ? bar : arrive(bar, item.id)
    if (!again) return here
    const back = reopen(here, item.id)
    return item.asked && !item.held ? openTab(back, item.id) : back
  })
  if (!again) return arrived
  const bar = barOf(arrived, after)
  return (item.asked && !item.held) || (bar.open && bar.tab === item.id)
    ? unfresh(arrived, item.id)
    : { ...arrived, fresh: { ...arrived.fresh, [item.id]: true } }
}

// What the backend says of a window. One the person didn't just undock here, as from
// another of their windows, is laid out like a new terminal, without taking the selection.
const upsertWindow = (state: WorkspaceState, window: CompanionWindowMeta): WorkspaceState => {
  if (hasWindow(state.roster, window.id)) {
    const roster = updateWindow(state.roster, window)
    return roster === state.roster ? state : { ...state, roster }
  }
  if (hasTerminal(state.roster, window.id)) return state
  const tiles = tilesOf(state.roster)
  return {
    ...state,
    roster: addWindow(state.roster, window),
    layout: placeTerminal(state.layout, {
      terminal: window,
      terminals: tiles,
      anchor: tiles.at(-1),
      gridLayouts: addCompactGridTerminal(tiles, state.layout.grid, window),
    }),
  }
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
      const projects =
        action.activate && initial
          ? workspace.projects.map((project) =>
              project.id === workspace.activeProjectId
                ? visit(project, project.activeSessionId, initial.visitedAt)
                : project,
            )
          : workspace.projects
      return {
        ...workspace,
        activeProjectId: action.activate ? action.project.id : workspace.activeProjectId,
        projects: [
          ...projects,
          {
            ...action.project,
            activeSessionId: initial?.id ?? "",
            history: initial ? [initial] : [],
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
      const restored = visit(seeded, seeded.activeSessionId, action.now)
      const next = {
        ...restored,
        history: restored.history.map((session) =>
          session.id === restored.activeSessionId
            ? { ...session, state: restoreView(session.state, action.enabledViews) }
            : session,
        ),
      }
      const projects = workspace.projects.map((item) => {
        if (item.id === project.id) return next
        return item.id === workspace.activeProjectId
          ? visit(item, item.activeSessionId, action.now)
          : item
      })
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
        const previous =
          action.activate === false
            ? project
            : visit(project, project.activeSessionId, action.session.visitedAt)
        return {
          ...previous,
          history: [action.session, ...previous.history],
          activeSessionId: action.activate === false ? previous.activeSessionId : action.session.id,
        }
      })
    case "session/select":
      return updateProject(workspace, action.projectId, (project) => {
        const session = project.history.find((item) => item.id === action.workspaceSessionId)
        if (!session) return project
        const visited = visit(project, project.activeSessionId, action.now)
        const selected = visit(visited, session.id, action.now)
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
    case "terminal/add":
      return updateTarget(workspace, action.target, (state) => {
        const { roster } = state
        if (!action.terminal.id || hasTerminal(roster, action.terminal.id)) return state
        const beside = action.anchor ?? state.selected
        const tiles = tilesOf(roster)
        const anchor = tiles.find((tile) => tile.id === beside) ?? tiles.at(-1)
        return {
          ...state,
          roster: addTerminal(roster, action.terminal),
          layout: placeTerminal(state.layout, {
            terminal: action.terminal,
            terminals: tiles,
            anchor,
            gridLayouts: action.gridLayouts,
            canvasGeometry: action.canvasGeometry,
            canvasSize: action.canvasSize,
          }),
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
          ...(action.titleSource !== undefined && { titleSource: action.titleSource }),
        })
        return roster === state.roster ? state : { ...state, roster }
      })
    case "terminal/close":
      return updateTarget(workspace, action.target, (state) =>
        closeTerminal(state, action.terminalId),
      )
    case "item/move":
      return updateTarget(workspace, action.target, (state) => {
        const moved = moveItems(state, action.itemIds, action.terminalId)
        const last = action.itemIds.at(-1)
        const shown = state.items.some((item) => item.id === last)
        return action.open && last && shown
          ? unfresh(
              withBar(moved, action.terminalId, (bar) => openTab(bar, last)),
              last,
            )
          : moved
      })
    case "item/undock":
      return updateTarget(workspace, action.target, (state) => undockItem(state, action))
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
        const opened = withBar(state, action.terminalId, (bar) => openTab(bar, action.key))
        return action.key === messagesKey ? opened : unfresh(opened, action.key)
      })
    case "bar/close":
      return updateTarget(workspace, action.target, (state) =>
        withBar(state, action.terminalId, closePane),
      )
    case "bar/hide":
      return updateTarget(workspace, action.target, (state) =>
        withBar(state, action.terminalId, (bar) => hide(bar, action.key)),
      )
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
        const roster = setTerminalProcess(state.roster, action.terminalId, action.process)
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
    case "grid/layouts":
      return updateTarget(workspace, action.target, (state) =>
        updateLayout(state, (layout) => {
          const grid = pruneGridLayouts(apply(layout.grid, action.layouts), tilesOf(state.roster))
          return grid === layout.grid ? layout : { ...layout, grid }
        }),
      )
    case "grid/size-toggle":
      return updateTarget(workspace, action.target, (state) =>
        hasTile(state.roster, action.terminalId)
          ? updateLayout(state, (layout) =>
              resizeGridTerminal(layout, action.terminalId, action.change, tilesOf(state.roster)),
            )
          : state,
      )
    case "terminal/size-preset":
      return updateTarget(workspace, action.target, (state) =>
        hasTile(state.roster, action.terminalId)
          ? updateLayout(state, (layout) => ({
              ...layout,
              sizePresets: {
                ...layout.sizePresets,
                [action.view]: {
                  ...layout.sizePresets[action.view],
                  [action.terminalId]: action.preset,
                },
              },
            }))
          : state,
      )
  }
}

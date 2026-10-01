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
  createRoster,
  hasTerminal,
  orderedTerminals,
  removeTerminal,
  renameTerminal,
  reorderTerminals,
  setTerminalProcess,
  setTerminalStatus,
} from "./roster"
import type {
  CanvasLayout,
  GridLayouts,
  GridRestoreWidths,
  PreferencesValue,
  Project,
  TerminalLayout,
  TerminalMetadata,
  TerminalStatus,
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
      // The terminal to place it beside; the selected one by default.
      anchor?: string
      // Whether it becomes the session's selection, as it does by default.
      select?: boolean
    }
  | { type: "terminal/rename"; target: WorkspaceTarget; terminalId: string; name: string }
  | { type: "terminal/close"; target: WorkspaceTarget; terminalId: string }
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
  | { type: "grid/minimize"; target: WorkspaceTarget; terminalId: string }

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

const closeTerminal = (state: WorkspaceState, terminalId: string): WorkspaceState => {
  if (!hasTerminal(state.roster, terminalId)) return state
  const terminals = orderedTerminals(state.roster)
  const index = terminals.findIndex((terminal) => terminal.id === terminalId)
  const remaining = terminals.filter((terminal) => terminal.id !== terminalId)
  const neighbor =
    state.view === "canvas" ? "" : ((remaining[index] ?? remaining[index - 1])?.id ?? "")
  return {
    ...state,
    roster: removeTerminal(state.roster, terminalId),
    layout: removeFromLayout(state.layout, terminalId),
    selected: state.selected === terminalId ? neighbor : state.selected,
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
        const anchor =
          roster.terminals.find((terminal) => terminal.id === beside) ?? roster.terminals.at(-1)
        return {
          ...state,
          roster: addTerminal(roster, action.terminal),
          layout: placeTerminal(state.layout, {
            terminal: action.terminal,
            terminals: roster.terminals,
            anchor,
            gridLayouts: action.gridLayouts,
            canvasGeometry: action.canvasGeometry,
          }),
          selected: action.select === false ? state.selected : action.terminal.id,
        }
      })
    case "terminal/rename":
      return updateTarget(workspace, action.target, (state) => {
        const roster = renameTerminal(state.roster, action.terminalId, action.name)
        return roster === state.roster ? state : { ...state, roster }
      })
    case "terminal/close":
      return updateTarget(workspace, action.target, (state) =>
        closeTerminal(state, action.terminalId),
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
        (hasTerminal(state.roster, action.terminalId) || action.terminalId === "") &&
        state.selected !== action.terminalId
          ? { ...state, selected: action.terminalId }
          : state,
      )
    case "terminal/visibility":
      return updateTarget(workspace, action.target, (state) =>
        hasTerminal(state.roster, action.terminalId) &&
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
            state.roster.terminals,
          )
          return canvas === layout.canvas ? layout : { ...layout, canvas }
        }),
      )
    case "grid/layouts":
      return updateTarget(workspace, action.target, (state) =>
        updateLayout(state, (layout) => {
          const grid = pruneGridLayouts(apply(layout.grid, action.layouts), state.roster.terminals)
          return grid === layout.grid ? layout : { ...layout, grid }
        }),
      )
    case "grid/size-toggle":
      return updateTarget(workspace, action.target, (state) =>
        hasTerminal(state.roster, action.terminalId)
          ? updateLayout(state, (layout) =>
              resizeGridTerminal(layout, action.terminalId, action.change, state.roster.terminals),
            )
          : state,
      )
    case "terminal/size-preset":
      return updateTarget(workspace, action.target, (state) =>
        hasTerminal(state.roster, action.terminalId)
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
    case "grid/minimize":
      return updateTarget(workspace, action.target, (state) =>
        hasTerminal(state.roster, action.terminalId)
          ? updateLayout(state, (layout) => ({
              ...layout,
              gridMinimized: {
                ...layout.gridMinimized,
                [action.terminalId]: !layout.gridMinimized[action.terminalId],
              },
            }))
          : state,
      )
  }
}

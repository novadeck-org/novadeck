import { addCompactGridTerminal, initialGridLayouts } from "./layout/grid-placement"
import { placeTerminal, removeFromLayout } from "./layout/workspace-layout"
import { addTerminal } from "./roster"
import {
  createTerminalState,
  createWorkspace,
  createWorkspaceSession,
  workspaceReducer,
} from "./state"
import type {
  CanvasLayout,
  Project,
  TerminalMetadata,
  ViewMode,
  WindowedView,
  Workspace,
  WorkspaceState,
} from "./types"

// How the UI showed a session's terminals, as it saved it: only its own view state, by
// terminal id, never the terminals themselves, which their backend reports. Placements
// aren't kept: every terminal's items start on its own taskbar.
// TODO: keep placements once a backend keeps the companion items they place.
export type RestoredView = Omit<WorkspaceState, "roster" | "placements"> & {
  readonly order: readonly string[]
}

// A session's view state, without its terminals.
export const viewOf = ({
  roster,
  placements: _placements,
  ...view
}: WorkspaceState): RestoredView => ({
  ...view,
  order: roster.order,
})

export type SessionSeed = {
  readonly id: string
  readonly name: string
  // The session's terminals, as the backend reports them, oldest first.
  readonly terminals: readonly TerminalMetadata[]
  readonly canvasLayout?: CanvasLayout
  // When the session was last visited; the seed's time when omitted.
  readonly visitedAt?: number
  // How the session was shown, as saved earlier: terminals it laid out keep their place,
  // order and layout, and the others are laid out after them as new terminals would be.
  // What it kept of terminals the backend no longer has goes. `canvasLayout` is ignored.
  readonly restored?: RestoredView
}
// Every project needs at least one session, and a seed needs at least one project:
// the workspace always has an active project and session to show.
export type ProjectSeed = Project & { readonly sessions: readonly SessionSeed[] }
export type WorkspaceSeed = {
  readonly projects: readonly ProjectSeed[]
  // The project to open; the first one when omitted or unknown.
  readonly activeProjectId?: string
}

export class WorkspaceSeedError extends Error {
  override name = "WorkspaceSeedError"
}

const validate = (seed: WorkspaceSeed): void => {
  if (!seed.projects.length) throw new WorkspaceSeedError("A workspace seed needs a project")
  const empty = seed.projects.find((project) => !project.sessions.length)
  if (empty) throw new WorkspaceSeedError(`Project "${empty.id}" in the seed has no session`)
}

const appendTerminal = (state: WorkspaceState, terminal: TerminalMetadata): WorkspaceState => ({
  ...state,
  roster: addTerminal(state.roster, terminal),
  layout: placeTerminal(state.layout, {
    terminal,
    terminals: state.roster.terminals,
    anchor: state.roster.terminals.at(-1),
    gridLayouts: addCompactGridTerminal(state.roster.terminals, state.layout.grid, terminal),
  }),
})

// Every terminal a saved view kept something of, in any view.
const laidOutIds = (layout: WorkspaceState["layout"], order: readonly string[]): Set<string> =>
  new Set([
    ...order,
    ...Object.keys(layout.canvas.geometry),
    ...Object.keys(layout.canvas.minimized),
    ...Object.values(layout.grid).flatMap((items) => (items ?? []).map((item) => item.i)),
    ...Object.keys(layout.gridRestoreWidths),
    ...Object.keys(layout.gridMinimized),
    ...Object.keys(layout.sizePresets.canvas),
    ...Object.keys(layout.sizePresets.grid),
    ...Object.keys(layout.hidden),
  ])

const restoredState = (
  { order, ...restored }: RestoredView,
  terminals: readonly TerminalMetadata[],
): WorkspaceState => {
  const present = new Set(terminals.map((terminal) => terminal.id))
  const laidOut = laidOutIds(restored.layout, order)
  const gone = [...laidOut, ...order].filter((id) => !present.has(id))
  const layout = gone.reduce(removeFromLayout, restored.layout)
  const kept = terminals.filter((terminal) => laidOut.has(terminal.id))
  const sorted = order.filter((id) => present.has(id))
  // A selected terminal that is gone hands selection on.
  const selected = present.has(restored.selected)
    ? restored.selected
    : ([...sorted, ...terminals.map((terminal) => terminal.id)][0] ?? "")
  const base: WorkspaceState = {
    ...restored,
    layout,
    selected,
    roster: { terminals: kept, order: sorted },
    placements: [],
  }
  return terminals.filter((terminal) => !laidOut.has(terminal.id)).reduce(appendTerminal, base)
}

export type SeedDefaults = {
  readonly view: ViewMode
  readonly windowedView: WindowedView
  readonly now: number
}

// Builds the starting workspace through the same reducer path as new sessions.
// The seed's active project (else the first) is active, and each project opens its
// first listed session.
// Throws WorkspaceSeedError for a seed without projects or a project without sessions.
export const workspaceFromSeed = (seed: WorkspaceSeed, defaults: SeedDefaults): Workspace => {
  validate(seed)
  const projects = seed.projects.map(({ sessions: _sessions, ...project }) => project)
  const active = projects.find((project) => project.id === seed.activeProjectId) ?? projects[0]!
  const seeded = seed.projects.reduce(
    (workspace, project) =>
      project.sessions.reduceRight((next, session) => {
        const terminals = [...session.terminals]
        const state = session.restored
          ? restoredState(session.restored, terminals)
          : createTerminalState(terminals, defaults.view, defaults.windowedView, {
              ...(session.canvasLayout ? { canvasLayout: session.canvasLayout } : {}),
              gridLayouts: initialGridLayouts(terminals, session.canvasLayout?.geometry),
            })
        return workspaceReducer(next, {
          type: "session/add",
          projectId: project.id,
          session: createWorkspaceSession(
            { name: session.name, state },
            { id: session.id, now: defaults.now },
          ),
        })
      }, workspace),
    createWorkspace({ projects, activeProjectId: active.id }),
  )
  // Adding a session marks the one it replaces as visited; keep the seeded times instead.
  const visited = new Map(
    seed.projects.flatMap((project) =>
      project.sessions.flatMap((session) =>
        session.visitedAt === undefined
          ? []
          : [[JSON.stringify([project.id, session.id]), session.visitedAt] as const],
      ),
    ),
  )
  return {
    ...seeded,
    projects: seeded.projects.map((project) => ({
      ...project,
      history: project.history.map((session) => ({
        ...session,
        visitedAt: visited.get(JSON.stringify([project.id, session.id])) ?? session.visitedAt,
      })),
    })),
  }
}

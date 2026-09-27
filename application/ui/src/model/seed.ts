import { addCompactGridTerminal, initialGridLayouts } from "./layout/grid-placement"
import { placeTerminal } from "./layout/workspace-layout"
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

export type SessionSeed = {
  readonly id: string
  readonly name: string
  readonly terminals: readonly TerminalMetadata[]
  readonly canvasLayout?: CanvasLayout
  // When the session was last visited; the seed's time when omitted.
  readonly visitedAt?: number
  // A state saved earlier. `terminals` replaces its roster's metadata: saved terminals
  // keep their place, order and layout, and the others are laid out after them as
  // new terminals would be. `canvasLayout` is ignored.
  readonly restored?: WorkspaceState
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

const restoredState = (
  restored: WorkspaceState,
  terminals: readonly TerminalMetadata[],
): WorkspaceState => {
  const saved = new Set(restored.roster.terminals.map((terminal) => terminal.id))
  const kept = terminals.filter((terminal) => saved.has(terminal.id))
  const base = { ...restored, roster: { ...restored.roster, terminals: kept } }
  return terminals.filter((terminal) => !saved.has(terminal.id)).reduce(appendTerminal, base)
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

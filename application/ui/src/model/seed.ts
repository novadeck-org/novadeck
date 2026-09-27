import { initialGridLayouts } from "./layout/grid-placement"
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
} from "./types"

export type SessionSeed = {
  readonly id: string
  readonly name: string
  readonly terminals: readonly TerminalMetadata[]
  readonly canvasLayout?: CanvasLayout
}
// Every project needs at least one session, and a seed needs at least one project:
// the workspace always has an active project and session to show.
export type ProjectSeed = Project & { readonly sessions: readonly SessionSeed[] }
export type WorkspaceSeed = { readonly projects: readonly ProjectSeed[] }

export class WorkspaceSeedError extends Error {
  override name = "WorkspaceSeedError"
}

const validate = (seed: WorkspaceSeed): void => {
  if (!seed.projects.length) throw new WorkspaceSeedError("A workspace seed needs a project")
  const empty = seed.projects.find((project) => !project.sessions.length)
  if (empty) throw new WorkspaceSeedError(`Project "${empty.id}" in the seed has no session`)
}

export type SeedDefaults = {
  readonly view: ViewMode
  readonly windowedView: WindowedView
  readonly now: number
}

// Builds the starting workspace through the same reducer path as new sessions.
// The first project is active, and each project opens its first listed session.
// Throws WorkspaceSeedError for a seed without projects or a project without sessions.
export const workspaceFromSeed = (seed: WorkspaceSeed, defaults: SeedDefaults): Workspace => {
  validate(seed)
  const projects = seed.projects.map(({ sessions: _sessions, ...project }) => project)
  return seed.projects.reduce(
    (workspace, project) =>
      project.sessions.reduceRight((next, session) => {
        const terminals = [...session.terminals]
        const state = createTerminalState(terminals, defaults.view, defaults.windowedView, {
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
    createWorkspace({ projects, activeProjectId: projects[0]!.id }),
  )
}

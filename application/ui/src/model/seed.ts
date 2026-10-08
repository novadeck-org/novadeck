import { isOnBar, type CompanionItem } from "./companion"
import { arrive, emptyBar, messagesKey, settle, type Bar, type BarKey } from "./companion-bar"
import { addCompactGridTerminal, initialGridLayouts } from "./layout/grid-placement"
import { placeTerminal, removeFromLayout } from "./layout/workspace-layout"
import { addTerminal, addWindow, isWindow, tilesOf } from "./roster"
import {
  createTerminalState,
  createWorkspace,
  createWorkspaceSession,
  workspaceReducer,
} from "./state"
import type {
  CanvasLayout,
  CompanionWindowMeta,
  Project,
  TerminalMetadata,
  Tile,
  ViewMode,
  WindowedView,
  Workspace,
  WorkspaceState,
} from "./types"

// How the UI showed a session's terminals and windows, as it saved it: only its own view
// state, by id, never the terminals, windows or companion items themselves, which their
// backend reports. What's new isn't kept: nothing is new after a reload.
export type RestoredView = Omit<WorkspaceState, "roster" | "items" | "bars" | "fresh"> & {
  readonly order: readonly string[]
  // Each terminal's bar as the person arranged it, where the view kept them.
  readonly bars?: WorkspaceState["bars"]
}

// A session's view state, without its terminals, windows and items.
export const viewOf = ({
  roster,
  items: _items,
  fresh: _fresh,
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
  // Its windows undocked from companions, each with its item among `items`, and what
  // agents showed and the person attached.
  readonly windows: readonly CompanionWindowMeta[]
  readonly items: readonly CompanionItem[]
  readonly canvasLayout?: CanvasLayout
  // When the session was last visited; the seed's time when omitted.
  readonly visitedAt?: number
  // How the session was shown, as saved earlier: terminals it laid out keep their place,
  // order and layout, and the others are laid out after them as new terminals would be.
  // What it kept of terminals, windows and items the backend no longer has goes.
  // `canvasLayout` is ignored.
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

const appendTile = (state: WorkspaceState, tile: Tile): WorkspaceState => {
  const tiles = tilesOf(state.roster)
  return {
    ...state,
    roster: isWindow(tile) ? addWindow(state.roster, tile) : addTerminal(state.roster, tile),
    layout: placeTerminal(state.layout, {
      terminal: tile,
      terminals: tiles,
      anchor: tiles.at(-1),
      gridLayouts: addCompactGridTerminal(tiles, state.layout.grid, tile),
    }),
  }
}

// The session's items, and each terminal's bar: as saved, less what's gone, with what the
// save didn't know after, oldest first. An item whose terminal or window isn't known is
// kept, on no bar, until it is.
const withItems = (
  state: WorkspaceState,
  held: readonly CompanionItem[],
  saved: WorkspaceState["bars"],
): WorkspaceState => {
  const bars = Object.fromEntries(
    state.roster.terminals.flatMap((terminal): [string, Bar][] => {
      const own = held
        .filter((item) => isOnBar(item, terminal.id))
        .toSorted((a, b) => a.shownAt - b.shownAt)
      const ids = new Set<BarKey>(own.map((item) => item.id))
      const kept = settle(
        saved[terminal.id] ?? emptyBar,
        (key) => key === messagesKey || ids.has(key),
      )
      const bar = own.reduce((next, item) => arrive(next, item.id), kept)
      return bar === emptyBar ? [] : [[terminal.id, bar]]
    }),
  )
  return { ...state, items: held, bars }
}

// Every terminal a saved view kept something of, in any view.
const laidOutIds = (layout: WorkspaceState["layout"], order: readonly string[]): Set<string> =>
  new Set([
    ...order,
    ...Object.keys(layout.canvas.geometry),
    ...Object.values(layout.grid).flatMap((items) => (items ?? []).map((item) => item.i)),
    ...Object.keys(layout.gridRestoreWidths),
    ...Object.keys(layout.sizePresets.canvas),
    ...Object.keys(layout.sizePresets.grid),
    ...Object.keys(layout.hidden),
  ])

const restoredState = (
  { order, bars = {}, ...restored }: RestoredView,
  terminals: readonly TerminalMetadata[],
  windows: readonly CompanionWindowMeta[],
  items: readonly CompanionItem[],
): WorkspaceState => {
  const tiles: readonly Tile[] = [...terminals, ...windows]
  const present = new Set(tiles.map((tile) => tile.id))
  const laidOut = laidOutIds(restored.layout, order)
  const gone = [...laidOut, ...order].filter((id) => !present.has(id))
  const layout = gone.reduce(removeFromLayout, restored.layout)
  const sorted = order.filter((id) => present.has(id))
  // A selected terminal that is gone hands selection on.
  const selected = present.has(restored.selected)
    ? restored.selected
    : ([...sorted, ...tiles.map((tile) => tile.id)][0] ?? "")
  const base: WorkspaceState = {
    ...restored,
    layout,
    selected,
    roster: {
      terminals: terminals.filter((terminal) => laidOut.has(terminal.id)),
      windows: windows.filter((window) => laidOut.has(window.id)),
      order: sorted,
    },
    items: [],
    bars: {},
    fresh: {},
  }
  const laid = tiles.filter((tile) => !laidOut.has(tile.id)).reduce(appendTile, base)
  return withItems(laid, items, bars)
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
        const { items, windows } = session
        const state = session.restored
          ? restoredState(session.restored, terminals, windows, items)
          : withItems(
              windows.reduce(
                appendTile,
                createTerminalState(terminals, defaults.view, defaults.windowedView, {
                  ...(session.canvasLayout ? { canvasLayout: session.canvasLayout } : {}),
                  gridLayouts: initialGridLayouts(terminals, session.canvasLayout?.geometry),
                }),
              ),
              items,
              {},
            )
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

import type { SourceState } from "@novadeck/core/source"
import { createStore } from "@novadeck/core/store"
import type { WorkspaceSession } from "@novadeck/core/types"
import type { Work, WorksState } from "@novadeck/core/works"

import type { Owner } from "../sidebar/source-works"

// What the Source panel and the file preview share of the backend's source and works.

// Every terminal in the sessions that has a handle, by id: its handle, and the file its
// running agent's turn wrote last.
export const ownersOf = (sessions: readonly WorkspaceSession[]): ReadonlyMap<string, Owner> =>
  new Map(
    sessions.flatMap((session) =>
      session.state.roster.terminals.flatMap((terminal) =>
        terminal.handle
          ? [
              [
                terminal.id,
                {
                  handle: terminal.handle,
                  wrote: terminal.state === "running" ? terminal.agent?.wrote : undefined,
                },
              ] as const,
            ]
          : [],
      ),
    ),
  )

export const sameOwners = (a: ReadonlyMap<string, Owner>, b: ReadonlyMap<string, Owner>): boolean =>
  a.size === b.size &&
  [...a].every(([id, owner]) => {
    const other = b.get(id)
    return other?.handle === owner.handle && other.wrote === owner.wrote
  })

// What a backend without a source reads in its place; its panel isn't drawn.
export const noSource = createStore<SourceState>({ projects: {} })

// What a backend without works reads in its place; its panel isn't drawn.
export const noWorks = createStore<WorksState>({ works: [], synced: true, reported: true })

export const sameWorks = (a: readonly Work[], b: readonly Work[]): boolean =>
  a.length === b.length && a.every((work, index) => Object.is(work, b[index]))

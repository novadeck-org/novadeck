import type { ClosedTerminal, History, HistoryState } from "@novadeck/core/history"
import { createStore } from "@novadeck/core/store"
import type { Runner } from "@novadeck/runner-client"

import { consume } from "./streams"

// The runner's History: every closed terminal as `history.watch` reports them, and a
// project's rows read afresh when the pane opens, which also checks their availability.

export type RunnerHistory = {
  readonly history: History
  // Follows the rows; once started it goes on across reconnections.
  readonly follow: () => void
  readonly stop: () => void
}

// Newest first, the rows of every project.
const byClosedAt = (rows: Iterable<ClosedTerminal>): ClosedTerminal[] =>
  [...rows].toSorted((a, b) => b.closedAt - a.closedAt)

export const createRunnerHistory = (
  calls: Runner["history"],
  // Keeps a call the backend waits for before it stops, as its other calls are.
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerHistory => {
  const state = createStore<HistoryState>({ rows: [] })
  const held = new Map<string, ClosedTerminal>()
  // The rows of a sequence the runner has yet to finish with `synced`; until then `held` stays.
  let incoming: Map<string, ClosedTerminal> | undefined
  let stream: AsyncIterableIterator<unknown, undefined> | undefined
  // For each `list` in flight, the ids the stream has touched since it began: the stream's
  // word on them is newer than the answer's.
  const listing = new Set<Set<string>>()
  const touch = (ids: Iterable<string>): void => {
    for (const id of ids) for (const touched of listing) touched.add(id)
  }

  const publish = (): void => {
    state.update(() => ({ rows: byClosedAt(held.values()) }))
  }

  const follow = (): void => {
    if (stream) return
    const changes = calls.watch()
    stream = changes
    void consume(changes, (change) => {
      if (stream !== changes) return
      switch (change.type) {
        case "reset": {
          incoming = new Map()
          break
        }
        case "changed": {
          touch([change.closed.id])
          if (incoming) incoming.set(change.closed.id, change.closed)
          else {
            held.set(change.closed.id, change.closed)
            publish()
          }
          break
        }
        case "removed": {
          touch([change.id])
          incoming?.delete(change.id)
          if (held.delete(change.id)) publish()
          break
        }
        case "synced": {
          // What the runner didn't report this time no longer exists.
          if (incoming) {
            touch([...held.keys(), ...incoming.keys()])
            held.clear()
            for (const [id, row] of incoming) held.set(id, row)
            incoming = undefined
          }
          publish()
          break
        }
      }
    })
  }

  const stop = (): void => {
    const done = stream
    stream = undefined
    incoming = undefined
    void done?.return?.()?.catch?.(() => {})
  }

  const history: History = {
    state,
    list: async (projectId) => {
      const touched = new Set<string>()
      listing.add(touched)
      try {
        const rows = await track(calls.list({ projectId }))
        // This project's rows are these, except any the stream spoke of while the call was
        // out: it is newer than the answer.
        for (const [id, row] of held)
          if (row.projectId === projectId && !touched.has(id)) held.delete(id)
        for (const row of rows) if (!touched.has(row.id)) held.set(row.id, row)
        publish()
        return byClosedAt([...held.values()].filter((row) => row.projectId === projectId))
      } finally {
        listing.delete(touched)
      }
    },
  }
  return { history, follow, stop }
}

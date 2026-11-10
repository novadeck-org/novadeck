import { createStore } from "@novadeck/core/store"
import { read, type Work, type Works, type WorksState } from "@novadeck/core/works"
import { hasCode, type Runner } from "@novadeck/runner-client"

import { consume } from "./streams"

// The runner's Works: every terminal's work against main as `works.watch` reports them,
// and the person's looks at and shows of them.

export type RunnerWorks = {
  readonly works: Works
  // Ends the following for good, as the backend closes.
  readonly stop: () => void
}

export const createRunnerWorks = (
  calls: Runner["works"],
  // Keeps a call the backend waits for before it stops, as its other calls are.
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerWorks => {
  const state = createStore<WorksState>({ works: [], synced: false })
  // By terminal.
  const held = new Map<string, Work>()
  // The works of a sequence the runner has yet to finish with `synced`; until then `held` stays.
  let incoming: Map<string, Work> | undefined
  let stream: AsyncIterableIterator<unknown, undefined> | undefined
  // Whether the runner has reported every work since the following began.
  let synced = false
  // How many are watching, and whether the backend has closed.
  let watchers = 0
  let closed = false

  const publish = (): void => {
    state.update(() => ({ works: [...held.values()], synced }))
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
          if (incoming) incoming.set(change.work.terminalId, change.work)
          else {
            held.set(change.work.terminalId, change.work)
            publish()
          }
          break
        }
        case "removed": {
          incoming?.delete(change.terminalId)
          if (held.delete(change.terminalId)) publish()
          break
        }
        case "synced": {
          // What the runner didn't report this time no longer exists.
          if (incoming) {
            held.clear()
            for (const [terminalId, work] of incoming) held.set(terminalId, work)
            incoming = undefined
          }
          synced = true
          publish()
          break
        }
      }
    })
  }

  // Stops following; what was last reported stays, no longer synced.
  const unfollow = (): void => {
    const done = stream
    stream = undefined
    incoming = undefined
    void done?.return?.()?.catch?.(() => {})
    if (synced) {
      synced = false
      publish()
    }
  }

  const stop = (): void => {
    closed = true
    watchers = 0
    unfollow()
  }

  const works: Works = {
    state,
    // Follows the works from the first watcher until the last one lets go, and goes on across
    // reconnections meanwhile.
    watch: () => {
      if (closed) return () => {}
      watchers += 1
      if (watchers === 1) follow()
      let released = false
      return () => {
        if (released) return
        released = true
        watchers -= 1
        if (watchers === 0) unfollow()
      }
    },
    look: (terminalId) => {
      // Read at once, as the person sees it; the runner's next report of the work confirms it.
      const work = held.get(terminalId)
      if (work) {
        held.set(terminalId, read(work))
        publish()
      }
      void track(calls.look(terminalId)).catch((error: unknown) => {
        // A work that is gone has nothing left to read.
        if (hasCode(error, "NOT_FOUND")) return
        console.error("Novadeck could not tell the runner a work was read:", error)
      })
    },
    show: async (terminalId) => (await track(calls.show(terminalId))).itemId,
  }
  return { works, stop }
}

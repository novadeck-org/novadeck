import { createStore } from "@novadeck/core/store"
import {
  madeOne,
  read,
  type Work,
  type Works,
  type WorksMade,
  type WorksState,
} from "@novadeck/core/works"
import { hasCode, type Runner } from "@novadeck/runner-client"

import { consume } from "./streams"

// The runner's Works: every tracked worktree's work against main as `works.watch` reports
// them, and the person's looks at, shows and closes of them.

export type RunnerWorks = {
  readonly works: Works
  // Reads the works once, as the backend starts, so the Worktrees panel lists them as soon as it
  // opens instead of after the runner's first read of every worktree: follows them until the
  // runner has reported every one, then lets go. The panel's own watch brings them up to date.
  // It also follows the worktrees made, from the backend's start. A backend that starts again
  // after `stop` (StrictMode's second mount, in development) is followed again, the panels that
  // still watch included.
  readonly readOnce: () => void
  // Ends the following, as the backend closes; `readOnce` begins it again.
  readonly stop: () => void
}

// How long the works' changes are gathered before the store hears them: the items of one poll
// come within a few milliseconds of each other, and a poll comes every few seconds.
export const worksBatchMs = 50

export const createRunnerWorks = (
  calls: Runner["works"],
  // Keeps a call the backend waits for before it stops, as its other calls are.
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerWorks => {
  const state = createStore<WorksState>({ works: [], synced: false, reported: false })
  // The worktrees made since the backend started, counted by project for as long as it lives:
  // the stream carries one small event per worktree and the runner reads no git for it. Followed
  // from `readOnce`, so a backend made and never started (StrictMode's throwaway) holds no made
  // stream. The works are another matter: a `watch` before the first start follows them, as
  // nothing has stopped yet.
  const made = createStore<WorksMade>(new Map())
  let madeStream: AsyncIterableIterator<unknown, undefined> | undefined
  const followMade = (): void => {
    if (madeStream) return
    const next = calls.made()
    madeStream = next
    void consume(next, ({ projectId }) => {
      // An event from a stream that was let go counts for nothing.
      if (madeStream !== next) return
      made.update((counts) => madeOne(counts, projectId))
    })
  }
  // By root.
  const held = new Map<string, Work>()
  // The works of a sequence the runner has yet to finish with `synced`; until then `held` stays.
  let incoming: Map<string, Work> | undefined
  let stream: AsyncIterableIterator<unknown, undefined> | undefined
  // Whether the runner has reported every work since the following began, and at least once.
  let synced = false
  let reported = false
  // Lets go of the watch `readOnce` holds, once the runner has reported every work.
  let readDone: (() => void) | undefined
  // How many are watching, and whether the backend has stopped: until it starts again they are
  // counted but not followed.
  let watchers = 0
  let stopped = false

  // Set while changes wait to be published.
  let pending: ReturnType<typeof setTimeout> | undefined

  const publish = (): void => {
    if (pending !== undefined) clearTimeout(pending)
    pending = undefined
    state.update(() => ({ works: [...held.values()], synced, reported }))
  }

  // A runner poll tells each work it changed as its own item, one after the other. They're
  // published together, `worksBatchMs` after the first, so a poll that changed ten worktrees
  // redraws the panels that read the works once, not ten times.
  const publishSoon = (): void => {
    pending ??= setTimeout(publish, worksBatchMs)
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
          if (incoming) incoming.set(change.work.root, change.work)
          else {
            held.set(change.work.root, change.work)
            publishSoon()
          }
          break
        }
        case "removed": {
          incoming?.delete(change.root)
          if (held.delete(change.root)) publishSoon()
          break
        }
        case "synced": {
          // What the runner didn't report this time no longer exists.
          if (incoming) {
            held.clear()
            for (const [root, work] of incoming) held.set(root, work)
            incoming = undefined
          }
          synced = true
          reported = true
          publish()
          const done = readDone
          readDone = undefined
          done?.()
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
    // Changes still waiting are published now, with the following's end.
    if (synced || pending !== undefined) {
      synced = false
      publish()
    }
  }

  const stop = (): void => {
    stopped = true
    // The first read's hold on the following goes with it.
    const release = readDone
    readDone = undefined
    release?.()
    void madeStream?.return?.()?.catch?.(() => {})
    madeStream = undefined
    unfollow()
  }

  const works: Works = {
    state,
    made,
    // Follows the works from the first watcher until the last one lets go, and goes on across
    // reconnections meanwhile.
    watch: () => {
      watchers += 1
      if (watchers === 1 && !stopped) follow()
      let released = false
      return () => {
        if (released) return
        released = true
        watchers -= 1
        if (watchers === 0 && !stopped) unfollow()
      }
    },
    look: (root) => {
      // Read at once, as the person sees it; the runner's next report of the work confirms it.
      const work = held.get(root)
      if (work) {
        held.set(root, read(work))
        publish()
      }
      void track(calls.look(root)).catch((error: unknown) => {
        // A work that is gone has nothing left to read.
        if (hasCode(error, "NOT_FOUND")) return
        console.error("Novadeck could not tell the runner a work was read:", error)
      })
    },
    show: async (root, terminalId) => (await track(calls.show(root, terminalId))).itemId,
    close: (root, force) => track(calls.close(root, force)),
    preview: (projectId, path) => track(calls.preview(projectId, path)),
    fetch: (projectId) => track(calls.fetch(projectId)),
  }
  const readOnce = (): void => {
    followMade()
    // A start after a stop reads once more, whatever was reported before: the works may have
    // changed while nothing followed. What was reported stays shown until the new report replaces it.
    const again = stopped
    if (stopped) {
      // Started again: what the watchers still hold is followed afresh.
      stopped = false
      if (watchers > 0) follow()
    }
    if (readDone || (reported && !again)) return
    readDone = works.watch()
  }
  return { works, readOnce, stop }
}

import type { Grant, Grants } from "@novadeck/core/grants"
import { createStore } from "@novadeck/core/store"
import type { Grant as WireGrant } from "@novadeck/protocol"

// The person's live grants, as the runner lists them: its `grants.watch` sends every live
// grant again on each change, and an ended one drops out. Followed while the Inbox is bound.

export type GrantStreams = {
  readonly watch: () => AsyncIterableIterator<WireGrant[], undefined>
  readonly revoke: (id: string) => Promise<void>
}

export type RunnerGrants = Grants & {
  // Follows the runner's grants until the returned function stops it.
  readonly start: () => () => void
}

export const createRunnerGrants = (
  streams: GrantStreams | undefined,
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerGrants => {
  const state = createStore<readonly Grant[]>([])
  return {
    state,
    // A revoke that fails (the grant already ended, or the runner is away) changes nothing: the
    // list says what is live.
    revoke: (id) => {
      track(Promise.resolve().then(() => streams?.revoke(id))).catch(() => {})
    },
    start: () => {
      if (!streams) return () => {}
      let stopped = false
      const stream = streams.watch()
      void (async () => {
        try {
          for await (const snapshot of stream) {
            if (stopped) return
            state.update(() => snapshot)
          }
        } catch {
          // The client opens the stream again after a reconnection.
        }
        if (!stopped) state.update(() => [])
      })()
      return () => {
        stopped = true
        state.update(() => [])
        void stream.return?.()?.catch?.(() => {})
      }
    },
  }
}

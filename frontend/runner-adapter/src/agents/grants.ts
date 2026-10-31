import type { Grant, Grants } from "@novadeck/core/grants"
import { answerFailure } from "@novadeck/core/inbox/tracker"
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
  const failed = createStore<Readonly<Record<string, string>>>({})
  const forgive = (id: string): void => {
    failed.update((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
    )
  }
  // A failure stays only while its grant is listed.
  const prune = (live: readonly Grant[]): void => {
    failed.update((current) => {
      const kept = Object.entries(current).filter(([key]) => live.some(({ id }) => id === key))
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
    })
  }
  return {
    state,
    failed,
    // A revoke that fails (the runner is away, or the grant already ended) says so beside the
    // grant; the list says what is live.
    revoke: (id) => {
      forgive(id)
      track(Promise.resolve().then(() => streams?.revoke(id))).catch((error: unknown) => {
        failed.update((current) => ({ ...current, [id]: answerFailure(error) }))
      })
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
            prune(snapshot)
          }
        } catch {
          // The client opens the stream again after a reconnection.
        }
        if (!stopped) {
          state.update(() => [])
          prune([])
        }
      })()
      return () => {
        stopped = true
        state.update(() => [])
        prune([])
        void stream.return?.()?.catch?.(() => {})
      }
    },
  }
}

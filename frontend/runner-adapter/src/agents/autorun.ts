import { type AutoRun, noAutoRun, type AutoRunState } from "@novadeck/core/autorun"
import { answerFailure } from "@novadeck/core/inbox/tracker"
import { createStore } from "@novadeck/core/store"
import type { AutoRunState as WireState } from "@novadeck/protocol"

// cmd's AutoRun as the runner reports it: its `autorun.watch` sends the state again on each
// change. Followed while the Inbox is bound, as the grants are.

export type AutoRunStreams = {
  readonly watch: () => AsyncIterableIterator<WireState, undefined>
  readonly silence: (value: string) => Promise<void>
  readonly undo: () => Promise<void>
  readonly dismiss: () => Promise<void>
}

export type RunnerAutoRun = AutoRun & {
  // Follows the runner's state until the returned function stops it.
  readonly start: () => () => void
}

export const createRunnerAutoRun = (
  streams: AutoRunStreams | undefined,
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerAutoRun => {
  const state = createStore<AutoRunState>(noAutoRun)
  const failed = createStore<string | null>(null)
  // A call that fails to reach the runner says so; the state says what the runner did.
  const call = (work: (live: AutoRunStreams) => Promise<void>): void => {
    failed.update(() => null)
    track(Promise.resolve().then(() => (streams ? work(streams) : undefined))).catch(
      (error: unknown) => failed.update(() => answerFailure(error)),
    )
  }
  return {
    state,
    failed,
    silence: (value) => call((live) => live.silence(value)),
    undo: () => call((live) => live.undo()),
    dismiss: () => call((live) => live.dismiss()),
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
        if (!stopped) state.update(() => noAutoRun)
      })()
      return () => {
        stopped = true
        state.update(() => noAutoRun)
        void stream.return?.()?.catch?.(() => {})
      }
    },
  }
}

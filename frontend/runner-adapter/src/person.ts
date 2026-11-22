import type { PersonPreferences } from "@novadeck/core/port"
import type { Runner } from "@novadeck/runner-client"

import { consume } from "./streams"

type Listener = Parameters<PersonPreferences["subscribe"]>[0]

/**
 * The person's preferences as the runner keeps them (`preferences.*`), for the app's
 * person.ts: every value once the runner says, then each change another client made. This
 * client's own changes, which the runner tells back, are known already and skipped.
 */
export const runnerPreferences = (
  runner: Pick<Runner, "preferences">,
  track: <T>(work: Promise<T>) => Promise<T>,
): {
  readonly preferences: PersonPreferences
  readonly follow: () => void
  readonly stop: () => void
} => {
  // This client's own name for its changes, which the runner passes on.
  const writer = crypto.randomUUID()
  const listeners = new Set<Listener>()
  // Every value, once the runner first said.
  let known: Record<string, string | null> | undefined
  let stream: AsyncIterableIterator<unknown> | undefined
  return {
    preferences: {
      set: (key, value) =>
        void track(runner.preferences.set(key, value, writer)).catch(() => {
          // Kept here; the runner's next word on it, as after a reconnection, settles it.
        }),
      subscribe: (listener) => {
        listeners.add(listener)
        if (known) listener({ ...known }, true)
        return () => listeners.delete(listener)
      },
    },
    follow: () => {
      if (stream) return
      const changes = runner.preferences.watch()
      stream = changes
      void consume(changes, (change) => {
        if (stream !== changes) return
        const first = known === undefined
        known = { ...known, ...change.values }
        if (!first && change.writer === writer) return
        for (const listener of listeners) listener(first ? { ...known } : change.values, first)
      })
    },
    stop: () => {
      const ended = stream
      stream = undefined
      void ended?.return?.()?.catch(() => {})
    },
  }
}

import type { PersonPreferences } from "@novadeck/core/port"
import type { Runner } from "@novadeck/runner-client"

import { consume } from "./streams"

type Listener = Parameters<PersonPreferences["subscribe"]>[0]

/**
 * The person's preferences as the runner keeps them (`preferences.*`), for the app's
 * person.ts: every value once the runner says, then each change another client made. This
 * client's own changes, which the runner tells back, are known already and skipped; so is
 * another's change of a key this client is changing meanwhile, which the runner then has
 * after it. A change the runner couldn't take, as while the link was down, is sent again
 * once it tells anything, as after the reconnection, and stands over what it says.
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
  // Changes under way, by key, and each key's latest, so only its last change is sent again.
  const pending = new Map<string, number>()
  const latest = new Map<string, number>()
  const unsent = new Map<string, string | null>()
  let sends = 0
  const send = (key: string, value: string | null): void => {
    const mine = (sends += 1)
    latest.set(key, mine)
    unsent.delete(key)
    pending.set(key, (pending.get(key) ?? 0) + 1)
    void track(runner.preferences.set(key, value, writer))
      .catch(() => {
        if (latest.get(key) === mine) unsent.set(key, value)
      })
      .finally(() => {
        const left = (pending.get(key) ?? 1) - 1
        if (left > 0) pending.set(key, left)
        else pending.delete(key)
      })
  }
  return {
    preferences: {
      set: send,
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
        if (first) {
          for (const listener of listeners) listener({ ...known }, true)
          return
        }
        // The runner is reachable: what it couldn't take goes again.
        for (const [key, value] of unsent) send(key, value)
        if (change.writer === writer) return
        const taken = Object.fromEntries(
          Object.entries(change.values).filter(([key]) => !pending.has(key)),
        )
        if (Object.keys(taken).length === 0) return
        for (const listener of listeners) listener(taken, false)
      })
    },
    stop: () => {
      const ended = stream
      stream = undefined
      void ended?.return?.()?.catch(() => {})
    },
  }
}

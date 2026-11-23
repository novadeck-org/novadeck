import type { ChatPermit, Conversation, Conversations } from "@novadeck/core/conversation"
import { createStore, type Store } from "@novadeck/core/store"
import { terminalKeyId } from "@novadeck/core/terminals/registry"
import type { PermitHolders } from "@novadeck/demo/inbox"

import type { DemoAction } from "./types"

// The shipping gate's standing permits, which no demo agent is given: the selected agent's chat
// and its Inbox gain one of each kind the runner sends (given by the person's words, or by Allow
// on the gate's card; not yet used, or used and standing only for a retry), and the demo takes
// one back as the runner does, after the moment a call takes, or fails as it armed to.

const hour = 60 * 60_000
const minute = 60_000

const given = (
  id: string,
  title: string,
  quote: string | null,
  used: boolean,
  now: number,
): ChatPermit => ({
  id,
  title,
  quote,
  givenAt: now - (used ? 5 * minute : 0),
  until: used ? now + 9 * minute : now + 12 * hour,
  usedAt: used ? now - minute : null,
})

// Wraps the demo's conversations so a chat holds the permits the panel gave it, and takes them
// back.
export const createChatPermits = (): {
  readonly wrap: (conversations: Conversations) => Conversations & PermitHolders
  readonly actions: readonly DemoAction[]
} => {
  const standing = new Map<string, readonly ChatPermit[]>()
  const listeners = new Map<string, Set<() => void>>()
  const views = new Map<string, Store<Conversation>>()
  let failing = false
  // The terminals that hold some, for the demo's Inbox to follow.
  const holders = createStore<ReadonlySet<string>>(new Set())
  const tell = (id: string): void => {
    holders.update(
      () => new Set([...standing].filter(([, each]) => each.length > 0).map(([at]) => at)),
    )
    listeners.get(id)?.forEach((listener) => listener())
  }
  const give =
    (make: (now: number) => ChatPermit): DemoAction["run"] =>
    ({ selected, note }) => {
      const key = selected()
      if (!key) return note("Select a terminal first.")
      const id = terminalKeyId(key)
      standing.set(id, [...(standing.get(id) ?? []), make(Date.now())])
      tell(id)
    }
  const next = (): string => `permit-${standing.size}-${Date.now()}`
  return {
    wrap: (conversations) => ({
      ...conversations,
      permitHolders: holders,
      takeBack: async (key, permit) => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (failing) {
          failing = false
          throw new Error("Couldn't take it back. Try again.")
        }
        const id = terminalKeyId(key)
        const before = standing.get(id) ?? []
        if (!before.some((each) => each.id === permit)) throw new Error("It had already ended.")
        standing.set(
          id,
          before.filter((each) => each.id !== permit),
        )
        tell(id)
      },
      conversation: (key) => {
        const id = terminalKeyId(key)
        const known = views.get(id)
        if (known) return known
        const base = conversations.conversation(key)
        let last:
          | { base: Conversation; permits: readonly ChatPermit[]; out: Conversation }
          | undefined
        const view: Store<Conversation> = {
          getSnapshot: () => {
            const snapshot = base.getSnapshot()
            const added = standing.get(id)
            if (!added || added.length === 0) return snapshot
            if (last?.base === snapshot && last.permits === added) return last.out
            const out = { ...snapshot, permits: [...snapshot.permits, ...added] }
            last = { base: snapshot, permits: added, out }
            return out
          },
          subscribe: (listener) => {
            const set = listeners.get(id) ?? new Set()
            set.add(listener)
            listeners.set(id, set)
            const stop = base.subscribe(listener)
            return () => {
              set.delete(listener)
              stop()
            }
          },
        }
        views.set(id, view)
        return view
      },
    }),
    actions: [
      {
        label: "Permit by words, not used",
        hint: "Selected agent's chat and Inbox: Allowed, 'On your words' with a quote, 'Stands until … or its first use', Take back",
        run: give((now) =>
          given(
            next(),
            "Merge PR #1190 into main",
            "yes, merge it once the checks pass",
            false,
            now,
          ),
        ),
      },
      {
        label: "Permit by card, not used",
        hint: "Selected agent's chat and Inbox: Allowed, 'You allowed it on its card', Take back",
        run: give((now) => given(next(), "Open a PR into main", null, false, now)),
      },
      {
        label: "Permit by words, used",
        hint: "Selected agent's chat and Inbox: 'Used at … · ends …' over the quote, Take back",
        run: give((now) => given(next(), "Push to origin/main", "push it", true, now)),
      },
      {
        label: "Permit by card, used",
        hint: "Selected agent's chat and Inbox: 'Used at … · ends …' over 'You allowed it on its card'",
        run: give((now) => given(next(), "Land work on main", null, true, now)),
      },
      {
        label: "Next Take back fails",
        hint: "The next Take back says it couldn't, on the card and the sheet, and the permit stands",
        run: () => {
          failing = true
        },
      },
      {
        label: "Back to normal",
        hint: "The selected agent's permits go, as they would on ending, and Take back works",
        run: ({ selected, note }) => {
          failing = false
          const key = selected()
          if (!key) return note("Select a terminal first.")
          standing.delete(terminalKeyId(key))
          tell(terminalKeyId(key))
        },
      },
    ],
  }
}

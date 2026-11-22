import type { InboxEntry, SettledHow } from "@novadeck/core/inbox"

import { demoEntries, demoInboxIds, demoInboxEntriesAll } from "./fixtures"

const minute = 60_000

// The entries the debug panel adds already resolved, one for each way an entry ends, as the Inbox
// keeps them as history: the fixture each is made from, how it ended, with what words, and how
// long ago it was added and how long it took to end.
type Ended = {
  readonly from: string
  readonly how: SettledHow
  readonly answer?: string
  readonly added: number
  readonly took: number
}

export const demoResolved = {
  dialogs: [
    {
      from: demoInboxIds.codexPermission,
      how: "answered",
      answer: "Yes, proceed",
      added: 50,
      took: 4,
    },
    {
      from: demoInboxIds.plan,
      how: "answered",
      answer: "Yes, and manually approve edits",
      added: 46,
      took: 6,
    },
    { from: demoInboxIds.question, how: "terminal", added: 41, took: 3 },
    { from: demoInboxIds.rawDialog, how: "gone", added: 37, took: 9 },
  ],
  asks: [
    {
      from: demoInboxIds.webhook,
      how: "answered",
      answer: "Our own retries: 6 tries with backoff over an hour",
      added: 33,
      took: 8,
    },
    { from: demoInboxIds.preview, how: "dismissed", added: 29, took: 5 },
    { from: demoInboxIds.text, how: "replied", added: 25, took: 4 },
    { from: demoInboxIds.login, how: "answered", answer: "I've logged in", added: 21, took: 7 },
    { from: demoInboxIds.entryAsk, how: "ended", added: 18, took: 2 },
  ],
  updates: [
    { from: demoInboxIds.told, how: "read", added: 15, took: 3 },
    { from: demoInboxIds.done, how: "read", added: 12, took: 2 },
  ],
  novadeck: [
    { from: demoInboxIds.held, how: "released", added: 10, took: 3 },
    { from: demoInboxIds.heldSenderGone, how: "stopped", added: 8, took: 2 },
    { from: demoInboxIds.limit, how: "worked", added: 7, took: 3 },
    { from: demoInboxIds.failed, how: "worked", added: 5, took: 2 },
    { from: demoInboxIds.waits, how: "delivered", added: 4, took: 1 },
    { from: demoInboxIds.stuck, how: "worked", added: 3, took: 1 },
  ],
} as const satisfies Record<string, readonly Ended[]>

// The id a fixture has once it is resolved.
export const demoResolvedId = (from: string): string => `resolved:${from}`

// The resolved entries of a group, as they stand at `now`: the newest ended last in the group.
export const demoResolvedEntries = (now: number, ended: readonly Ended[]): InboxEntry[] => {
  const all = [...demoInboxEntriesAll(now), ...demoEntries(now)]
  return ended.flatMap((each): InboxEntry[] => {
    const found = all.find((entry) => entry.id === each.from)
    if (!found) return []
    const at = now - each.added * minute
    return [
      {
        ...found,
        id: demoResolvedId(each.from),
        at,
        stopped: false,
        seen: true,
        settled: {
          how: each.how,
          at: at + each.took * minute,
          ...("answer" in each && each.answer ? { answer: each.answer } : {}),
        },
      },
    ]
  })
}

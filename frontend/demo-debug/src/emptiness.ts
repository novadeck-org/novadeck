import type { ChatRecords, Conversation, Conversations } from "@novadeck/core/conversation"
import type { Store } from "@novadeck/core/store"
import { terminalKeyId } from "@novadeck/core/terminals/registry"
import { idleScreen as idle, unreadDialogScreen as dialog } from "@novadeck/demo/agents/screens"

import type { DemoAction } from "./types"

// What the chat of a terminal says when it has nothing to show, which the demo's agents never
// get to on their own: the panel sets what the runner would have said of the session's record
// and the agent's screen, and the chat shows its words for it in place of the terminal's items.
// Display only: the terminal's own conversation goes on beneath, and "Back to normal" gives it
// back.
type Facts = Pick<Conversation, "records" | "rest" | "turned" | "screen" | "slice">

const read: ChatRecords = { state: "read", lines: 0, unread: 0 }

const states: readonly {
  readonly label: string
  readonly hint: string
  readonly facts: Facts
}[] = [
  {
    label: "Empty, proven",
    hint: "Nothing said yet. Send a prompt below.: the record was read and holds nothing, no turn, the agent idle",
    facts: { records: read, rest: true, turned: false, screen: idle, slice: null },
  },
  {
    label: "Transcript not found",
    hint: "Says Novadeck can't find or read the transcript, with a Show terminal button above the agent's screen",
    facts: { records: { state: "lost" }, rest: true, turned: false, screen: idle, slice: null },
  },
  {
    label: "Records unreadable",
    hint: "Says the transcript holds records Novadeck couldn't read, with a Show terminal button above the agent's screen",
    facts: {
      records: { state: "read", lines: 12, unread: 12 },
      rest: true,
      turned: false,
      screen: idle,
      slice: null,
    },
  },
  {
    label: "Turn with no records",
    hint: "Says the agent has worked in this session, but its transcript gave nothing",
    facts: { records: { state: "absent" }, rest: true, turned: true, screen: idle, slice: null },
  },
  {
    label: "Dialog on its screen",
    hint: "Says something of the agent's own may be on its screen and that its rows are below, where the dialog draws live, its keys on the title's line, once",
    facts: { records: read, rest: false, turned: false, screen: dialog, slice: dialog },
  },
  {
    label: "Waiting on the screen",
    hint: "Loading the conversation…: the record is read, the screen not looked at yet",
    facts: { records: read, rest: null, turned: false, screen: null, slice: null },
  },
]

// Wraps the demo's conversations so a chat shows what the panel set, and the panel's actions.
export const createEmptyChats = (): {
  readonly wrap: (conversations: Conversations) => Conversations
  readonly actions: readonly DemoAction[]
} => {
  const set = new Map<string, Facts>()
  const listeners = new Map<string, Set<() => void>>()
  const views = new Map<string, Store<Conversation>>()
  const tell = (id: string): void => listeners.get(id)?.forEach((listener) => listener())
  return {
    wrap: (conversations) => ({
      ...conversations,
      conversation: (key) => {
        const id = terminalKeyId(key)
        const known = views.get(id)
        if (known) return known
        const base = conversations.conversation(key)
        let last: { base: Conversation; facts: Facts; out: Conversation } | undefined
        const view: Store<Conversation> = {
          getSnapshot: () => {
            const snapshot = base.getSnapshot()
            const facts = set.get(id)
            if (!facts || snapshot.session === null) return snapshot
            if (last?.base === snapshot && last.facts === facts) return last.out
            const out = { ...snapshot, ...facts, loaded: true, items: [], requests: [] }
            last = { base: snapshot, facts, out }
            return out
          },
          subscribe: (listener) => {
            const listening = listeners.get(id) ?? new Set()
            listening.add(listener)
            listeners.set(id, listening)
            const stop = base.subscribe(listener)
            return () => {
              listening.delete(listener)
              stop()
            }
          },
        }
        views.set(id, view)
        return view
      },
    }),
    actions: [
      ...states.map(({ label, hint, facts }) => ({
        label,
        hint,
        run: ({ selected, note }: Parameters<DemoAction["run"]>[0]) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          set.set(terminalKeyId(key), facts)
          tell(terminalKeyId(key))
        },
      })),
      {
        label: "Back to normal",
        hint: "The selected agent's own conversation shows again",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          set.delete(terminalKeyId(key))
          tell(terminalKeyId(key))
        },
      },
    ],
  }
}

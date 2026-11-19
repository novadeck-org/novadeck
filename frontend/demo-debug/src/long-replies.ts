import type { ChatItem, Conversation, Conversations } from "@novadeck/core/conversation"
import type { Store } from "@novadeck/core/store"
import { terminalKeyId } from "@novadeck/core/terminals/registry"

import type { DemoAction } from "./types"

// Agent Chat folds an agent's long replies, all but its latest, with Fold long replies on
// (Preferences > Experimental). The demo's agents reply in a few lines, so the panel plays it: the
// selected agent's chat gains three finished turns, each a prompt and a long reply.

// A long reply, as an agent writes one: a summary, then headings and lists, about 60 lines at a
// chat's width.
const replyText = (topic: string): string =>
  [
    `I looked into ${topic} and changed three things. The tests pass, and nothing else moved.`,
    "## What changed",
    ...[1, 2, 3, 4, 5, 6].map(
      (step) =>
        `- Step ${step}: read where ${topic} starts, followed it through the store and the view, and moved the check to the one place every caller passes, so it runs once instead of at each call site.`,
    ),
    "## Why",
    `Before this, ${topic} ran its check in each caller, and two of them disagreed about an empty value. One treated it as missing and the other as zero, so the same input could show two different results depending on where you looked. Keeping one check in one place makes them agree, and the next caller can't forget it.`,
    "## What I didn't do",
    ...[1, 2, 3, 4].map(
      (step) =>
        `- Left part ${step} of ${topic} as it was: it reads the old shape on purpose, for settings saved before this change, and moving it would need a migration with a test of its own.`,
    ),
    "## How I checked",
    "```sh\npnpm test\npnpm typecheck\npnpm lint\n```",
    `All three pass. I also ran the app and tried ${topic} by hand with an empty value, a zero and a long one.`,
  ].join("\n\n")

const item = (id: string, at: number, role: "user" | "assistant", text: string): ChatItem => ({
  id,
  at,
  role,
  kind: "text",
  text,
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
})

const topics = ["the cart total", "the sign-in redirect", "the export button"]

// The turns a chat gains, played at `at`: each a prompt and its long reply, a minute apart.
export const longTurns = (at: number): readonly ChatItem[] =>
  topics.flatMap((topic, index) => {
    const when = at - (topics.length - index) * 60_000
    return [
      item(`long-reply-prompt-${index}`, when, "user", `Can you look at ${topic}?`),
      item(`long-reply-${index}`, when + 30_000, "assistant", replyText(topic)),
    ]
  })

// Wraps the demo's conversations so a chat gains the turns the panel played, and the panel's
// actions that play and undo them.
export const createLongReplies = (): {
  readonly wrap: (conversations: Conversations) => Conversations
  readonly actions: readonly DemoAction[]
} => {
  const played = new Map<string, readonly ChatItem[]>()
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
        let last: { base: Conversation; turns: readonly ChatItem[]; out: Conversation } | undefined
        const view: Store<Conversation> = {
          getSnapshot: () => {
            const snapshot = base.getSnapshot()
            const turns = played.get(id)
            if (!turns) return snapshot
            if (last?.base === snapshot && last.turns === turns) return last.out
            const out = { ...snapshot, items: [...snapshot.items, ...turns] }
            last = { base: snapshot, turns, out }
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
        label: "Long replies",
        hint: "Selected agent's chat gains three turns with long replies: with Fold long replies on (Preferences > Experimental), the first two fold, the latest shows in full",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          played.set(terminalKeyId(key), longTurns(Date.now()))
          tell(terminalKeyId(key))
        },
      },
      {
        label: "Long replies gone",
        hint: "The added turns go",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          played.delete(terminalKeyId(key))
          tell(terminalKeyId(key))
        },
      },
    ],
  }
}

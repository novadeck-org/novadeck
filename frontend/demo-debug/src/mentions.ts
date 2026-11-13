import type { ChatItem, Conversation, Conversations } from "@novadeck/core/conversation"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import type { Store } from "@novadeck/core/store"
import { terminalKeyId } from "@novadeck/core/terminals/registry"
import type { Workspace } from "@novadeck/core/types"

import { othersOf, sessionTarget } from "./terminals"
import type { DemoAction } from "./types"

// A project gives a handle to a new terminal an hour after its terminal closes, so a chat entry
// that names `@fox` from before may mean a terminal that is gone. The chat draws such a mention
// as plain words; one written since the terminal that holds the handle now was given it, in its
// hue. The demo's terminals keep their handles for good, so the panel plays it: another
// terminal of the session is given its handle just now, and the selected terminal's chat gains
// an entry from hours before that names the handle, and one from after.

// How long before the handle was given the old entry was written.
const earlierMs = 3 * 60 * 60_000

// What the chat of a terminal gains, as the panel played it: the handle's holder and the two
// entries that name it.
export type StaleMention = {
  readonly handle: string
  readonly items: readonly ChatItem[]
}

const entry = (id: string, at: number, text: string): ChatItem => ({
  id,
  at,
  role: "assistant",
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

// The entries a chat gains when `handle` was given to a terminal at `given`: one written well
// before, one just after.
export const staleMention = (handle: string, given: number): StaleMention => ({
  handle,
  items: [
    entry(
      "stale-mention-old",
      given - earlierMs,
      `I handed the review to @${handle} and it found two problems.`,
    ),
    entry(
      "stale-mention-new",
      given + 1_000,
      `@${handle} is a new terminal now, so I asked it again: please review the change.`,
    ),
  ],
})

// The terminal that holds the handle in the session: the first other live one with a handle,
// given it at `given`; nothing where there is none.
export const regiven = (
  workspace: Workspace | undefined,
  key: TerminalKey,
  given: number,
): { readonly action: BackendAction; readonly handle: string } | undefined => {
  const other = othersOf(workspace, key).find((terminal) => terminal.handle)
  if (!other?.handle) return undefined
  return {
    action: {
      type: "terminal/update",
      target: sessionTarget(key),
      terminalId: other.id,
      handleGivenAt: given,
    },
    handle: other.handle,
  }
}

// The terminals given their handle again, to be undone: their handle was given long ago.
export const restored = (
  workspace: Workspace | undefined,
  key: TerminalKey,
): readonly BackendAction[] =>
  othersOf(workspace, key)
    .filter((terminal) => terminal.handleGivenAt)
    .map((terminal) => ({
      type: "terminal/update",
      target: sessionTarget(key),
      terminalId: terminal.id,
      handleGivenAt: 0,
    }))

// Wraps the demo's conversations so a chat gains the entries the panel played, and the panel's
// actions that play and undo it.
export const createStaleMentions = (): {
  readonly wrap: (conversations: Conversations) => Conversations
  readonly actions: readonly DemoAction[]
} => {
  const played = new Map<string, StaleMention>()
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
        let last: { base: Conversation; mention: StaleMention; out: Conversation } | undefined
        const view: Store<Conversation> = {
          getSnapshot: () => {
            const snapshot = base.getSnapshot()
            const mention = played.get(id)
            if (!mention) return snapshot
            if (last?.base === snapshot && last.mention === mention) return last.out
            const out = { ...snapshot, items: [...snapshot.items, ...mention.items] }
            last = { base: snapshot, mention, out }
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
        label: "Handle given again",
        hint: "Selected agent's chat gains an old entry naming a session-mate's @handle, plain, and a new one, in its hue",
        run: ({ selected, workspace, dispatch, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          const given = Date.now()
          const again = regiven(workspace(), key, given)
          if (!again) return note("Add another terminal with a handle first.")
          dispatch?.([again.action])
          played.set(terminalKeyId(key), staleMention(again.handle, given))
          tell(terminalKeyId(key))
        },
      },
      {
        label: "Handle back to its first terminal",
        hint: "The added entries go; its holder was given it long ago",
        run: ({ selected, workspace, dispatch, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          const undo = restored(workspace(), key)
          if (undo.length > 0) dispatch?.(undo)
          played.delete(terminalKeyId(key))
          tell(terminalKeyId(key))
        },
      },
    ],
  }
}

import { valueOf, withValue, type ByTerminal } from "./by-terminal"

// What the person opened or shut in a terminal's chat, by session context and terminal id: a long
// message, a tool line, a run of calls, by the key its row gives (see ./use-open). The rows go and
// come back as the log draws again (a chat back in sight starts again from its last blocks, the
// screen shown in its place and back, another view), so what they show can't live in them.
export type ChatOpened = ByTerminal<Readonly<Record<string, boolean>>>

export const noChatOpened: ChatOpened = {}

const none: Readonly<Record<string, boolean>> = {}

// How many a terminal keeps: the latest the person touched.
const kept = 200

export const chatOpenedOf = (
  opened: ChatOpened,
  context: string,
  id: string,
): Readonly<Record<string, boolean>> => valueOf(opened, context, id) ?? none

// The map with `key` opened or shut in the terminal's chat, the latest touched last; the same map
// where it already was.
export const withOpened = (
  opened: ChatOpened,
  context: string,
  id: string,
  key: string,
  open: boolean,
): ChatOpened => {
  const before = chatOpenedOf(opened, context, id)
  if (before[key] === open) return opened
  const { [key]: _before, ...rest } = before
  const entries = [...Object.entries(rest), [key, open] as const].slice(-kept)
  return withValue(opened, context, id, Object.fromEntries(entries))
}

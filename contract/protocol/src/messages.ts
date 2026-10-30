import { z } from "zod"

import { agentName } from "./agents.js"
import { id } from "./fields.js"
import { handle } from "./terminals.js"

const messageId = z.string().regex(/^m-[a-z0-9]{1,32}$/)
export const threadId = z.string().regex(/^t-[a-z0-9]{1,32}$/)

// Where a message is on its way: waiting for its recipient's next hook (`queued`), handed
// to a hook that has yet to confirm it printed it (`leased`), printed to the recipient's
// harness (`delivered`), held while messaging is paused or its thread awaits the
// person's release (`held`), or no longer deliverable since its recipient's session
// ended (`gone`), until that same session runs there again.
const messageState = z.enum(["queued", "leased", "delivered", "held", "gone"])

// How a terminal's agent can take a message now: no agent there (`unbound`), a session
// bound that has had no turn yet (`fresh`), the agent's own empty input prompt showing
// with no turn yet, its session bound or about to bind (`ready`), a turn running
// (`working`), a turn that ended normally with the prompt known empty (`settled`), the
// doorbell waking it (`ringing`), the person busy at the prompt (`drafting`), or a turn
// that ended without a normal stop (`unknown`).
const deliveryState = z.enum([
  "unbound",
  "fresh",
  "ready",
  "working",
  "settled",
  "ringing",
  "drafting",
  "unknown",
])

// Who a message is from or for: a terminal's agent, by the terminal's handle, or the
// person, whose Inbox answers reach agents as messages and whose Inbox history shows the
// agents' asks to them. A sender's `agent` is null where none had bound there; a
// recipient's is always the agent it was for.
const personParty = z.strictObject({ kind: z.literal("person") })
const messageParty = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent"), handle, agent: agentName.nullable() }),
  personParty,
])
const messageRecipient = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent"), handle, agent: agentName }),
  personParty,
])

// One message between two terminals' agents, as sent: its text up to 4 KB, its place in
// its thread, and where it is on its way. `held` says why a held message waits: messaging
// is paused, or its thread awaits the person's `messages.release`.
const agentMessage = z.strictObject({
  id: messageId,
  thread: threadId,
  hop: z.number().int().positive(),
  from: messageParty,
  to: messageRecipient,
  text: z.string().max(65_536),
  sentAt: z.number(),
  state: messageState,
  held: z.enum(["paused", "release"]).nullable(),
  deliveredAt: z.number().nullable(),
  // Only the runner creates Inbox history and responses. Ordinary agent messages have none.
  inbox: z.enum(["ask", "tell", "done", "answer"]).optional(),
  inboxState: z
    .enum(["open", "answered", "read", "withdrawn", "dismissed", "gone", "undelivered"])
    .optional(),
})

// A thread between a terminal and one other: the other party (an agent, or the person), how
// many messages it has had, its idle messages in a row (sent while neither end worked),
// whether it is held until the person releases or stops it and why (`loop`, or null for a
// hold carried over from the twelve-message rule, or none), and its messages, oldest first.
const messageThread = z.strictObject({
  id: threadId,
  peer: messageParty,
  hops: z.number().int().nonnegative(),
  idle: z.number().int().nonnegative(),
  held: z.boolean(),
  heldFor: z.enum(["loop"]).nullable(),
  // Whether the person's stop of it is in force: a send between the pair is refused, for 10
  // minutes after the later of the stop and its last message.
  stopped: z.boolean(),
  messages: z.array(agentMessage).max(1000),
})

// Why the doorbell can't ring an idle agent whose messages wait, as it saw: its activity
// saying a turn runs (`working`), a prompt the harness shows queued (`queued`), its box in
// shell mode (`shell`), text in its input box (`draft`), a dialog, picker or other screen
// that isn't its prompt (`dialog`), a question it waits on the person for (`asking`), rings
// that failed (`failed`), or a terminal not at the agent's prompt (`away`).
const deliveryWaits = z.enum([
  "working",
  "queued",
  "shell",
  "draft",
  "dialog",
  "asking",
  "failed",
  "away",
])

// How long a message may wait for an idle agent, the agent idle all along, before the hold is
// raised: an Inbox item for the person, and a word to its sender, in milliseconds.
export const longHoldMs = 3 * 60_000

// `messages.list`: a terminal's handle, how its agent can take messages now, why the doorbell
// can't ring it if it is idle (`waits`), since when the longest-held message for its idle
// agent has waited (`waitsSince`, epoch milliseconds: the later of when the agent last went
// idle and when the message last came to wait; null with none), whether messaging is
// paused, and every thread it is in, latest first.
export const terminalMessages = z.strictObject({
  terminalId: id,
  handle,
  delivery: deliveryState,
  waits: deliveryWaits.nullable(),
  waitsSince: z.number().int().nonnegative().nullable(),
  paused: z.boolean(),
  threads: z.array(messageThread).max(1000),
})

export type MessageState = z.infer<typeof messageState>
export type DeliveryState = z.infer<typeof deliveryState>
export type MessageParty = z.infer<typeof messageParty>
export type MessageRecipient = z.infer<typeof messageRecipient>
export type MessageThread = z.infer<typeof messageThread>
export type TerminalMessages = z.infer<typeof terminalMessages>

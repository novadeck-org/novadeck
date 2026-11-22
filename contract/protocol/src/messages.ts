import { z } from "zod"

import { agentNameRead } from "./agents.js"
import { id } from "./fields.js"
import { openEnum, openUnion } from "./open.js"
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
// A state a UI doesn't know reads as `unknown`.
const deliveryState = openEnum(
  ["unbound", "fresh", "ready", "working", "settled", "ringing", "drafting", "unknown"],
  { since: 3, unknown: { fallback: "unknown" } },
)

// Who a message is from or for: a terminal's agent, by the terminal's id (`terminalId`; its
// `handle` is how the party reads, and may be another terminal's later), or the person, whose Inbox answers reach agents as messages and whose Inbox history shows the
// agents' asks to them. A sender's `agent` is null where none had bound there; a
// recipient's is always the agent it was for.
const personParty = z.strictObject({ kind: z.literal("person") })
const messageParty = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    terminalId: id,
    handle,
    agent: agentNameRead.nullable(),
  }),
  personParty,
])
const messageRecipient = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent"), terminalId: id, handle, agent: agentNameRead }),
  personParty,
])

// One message between two terminals' agents, as sent: its text (an agent's runs up to 4 KB;
// the bound leaves room for the Inbox history and responses the runner writes), its place
// in its thread, and where it is on its way. `held` says why a held message waits: messaging
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

// One of Novadeck's own notices that reached a terminal's agent inside a delivery of messages: its
// text as sent (`Novadeck · <Kind>` header and all, which `@novadeck/protocol/notices` reads) and
// when it was sent and delivered. Notices are no conversation: they stand outside the threads, and
// only the chat's rings hold them, by when each was delivered. Only delivered ones are listed.
const deliveredNotice = z.strictObject({
  id: messageId,
  text: z.string().max(65_536),
  sentAt: z.number(),
  deliveredAt: z.number(),
})

// The most characters of a message a ring's part holds, and the most parts of a ring.
export const ringTextMost = 240
export const ringPartsMost = 8

// How many rings and deliveries a terminal's listing keeps: the rows of a ring or block that may
// still be in the terminal's scrollback (1000 lines), the oldest dropped first.
export const listedRingsMost = 100
export const listedDeliveriesMost = 40
export const listedDeliveryIdsMost = 64

// How many delivered notices a listing holds, the latest ones, as it holds a thread's last messages.
export const listedNoticesMost = 200

// What a ring says, for the terminal view to draw over the doorbell line the harness shows: one part
// per message of the ring, in delivery order, its words cut to `ringTextMost` characters (the view
// shows the first words of one row). An agent's message has its sender's handle; a notice is Novadeck's
// own, as sent, header and all (`@novadeck/protocol/notices` reads it); `person` is an Inbox reply.
// `id` is the message's, which finds a turn-end delivery block (it holds no nonce).
// A part of a kind a UI doesn't know is left out of the row.
const ringPart = openUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("agent"),
      handle,
      text: z.string().max(ringTextMost),
      id: messageId.optional(),
    }),
    z.strictObject({
      kind: z.literal("notice"),
      text: z.string().max(ringTextMost),
      id: messageId.optional(),
    }),
    z.strictObject({
      kind: z.literal("person"),
      text: z.string().max(ringTextMost),
      id: messageId.optional(),
    }),
  ],
  { since: 3, unknown: "drop" },
)

// A ring the doorbell typed into the terminal, by its nonce, and when. Only the rings the runner
// typed are drawn, matched by the nonce in the row. `seq` counts a terminal's rings and deliveries
// together, so a reader asks for what came after the last it has (`messages.rings`); `more` is how
// many messages the ring held beyond the parts kept.
const ringContent = z.strictObject({
  seq: z.number().int().positive(),
  nonce: z.string().regex(/^[A-Za-z0-9]{1,32}$/),
  at: z.number(),
  parts: z.array(ringPart).max(ringPartsMost),
  more: z.number().int().positive().optional(),
})

// The messages one hook delivered whose block the harness may print in the terminal (Claude Code's
// "Stop hook says:", Codex's "Blocked by hook"), found there by the message ids in it.
// `ids` are all its messages' ids (the block is matched by its set), `parts` the first few as a ring's.
const deliveryContent = z.strictObject({
  seq: z.number().int().positive(),
  at: z.number(),
  ids: z.array(messageId).max(listedDeliveryIdsMost),
  parts: z.array(ringPart).max(ringPartsMost),
  more: z.number().int().positive().optional(),
})

// What `messages.rings` answers: the rings and deliveries of a terminal after the sequence the
// caller has, oldest first, and the latest sequence.
export const terminalRings = z.strictObject({
  seq: z.number().int().nonnegative(),
  rings: z.array(ringContent).max(listedRingsMost),
  deliveries: z.array(deliveryContent).max(listedDeliveriesMost),
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
// paused, every thread it is in, latest first, and the notices Novadeck delivered to its agent
// (`notices`, oldest first), which no thread holds.
export const terminalMessages = z.strictObject({
  terminalId: id,
  handle,
  delivery: deliveryState,
  waits: deliveryWaits.nullable(),
  waitsSince: z.number().int().nonnegative().nullable(),
  paused: z.boolean(),
  threads: z.array(messageThread).max(1000),
  notices: z.array(deliveredNotice).max(listedNoticesMost),
  // The sequence of the latest ring or delivery the runner keeps for it (`messages.rings` gives their
  // content after the last the caller has): absent while it has none.
  ringSeq: z.number().int().positive().optional(),
})

export type MessageState = z.infer<typeof messageState>
export type DeliveryState = z.infer<typeof deliveryState>
export type MessageParty = z.infer<typeof messageParty>
export type MessageRecipient = z.infer<typeof messageRecipient>
export type MessageThread = z.infer<typeof messageThread>
export type DeliveredNotice = z.infer<typeof deliveredNotice>
export type RingPart = z.infer<typeof ringPart>
export type RingContent = z.infer<typeof ringContent>
export type DeliveryContent = z.infer<typeof deliveryContent>
export type TerminalRings = z.infer<typeof terminalRings>
export type TerminalMessages = z.infer<typeof terminalMessages>

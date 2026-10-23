import type { CompanionKey } from "./items"
import type { Store } from "./store"

// Messages between the agents in a session's terminals, as a backend reports them: each
// terminal's threads with the other terminals, the messages in each and where each is on
// its way, and whether messaging is paused. The terminal's tab counts what waits for its
// agent; its companion pane lists the threads. Agents write the text; Novadeck shows it
// as it is, never formatted or interpreted.

// Where a message is on its way: waiting for its recipient's next hook (`queued`), handed
// to a hook that has yet to confirm it (`leased`), received by the recipient's harness
// (`delivered`), held while messaging is paused or its thread awaits the person's release
// (`held`), or no longer deliverable since its recipient's session ended (`gone`).
export type MessageState = "queued" | "leased" | "delivered" | "held" | "gone"

export type InboxHistory = "open" | "answered" | "read" | "withdrawn" | "gone" | "undelivered"

export type AgentMessage = {
  readonly id: string
  // Inbox letters and the person's replies share a thread with You.
  readonly inbox?: "ask" | "tell" | "answer"
  readonly inboxState?: InboxHistory
  // Its place in its thread, counted from 1.
  readonly hop: number
  // The sender's and recipient's handles, such as `moth`.
  readonly from: string
  readonly to: string
  readonly text: string
  // Epoch milliseconds.
  readonly sentAt: number
  readonly state: MessageState
  // Why a held message waits: messaging is paused, or its thread awaits release.
  readonly held: "paused" | "release" | null
  readonly deliveredAt: number | null
}

// A terminal's thread with one other terminal, by that terminal's handle: how many
// messages it has had and may have before the person releases it again, and its
// messages, oldest first. `held` while some wait for that release.
export type MessageThread = {
  readonly id: string
  readonly peer: string
  readonly hops: number
  readonly allowed: number
  readonly held: boolean
  readonly messages: readonly AgentMessage[]
}

// Why the doorbell can't wake an idle agent whose messages wait, as it saw: a turn running
// (`working`), a prompt queued in the agent (`queued`), its box in shell mode (`shell`),
// text in its box (`draft`), a dialog or picker over it (`dialog`), or a question it waits
// on the person for (`asking`). The pane says so in plain words.
export type MailWaits =
  | "working"
  | "queued"
  | "shell"
  | "draft"
  | "dialog"
  | "asking"
  | "failed"
  | "away"

export const waitsText: Readonly<Record<MailWaits, string>> = {
  working: "It is working, so they wait. They arrive once its turn ends.",
  queued: "A prompt is queued in it, so they wait. They arrive once that prompt has run.",
  shell: "Its box is in shell mode, so they wait. They arrive once it's back to a prompt.",
  draft: "There's text in its box, so they wait. They arrive once the box is empty.",
  dialog: "A dialog or picker is open in its terminal, so they wait. They arrive once it closes.",
  asking: "It is asking you a question, so they wait. They arrive once you answer.",
  failed: "The doorbell failed three times, so they wait. They arrive at its next prompt.",
  away: "Its terminal isn't at the agent's prompt, so they wait. They arrive once it is.",
}

// What the messages wait behind, as the Inbox says it after "N messages for @x wait", and
// where the doorbell hasn't said why it can't wake the idle agent.
export const unsaidWaits = {
  behind: "an idle agent Novadeck can't wake yet",
  text: "It is idle, but Novadeck can't wake it yet, so they wait. They arrive at its next prompt.",
}
export const waitsBehind: Readonly<Record<MailWaits, string>> = {
  working: "its turn running",
  queued: "a prompt queued in the agent",
  shell: "its box in shell mode",
  draft: "text in its box",
  dialog: "a dialog or picker in its terminal",
  asking: "a question it asks you",
  failed: "a doorbell that failed three times",
  away: "a terminal that isn't at its prompt",
}

// A terminal's messages: its own handle, whether an agent is there to take them, why the
// doorbell can't wake it now if its agent is idle and since when (epoch milliseconds), and
// its threads, latest first.
export type TerminalMail = {
  readonly handle: string
  readonly agent: boolean
  readonly waits?: MailWaits | null
  readonly waitsSince?: number | null
  readonly threads: readonly MessageThread[]
}

// Another terminal of the session as a terminal's messages show it, by its handle: its
// name and id, the program running in it, and whether its agent is there, at rest or
// working, or gone from it.
export type MailPeer = {
  readonly name: string
  readonly terminalId: string
  readonly program: string | undefined
  readonly live: "idle" | "working" | "gone"
}

// Whether two sets of peers show the same, as the roster gives new ones each time any
// terminal changes.
export const samePeers = (
  a: Readonly<Record<string, MailPeer>>,
  b: Readonly<Record<string, MailPeer>>,
): boolean => {
  if (a === b) return true
  const handles = Object.keys(a)
  return (
    handles.length === Object.keys(b).length &&
    handles.every((handle) => {
      const one = a[handle]!
      const other = b[handle]
      return (
        other !== undefined &&
        one.name === other.name &&
        one.terminalId === other.terminalId &&
        one.program === other.program &&
        one.live === other.live
      )
    })
  )
}

// Every followed terminal's messages, by `companionKeyId`, and the one pause switch,
// which holds messages between agents across every project and session. Person replies go through. `pending` while a
// pause or resume is on its way to the backend, and `error` why the last one didn't take.
// `releasing` the threads whose release is on its way, by whether the backend has only
// been asked or has accepted it, until a listing shows them going
// on, and `failed` why a thread's last release didn't take: only that thread says so.
export type MailState = {
  readonly paused: boolean
  readonly pending: boolean
  readonly error: string | null
  readonly releasing: Readonly<Record<string, "asked" | "accepted">>
  readonly failed: Readonly<Record<string, string>>
  readonly terminals: Readonly<Record<string, TerminalMail>>
}

export const noMail: MailState = {
  paused: false,
  pending: false,
  error: null,
  releasing: {},
  failed: {},
  terminals: {},
}

export type Messages = {
  readonly state: Store<MailState>
  // Pauses messaging, or resumes it.
  readonly pause: (paused: boolean) => void
  // Lets a thread held for going back and forth too often go on: its held messages wait
  // to be delivered again, and it may have more.
  readonly release: (thread: string) => void
  // Stops a thread held for release: its messages not yet delivered are gone, and its
  // senders are told the person stopped it.
  readonly stop: (thread: string) => void
  // Only the demo's: puts a terminal's agent in a state the doorbell can't ring, or back.
  readonly waits?: (key: CompanionKey, waits: MailWaits | null) => boolean
}

const waitingStates: ReadonlySet<MessageState> = new Set(["queued", "leased", "held"])

// Messages on their way to the terminal's agent: not yet delivered, nor gone.
export const waitingFor = (mail: TerminalMail): readonly AgentMessage[] =>
  mail.threads.flatMap((thread) =>
    thread.messages.filter(
      (message) => message.to === mail.handle && waitingStates.has(message.state),
    ),
  )

// What a terminal's tab says of the messages waiting for its agent: how many, and whether
// some need the person to release their thread, or all wait for messaging to resume.
export type MailBadge = {
  readonly count: number
  readonly kind: "waiting" | "held" | "paused"
}

export const mailBadge = (mail: TerminalMail | undefined, paused: boolean): MailBadge | null => {
  if (!mail) return null
  const waiting = waitingFor(mail)
  if (!waiting.length) return null
  const kind = waiting.some((message) => message.held === "release")
    ? "held"
    : paused && waiting.every((message) => message.inbox !== "answer")
      ? "paused"
      : "waiting"
  return { count: waiting.length, kind }
}

const messagesWord = (count: number): string => `${count} message${count === 1 ? "" : "s"}`

export const mailBadgeLabel = ({ count, kind }: MailBadge): string =>
  kind === "held"
    ? `${messagesWord(count)} waiting, held until you release ${count === 1 ? "it" : "them"}`
    : kind === "paused"
      ? `${messagesWord(count)} waiting, held while messaging is paused`
      : `${messagesWord(count)} waiting`

// Whether a terminal has a messages view: it has had messages. An agent with none yet
// keeps its bar clear until one comes.
export const hasMail = (mail: TerminalMail | undefined): boolean =>
  Boolean(mail && mail.threads.length > 0)

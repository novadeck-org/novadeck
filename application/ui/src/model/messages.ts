import type { Store } from "./store"

// Messages between the agents in a session's terminals, as a backend reports them: each
// terminal's threads with the other terminals, the messages in each and where each is on
// its way, and whether messaging is paused. The terminal's tab counts what waits for its
// agent; its companion pane lists the threads. Agents write the text; NovaDeck shows it
// as it is, never formatted or interpreted.

// Where a message is on its way: waiting for its recipient's next hook (`queued`), handed
// to a hook that has yet to confirm it (`leased`), received by the recipient's harness
// (`delivered`), held while messaging is paused or its thread awaits the person's release
// (`held`), or no longer deliverable since its recipient's session ended (`gone`).
export type MessageState = "queued" | "leased" | "delivered" | "held" | "gone"

export type AgentMessage = {
  readonly id: string
  // Its place in its thread, counted from 1.
  readonly hop: number
  // The sender's and recipient's handles, such as `t3`.
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

// A terminal's messages: its own handle, whether an agent is there to take them, and its
// threads, latest first.
export type TerminalMail = {
  readonly handle: string
  readonly agent: boolean
  readonly threads: readonly MessageThread[]
}

// Every followed terminal's messages, by `companionKeyId`, and the one pause switch,
// which holds every message waiting, across every project and session. `pending` while a
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
    : paused
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

// Whether a terminal has a messages view: an agent is there, or it has had messages.
export const hasMail = (mail: TerminalMail | undefined): boolean =>
  Boolean(mail && (mail.agent || mail.threads.length > 0))

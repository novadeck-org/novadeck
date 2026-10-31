import type { AgentName, TerminalMessages } from "@novadeck/protocol"
import { z } from "zod"

import { agents as allAgents, harnesses } from "../harnesses/registry.js"
import { bareHandle, mention } from "../terminals/handles.js"
import { midTurnCall, route } from "./delivery.js"
import type { Holds } from "./holds.js"
import type { Leading } from "./leading.js"
import { isFromLead } from "./leasing.js"
import { listedThreads } from "./listing.js"
import {
  deliverableAgent,
  leads,
  neverBound,
  promptsInBackground,
  type Deliverable,
  type Live,
} from "./live.js"
import type { Loops } from "./loops.js"
import type { MessageStore } from "./message-store.js"
import {
  byteLength,
  cleanText,
  duplicateOf,
  heldPerPair,
  holdOf,
  idleToHold,
  isNotice,
  markLength,
  maxDeliveryBytes,
  maxMessageBytes,
  maxUndelivered,
  senderTerminal,
  stoppedBetween,
  threadBetween,
  undelivered,
  waiting,
  wrap,
  type Message,
  type Thread,
} from "./messages.js"
import {
  deliveredTo,
  lastBetween,
  peerOf,
  renderAgents,
  unknownHandle,
  type About,
  type Peer,
} from "./peers.js"
import { SendRates, senderRate } from "./send-rates.js"
import type { Sessions } from "./sessions.js"

/** What `send` answers: where the message is, or why it was refused. */
export type SendAnswer =
  | {
      readonly ok: true
      readonly to: string
      readonly id: string
      readonly state: Message["state"]
      /** When a queued message reaches its recipient. */
      readonly route?: string
      /** Why a held message waits. */
      readonly held?: "paused" | "release"
      /** What a message held for release tells its sender of why, and what to do. */
      readonly why?: string
      /** Earlier messages from this terminal that won't arrive, told once. */
      readonly gone?: readonly GoneMessage[]
      /** Its messages held long behind what keeps their recipient from them, told once each hold. */
      readonly holds?: readonly string[]
      /** This terminal's own session never bound, so replies can't reach it. */
      readonly unbound?: true
    }
  | {
      readonly ok: false
      readonly reason: string
      /** This terminal's own session never bound, so replies can't reach it. */
      readonly unbound?: true
    }

/** A message on its way, as a close of its sender tells of it: whether it waits held too. */
export type OnTheWay = Pick<Message, "id" | "sentAt"> & { readonly held: boolean }

/** One recipient's part of a send to several terminals: its message, or why it wasn't sent. */
export type RecipientAnswer =
  | Omit<Extract<SendAnswer, { ok: true }>, "gone" | "holds" | "unbound">
  | { readonly ok: false; readonly to: string; readonly reason: string }

/**
 * What a send to several terminals the caller leads answers: each recipient's own answer,
 * its team first with `team`, then the others in the order named, and what every answer
 * tells its sender, once.
 */
export type TeamAnswer = {
  readonly ok: true
  readonly sent: readonly RecipientAnswer[]
  readonly gone?: readonly GoneMessage[]
  readonly holds?: readonly string[]
  readonly unbound?: true
}

/** An earlier message from a terminal that won't arrive, as its next answer tells it. */
type GoneMessage = {
  readonly id: string
  readonly to: string
  /** The person stopped the thread it was in. */
  readonly stopped?: true
  /** The person released its recipient from the lead that sent it. */
  readonly released?: true
}

/**
 * A terminal an agent named among its peers: its id, its handle, and the agent running
 * there, if any; or why none is.
 */
export type PeerAnswer =
  | {
      readonly ok: true
      readonly terminalId: string
      readonly handle: string
      readonly agent: AgentName | null
    }
  | { readonly ok: false; readonly reason: string }

/** What `agents` answers: the listing, rendered once, as agents read it. */
export type AgentsAnswer =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

/** Why a message's text, cleaned, can't be sent; undefined when it can. */
export const refusalOfText = (text: string): string | undefined => {
  if (!text.trim()) return "The message is empty."
  if (byteLength(text) > maxMessageBytes)
    return (
      `The message is ${byteLength(text)} bytes, over the ${maxMessageBytes} a message may ` +
      "hold; put longer content in a file the recipient can open, and send its path."
    )
  return undefined
}

/** The bytes the largest of a message's deliveries on its own would print, in any harness. */
export const deliveredBytes = (message: Message): number => {
  // Agent messages use the longer lead note. Person replies use their own note and nonce.
  // Its sender may close before it arrives, which marks it so.
  const text = wrap([message], () => message.response === undefined, "x".repeat(markLength), {
    fromClosed: () => message.response === undefined,
  })
  return Math.max(
    ...allAgents.flatMap((agent) => {
      const { messaging } = harnesses[agent]
      // A tool-call hook carries a lead's message, under each name its events have.
      const tools = Object.entries(messaging.asks)
        .filter(([, kind]) => kind === "tool")
        .map(([event]) => byteLength(messaging.call?.(text, event) ?? ""))
      return [byteLength(messaging.stop(text)), byteLength(messaging.prompt(text)), ...tools]
    }),
  )
}

/**
 * Who a send is for: the terminals named, by bare handle, and, with `team`, every one the
 * caller leads; and `to` as written, bare, which a refusal of a name there quotes.
 */
type Addressees = {
  readonly handles: readonly string[]
  readonly team: boolean
  readonly written: string
}

/** The word in `to` that names every terminal the caller leads. */
export const teamWord = "team"

/**
 * `to` read: one handle, several separated by spaces or commas (or given as a list), and
 * `team` for every terminal the caller leads; each handle bare, each once.
 */
const addressees = (to: string | readonly string[]): Addressees => {
  const words = (typeof to === "string" ? to.split(/[\s,]+/) : to)
    .map((word) => bareHandle(word.trim()))
    .filter((word) => word !== "")
  return {
    handles: [...new Set(words.filter((word) => word !== teamWord))],
    team: words.includes(teamWord),
    written: typeof to === "string" ? bareHandle(to) : words.join(" "),
  }
}

const sendRequest = z.strictObject({
  to: z
    .union([z.string().min(1).max(4096), z.array(z.string().min(1).max(65)).min(1).max(256)])
    .transform(addressees)
    .refine(({ handles, team }) => team || handles.length > 0)
    .refine(({ handles }) => handles.every((handle) => handle.length <= 64)),
  text: z.string().max(64 * 1024),
})

/** Whether a word could be a handle: letters, digits and dashes, as every handle is. */
const handleShaped = (word: string): boolean => /^[\p{L}\p{N}_-]+$/u.test(word)

/** The one terminal a send names, when it names one and not the team. */
const single = (to: Addressees): string | undefined =>
  !to.team && to.handles.length === 1 ? to.handles[0] : undefined

const refused = (reason: string) => ({ ok: false, reason }) as const

const oneOnly = refused("Name one terminal's handle to send it this message.")

// Closed, messaging keeps nothing more, so a message then would be lost, not queued.
const stopping = "Novadeck is stopping and couldn't keep the message; send it again once it's back."

/** What sending asks of the rest of messaging. */
export type SendingHost = {
  readonly sessions: Sessions
  readonly store: MessageStore
  readonly loops: Loops
  readonly now: () => number
  readonly holds: Holds
  readonly leading: Leading
}

/**
 * Agents' messages to each other, and what agents and the runner API read of them: a
 * message's checks, its thread and hold as it is sent, and what every answer tells its
 * sender; each terminal's peers described (`peers.ts`), and its threads listed.
 */
export class Sending {
  private readonly rates = new SendRates()

  constructor(private readonly host: SendingHost) {}

  /**
   * An agent's message to another terminal in its project and session, by that
   * terminal's exact handle. It never claims delivery: it answers where the message is,
   * or why not, describing every terminal there when `to` is no current handle.
   */
  send(terminalId: string, request: unknown, about: About = () => undefined): SendAnswer {
    // Refused before anything is sent: messaging's own callers name one terminal.
    const parsed = sendRequest.safeParse(request)
    const many = parsed.success && single(parsed.data.to) === undefined
    const answer: SendAnswer | TeamAnswer = many
      ? oneOnly
      : this.sendAny(terminalId, request, about)
    return "sent" in answer ? oneOnly : answer
  }

  /**
   * As `send`, and also to several terminals the caller leads in one call (`to` names
   * them, or `team` names all): each gets its own message, judged as `send` judges it,
   * while the call counts once against the caller's own rate.
   */
  sendAny(
    terminalId: string,
    request: unknown,
    about: About = () => undefined,
  ): SendAnswer | TeamAnswer {
    const live = this.host.sessions.get(terminalId)
    if (!live) return refused("Novadeck couldn't send the message.")
    if (this.host.store.closed) return refused(stopping)
    const answer = this.sendFrom(live, request, about)
    // Refused too, a sender whose own session never bound learns replies can't reach it.
    return answer.ok || !neverBound(live) ? answer : { ...answer, unbound: true }
  }

  /**
   * The agent messages to the terminal reach, and its root session once bound, as `send`
   * judges a recipient; or why none does. Undefined for a terminal messaging doesn't hold.
   */
  agentIn(terminalId: string): Deliverable | undefined {
    const live = this.host.sessions.get(terminalId)
    return live && deliverableAgent(live)
  }

  private sendFrom(live: Live, request: unknown, about: About): SendAnswer | TeamAnswer {
    const parsed = sendRequest.safeParse(request)
    if (!parsed.success)
      return refused(
        "A message needs `to`, a terminal's handle (or, for terminals you lead, several, or " +
          "`team`), and its `text`.",
      )
    const text = cleanText(parsed.data.text)
    const textRefusal = refusalOfText(text)
    if (textRefusal) return refused(textRefusal)
    const scoped = this.host.sessions.scoped(live)
    const one = single(parsed.data.to)
    if (one === undefined) return this.sendTeam(live, scoped, parsed.data.to, text, about)
    const recipient = scoped.find((peer) => peer.handle === one)
    if (!recipient) return refused(this.unknown(live, one, about))
    const { answer } = this.sendTo(live, recipient, text, true)
    return answer.ok ? { ...answer, ...this.extras(live) } : answer
  }

  /** Why `handle` is no terminal there, describing every terminal there, as `send` does. */
  private unknown(live: Live, handle: string, about: About): string {
    return unknownHandle(
      handle,
      live.handle,
      this.peers(live, about),
      this.host.now(),
      this.host.leading.leadOf(live.terminalId) ?? null,
    )
  }

  /**
   * The caller's message to several terminals it leads: each named one, and with `team`
   * every one, gets its own, judged as `send` judges it, and the call counts once against
   * the caller's own rate and the runner's, if any recipient keeps one. A terminal named
   * that it doesn't lead refuses the whole call, so nothing goes to some of them only.
   */
  private sendTeam(
    live: Live,
    scoped: readonly Live[],
    to: Addressees,
    text: string,
    about: About,
  ): SendAnswer | TeamAnswer {
    const named: Live[] = []
    for (const handle of to.handles) {
      const peer = scoped.find((each) => each.handle === handle)
      // The name itself, unless `to` holds what no handle has, as `@fox · api`, which an
      // agent may have meant as one name: then quoted as written.
      if (!peer)
        return refused(
          this.unknown(live, to.handles.every(handleShaped) ? handle : to.written, about),
        )
      named.push(peer)
    }
    const team = this.teammates(live)
    const outside = named.filter((peer) => !team.includes(peer)).map((peer) => mention(peer.handle))
    if (outside.length > 0)
      return refused(
        `${outside.join(", ")} ${outside.length === 1 ? "isn't a terminal" : "aren't terminals"} ` +
          "you lead: a message to several terminals, or to your team, goes only to terminals " +
          "you lead. Send to each other terminal on its own.",
      )
    const recipients = [...new Set([...(to.team ? team : []), ...named])]
    if (recipients.length === 0)
      return refused(
        "`team` names the terminals you lead, and you lead none here; send to your lead or a " +
          "teammate by its handle.",
      )
    const own = this.rates.sender(live.terminalId, this.host.now(), this.senderLimit(live))
    if (!own.ok) return refused(own.reason)
    const sent = recipients.map((recipient) => this.sendTo(live, recipient, text, false))
    if (sent.some(({ kept }) => kept)) own.spend()
    // Refused for every one: the call failed, as a send to one refused does.
    if (sent.every(({ answer }) => !answer.ok))
      return refused(
        sent
          .map(({ answer }, index) =>
            answer.ok ? "" : `Not sent to ${mention(recipients[index]!.handle)}: ${answer.reason}`,
          )
          .join("\n"),
      )
    return {
      ok: true,
      sent: sent.map(({ answer }, index) =>
        answer.ok ? answer : { ok: false, to: recipients[index]!.handle, reason: answer.reason },
      ),
      ...this.extras(live),
    }
  }

  /**
   * How many messages a minute the terminal may send: more for a lead, by the terminals it
   * leads now.
   */
  private senderLimit(live: Live | undefined): number {
    return senderRate(live ? this.teammates(live).length : 0)
  }

  /**
   * The terminals the caller leads now, its team: not one it leads only until its brief is
   * delivered, which takes that brief and nothing more as its lead's.
   */
  private teammates(live: Live): Live[] {
    return this.host.sessions
      .scoped(live)
      .filter(
        (peer) => leads(peer, live) && this.host.leading.briefOf(peer.terminalId) === undefined,
      )
  }

  /**
   * The caller's message to one recipient, as it is sent now: checked, threaded, held as
   * its thread is, and kept; or why not. With `own`, it counts against the caller's own rate
   * and the runner's; without, the caller counts its call once itself. `kept` says whether
   * a new message was kept, not a duplicate answered nor a refusal.
   */
  private sendTo(
    live: Live,
    recipient: Live,
    text: string,
    own: boolean,
  ): { readonly answer: SendAnswer; readonly kept: boolean } {
    const { store, holds } = this.host
    const { terminalId } = live
    const answer = (value: SendAnswer, kept = false) => ({ answer: value, kept })
    const root = recipient.root
    const deliverable = deliverableAgent(recipient)
    if (!deliverable.ok) return answer(refused(deliverable.reason))
    const { agent } = deliverable
    const now = this.host.now()
    const known = threadBetween(store.threads(), terminalId, recipient.terminalId, now)
    // The person stopped it: nothing continues it, and the refusal leaves its clock alone.
    if (stoppedBetween(store.threads(), terminalId, recipient.terminalId, now))
      return answer(
        refused(
          `The user stopped your thread with ${mention(recipient.handle)} in Novadeck. ` +
            `Don't message ${mention(recipient.handle)} about it again unless the user asks.`,
        ),
      )
    const same = duplicateOf(store.messages(), terminalId, recipient.terminalId, text, now)
    if (same) return answer(this.answer(same, recipient))
    // Idle or not, judged from the thread's previous message to now; the count of the idle in
    // a row starts the hold at its sixth, and stays as it was once held. A new thread of a
    // pair with messages waiting held goes on with the pair's run, from the pair's last
    // message, so a loop gains nothing by letting its thread lapse.
    const carried = known ? undefined : holds.carriedRun(terminalId, recipient.terminalId)
    const from = known?.lastAt ?? carried?.from
    const quiet = from !== undefined && holds.idleSince(from, now, terminalId, recipient.terminalId)
    const before = (known ? holds.run(known.id) : carried?.run) ?? { count: 0, senders: [] }
    const run =
      known?.heldFrom != null
        ? before
        : quiet
          ? { count: before.count + 1, senders: [...before.senders, terminalId] }
          : { count: 0, senders: [] }
    const starts = known?.heldFrom == null && run.count >= idleToHold
    const hop = (known?.hops ?? 0) + 1
    const heldFrom = starts ? hop : (known?.heldFrom ?? null)
    const heldFor = starts ? ("loop" as const) : (known?.heldFor ?? null)
    const thread: Thread = known
      ? { ...known, hops: hop, heldFrom, heldFor, lastAt: now }
      : {
          id: store.freshThreadId(),
          projectId: live.projectId,
          between: [terminalId, recipient.terminalId],
          hops: 1,
          heldFrom: starts ? 1 : null,
          heldFor: starts ? ("loop" as const) : null,
          lastAt: now,
          stoppedAt: null,
        }
    // Its authority is fixed now: from the recipient's running lead, it is marked so when
    // delivered, and never awaits release, whatever happens to the lead after.
    const fromLead = leads(recipient, live) && this.host.leading.marks(recipient.terminalId)
    const toLead = leads(live, recipient)
    const message: Message = {
      ...this.draft(live, text, {
        terminalId: recipient.terminalId,
        handle: recipient.handle,
        agent,
      }),
      id: store.freshMessageId(),
      thread: thread.id,
      hop: thread.hops,
      to: {
        terminalId: recipient.terminalId,
        handle: recipient.handle,
        agent,
        sessionId: root?.sessionId ?? null,
      },
      fromLead,
      toLead,
      state: waiting({ hop: thread.hops }, thread, store.isPaused()),
    }
    const vetted = this.vet(message, own)
    if (!vetted.ok) return answer(vetted)
    // One held beyond the pair's ten isn't kept, and uses no hop; if it began the hold, that
    // stays, at its hop, so the pair's next messages are held too.
    if (
      holdOf(message, thread, store.isPaused()) === "release" &&
      holds.heldBetween(terminalId, recipient.terminalId) >= heldPerPair
    ) {
      // A refused first message of a new thread keeps no thread: the pair's next is judged
      // the same way, from the held messages still waiting.
      if (known && starts) {
        store.putThread({ ...known, heldFrom, heldFor })
        holds.setRun(known.id, run)
      }
      return answer(
        refused(
          `refused: you and ${mention(recipient.handle)} already have ten messages waiting ` +
            "for the user's release; this one wasn't kept. Wait for the user rather than " +
            `messaging ${mention(recipient.handle)} again.`,
        ),
      )
    }
    vetted.spend()
    holds.setRun(thread.id, run)
    if (quiet) holds.idle(message.id)
    this.host.loops.sent(terminalId, now)
    store.putThread(thread)
    store.put(message)
    return answer(this.answer(message, recipient), true)
  }

  /**
   * Why `send` would refuse the caller's message to a terminal not yet open, running
   * `agent`, as its task: every check `send` makes but the recipient's own; undefined
   * when it would take it.
   */
  refusal(terminalId: string, text: string, agent: AgentName): string | undefined {
    const live = this.host.sessions.get(terminalId)
    if (!live) return "Novadeck couldn't send the message."
    if (this.host.store.closed) return stopping
    const clean = cleanText(text)
    const textRefusal = refusalOfText(clean)
    if (textRefusal) return textRefusal
    // The longest handle a terminal may have, so the size is never underestimated.
    const vetted = this.vet(
      this.draft(live, clean, {
        terminalId: "",
        handle: "z".repeat(12) + "999999999",
        agent,
      }),
    )
    return vetted.ok ? undefined : vetted.reason
  }

  /** A message from the caller to a recipient, as it would be sent now, for `vet`. */
  private draft(
    live: Live,
    text: string,
    to: { readonly terminalId: string; readonly handle: string; readonly agent: AgentName },
  ): Message {
    return {
      id: "m-0000000000",
      projectId: live.projectId,
      thread: "t-0000000000",
      hop: 1,
      from: {
        kind: "agent",
        terminalId: live.terminalId,
        handle: live.handle,
        agent: live.root?.agent ?? null,
        sessionId: live.root?.sessionId ?? null,
      },
      to: { ...to, sessionId: null },
      text,
      sentAt: this.host.now(),
      state: "queued",
      deliveredAt: null,
      notified: false,
      stopped: false,
      fromLead: false,
      toLead: false,
    }
  }

  /**
   * What `send` checks of a message beyond its text, as it would be sent: its size once
   * delivered, the recipient's undelivered cap, and the rates, with the send times it
   * would spend. One check for every way a message is sent, so they never drift apart.
   * Without `own`, only the pair's rate is checked: a send to several terminals counts
   * against the caller's own once, itself.
   */
  private vet(
    message: Message,
    own = true,
  ):
    | { readonly ok: false; readonly reason: string }
    | { readonly ok: true; readonly spend: () => void } {
    // Alone in a delivery, it must fit whichever harness it reaches, as it is printed.
    const size = deliveredBytes(message)
    if (size > maxDeliveryBytes)
      return refused(
        `Delivered, this message would take ${size} bytes, over the ${maxDeliveryBytes} a ` +
          'delivery may: plain text of up to 4 KB fits, but characters such as < > & " and ' +
          "line breaks take more room once escaped. Shorten it, or put it in a file and send " +
          "its path.",
      )
    const { to, from } = message
    const waitingThere = [...this.host.store.messages()].filter(
      (each) => !each.response && each.to.terminalId === to.terminalId && undelivered(each),
    ).length
    if (waitingThere >= maxUndelivered)
      return refused(
        `${mention(to.handle)} already has ${maxUndelivered} messages waiting; ` +
          "wait for it to take them before sending more.",
      )
    // Only terminals' agents send under the rates; the person's and Novadeck's never come here.
    if (from.kind !== "agent") return refused("Only an agent's message is sent this way.")
    const limit = this.senderLimit(this.host.sessions.get(from.terminalId))
    return own
      ? this.rates.check(from.terminalId, to.terminalId, message.sentAt, limit)
      : this.rates.pair(from.terminalId, to.terminalId, message.sentAt, limit)
  }

  /** What `send` answers of a message to `recipient`. */
  private answer(message: Message, recipient: Live): SendAnswer {
    const base = { ok: true, to: message.to.handle, id: message.id, state: message.state } as const
    if (message.state === "held") {
      const held = this.host.store.holdOf(message)
      const why = this.host.holds.holdWhy(message)
      return held ? { ...base, held, ...(why && { why }) } : base
    }
    if (message.state !== "queued") return base
    const agent = recipient.root?.agent ?? recipient.shown?.agent
    const profile = agent ? harnesses[agent].messaging : undefined
    return {
      ...base,
      route: profile
        ? route(
            recipient.delivery,
            profile.silentOnFailure,
            isFromLead(message)
              ? midTurnCall(profile.call !== undefined, profile.reinjectPerCall)
              : undefined,
            recipient.waits ?? undefined,
            promptsInBackground(recipient),
          )
        : "when its agent starts: rung once Novadeck sees it at its prompt, else at its first turn",
    }
  }

  /**
   * What every answer to the sender adds: its messages newly gone, or held long, and whether
   * replies reach it.
   */
  private extras(live: Live) {
    const gone = this.goneFrom(live.terminalId)
    const holds = this.host.holds.heldFrom(live.terminalId)
    return {
      ...(gone.length > 0 && { gone }),
      ...(holds.length > 0 && { holds }),
      ...(neverBound(live) && { unbound: true as const }),
    }
  }

  /** The caller's messages gone since it was last told, told now, as every answer tells them. */
  goneFrom(terminalId: string): readonly GoneMessage[] {
    const { store, leading } = this.host
    const gone = [...store.messages()].filter(
      (message) =>
        senderTerminal(message.from) === terminalId &&
        message.state === "gone" &&
        !message.notified,
    )
    for (const message of gone) store.put({ ...message, notified: true })
    const told = gone.map((message) => ({
      id: message.id,
      to: message.to.handle,
      ...(message.stopped && !leading.released(message.id) && { stopped: true as const }),
      ...(leading.released(message.id) && { released: true as const }),
    }))
    // Told: the flag has done its work.
    for (const message of gone) leading.forgot(message.id)
    return told
  }

  /**
   * The messages `from` sent `to` that wait to arrive, oldest first, and whether each is
   * held: closing `from` lets them arrive after it closed, marked so. One leased is left
   * out, as its recipient's harness already has it.
   */
  onTheWay(from: string, to: string): readonly OnTheWay[] {
    return [...this.host.store.messages()]
      .filter(
        (message) =>
          senderTerminal(message.from) === from &&
          message.to.terminalId === to &&
          (message.state === "queued" || message.state === "held"),
      )
      .toSorted((a, b) => a.sentAt - b.sentAt)
      .map(({ id, sentAt, state }) => ({ id, sentAt, held: state === "held" }))
  }

  /**
   * How many messages terminals other than `except` sent `terminalId` that are yet to
   * arrive, which closing it makes gone.
   */
  waitingFor(terminalId: string, except: string): number {
    return [...this.host.store.messages()].filter(
      (message) =>
        message.to.terminalId === terminalId &&
        senderTerminal(message.from) !== except &&
        !isNotice(message) &&
        undelivered(message),
    ).length
  }

  /**
   * Whether `send` would answer this request by describing the terminals there, as its
   * `to` is no current handle of theirs; only then does it need their whereabouts.
   */
  describes(terminalId: string, request: unknown): boolean {
    const live = this.host.sessions.get(terminalId)
    const parsed = sendRequest.safeParse(request)
    if (!live || !parsed.success) return false
    const scoped = this.host.sessions.scoped(live)
    return parsed.data.to.handles.some((handle) => !scoped.some((peer) => peer.handle === handle))
  }

  /**
   * The other running terminal in the caller's project and session whose exact handle
   * `to` is, as `send` finds its recipient, with the agent running there as `agents`
   * names it, or the one it is opened to run and expects to bind; or why there is none,
   * describing every terminal there as `send` does.
   */
  peer(terminalId: string, to: string, about: About = () => undefined): PeerAnswer {
    const live = this.host.sessions.get(terminalId)
    if (!live) return refused("Novadeck couldn't find the terminals here.")
    const found = this.host.sessions.scoped(live).find((peer) => peer.handle === to)
    if (found)
      return {
        ok: true,
        terminalId: found.terminalId,
        handle: found.handle,
        agent: found.root?.agent ?? found.shown?.agent ?? found.expecting,
      }
    return refused(
      unknownHandle(
        to,
        live.handle,
        this.peers(live, about),
        this.host.now(),
        this.host.leading.leadOf(live.terminalId) ?? null,
      ),
    )
  }

  /**
   * The other terminals in the caller's project and session, each described by what
   * Novadeck knows of it, and the caller's own messages not yet delivered or gone, as one
   * text agents read.
   */
  agents(terminalId: string, about: About = () => undefined): AgentsAnswer {
    const { store, holds } = this.host
    const live = this.host.sessions.get(terminalId)
    if (!live) return refused("Novadeck couldn't list the terminals.")
    const mine = [...store.messages()]
      .filter(
        (message) =>
          senderTerminal(message.from) === terminalId &&
          (undelivered(message) || message.state === "gone"),
      )
      .toSorted((a, b) => a.sentAt - b.sentAt)
    for (const message of mine)
      if (message.state === "gone" && !message.notified) store.put({ ...message, notified: true })
    const text = renderAgents({
      handle: live.handle,
      lead: this.host.leading.leadOf(live.terminalId) ?? null,
      peers: this.peers(live, about),
      messages: mine.map((message) => {
        const why = holds.holdWhy(message)
        return { message, hold: store.holdOf(message), ...(why !== undefined && { why }) }
      }),
      unbound: live.root === null,
      now: this.host.now(),
    })
    // As every answer to the caller does, it tells of its messages held long, once.
    const held = holds.heldFrom(terminalId)
    return { ok: true, text: [text, ...held].join("\n") }
  }

  /**
   * The terminal's threads and messages with their states, for the runner API; an exited
   * terminal's too, while its messages are kept.
   */
  list(terminalId: string, handle: string): TerminalMessages {
    const { store, holds } = this.host
    const live = this.host.sessions.get(terminalId)
    const mine = [...store.messages()]
      .filter(
        (message) =>
          !isNotice(message) &&
          (senderTerminal(message.from) === terminalId || message.to.terminalId === terminalId),
      )
      .toSorted((a, b) => a.sentAt - b.sentAt)
    const threads = listedThreads(terminalId, mine, {
      thread: (id) => store.thread(id),
      idled: (id) => holds.run(id)?.count ?? 0,
      holdOf: (message) => store.holdOf(message),
      now: this.host.now(),
    })
    return {
      terminalId,
      handle,
      delivery: live?.delivery.state ?? "unbound",
      waits: live ? holds.waitsOf(live) : null,
      waitsSince: live ? holds.oldestHeld(live) : null,
      paused: store.isPaused(),
      threads,
    }
  }

  /** When the latest message was delivered to the terminal: see `deliveredTo`. */
  deliveredAt(terminalId: string): number | null {
    return deliveredTo(this.host.store.messages(), terminalId)
  }

  /** The caller's peers, described. */
  private peers(live: Live, about: About): Peer[] {
    const { store } = this.host
    return this.host.sessions.scoped(live).map((peer) =>
      peerOf({
        terminalId: peer.terminalId,
        handle: peer.handle,
        agent: peer.root?.agent ?? peer.shown?.agent ?? null,
        expecting: peer.root || peer.shown ? null : peer.expecting,
        untrusted: peer.root || peer.shown ? null : peer.untrusted,
        // Working as its terminal shows it too: waiting on subagents its turn left
        // running, as after an Esc, is no delivery phase.
        busy: peer.delivery.state === "working" || about(peer.terminalId)?.working === true,
        where: about(peer.terminalId),
        withYou: lastBetween(store.messages(), live.terminalId, peer),
        lead: this.host.leading.leadOf(peer.terminalId) ?? null,
        deliveredAt: deliveredTo(store.messages(), peer.terminalId),
      }),
    )
  }
}

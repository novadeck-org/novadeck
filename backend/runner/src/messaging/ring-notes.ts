import {
  listedDeliveriesMost,
  listedDeliveryIdsMost,
  listedRingsMost,
  ringPartsMost,
  ringTextMost,
  type DeliveryContent,
  type RingContent,
  type RingPart,
  type TerminalRings,
} from "@novadeck/protocol"

import { isNotice, type Message } from "./messages.js"

/**
 * What each terminal's rings and deliveries said, for its view to draw over the lines the
 * harness shows (see docs/agent-messaging.md, "The doorbell's row in the terminal"). The tag the
 * doorbell types holds no words, so the view is told them here, by the ring's nonce; a hook's
 * delivery block, which holds no nonce, by its messages' ids.
 *
 * Kept in memory while the rows may still be in the terminal's scrollback: the latest
 * `listedRingsMost` rings and `listedDeliveriesMost` deliveries of a terminal (a ring or a block
 * takes a few rows of its 1000), each at most `ringPartsMost` parts of `ringTextMost`
 * characters, `listedDeliveryIdsMost` ids: some 100 KB at the most for a terminal whose every
 * ring was full, a few KB as a rule. They only ever grow at their end, so a reader keeps what it
 * has and asks for what came after its last sequence (`since`). A terminal that closes for good
 * forgets them; a runner that restarts has none, and its terminals' older rows stay as the
 * harness drew them.
 */

/** What a message says as a ring's part: its sender, or the person's own words, or a notice. */
export const partOf = (message: Message, withId = false): RingPart => {
  const id = withId ? { id: message.id } : {}
  const { response } = message
  if (response) {
    const picked = response.feedback
      ? ["Asked for feedback about Novadeck", message.text]
      : [
          response.option !== undefined
            ? `Picked ${response.option}`
            : response.action !== undefined
              ? `Marked done: ${response.action}`
              : undefined,
          message.text,
        ]
    return {
      kind: "person",
      text: cut(picked.filter(Boolean).join(": ")),
      ...id,
    }
  }
  if (isNotice(message)) return { kind: "notice", text: cut(message.text), ...id }
  const handle = message.from.kind === "agent" ? message.from.handle : "you"
  return { kind: "agent", handle, text: cut(message.text), ...id }
}

const cut = (text: string): string => {
  const points = [...text]
  return points.length <= ringTextMost ? text : `${points.slice(0, ringTextMost - 1).join("")}…`
}

/** What a task's start prompt says: the task, from the agent that opened this one. */
export const startRing = (handle: string, text: string): { readonly parts: RingPart[] } => ({
  parts: [{ kind: "agent", handle, text: cut(text) }],
})

/** The parts of the messages, in their order, the most a ring holds. */
export const partsOf = (messages: readonly Message[], withId = false): RingPart[] =>
  messages.slice(0, ringPartsMost).map((message) => partOf(message, withId))

/** The parts of the messages as a ring keeps them, and how many more there were. */
const kept = (
  messages: readonly Message[],
  withId: boolean,
): { readonly parts: RingPart[]; readonly more?: number } => {
  const more = messages.length - ringPartsMost
  return { parts: partsOf(messages, withId), ...(more > 0 && { more }) }
}

export class RingNotes {
  private readonly rings = new Map<string, RingContent[]>()
  private readonly deliveries = new Map<string, DeliveryContent[]>()
  private readonly seqs = new Map<string, number>()

  constructor(
    private readonly changed: (terminalId: string) => void,
    private readonly now: () => number,
  ) {}

  private next(terminalId: string): number {
    const seq = (this.seqs.get(terminalId) ?? 0) + 1
    this.seqs.set(terminalId, seq)
    return seq
  }

  /** The doorbell typed a ring with this nonce into the terminal, saying these messages. */
  ring(terminalId: string, nonce: string, messages: readonly Message[]): void {
    this.ringOf(terminalId, nonce, kept(messages, false))
  }

  /** A ring (a task's start prompt) that says these parts. */
  ringOf(
    terminalId: string,
    nonce: string,
    { parts, more }: { readonly parts: readonly RingPart[]; readonly more?: number },
  ): void {
    const list = (this.rings.get(terminalId) ?? []).filter((each) => each.nonce !== nonce)
    list.push({
      seq: this.next(terminalId),
      nonce,
      at: this.now(),
      parts: [...parts],
      ...(more !== undefined && { more }),
    })
    this.rings.set(terminalId, list.slice(-listedRingsMost))
    this.changed(terminalId)
  }

  /**
   * A hook was given these messages to print, which the harness may show as a block. Told as the
   * messages are leased, whose change notices carry it: none of its own.
   */
  delivery(terminalId: string, messages: readonly Message[]): void {
    if (messages.length === 0) return
    const { parts, more } = kept(messages, true)
    const list = [
      ...(this.deliveries.get(terminalId) ?? []),
      {
        seq: this.next(terminalId),
        at: this.now(),
        ids: messages.slice(0, listedDeliveryIdsMost).map(({ id }) => id),
        parts,
        ...(more !== undefined && { more }),
      },
    ]
    this.deliveries.set(terminalId, list.slice(-listedDeliveriesMost))
  }

  /** The latest sequence of the terminal's rings and deliveries, as a listing says it. */
  listed(terminalId: string): { readonly ringSeq?: number } {
    const seq = this.seqs.get(terminalId)
    return seq === undefined ? {} : { ringSeq: seq }
  }

  /** What the terminal's rings and deliveries say after sequence `since`, oldest first. */
  since(terminalId: string, since: number): TerminalRings {
    return {
      seq: this.seqs.get(terminalId) ?? 0,
      rings: (this.rings.get(terminalId) ?? []).filter((each) => each.seq > since),
      deliveries: (this.deliveries.get(terminalId) ?? []).filter((each) => each.seq > since),
    }
  }

  /** The terminal closed for good. */
  forget(terminalId: string): void {
    this.rings.delete(terminalId)
    this.deliveries.delete(terminalId)
    this.seqs.delete(terminalId)
  }
}

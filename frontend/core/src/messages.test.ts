import {
  hasMail,
  mailBadge,
  mailBadgeLabel,
  waitingFor,
  type AgentMessage,
  type TerminalMail,
} from "./messages"
import { context, describe, expect, it } from "./test"

const message = (
  id: string,
  change: Partial<AgentMessage> & Pick<AgentMessage, "from" | "to" | "state">,
): AgentMessage => ({
  id,
  hop: 1,
  text: id,
  sentAt: 0,
  held: null,
  deliveredAt: null,
  ...change,
})

// moth's thread with fox, when it has messages.
const mail = (messages: readonly AgentMessage[], agent = true): TerminalMail => ({
  handle: "moth",
  agent,
  threads: messages.length
    ? [{ id: "t-1", peer: "fox", hops: messages.length, allowed: 12, held: false, messages }]
    : [],
})

const inbound = [
  message("queued", { from: "fox", to: "moth", state: "queued" }),
  message("leased", { from: "fox", to: "moth", state: "leased" }),
  message("delivered", { from: "fox", to: "moth", state: "delivered" }),
  message("gone", { from: "fox", to: "moth", state: "gone" }),
]
const outbound = [message("sent", { from: "moth", to: "fox", state: "queued" })]

describe("messages waiting for a terminal's agent", () => {
  it("are those to it still on their way: queued, leased or held", () => {
    const held = message("held", { from: "fox", to: "moth", state: "held", held: "paused" })
    expect(waitingFor(mail([...inbound, held, ...outbound])).map(({ id }) => id)).toEqual([
      "queued",
      "leased",
      "held",
    ])
  })
})

describe("a terminal's badge", () => {
  context("with nothing waiting for its agent", () => {
    it("shows nothing, whatever it sent", () => {
      expect(mailBadge(mail(outbound), false)).toBeNull()
      expect(mailBadge(undefined, true)).toBeNull()
    })
  })

  context("with messages waiting", () => {
    it("counts them", () => {
      const badge = mailBadge(mail(inbound), false)
      expect(badge).toEqual({ count: 2, kind: "waiting" })
      expect(mailBadgeLabel(badge!)).toBe("2 messages waiting")
    })

    it("says they're held while messaging is paused", () => {
      const paused = inbound.map((each) =>
        each.state === "queued"
          ? { ...each, state: "held" as const, held: "paused" as const }
          : each,
      )
      const badge = mailBadge(mail(paused), true)
      expect(badge).toEqual({ count: 2, kind: "paused" })
      expect(mailBadgeLabel(badge!)).toBe("2 messages waiting, held while messaging is paused")
    })
  })

  it("keeps the person's reply waiting while messages between agents are paused", () => {
    const reply = message("reply", { from: "you", to: "moth", state: "queued", inbox: "answer" })
    expect(mailBadge(mail([reply]), true)).toEqual({ count: 1, kind: "waiting" })
    expect(mailBadge(mail([...inbound, reply]), true)).toEqual({ count: 3, kind: "waiting" })
  })

  context("with a thread held for release", () => {
    it("says the person must release it, even while paused", () => {
      const held = message("held", { from: "fox", to: "moth", state: "held", held: "release" })
      const badge = mailBadge(mail([held]), true)
      expect(badge).toEqual({ count: 1, kind: "held" })
      expect(mailBadgeLabel(badge!)).toBe("1 message waiting, held until you release it")
    })
  })
})

describe("a terminal's messages view", () => {
  it("is there for messages it had, but not for an agent that has had none", () => {
    expect(hasMail(mail(outbound))).toBe(true)
    expect(hasMail(mail(outbound, false))).toBe(true)
    expect(hasMail(mail([]))).toBe(false)
    expect(hasMail(mail([], false))).toBe(false)
    expect(hasMail(undefined)).toBe(false)
  })
})

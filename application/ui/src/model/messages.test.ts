import { context, describe, expect, it } from "../test"
import {
  hasMail,
  mailBadge,
  mailBadgeLabel,
  waitingFor,
  type AgentMessage,
  type TerminalMail,
} from "./messages"

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

// t1's thread with t2, when it has messages.
const mail = (messages: readonly AgentMessage[], agent = true): TerminalMail => ({
  handle: "t1",
  agent,
  threads: messages.length
    ? [{ id: "t-1", peer: "t2", hops: messages.length, allowed: 12, held: false, messages }]
    : [],
})

const inbound = [
  message("queued", { from: "t2", to: "t1", state: "queued" }),
  message("leased", { from: "t2", to: "t1", state: "leased" }),
  message("delivered", { from: "t2", to: "t1", state: "delivered" }),
  message("gone", { from: "t2", to: "t1", state: "gone" }),
]
const outbound = [message("sent", { from: "t1", to: "t2", state: "queued" })]

describe("messages waiting for a terminal's agent", () => {
  it("are those to it still on their way: queued, leased or held", () => {
    const held = message("held", { from: "t2", to: "t1", state: "held", held: "paused" })
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

  context("with a thread held for release", () => {
    it("says the person must release it, even while paused", () => {
      const held = message("held", { from: "t2", to: "t1", state: "held", held: "release" })
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

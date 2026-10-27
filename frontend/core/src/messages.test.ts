import {
  hasMessages,
  messageBadge,
  messageBadgeLabel,
  waitingFor,
  type AgentMessage,
  type MessageParty,
  type TerminalThreads,
} from "./messages"
import { context, describe, expect, it } from "./test"

const agent = (handle: string): MessageParty => ({ kind: "agent", handle, agent: null })

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
const terminalMessages = (messages: readonly AgentMessage[], bound = true): TerminalThreads => ({
  handle: "moth",
  agent: bound,
  threads: messages.length
    ? [
        {
          id: "t-1",
          peer: agent("fox"),
          hops: messages.length,
          idle: 0,
          held: false,
          heldFor: null,
          messages,
        },
      ]
    : [],
})

const inbound = [
  message("queued", { from: agent("fox"), to: agent("moth"), state: "queued" }),
  message("leased", { from: agent("fox"), to: agent("moth"), state: "leased" }),
  message("delivered", { from: agent("fox"), to: agent("moth"), state: "delivered" }),
  message("gone", { from: agent("fox"), to: agent("moth"), state: "gone" }),
]
const outbound = [message("sent", { from: agent("moth"), to: agent("fox"), state: "queued" })]

describe("messages waiting for a terminal's agent", () => {
  it("are those to it still on their way: queued, leased or held", () => {
    const held = message("held", {
      from: agent("fox"),
      to: agent("moth"),
      state: "held",
      held: "paused",
    })
    expect(
      waitingFor(terminalMessages([...inbound, held, ...outbound])).map(({ id }) => id),
    ).toEqual(["queued", "leased", "held"])
  })
})

describe("a terminal's badge", () => {
  context("with nothing waiting for its agent", () => {
    it("shows nothing, whatever it sent", () => {
      expect(messageBadge(terminalMessages(outbound), false)).toBeNull()
      expect(messageBadge(undefined, true)).toBeNull()
    })
  })

  context("with messages waiting", () => {
    it("counts them", () => {
      const badge = messageBadge(terminalMessages(inbound), false)
      expect(badge).toEqual({ count: 2, kind: "waiting" })
      expect(messageBadgeLabel(badge!)).toBe("2 messages waiting")
    })

    it("says they're held while messaging is paused", () => {
      const paused = inbound.map((each) =>
        each.state === "queued"
          ? { ...each, state: "held" as const, held: "paused" as const }
          : each,
      )
      const badge = messageBadge(terminalMessages(paused), true)
      expect(badge).toEqual({ count: 2, kind: "paused" })
      expect(messageBadgeLabel(badge!)).toBe("2 messages waiting, held while messaging is paused")
    })
  })

  it("keeps the person's reply waiting while messages between agents are paused", () => {
    const reply = message("reply", {
      from: { kind: "person" },
      to: agent("moth"),
      state: "queued",
      inbox: "answer",
    })
    expect(messageBadge(terminalMessages([reply]), true)).toEqual({ count: 1, kind: "waiting" })
    expect(messageBadge(terminalMessages([...inbound, reply]), true)).toEqual({
      count: 3,
      kind: "waiting",
    })
  })

  context("with a thread held for release", () => {
    it("says the person must release it, even while paused", () => {
      const held = message("held", {
        from: agent("fox"),
        to: agent("moth"),
        state: "held",
        held: "release",
      })
      const badge = messageBadge(terminalMessages([held]), true)
      expect(badge).toEqual({ count: 1, kind: "held" })
      expect(messageBadgeLabel(badge!)).toBe("1 message waiting, held until you release it")
    })
  })
})

describe("a terminal's messages view", () => {
  it("is there for messages it had, but not for an agent that has had none", () => {
    expect(hasMessages(terminalMessages(outbound))).toBe(true)
    expect(hasMessages(terminalMessages(outbound, false))).toBe(true)
    expect(hasMessages(terminalMessages([]))).toBe(false)
    expect(hasMessages(terminalMessages([], false))).toBe(false)
    expect(hasMessages(undefined)).toBe(false)
  })
})

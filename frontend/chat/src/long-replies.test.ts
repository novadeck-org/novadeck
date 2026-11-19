import type { ChatBlock } from "@novadeck/core/conversation/turns"

import { foldableReplies, mayFold } from "./long-replies"
import { context, describe, expect, it } from "./test"

const prompt = (id: string): ChatBlock => ({
  kind: "user",
  id,
  text: "Go",
  truncated: false,
  at: null,
})
const said = (id: string, thinking = false): ChatBlock => ({
  kind: "assistant",
  id,
  text: "Words",
  truncated: false,
  at: null,
  ...(thinking && { thinking: true as const }),
})
const tools = (id: string): ChatBlock => ({ kind: "tools", id, entries: [] })
const doorbell = (id: string): ChatBlock => ({
  kind: "doorbell",
  id,
  at: null,
  messages: null,
  replies: false,
})

describe("the replies that may fold", () => {
  it("are each turn's last words, not what the agent said between its calls", () => {
    const blocks = [
      prompt("p1"),
      said("narration"),
      tools("t1"),
      said("reply1"),
      prompt("p2"),
      said("reply2"),
    ]
    expect([...foldableReplies(blocks, false)]).toEqual(["reply1"])
  })

  it("leave out the latest reply, which the person reads now", () => {
    expect([...foldableReplies([prompt("p1"), said("r1")], false)]).toEqual([])
  })

  it("leave out an update of the agent's thinking", () => {
    const blocks = [prompt("p1"), said("r1"), said("summary", true), prompt("p2"), said("r2")]
    expect([...foldableReplies(blocks, false)]).toEqual(["r1"])
  })

  context("while the agent works", () => {
    it("keep the turn before it open: its reply is still the latest", () => {
      const blocks = [prompt("p1"), said("r1"), prompt("p2"), said("r2"), prompt("p3"), said("now")]
      expect([...foldableReplies(blocks, true)]).toEqual(["r1"])
    })
  })

  it("count a turn the doorbell started as a turn", () => {
    const blocks = [prompt("p1"), said("r1"), doorbell("d"), said("r2")]
    expect([...foldableReplies(blocks, false)]).toEqual(["r1"])
  })

  it("count words before the window's first prompt as a turn of their own", () => {
    const blocks = [said("earlier"), prompt("p1"), said("r1")]
    expect([...foldableReplies(blocks, false)]).toEqual(["earlier"])
  })
})

describe("whether a reply might run long", () => {
  it("is so from 1,200 characters or 30 lines, else never measured", () => {
    expect(mayFold("a".repeat(1_199))).toBe(false)
    expect(mayFold("a".repeat(1_200))).toBe(true)
    expect(mayFold("line\n".repeat(28))).toBe(false)
    expect(mayFold("line\n".repeat(29))).toBe(true)
  })
})

import type { ChatBlock } from "@novadeck/core/conversation/turns"

import { withBubbles, type SentBubble } from "./bubbles"
import type { Echo } from "./echoes"
import { describe, expect, it } from "./test"

const block = (id: string, at: number | null): ChatBlock => ({
  kind: "user",
  id,
  text: id,
  truncated: false,
  at,
})
const bubble = (ref: string, at: number | null): SentBubble => ({
  ref,
  text: ref,
  images: [],
  state: "sending",
  at,
})
const echo = (id: number, at: number): Echo => ({ id, text: `/${id}`, at, slice: null })

const order = (placed: ReturnType<typeof withBubbles>): string[] =>
  placed.map((each) =>
    each.kind === "block" ? each.block.id : each.kind === "sent" ? each.bubble.ref : each.echo.text,
  )

describe("withBubbles", () => {
  it("stands an echo before the first block recorded after it", () => {
    const placed = withBubbles([block("a", 10), block("b", 30)], [], [echo(1, 20)])
    expect(order(placed)).toEqual(["a", "/1", "b"])
  })

  it("puts an echo after every block when nothing came after it", () => {
    const placed = withBubbles([block("a", 10)], [], [echo(1, 20)])
    expect(order(placed)).toEqual(["a", "/1"])
  })

  it("orders echoes and bubbles by when each went, one not sent yet last", () => {
    const placed = withBubbles(
      [block("a", 10), block("b", 50)],
      [bubble("sent", 25), bubble("unsent", null)],
      [echo(1, 20), echo(2, 30), echo(3, 60)],
    )
    expect(order(placed)).toEqual(["a", "/1", "sent", "/2", "b", "/3", "unsent"])
  })

  it("places nothing before a block with no time of its own", () => {
    const placed = withBubbles([block("a", null), block("b", 30)], [], [echo(1, 5)])
    expect(order(placed)).toEqual(["a", "/1", "b"])
  })
})

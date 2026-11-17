import type { ChatItem, ChatPrompt } from "@novadeck/core/conversation"
import type { ChatBlock } from "@novadeck/core/conversation/turns"

import { sentBubbles, withBubbles, type SentBubble } from "./bubbles"
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

describe("sentBubbles", () => {
  const said = (text: string, at: number | null, over: Partial<ChatItem> = {}): ChatItem => ({
    id: `${text}@${at}`,
    at,
    role: "user",
    kind: "text",
    text,
    truncated: false,
    tool: null,
    call: null,
    author: null,
    run: null,
    outcome: null,
    scripted: false,
    interrupted: false,
    ring: null,
    ...over,
  })
  const receipt = (ref: string, text: string, sentAt: number, item: number | null = null) =>
    ({
      ref,
      text,
      sentAt,
      state: item === null ? "pending" : "settled",
      item,
    }) satisfies ChatPrompt
  const shown = (prompts: readonly ChatPrompt[], items: readonly ChatItem[]) =>
    sentBubbles([], prompts, items).map(({ ref }) => ref)

  it("drops a pending prompt the transcript holds before its receipt says so", () => {
    const prompts = [receipt("r1", "check the logs", 5_400)]
    expect(shown(prompts, [said("earlier", 1_000)])).toEqual(["r1"])
    expect(shown(prompts, [said("earlier", 1_000), said("\ncheck the logs \r\n", 5_600)])).toEqual(
      [],
    )
  })

  it("takes an item the record dates before the receipt's send, as its Enter came first", () => {
    // A first prompt's receipt tells the send once its session bound, seconds after the Enter.
    expect(shown([receipt("r1", "go", 15_400)], [said("go", 9_000)])).toEqual([])
  })

  it("keeps a pending prompt whose words the record holds only from long before it went", () => {
    expect(shown([receipt("r1", "go", 15_400)], [said("go", 8_399)])).toEqual(["r1"])
  })

  it("keeps a pending prompt where the record holds other words or lines, or none dated", () => {
    const prompts = [receipt("r1", "check the logs", 5_400)]
    expect(shown(prompts, [said("stop", 6_000)])).toEqual(["r1"])
    expect(shown(prompts, [said("check the\nlogs", 6_000)])).toEqual(["r1"])
    expect(shown(prompts, [said("check the logs", null)])).toEqual(["r1"])
  })

  it("keeps prompts the record holds as one item, for their receipts to tell", () => {
    const prompts = [receipt("r1", "one", 5_000), receipt("r2", "two", 5_100)]
    expect(shown(prompts, [said("one\ntwo", 6_000)])).toEqual(["r1", "r2"])
  })

  it("lets one item stand for one prompt only, the first", () => {
    const prompts = [receipt("r1", "yes", 5_000), receipt("r2", "yes", 5_100)]
    expect(shown(prompts, [said("yes", 6_000)])).toEqual(["r2"])
    expect(shown(prompts, [said("yes", 6_000), said("yes", 6_100)])).toEqual([])
  })

  it("leaves an item a settled or withdrawn receipt claims to that receipt", () => {
    const prompts = [receipt("r1", "yes", 5_000, 0), receipt("r2", "yes", 5_100)]
    expect(shown(prompts, [said("yes", 6_000)])).toEqual(["r2"])
    const withdrawn = { ...receipt("r1", "go", 5_000, 0), state: "withdrawn" } satisfies ChatPrompt
    expect(shown([withdrawn, receipt("r2", "go", 6_000)], [said("go", 5_500)])).toEqual(["r2"])
  })

  it("counts neither a doorbell's line nor an interruption's record as the person's words", () => {
    const prompts = [receipt("r1", "go", 5_000)]
    const ring = said("go", 6_000, { ring: { nonce: "n", replies: false } })
    const stopped = said("go", 6_000, { interrupted: true })
    expect(shown(prompts, [ring, stopped])).toEqual(["r1"])
  })
})

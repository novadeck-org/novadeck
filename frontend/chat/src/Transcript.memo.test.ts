import type { ChatBlock } from "@novadeck/core/conversation/turns"
import { render } from "@novadeck/test-kit/render"
import type { Mention } from "@novadeck/toolkit/mentions"
import { createElement } from "react"
import { vi } from "vitest"

import { describe, expect, it } from "./test"
import { Transcript, type PeerLooks } from "./Transcript"

// What the Markdown was asked to draw, block by block.
const drawn = vi.hoisted((): string[] => [])
vi.mock("@novadeck/toolkit/Markdown", () => ({
  Markdown: ({ text }: { readonly text: string }) => {
    drawn.push(text)
    return createElement("div", { className: "markdown" }, text)
  },
}))

const blocks: readonly ChatBlock[] = [
  { kind: "assistant", id: "1", text: "Because.", truncated: false, at: null },
  {
    kind: "doorbell",
    id: "2",
    at: null,
    replies: false,
    messages: [
      {
        id: "m",
        text: "Keep it.",
        from: { kind: "agent", handle: "moth", agent: "codex" },
      } as never,
    ],
  },
]

const transcript = (looks: PeerLooks, mention?: Mention) =>
  createElement(Transcript, { blocks, agent: "Claude", working: false, looks, mention })

describe("the scrollback, as other agents' looks change", () => {
  it("draws again the blocks whose words may name other agents", () => {
    const { rerender } = render(transcript(() => null))
    expect(drawn.splice(0).toSorted()).toEqual(["Because.", "Keep it."])
    rerender(transcript(() => null))
    expect(drawn.splice(0).toSorted()).toEqual(["Because.", "Keep it."])
  })

  it("leaves the words that only name agents be while the set of handles they name stays", () => {
    const mention: Mention = () => null
    const { rerender } = render(transcript(() => null, mention))
    drawn.splice(0)
    rerender(transcript(() => null, mention))
    // Only the agent's own message, which draws its face from the looks.
    expect(drawn.splice(0)).toEqual(["Keep it."])
  })

  it("never draws a block with no agents or names in it again", () => {
    // The same block, its words changed behind its back: only a block drawn again shows them.
    const note: ChatBlock = { kind: "note", id: "n", text: "Before" } as never
    const view = (looks: PeerLooks, mention: Mention) =>
      createElement(Transcript, { blocks: [note], agent: "Claude", working: false, looks, mention })
    const { container, rerender } = render(
      view(
        () => null,
        () => null,
      ),
    )
    ;(note as { text: string }).text = "After"
    rerender(
      view(
        () => null,
        () => 3,
      ),
    )
    expect(container.querySelector(".chat-note")?.textContent).toBe("Before")
  })
})

import type { ChatBlock } from "@novadeck/core/conversation/turns"
import { render } from "@novadeck/test-kit/render"
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

const transcript = (looks: PeerLooks) =>
  createElement(Transcript, { blocks, agent: "Claude", working: false, looks })

describe("the scrollback, as other agents' looks change", () => {
  it("draws again only the blocks that show other agents", () => {
    const { rerender } = render(transcript(() => null))
    expect(drawn.splice(0).toSorted()).toEqual(["Because.", "Keep it."])
    rerender(transcript(() => null))
    expect(drawn.splice(0)).toEqual(["Keep it."])
  })
})

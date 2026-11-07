import type { ChatBlock } from "@novadeck/core/conversation/turns"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import type { SentBubble } from "./bubbles"
import { describe, expect, it } from "./test"
import { Transcript } from "./Transcript"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const show = (blocks: readonly ChatBlock[], sent?: readonly SentBubble[]) => {
  const { container, unmount } = render(
    createElement(Transcript, {
      blocks,
      agent: "Claude",
      working: false,
      ...(sent && { sent }),
    }),
  )
  unmounts.push(unmount)
  return container
}

const words = (id: string, kind: "user" | "assistant", text: string): ChatBlock => ({
  kind,
  id,
  text,
  truncated: false,
  at: null,
})

describe("the scrollback", () => {
  it("marks the person's prompts, and only those", () => {
    const container = show([
      words("1", "user", "Why?"),
      words("2", "assistant", "Because."),
      { kind: "note", id: "3", text: "Interrupted" },
    ])
    const marks = [...container.querySelectorAll(".chat-mark")]
    expect(marks.map((mark) => mark.closest("article")?.getAttribute("aria-label"))).toEqual([
      "You",
    ])
    expect(marks[0]?.getAttribute("aria-hidden")).toBe("true")
  })

  it("names who says what to a screen reader", () => {
    const labels = [
      ...show([words("1", "user", "Why?"), words("2", "assistant", "Because.")]).querySelectorAll(
        "article",
      ),
    ].map((article) => article.getAttribute("aria-label"))
    expect(labels).toEqual(["You", "Claude"])
  })

  it("says a prompt was cut short", () => {
    const container = show([{ ...words("1", "user", "Long"), truncated: true } as ChatBlock])
    expect(container.querySelector(".chat-shortened")).not.toBeNull()
  })

  it("marks a prompt the record doesn't have yet, with its state", () => {
    const container = show([], [{ ref: "a", text: "and a test", state: "queued", at: null }])
    const prompt = container.querySelector("article")
    expect(prompt?.getAttribute("data-sent")).toBe("queued")
    expect(prompt?.querySelector(".chat-mark")).not.toBeNull()
    expect(prompt?.textContent).toContain("Queued")
  })
})

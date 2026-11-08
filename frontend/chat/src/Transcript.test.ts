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
    const container = show(
      [],
      [{ ref: "a", text: "and a test", images: [], state: "queued", at: null }],
    )
    const prompt = container.querySelector("article")
    expect(prompt?.getAttribute("data-sent")).toBe("queued")
    expect(prompt?.querySelector(".chat-mark")).not.toBeNull()
    expect(prompt?.querySelector(".chat-sent-tag")?.textContent).toBe("queued")
  })

  it("sets another agent's handle beside its words, with no mark", () => {
    const container = show([
      { kind: "agent", id: "1", author: "moth", text: "Keep it.", truncated: false, at: null },
    ])
    const message = container.querySelector("article")
    expect(message?.getAttribute("aria-label")).toBe("Message from moth")
    expect(message?.querySelector(".chat-author")?.textContent).toBe("moth")
    expect(message?.querySelector(".markdown")?.textContent).toBe("Keep it.")
    expect(message?.querySelector(".chat-mark")).toBeNull()
  })

  it("offers what can be done about a prompt the record never got", () => {
    const lost: SentBubble = { ref: "a", text: "words", images: [], state: "unrecorded", at: null }
    const resent: SentBubble[] = []
    const edited: SentBubble[] = []
    const { container, unmount } = render(
      createElement(Transcript, {
        blocks: [],
        agent: "Claude",
        working: false,
        sent: [lost],
        onResend: (bubble) => resent.push(bubble),
        onEdit: (bubble) => edited.push(bubble),
      }),
    )
    unmounts.push(unmount)
    const key = (name: string) =>
      [...container.querySelectorAll<HTMLElement>(".chat-sent button")].find(
        (each) => each.textContent === name,
      )!
    key("send again").click()
    key("edit").click()
    expect(resent).toEqual([lost])
    expect(edited).toEqual([lost])
  })

  it("has no way to send again while the box holds words it would take along", () => {
    const { container, unmount } = render(
      createElement(Transcript, {
        blocks: [],
        agent: "Claude",
        working: false,
        sent: [{ ref: "a", text: "words", images: [], state: "unrecorded", at: null }],
        onEdit: () => {},
      }),
    )
    unmounts.push(unmount)
    expect(container.querySelector(".chat-sent")?.textContent).not.toContain("send again")
  })

  it("points at the terminal's box for words that went back there", () => {
    const { container, unmount } = render(
      createElement(Transcript, {
        blocks: [],
        agent: "Claude",
        working: false,
        sent: [{ ref: "a", text: "words", images: [], state: "in-box", at: null }],
        onShowTerminal: () => {},
      }),
    )
    unmounts.push(unmount)
    expect(container.querySelector('[aria-label="Show terminal"]')?.textContent).toBe("terminal")
  })
})

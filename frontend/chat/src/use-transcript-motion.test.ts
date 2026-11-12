import { render } from "@novadeck/test-kit/render"
import { createElement, useRef } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "./test"
import { useTranscriptMotion } from "./use-transcript-motion"

let entered: Element[]
let reduced: boolean
const original = Object.getOwnPropertyDescriptor(Element.prototype, "animate")
beforeEach(() => {
  entered = []
  reduced = false
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value(this: Element) {
      entered.push(this)
      return { cancel: () => {}, addEventListener: () => {} }
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (original) Object.defineProperty(Element.prototype, "animate", original)
  else Reflect.deleteProperty(Element.prototype, "animate")
})

const Host = ({
  ids,
  loaded = true,
  session = "one",
  text = "words",
  tools = [],
  role,
  pending = false,
}: {
  ids: string[]
  loaded?: boolean
  session?: string
  text?: string
  tools?: string[]
  role?: string
  pending?: boolean
}) => {
  const thread = useRef<HTMLDivElement>(null)
  useTranscriptMotion(thread, session, loaded)
  return createElement(
    "div",
    // oxlint-disable-next-line react/refs -- React invokes this ref callback at commit, not during render.
    {
      ref: (node: HTMLDivElement | null) => {
        thread.current = node
      },
    },
    ...ids.map((id) =>
      createElement(
        "article",
        {
          key: id,
          id,
          className: "chat-message",
          "data-role": role,
          "data-sent": pending ? "sending" : undefined,
          "data-turn": role === "user" && !pending ? id : undefined,
        },
        text,
      ),
    ),
    ...(tools.length
      ? [
          createElement(
            "div",
            { key: "tools", className: "chat-tools" },
            createElement(
              "ul",
              { className: "chat-tools-list" },
              ...tools.map((id) =>
                createElement("li", { key: id, id, className: "chat-tool" }, text),
              ),
            ),
          ),
        ]
      : []),
  )
}
const names = () => entered.map((row) => row.id || row.className)

describe("transcript arrivals", () => {
  it("leaves initial history and streamed text steady, fading only appended segments", () => {
    const { rerender } = render(createElement(Host, { ids: ["first"] }))
    rerender(createElement(Host, { ids: ["first"], text: "more words" }))
    expect(names()).toEqual([])
    rerender(createElement(Host, { ids: ["first", "second"] }))
    expect(names()).toEqual(["second"])
    rerender(createElement(Host, { ids: ["first", "second"], text: "still streaming" }))
    expect(names()).toEqual(["second"])
  })

  it("waits for history to load and resets for another session", () => {
    const { rerender } = render(createElement(Host, { ids: [], loaded: false }))
    rerender(createElement(Host, { ids: ["history"] }))
    rerender(createElement(Host, { ids: ["other"], session: "two" }))
    expect(names()).toEqual([])
    rerender(createElement(Host, { ids: ["other", "new"], session: "two" }))
    expect(names()).toEqual(["new"])
  })

  it("ignores prepended history while allowing the first arrival in an empty loaded chat", () => {
    const { rerender } = render(createElement(Host, { ids: [] }))
    rerender(createElement(Host, { ids: ["first"] }))
    rerender(createElement(Host, { ids: ["older", "first"] }))
    expect(names()).toEqual(["first"])
    rerender(createElement(Host, { ids: ["first", "next"] }))
    expect(names()).toEqual(["first", "next"])
  })

  it("fades new tool groups once and subsequent tool rows individually", () => {
    const { rerender } = render(createElement(Host, { ids: ["prompt"] }))
    rerender(createElement(Host, { ids: ["prompt"], tools: ["read"] }))
    expect(names()).toEqual(["chat-tools"])
    rerender(createElement(Host, { ids: ["prompt"], tools: ["read", "write"] }))
    expect(names()).toEqual(["chat-tools", "write"])
  })

  it("fades the recorded prompt once while its pending row stays steady", () => {
    const { rerender } = render(createElement(Host, { ids: [], role: "user" }))
    rerender(createElement(Host, { ids: ["pending"], role: "user", pending: true }))
    expect(names()).toEqual([])
    rerender(createElement(Host, { ids: ["recorded"], role: "user" }))
    expect(names()).toEqual(["recorded"])
    rerender(createElement(Host, { ids: ["recorded"], role: "user", text: "same prompt" }))
    expect(names()).toEqual(["recorded"])
  })

  it("fades the recorded prompt and the next agent segment after a pending tail disappears", () => {
    const { rerender } = render(createElement(Host, { ids: ["history"] }))
    rerender(createElement(Host, { ids: ["history", "pending"], pending: true }))
    expect(names()).toEqual([])
    rerender(createElement(Host, { ids: ["history", "recorded", "reply"] }))
    expect(names()).toEqual(["recorded", "reply"])
  })

  it("leaves loaded and prepended user history steady, fading only new recorded turns", () => {
    const { rerender } = render(createElement(Host, { ids: ["old"], role: "user" }))
    rerender(createElement(Host, { ids: ["older", "old"], role: "user" }))
    expect(names()).toEqual([])
    rerender(createElement(Host, { ids: ["older", "old", "new"], role: "user" }))
    expect(names()).toEqual(["new"])
  })

  it("does not queue arrivals for replay when reduced motion is enabled", () => {
    const { rerender } = render(createElement(Host, { ids: [] }))
    reduced = true
    rerender(createElement(Host, { ids: ["first"] }))
    reduced = false
    rerender(createElement(Host, { ids: ["first"] }))
    expect(names()).toEqual([])
  })
})

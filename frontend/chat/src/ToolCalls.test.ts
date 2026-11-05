import type { ToolEntry } from "@novadeck/core/conversation/turns"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { context, describe, expect, it } from "./test"
import { ToolCalls } from "./ToolCalls"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const call = (id: string, title: string, detail = ""): ToolEntry => ({
  id,
  call: id,
  tool: title,
  run: { kind: "run", title, detail },
  input: "{}",
  truncated: false,
  result: { id: `${id}:result`, text: "ok", truncated: false },
})

// A result whose call is outside the window.
const orphan = (id: string): ToolEntry => ({
  id,
  call: id,
  tool: null,
  run: null,
  input: "",
  truncated: false,
  result: { id: `${id}:result`, text: "ok", truncated: false },
})

const show = (entries: readonly ToolEntry[]) => {
  const { container, unmount } = render(createElement(ToolCalls, { entries, live: false }))
  unmounts.push(unmount)
  return container
}

describe("a run of tool calls", () => {
  context("folded", () => {
    it("names what its calls were, leaving out a result whose call is outside the window", () => {
      for (const entries of [
        [orphan("0"), call("1", "Ran"), call("2", "Read"), call("3", "Edited")],
        [call("1", "Ran"), call("2", "Read"), orphan("0"), call("3", "Edited")],
      ]) {
        const fold = show(entries).querySelector(".chat-tools-fold .chat-tool-detail")
        expect(fold?.textContent).toBe("Ran, Read, Edited")
      }
    })
  })

  it("shows each control that would reorder a call's detail, as the terminal shows it in order", () => {
    const container = show([call("1", "Ran", "echo \u202Ehi\u200F")])
    expect(container.querySelector(".chat-tool-detail")?.textContent).toBe(
      "echo ⟨U+202E⟩hi⟨U+200F⟩",
    )
  })
})

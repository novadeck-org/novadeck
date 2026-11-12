import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { Hold } from "./Hold"
import { describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const hold = (open: boolean) => {
  const { container, unmount } = render(
    createElement(Hold, {
      text: "Ask @thorn about it,\nnot @nobody",
      at: null,
      offset: 0,
      phase: undefined,
      open,
      onOpen: () => {},
      onClose: () => {},
      onGo: () => {},
      mention: (handle) => (handle === "thorn" ? 3 : null),
    }),
  )
  unmounts.push(unmount)
  return container
}

describe("the held prompt", () => {
  it.each([
    ["one line", false],
    ["peek", true],
  ])("draws a known agent's handle in its hue in the %s", (_, open) => {
    const mentions = [...hold(open).querySelectorAll(".chat-hold-words .markdown-mention")]
    expect(mentions.map((each) => [each.textContent, each.getAttribute("data-hue")])).toEqual([
      ["@thorn", "3"],
    ])
  })
})

import type { MessageWaits, TerminalThreads } from "@novadeck/core/messages"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../../../test"
import { noLinks, type MessagesHandle } from "./messages"
import { MessagesView } from "./MessagesView"

const message = {
  id: "m1",
  hop: 1,
  from: "fox",
  to: "moth",
  text: "Hello.",
  sentAt: 1,
  state: "queued",
  held: null,
  deliveredAt: null,
} as const

const messagesOf = (waits: MessageWaits | null, paused = false): MessagesHandle => {
  const threads: TerminalThreads = {
    handle: "moth",
    agent: true,
    waits,
    threads: [
      { id: "t1", peer: "fox", hops: 1, idle: 0, held: false, heldFor: null, messages: [message] },
    ],
  }
  return {
    threads,
    paused,
    pending: false,
    error: null,
    present: true,
    badge: { count: 1, kind: paused ? "paused" : "waiting" },
    pause: () => {},
    seenAt: () => 0,
    seen: () => {},
  }
}

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const html = (view: MessagesHandle): string => {
  const rendered = render(createElement(MessagesView, { view, links: noLinks }))
  unmounts.push(rendered.unmount)
  return rendered.container.innerHTML
}

describe("the Messages pane's note on why the doorbell cannot wake an idle agent", () => {
  it.each([
    ["working", "It is working"],
    ["queued", "A prompt is queued in it"],
    ["shell", "Its box is in shell mode"],
    ["draft", "There's text in its box"],
    ["dialog", "A dialog or picker is open"],
    ["asking", "It is asking you a question"],
    ["failed", "The doorbell failed"],
    ["away", "isn't at the agent's prompt"],
  ] as const)("says %s in plain words while messages wait", (waits, words) => {
    expect(html(messagesOf(waits))).toContain(words)
  })

  it("says nothing when nothing keeps it, or messaging is paused", () => {
    expect(html(messagesOf(null))).not.toContain("message-waits")
    expect(html(messagesOf("draft", true))).not.toContain("message-waits")
  })
})

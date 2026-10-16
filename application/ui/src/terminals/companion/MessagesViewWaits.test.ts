import { createElement } from "react"
import { afterEach } from "vitest"

import type { MailWaits, TerminalMail } from "../../model/messages"
import { describe, expect, it } from "../../test"
import { render } from "../../test/render"
import type { MailHandle } from "./mail"
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

const mailOf = (waits: MailWaits | null, paused = false): MailHandle => {
  const mail: TerminalMail = {
    handle: "moth",
    agent: true,
    waits,
    threads: [{ id: "t1", peer: "fox", hops: 1, allowed: 12, held: false, messages: [message] }],
  }
  return {
    mail,
    paused,
    pending: false,
    error: null,
    releasing: [],
    failed: {},
    present: true,
    badge: { count: 1, kind: paused ? "paused" : "waiting" },
    pause: () => {},
    release: () => {},
  }
}

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const html = (mail: MailHandle): string => {
  const rendered = render(createElement(MessagesView, { mail, peerName: () => undefined }))
  unmounts.push(rendered.unmount)
  return rendered.container.innerHTML
}

describe("the Messages pane's note on why the doorbell cannot wake an idle agent", () => {
  it.each([
    ["draft", "There's text in its box"],
    ["dialog", "A dialog or picker is open"],
    ["asking", "It is asking you a question"],
    ["failed", "The doorbell failed"],
    ["away", "isn't at the agent's prompt"],
  ] as const)("says %s in plain words while messages wait", (waits, words) => {
    expect(html(mailOf(waits))).toContain(words)
  })

  it("says nothing when nothing keeps it, or messaging is paused", () => {
    expect(html(mailOf(null))).not.toContain("mail-waits")
    expect(html(mailOf("draft", true))).not.toContain("mail-waits")
  })
})

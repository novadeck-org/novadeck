import type { AgentMessage, InboxHistory } from "@novadeck/core/messages"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"

import type { MailHandle } from "./mail"
import { MessagesView } from "./MessagesView"
import { describe, expect, it } from "./test"

const mount = (message: Partial<AgentMessage>, paused = false) => {
  const mail: MailHandle = {
    mail: {
      handle: "moth",
      agent: true,
      threads: [
        {
          id: "t-letter",
          peer: "you",
          hops: 1,
          allowed: 0,
          held: false,
          messages: [
            {
              id: "letter",
              from: "moth",
              to: "you",
              text: "Which route?",
              hop: 1,
              sentAt: 0,
              state: "delivered",
              held: null,
              deliveredAt: 0,
              inbox: "ask",
              ...message,
            },
          ],
        },
      ],
    },
    paused,
    pending: false,
    error: null,
    releasing: [],
    failed: {},
    present: true,
    badge: null,
    pause: () => {},
    release: () => {},
  }
  return render(createElement(MessagesView, { mail, peerName: () => undefined }))
}

describe("Inbox history", () => {
  const labels: readonly [InboxHistory, string][] = [
    ["open", "Waiting for your answer"],
    ["answered", "Replied"],
    ["withdrawn", "Withdrawn"],
    ["gone", "Agent session ended"],
    ["undelivered", "Reply not delivered"],
  ]
  for (const [state, label] of labels) {
    it(`shows an ask that is ${state} beside the preserved question`, () => {
      const view = mount({ inboxState: state })
      expect(view.container.querySelector(`[data-history="${state}"]`)?.textContent).toBe(label)
      expect(view.container.querySelector(".mail-text")?.textContent).toBe("Which route?")
      expect(view.container.querySelector("h3")?.textContent).toBe("You")
      view.unmount()
    })
  }

  it("labels a person's reply that could not be delivered", () => {
    const view = mount({
      inbox: "answer",
      from: "you",
      to: "moth",
      state: "gone",
      deliveredAt: null,
      text: "Use /retry.",
    })
    expect(view.container.querySelector(".mail-state[data-state=gone]")?.textContent).toBe(
      "Reply not delivered",
    )
    expect(view.container.textContent).toContain("Your reply")
    expect(view.container.textContent).not.toContain("@you")
    view.unmount()
  })

  it("names tell reading states and explains the person can reply while messaging is paused", () => {
    const view = mount({ inbox: "tell", inboxState: "read" }, true)
    expect(view.container.querySelector("[data-history=read]")?.textContent).toBe("Read")
    expect(view.container.textContent).toContain("Your replies still go through.")
    view.unmount()
  })
})

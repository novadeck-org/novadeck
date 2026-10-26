import type { AgentMessage, MessagePeer, MessageThread } from "@novadeck/core/messages"
import { render } from "@novadeck/test-kit/render"
import { Shown } from "@novadeck/toolkit/shown"
import { act, createElement } from "react"
import { afterEach } from "vitest"

import { context, describe, expect, it } from "../../../test"
import type { MessagesHandle, MessageLinks } from "./messages"
import { MessagesView } from "./MessagesView"

let sequence = 0
const message = (
  from: string,
  to: string,
  sentAt: number,
  text: string,
  extra: Partial<AgentMessage> = {},
): AgentMessage => ({
  id: `m${(sequence += 1)}`,
  hop: 1,
  from,
  to,
  text,
  sentAt,
  state: "delivered",
  held: null,
  deliveredAt: sentAt,
  ...extra,
})

const thread = (id: string, peer: string, messages: readonly AgentMessage[]): MessageThread => ({
  id,
  peer,
  hops: messages.length,
  idle: 0,
  held: false,
  heldFor: null,
  messages,
})

const now = Date.now()
const peers: Readonly<Record<string, MessagePeer>> = {
  owl: { name: "Tests", terminalId: "03", program: "claude", live: "working" },
  fox: { name: "Dev server", terminalId: "02", program: "zsh", live: "gone" },
  moth: { name: "Checkout", terminalId: "01", program: "claude", live: "working" },
}

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const mount = (
  threads: readonly MessageThread[],
  {
    paused = false,
    seenAt = 0,
    shown = true,
  }: { paused?: boolean; seenAt?: number; shown?: boolean } = {},
) => {
  const did = { goTo: [] as string[], answer: [] as string[], seen: [] as [string, number][] }
  const handle: MessagesHandle = {
    threads: { handle: "moth", agent: true, threads },
    paused,
    pending: false,
    error: null,
    present: true,
    badge: null,
    pause: () => {},
    seenAt: () => seenAt,
    seen: (conversation, at) => did.seen.push([conversation, at]),
  }
  const links: MessageLinks = {
    peers: { getSnapshot: () => peers, subscribe: () => () => {} },
    goTo: (terminalId) => did.goTo.push(terminalId),
    answer: (entry) => did.answer.push(entry.id),
  }
  const view = render(
    createElement(
      Shown.Provider,
      { value: shown },
      createElement(MessagesView, { view: handle, links }),
    ),
  )
  unmounts.push(view.unmount)
  const $ = (selector: string) => view.container.querySelector<HTMLElement>(selector)
  const rows = () =>
    [...view.container.querySelectorAll<HTMLElement>(".message-row")].map((row) => ({
      name: row.querySelector(".message-row-name")?.textContent,
      corner: row.querySelector(".message-row-end")?.textContent,
      unread: row.hasAttribute("data-unread"),
    }))
  const open = (key: string) => act(() => $(`[data-conversation="${key}"]`)!.click())
  return { view, $, rows, open, did }
}

const ask = (state: "open" | "answered", at = now) =>
  message("moth", "you", at, "Which route?", { inbox: "ask", inboxState: state })

describe("the Messages pane's list", () => {
  it("names each conversation by its terminal, the person's entries first while they wait", () => {
    const { rows } = mount([
      thread("t-owl", "owl", [message("owl", "moth", now - 1000, "3 of 10 failed.")]),
      thread("t-a", "you", [ask("open", now - 60 * 60_000)]),
    ])
    expect(rows().map(({ name }) => name)).toEqual(["You", "Tests"])
    expect(rows()[0]!.corner).toBe("Asks you")
  })

  it("says Unread for news since the person last looked, bolder, else the time", () => {
    const threads = [thread("t-owl", "owl", [message("owl", "moth", now, "News")])]
    expect(mount(threads, { seenAt: now - 1 }).rows()[0]).toMatchObject({
      corner: "Unread",
      unread: true,
    })
    expect(mount(threads, { seenAt: now }).rows()[0]).toMatchObject({ unread: false })
    expect(mount(threads, { seenAt: now }).rows()[0]!.corner).not.toBe("Unread")
  })

  it("says Not delivered once the last message was lost", () => {
    const { rows } = mount([
      thread("t-fox", "fox", [
        message("moth", "fox", now, "Restart it.", { state: "gone", deliveredAt: null }),
      ]),
    ])
    expect(rows()[0]!.corner).toBe("Not delivered")
  })

  it("previews the last message with who wrote it", () => {
    const { $ } = mount([
      thread("t-owl", "owl", [message("owl", "moth", now, "Line one\nline two")]),
    ])
    expect($(".message-preview")?.textContent).toBe("@owl: Line one line two")
  })

  it("explains the person can reply while messaging is paused", () => {
    const { view } = mount([thread("t-owl", "owl", [message("owl", "moth", now, "Hi")])], {
      paused: true,
    })
    expect(view.container.textContent).toContain("Your replies still go through.")
  })
})

describe("an open conversation", () => {
  context("with an agent", () => {
    const threads = [
      thread("t-owl", "owl", [
        message("owl", "moth", now - 2000, "cart.spec.ts failed again."),
        message("moth", "owl", now - 1000, "Run it ten more times."),
        message("owl", "moth", now, "3 of 10 failed.", { state: "queued", deliveredAt: null }),
      ]),
    ]

    it("reads as a chat, the terminal's agent on the right, notes only where worth a look", () => {
      const { $, view, open, did } = mount(threads)
      open("owl")
      expect($(".message-chat-name")?.textContent).toBe("Tests@owl")
      const sides = [...view.container.querySelectorAll(".message-bubble-row")].map((row) =>
        row.getAttribute("data-side"),
      )
      expect(sides).toEqual(["in", "out", "in"])
      const notes = [...view.container.querySelectorAll(".message-note")].map(
        (note) => note.textContent,
      )
      expect(notes).toEqual(["Delivered", "Waiting"])
      expect(did.seen).toEqual([["owl", now]])
    })

    it("leaves news unseen while its terminal is out of sight", () => {
      const { open, did } = mount(threads, { shown: false })
      open("owl")
      expect(did.seen).toEqual([])
    })

    it("goes to the other agent's terminal, and back to the list onto its row", () => {
      const { $, open, did } = mount(threads)
      open("owl")
      act(() => $(".message-go")!.click())
      expect(did.goTo).toEqual(["03"])
      act(() => $(".message-back")!.click())
      expect(document.activeElement?.getAttribute("data-conversation")).toBe("owl")
    })
  })

  context("with the person", () => {
    const entries = [
      thread("t-a", "you", [
        message("moth", "you", now - 3000, "Tax before shipping?", {
          inbox: "ask",
          inboxState: "answered",
        }),
        message("you", "moth", now - 2000, "After.", { inbox: "answer" }),
      ]),
      thread("t-b", "you", [ask("open")]),
    ]

    it("labels entries in plain words, quotes the question a reply answers, and offers Answer", () => {
      const { $, view, open, did } = mount(entries)
      open("you")
      expect($(".message-asks")?.textContent).toBe("1 question waits for you")
      const labels = [...view.container.querySelectorAll(".message-entry")].map(
        (label) => label.textContent,
      )
      expect(labels).toEqual(["Asked you · answered", "Asks you"])
      expect($(".message-quote")?.textContent).toBe("Tax before shipping?")
      // The terminal's own agent is there, working, whoever the conversation is with.
      expect($(".message-bubble-av .message-av")?.getAttribute("data-live")).toBe("working")
      expect($(".message-new")).not.toBeNull()
      act(() => $(".message-answer button")!.click())
      expect(did.answer).toHaveLength(1)
    })

    it("says a reply that could not be delivered", () => {
      const { $, open } = mount([
        thread("t-a", "you", [
          ask("answered", now - 2000),
          message("you", "moth", now, "Use /retry.", {
            inbox: "answer",
            state: "gone",
            deliveredAt: null,
          }),
        ]),
      ])
      open("you")
      expect($(".message-note[data-note=gone]")?.textContent).toBe("Reply not delivered")
    })
  })
})

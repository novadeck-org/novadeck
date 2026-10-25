import {
  emptyInbox,
  type Inbox,
  type InboxAnswer,
  type InboxItem,
  type InboxState,
} from "@novadeck/core/inbox"
import { createStore } from "@novadeck/core/store"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { describe, expect, it } from "../test"
import { InboxList } from "./InboxList"
import { InboxProvider } from "./InboxProvider"
import { InboxSheet } from "./InboxSheet"

Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const draftText =
  "The toast hides the footer.\nLog at ~/Workspace/app/out.log, from me@mail.dev, in frontend/ui/src/a.ts."

let count = 0
const mount = (text = draftText, failOnce = false) => {
  // A draft's edits are kept by its id, so each test has its own.
  const item: InboxItem = {
    id: `fb${count++}`,
    source: {
      projectId: "p",
      workspaceSessionId: "s",
      terminalId: "t",
      handle: "moth",
      agent: "claude",
      title: "Preview",
      projectName: "App",
    },
    at: Date.now(),
    stopped: false,
    seen: false,
    kind: "feedback",
    draft: { kind: "bug", text },
  }
  const state = createStore<InboxState>({ ...emptyInbox, items: [item] })
  const sent: InboxAnswer[] = []
  let failing = failOnce
  const inbox: Inbox = {
    state,
    answer: (id, answer) => {
      sent.push(answer)
      if (failing) {
        failing = false
        state.update((current) => ({ ...current, failed: { [id]: "Couldn't send." } }))
        return
      }
      state.update((current) => ({ ...current, answering: { [id]: true } }))
    },
    see: () => {},
    readAll: () => {},
  }
  const view = render(
    createElement(
      InboxProvider,
      {
        inbox,
        reveal: () => {},
        feedbackAbout: () => Promise.resolve({ version: "0.0.219", os: "Linux x64" }),
      },
      createElement("div", { id: "inbox-panel" }, createElement(InboxList)),
      createElement(InboxSheet, { active: true }),
    ),
  )
  act(() => view.container.querySelector<HTMLElement>(".inbox-row-select")!.click())
  const press = (name: string): void =>
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>(".inbox-sheet button"))
        .find((button) => button.textContent?.trim() === name)!
        .click()
    })
  const field = () => document.querySelector<HTMLTextAreaElement>(".inbox-sheet textarea")!
  const type = (value: string): void =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(),
        value,
      )
      field().dispatchEvent(new Event("input", { bubbles: true }))
    })
  const struck = () =>
    Array.from(document.querySelectorAll(".inbox-feedback-struck")).map((each) => each.textContent)
  return { view, sent, press, field, type, struck }
}

describe("A feedback draft in the Inbox", () => {
  it("shows as a row, and opens as the agent's draft with what could identify the person struck", async () => {
    const sheet = mount()
    expect(document.querySelector(".inbox-row-subject")?.textContent).toBe(
      "Feedback draft from @moth: The toast hides the footer.",
    )
    expect(document.querySelector(".inbox-byline")?.textContent).toContain(
      "@moth drafted this just now·Bug, its call·edit anything",
    )
    expect(sheet.field().value).toBe(draftText)
    expect(sheet.struck()).toEqual(["~/Workspace/app/out.log", "me@mail.dev"])
    expect(document.querySelector(".inbox-feedback-struck-line")?.textContent).toBe(
      "Struck before sending: 1 path, 1 email address.",
    )
    await nextFrame()
    sheet.view.unmount()
  })

  it("says the version and OS it sends, and links to an issue", async () => {
    const sheet = mount()
    await nextFrame()
    expect(document.querySelector(".inbox-feedback-privacy")?.textContent).toBe(
      "Anonymous. We get this note, 0.0.219, Linux x64.",
    )
    expect(document.querySelector<HTMLAnchorElement>(".inbox-feedback-reply a")?.href).toBe(
      "https://github.com/novadeck-org/novadeck/issues/new",
    )
    sheet.view.unmount()
  })

  it("sends the text as edited, without the struck parts", async () => {
    const sheet = mount()
    sheet.type("Tail of /home/al/x.log is empty.")
    expect(sheet.struck()).toEqual(["/home/al/x.log"])
    sheet.press("Send")
    expect(sheet.sent).toEqual([
      { kind: "feedback", answer: { type: "send", text: "Tail of [path] is empty." } },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  it("keeps an edit when the sheet closes and opens again", async () => {
    const sheet = mount()
    sheet.type("Edited.")
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    await nextFrame()
    act(() => document.querySelector<HTMLElement>(".inbox-row-select")!.click())
    await nextFrame()
    expect(sheet.field().value).toBe("Edited.")
    sheet.view.unmount()
  })

  it("can't send an emptied draft, and discards without sending", async () => {
    const sheet = mount()
    sheet.type("  ")
    const send = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Send",
    )!
    expect(send.disabled).toBe(true)
    sheet.press("Discard")
    expect(sheet.sent).toEqual([{ kind: "feedback", answer: { type: "discard" } }])
    await nextFrame()
    sheet.view.unmount()
  })

  it("keeps the person's edits when the answer doesn't take", async () => {
    const sheet = mount(draftText, true)
    sheet.type("Edited, then sent.")
    sheet.press("Send")
    expect(document.querySelector(".inbox-failure")?.textContent).toBe("Couldn't send.")
    expect(sheet.field().value).toBe("Edited, then sent.")
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    await nextFrame()
    act(() => document.querySelector<HTMLElement>(".inbox-row-select")!.click())
    await nextFrame()
    expect(sheet.field().value).toBe("Edited, then sent.")
    sheet.view.unmount()
  })

  it("won't send more than the card's limit, and says by how much", async () => {
    const sheet = mount()
    sheet.type("a".repeat(2001))
    expect(document.querySelector(".inbox-failure")?.textContent).toContain(
      "1 over the 2,000 character limit",
    )
    const send = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Send",
    )!
    expect(send.disabled).toBe(true)
    sheet.type("a".repeat(2000))
    expect(document.querySelector(".inbox-failure")).toBeNull()
    expect(send.disabled).toBe(false)
    await nextFrame()
    sheet.view.unmount()
  })
})

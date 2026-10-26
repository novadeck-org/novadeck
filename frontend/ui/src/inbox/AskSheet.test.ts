import {
  emptyInbox,
  type AskShape,
  type Inbox,
  type InboxAnswer,
  type InboxRow,
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

const shapes = {
  text: { type: "text" },
  options: {
    type: "options",
    recommend: 0,
    options: [
      { label: "Sample products", summary: null, details: null, code: null },
      { label: "Test catalog", summary: null, details: null, code: null },
    ],
  },
  action: { type: "action", command: "vercel login", directory: null, doneLabel: "I've logged in" },
} satisfies Record<string, AskShape>

// The sheet reads the public Inbox port; tests publish backend outcomes explicitly. An item
// given is shown in place of an ask of that shape.
const mount = (shape: keyof typeof shapes, item?: InboxRow) => {
  const sample: InboxRow = item ?? {
    id: "ask",
    source: {
      projectId: "p",
      workspaceSessionId: "s",
      terminalId: "t",
      handle: "moth",
      agent: "claude",
      title: "Preview",
      projectName: "App",
    },
    at: 0,
    stopped: false,
    seen: false,
    kind: "ask",
    ask: {
      subject: "Which catalog should the preview show?",
      body: "Choose the preview catalog.",
      details: null,
      hardToUndo: null,
      shape: shapes[shape],
    },
  }
  const state = createStore<InboxState>({ ...emptyInbox, items: [sample] })
  const sent: InboxAnswer[] = []
  const inbox: Inbox = {
    state,
    answer: (id, answer) => {
      sent.push(answer)
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
  const type = (text: string): void =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(),
        text,
      )
      field().dispatchEvent(new Event("input", { bubbles: true }))
    })
  const send = () => document.querySelector<HTMLButtonElement>(".inbox-send")!
  const confirm = (): void =>
    act(() => {
      state.update((current) => ({ ...current, items: [], answering: {} }))
    })
  const fail = (message: string): void =>
    act(() => {
      state.update((current) => ({ ...current, answering: {}, failed: { [sample.id]: message } }))
    })
  return { view, sent, press, field, type, send, confirm, fail }
}

describe("An Inbox reply's length", () => {
  it("promises no exact count, since the runner limits the encoded size", async () => {
    const sheet = mount("text")
    expect(document.querySelector(".inbox-reply-limit")?.textContent).toBe(
      "Up to about 4,000 characters, fewer with emoji or some languages.",
    )
    await nextFrame()
    sheet.view.unmount()
  })

  it("accepts 4,096 characters and names the limit", async () => {
    const sheet = mount("text")
    expect(sheet.field().maxLength).toBe(4096)
    sheet.type("a".repeat(4096))
    expect(document.querySelector(".inbox-reply-limit")?.textContent).toBe(
      "4,096 character limit reached.",
    )
    expect(sheet.send().disabled).toBe(false)
    sheet.press("Send")
    expect(sheet.sent).toEqual([
      { kind: "ask", answer: { type: "reply", option: null, text: "a".repeat(4096) } },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  for (const shape of ["text", "options", "action"] as const) {
    it(`keeps an overlong own answer to ${shape} editable and blocks button and Enter submission`, async () => {
      const sheet = mount(shape)
      if (shape === "action") sheet.press("Reply instead")
      sheet.type("a".repeat(4097))
      expect(sheet.field().maxLength).toBe(4096)
      expect(sheet.field().getAttribute("aria-invalid")).toBe("true")
      expect(document.querySelector(".inbox-reply-limit")?.textContent).toContain(
        "Shorten it to send.",
      )
      expect(sheet.send().disabled).toBe(true)
      act(() => {
        sheet.field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        sheet.send().form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      })
      expect(sheet.sent).toEqual([])
      sheet.type("Use samples.")
      expect(sheet.send().disabled).toBe(false)
      sheet.press("Send")
      expect(sheet.sent).toEqual([
        { kind: "ask", answer: { type: "reply", option: null, text: "Use samples." } },
      ])
      await nextFrame()
      sheet.view.unmount()
    })
  }

  it("preserves the draft when encoded delivery size rejects an otherwise valid length", async () => {
    const sheet = mount("text")
    const text = "🦋".repeat(2048)
    sheet.type(text)
    sheet.press("Send")
    sheet.fail("This reply exceeds the delivery size limit. Shorten it to send.")
    expect(sheet.field().value).toBe(text)
    expect(document.querySelector(".inbox-failure")?.textContent).toContain("delivery size limit")
    expect(document.querySelector(".inbox-sent")).toBeNull()
    await nextFrame()
    sheet.view.unmount()
  })
})

describe("An accepted reply's delivery", () => {
  it("replaces its queued confirmation when the reply cannot arrive", async () => {
    const sheet = mount("text")
    sheet.type("Use samples.")
    sheet.press("Send")
    sheet.confirm()
    expect(document.querySelector(".inbox-sent")?.textContent).toContain("Reply queued")
    sheet.fail("Your reply was not delivered because the agent's session ended.")
    expect(document.querySelector(".inbox-sent")).toBeNull()
    expect(document.querySelector(".inbox-failure")?.textContent).toBe(
      "Your reply was not delivered because the agent's session ended.",
    )
    expect(sheet.field().value).toBe("Use samples.")
    expect(document.querySelector(".inbox-status")?.textContent).toBe("reply not delivered")
    expect(sheet.send().disabled).toBe(true)
    await nextFrame()
    sheet.view.unmount()
  })
})

describe("An agent's several questions", () => {
  const question = (id: string, labels: readonly string[]) => ({
    id,
    header: null,
    question: `Which ${id}?`,
    multiSelect: false,
    text: false,
    options: labels.map((label) => ({ id: label, label, description: null })),
  })
  const asking: InboxRow = {
    id: "request:q",
    source: {
      projectId: "p",
      workspaceSessionId: "s",
      terminalId: "t",
      handle: "moth",
      agent: "claude",
      title: "Preview",
      projectName: "App",
    },
    at: 0,
    stopped: true,
    seen: false,
    kind: "request",
    request: {
      id: "q",
      kind: "question",
      tool: "AskUserQuestion",
      subject: "Which library?",
      choices: [],
      subagent: false,
      answered: false,
      dialog: {
        type: "questions",
        id: "d",
        chat: "prompt",
        questions: [question("library", ["date-fns", "Temporal"]), question("zone", ["UTC"])],
      },
    },
  }
  const pick = (label: string): void =>
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>(".inbox-sheet button"))
        .find((button) => button.textContent?.includes(label))!
        .click()
    })
  const footer = () => document.querySelector(".inbox-sheet-footer")

  it("count their answers beside a Send that stays in view and waits for all of them", async () => {
    const sheet = mount("text", asking)
    const send = () =>
      Array.from(footer()!.querySelectorAll("button")).find(
        (button) => button.textContent === "Send",
      )!
    expect(footer()?.querySelector(".inbox-progress")?.textContent).toBe("0 of 2 answered")
    expect(send().disabled).toBe(true)
    pick("Temporal")
    expect(footer()?.querySelector(".inbox-progress")?.textContent).toBe("1 of 2 answered")
    expect(send().disabled).toBe(true)
    pick("UTC")
    expect(footer()?.querySelector(".inbox-progress")?.textContent).toBe("2 of 2 answered")
    expect(send().disabled).toBe(false)
    act(() => send().click())
    expect(sheet.sent).toMatchObject([{ kind: "request", answer: { type: "questions" } }])
    await nextFrame()
    sheet.view.unmount()
  })
})

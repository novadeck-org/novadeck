import type { ChatDialogOption } from "@novadeck/core/conversation"
import {
  emptyInbox,
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

// jsdom has no ResizeObserver, which the sheet's placement watches its anchor with.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const item = (
  options: readonly ChatDialogOption[],
  kind: "permission" | "plan" = "permission",
  agent: InboxRow["source"]["agent"] = "codex",
): InboxRow => ({
  id: "i",
  source: {
    projectId: "p",
    workspaceSessionId: "s",
    terminalId: "t",
    handle: "moth",
    agent,
    title: "Title",
    projectName: "Project",
  },
  at: 0,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id: "r",
    kind,
    tool: kind === "plan" ? "ExitPlanMode" : "Bash",
    subject: "pnpm add x",
    choices: [],
    subagent: false,
    answered: false,
    dialog: { type: "choices", id: "d", title: null, detail: "pnpm add x", options },
  },
})

const codex: readonly ChatDialogOption[] = [
  { id: "yes", label: "Yes, proceed", text: null },
  {
    id: "always",
    label: "Yes, and don't ask again for commands that start with `pnpm add`",
    text: null,
  },
  { id: "no", label: "No, continue without running it", text: null },
  { id: "differently", label: "No, and tell Codex what to do differently", text: "prompt" },
]

// The sheet of one item, and the answers it gives the Inbox.
const mount = (
  options: readonly ChatDialogOption[],
  {
    kind = "permission",
    failing = false,
    agent = "codex",
    only,
  }: {
    only?: InboxRow
    kind?: "permission" | "plan"
    failing?: boolean
    agent?: InboxRow["source"]["agent"]
  } = {},
) => {
  const state = createStore<InboxState>({
    ...emptyInbox,
    items: [only ?? item(options, kind, agent)],
  })
  const sent: InboxAnswer[] = []
  const inbox: Inbox = {
    state,
    answer: (id, answer) => {
      sent.push(answer)
      // An answer that doesn't take leaves the item and says why.
      if (failing)
        return state.update((current) => ({
          ...current,
          failed: { [id]: "The agent didn't take that." },
        }))
      state.update((current) => ({ ...current, answering: { [id]: true } }))
    },
    see: () => {},
    readAll: () => {},
  }
  const view = render(
    createElement(
      InboxProvider,
      { inbox, reveal: () => {} },
      createElement("div", { id: "inbox-panel" }, createElement(InboxList)),
      createElement(InboxSheet, { active: true }),
    ),
  )
  act(() => view.container.querySelector<HTMLElement>(".inbox-row-select")!.click())
  const press = (name: string): void =>
    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".inbox-sheet button"))
        .find((button) => button.textContent?.trim().startsWith(name))!
        .click(),
    )
  const type = (text: string): void =>
    act(() => {
      const field = document.querySelector<HTMLTextAreaElement>(".inbox-sheet textarea")!
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
      set.call(field, text)
      field.dispatchEvent(new Event("input", { bubbles: true }))
    })
  // A successful backend answer removes its item once it has taken.
  const confirm = (): void =>
    act(() => {
      state.update((current) => ({ ...current, items: [], answering: {} }))
    })
  return { view, sent, press, type, state, confirm }
}

describe("A command permission's answers", () => {
  it("allows with the dialog's plain yes", async () => {
    const sheet = mount(codex)
    sheet.press("Allow")

    expect(sheet.sent).toEqual([
      { kind: "request", answer: { type: "choice", dialog: "d", option: "yes" } },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  it("denies with a note by the option that takes words, sending the note", async () => {
    const sheet = mount(codex)
    sheet.press("Deny")
    sheet.type("Use npm.")
    sheet.press("Deny")

    expect(sheet.sent).toEqual([
      {
        kind: "request",
        answer: { type: "choice", dialog: "d", option: "differently", text: "Use npm." },
      },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  it("denies without a note by the plain no", async () => {
    const sheet = mount(codex)
    sheet.press("Deny")
    sheet.press("Deny")

    expect(sheet.sent).toEqual([
      { kind: "request", answer: { type: "choice", dialog: "d", option: "no" } },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  it("denies at once, with no note to write, where the only no takes none", async () => {
    const sheet = mount([
      { id: "a", label: "Allow once", text: null },
      { id: "d", label: "Deny", text: null },
    ])
    sheet.press("Deny")

    expect(sheet.sent).toEqual([
      { kind: "request", answer: { type: "choice", dialog: "d", option: "d" } },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  it("offers no Deny where no option says no", async () => {
    const sheet = mount([{ id: "a", label: "Yes", text: null }])

    expect(document.querySelector(".inbox-sheet")?.textContent).not.toContain("Deny")
    await nextFrame()
    sheet.view.unmount()
  })
})

describe("A plan's sheet", () => {
  const plan: readonly ChatDialogOption[] = [
    { id: "bypass", label: "Yes, and bypass permissions", text: null },
    { id: "manual", label: "Yes, and manually approve edits", text: null },
    { id: "keep", label: "No, keep planning", text: "prompt" },
  ]

  it("approves with the plain yes, and offers bypass only as a quiet link", async () => {
    const sheet = mount(plan, { kind: "plan" })
    const text = document.querySelector(".inbox-sheet")?.textContent ?? ""

    expect(text).toContain("Approve")
    expect(document.querySelector(".inbox-sheet .button.primary")?.textContent).toBe("Approve")
    // Bypass never leads, nor sits beside Approve as a button: a quiet link in its own words.
    const buttons = Array.from(document.querySelectorAll(".inbox-sheet .inbox-actions .button"))
    expect(buttons.map((button) => button.textContent)).toEqual(["Approve", "Deny"])
    expect(text).toContain("Yes, and bypass permissions")
    sheet.press("Approve")
    expect(sheet.sent).toEqual([
      { kind: "request", answer: { type: "choice", dialog: "d", option: "manual" } },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  it("keeps planning by the plain no, as older Claude Code words it", async () => {
    const sheet = mount(
      [
        { id: "1", label: "Yes, and auto-accept edits", text: null },
        { id: "2", label: "Yes, and manually approve edits", text: null },
        { id: "3", label: "No, keep planning", text: null },
      ],
      { kind: "plan" },
    )
    sheet.press("Deny")

    expect(sheet.sent).toEqual([
      { kind: "request", answer: { type: "choice", dialog: "d", option: "3" } },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  // As the runner reads Claude Code 2.1.287's (harnesses/claude's plan-file probe), where
  // the only way back is the field, which takes words and none of the yeses do.
  const field: readonly ChatDialogOption[] = [
    { id: "1", label: "Yes, auto-accept edits", text: null },
    { id: "2", label: "Yes, manually approve edits", text: null },
    { id: "3", label: "Tell Claude what to change", text: "field" },
  ]

  it("approves with the manual yes, without words", async () => {
    const sheet = mount(field, { kind: "plan" })
    sheet.press("Approve")

    expect(sheet.sent).toEqual([
      { kind: "request", answer: { type: "choice", dialog: "d", option: "2" } },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  const send = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(".inbox-sheet .inbox-send")!

  it("sends it back with the person's words, and not without them", async () => {
    const sheet = mount(field, { kind: "plan", agent: "claude" })
    sheet.press("Deny")
    const box = document.querySelector<HTMLTextAreaElement>(".inbox-sheet textarea")!

    expect(box.getAttribute("aria-label")).toBe("What Claude should change")
    expect(box.getAttribute("aria-required")).toBe("true")
    expect(send().disabled).toBe(true)
    sheet.type("   ")
    expect(send().disabled).toBe(true)
    sheet.type("Add a rollback step")
    expect(send().disabled).toBe(false)
    act(() => send().click())
    expect(sheet.sent).toEqual([
      {
        kind: "request",
        answer: { type: "choice", dialog: "d", option: "3", text: "Add a rollback step" },
      },
    ])
    sheet.confirm()
    expect(document.querySelector(".inbox-sent")?.textContent).toContain(
      "Sent back. Claude has what to change.",
    )
    await nextFrame()
    sheet.view.unmount()
  })

  it("sends the field's words on one line, as it takes them", async () => {
    const sheet = mount(field, { kind: "plan", agent: "claude" })
    sheet.press("Deny")
    sheet.type("Add a rollback step\n\nand a test\t")
    act(() => send().click())

    expect(sheet.sent).toEqual([
      {
        kind: "request",
        answer: {
          type: "choice",
          dialog: "d",
          option: "3",
          text: "Add a rollback step and a test",
        },
      },
    ])
    await nextFrame()
    sheet.view.unmount()
  })
})

describe("Antigravity's review", () => {
  const review: readonly ChatDialogOption[] = [
    { id: "approve", label: "Approve", text: null },
    { id: "reject", label: "Reject", text: null },
    { id: "feedback", label: "Tell it what to change", text: "field" },
  ]
  const send = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(".inbox-sheet .inbox-send")!

  it("rejects plainly without words, and sends words back with the field", async () => {
    const sheet = mount(review, { kind: "plan", agent: "agy" })
    sheet.press("Deny")
    act(() => send().click())
    sheet.press("Deny")
    sheet.type("Split the second step")
    act(() => send().click())

    expect(sheet.sent).toEqual([
      { kind: "request", answer: { type: "choice", dialog: "d", option: "reject" } },
    ])
    await nextFrame()
    sheet.view.unmount()
  })

  it.each(["/compact", "? help", "!ls", "see @notes.md"])(
    "says before Send that it can't take %s",
    async (words) => {
      const sheet = mount(review, { kind: "plan", agent: "agy" })
      sheet.press("Deny")
      sheet.type(words)

      expect(send().disabled).toBe(true)
      expect(document.querySelector(".inbox-sheet .inbox-aside")?.textContent).toBe(
        "Antigravity can't take words that start with /, ? or !, or that have an @.",
      )
      sheet.type("Split the second step")
      expect(send().disabled).toBe(false)
      expect(document.querySelector(".inbox-sheet .inbox-aside")).toBeNull()
      await nextFrame()
      sheet.view.unmount()
    },
  )
})

describe("An answer that does not take", () => {
  it("shows why, offers the answer again, and confirms nothing", async () => {
    const sheet = mount(codex, { failing: true })
    sheet.press("Allow")

    expect(document.querySelector(".inbox-failure")?.textContent).toBe(
      "The agent didn't take that.",
    )
    expect(document.querySelector(".inbox-sent")).toBeNull()
    expect(
      Array.from(document.querySelectorAll(".inbox-sheet button")).some(
        (button) => button.textContent === "Allow",
      ),
    ).toBe(true)
    await nextFrame()
    sheet.view.unmount()
  })
})

describe("An item that takes the place of one answered", () => {
  it("shows as waiting, not as the old answer", async () => {
    const sheet = mount(codex)
    sheet.press("Allow")
    expect(document.querySelector(".inbox-sent")).toBeNull()
    expect(
      document.querySelector<HTMLButtonElement>(".inbox-sheet .button.primary")?.disabled,
    ).toBe(true)
    sheet.confirm()
    expect(document.querySelector(".inbox-sent")).not.toBeNull()
    // After confirmation, the same id arrives again, waiting from later.
    act(() => {
      sheet.state.update((current) => ({ ...current, items: [{ ...item(codex), at: 5000 }] }))
    })

    expect(document.querySelector(".inbox-sent")).toBeNull()
    expect(document.querySelector(".inbox-sheet .button.primary")?.textContent).toBe("Allow")
    await nextFrame()
    sheet.view.unmount()
  })
})

describe("A held message's sheet", () => {
  const held = (heldFor: "loop" | null): InboxRow => ({
    ...item([]),
    kind: "held",
    held: {
      threadId: "th",
      from: { handle: "moth", title: "Tests" },
      to: { handle: "fox", title: "Checkout" },
      text: "Thanks again.",
      hop: 7,
      heldFor,
    },
  })

  it("says the two agents kept messaging while neither worked, for a loop", async () => {
    const sheet = mount([], { only: held("loop") })
    const aside = document.querySelector(".inbox-sheet .inbox-aside")!
    expect(aside.textContent).toContain("kept messaging while neither did any work")
    expect(aside.textContent).toContain("moth")
    expect(aside.textContent).toContain("fox")
    await nextFrame()
    sheet.view.unmount()
  })

  it("says only that Novadeck holds the thread, with no reason", async () => {
    const sheet = mount([], { only: held(null) })
    expect(document.querySelector(".inbox-sheet .inbox-aside")?.textContent).toBe(
      "Novadeck holds this thread for you.",
    )
    await nextFrame()
    sheet.view.unmount()
  })
})

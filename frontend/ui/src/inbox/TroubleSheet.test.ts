import { emptyInbox, type Inbox, type InboxAnswer, type InboxItem } from "@novadeck/core/inbox"
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

const limit = (autoResume: boolean | null, resetsAt: number, minutes = 300): InboxItem => ({
  id: "i",
  source: {
    projectId: "p",
    workspaceSessionId: "s",
    terminalId: "t",
    handle: "moth",
    agent: "claude",
    title: "Title",
    projectName: "Project",
  },
  at: 0,
  stopped: autoResume !== true,
  seen: false,
  kind: "trouble",
  trouble: { type: "limit", minutes, resetsAt, autoResume, evidence: [] },
})

// The sheet of one limit item, open, and the answers it gives, and the terminals it shows.
const mount = (item: InboxItem) => {
  const sent: InboxAnswer[] = []
  const revealed: string[] = []
  const inbox: Inbox = {
    state: createStore({ ...emptyInbox, items: [item] }),
    answer: (_id, answer) => sent.push(answer),
    see: () => {},
    readAll: () => {},
  }
  const view = render(
    createElement(
      InboxProvider,
      { inbox, reveal: (terminalId: string) => revealed.push(terminalId) },
      createElement("div", { id: "inbox-panel" }, createElement(InboxList)),
      createElement(InboxSheet, { active: true }),
    ),
  )
  act(() => view.container.querySelector<HTMLElement>(".inbox-row-select")!.click())
  const sheet = (): string => document.querySelector(".inbox-sheet")?.textContent ?? ""
  return { view, sent, revealed, sheet }
}

describe("A usage limit's sheet", () => {
  it("offers the auto-resume switch where Novadeck can resume the agent", async () => {
    const open = mount(limit(true, Date.now() + 3_600_000))

    expect(
      document.querySelector('.inbox-sheet [role="switch"], .inbox-sheet input'),
    ).not.toBeNull()
    await nextFrame()
    open.view.unmount()
  })

  it("offers no switch where Novadeck can't, and says it stays stopped", async () => {
    const open = mount(limit(null, Date.now() + 3_600_000))

    expect(document.querySelector(".inbox-switch-row")).toBeNull()
    expect(open.sheet()).toContain("It stays stopped until you continue it.")
    await nextFrame()
    open.view.unmount()
  })

  it("offers Continue once the limit has reset", async () => {
    const open = mount(limit(null, Date.now() - 60_000))
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".inbox-sheet button"),
    ).find((each) => each.textContent?.trim() === "Continue now")!
    act(() => button.click())

    expect(open.sent).toEqual([{ kind: "trouble", action: { type: "continue" } }])
    await nextFrame()
    open.view.unmount()
  })

  it("names a window of unknown length plainly", async () => {
    const open = mount(limit(null, Date.now() + 3_600_000, 0))

    expect(open.sheet()).toContain("used up its usage window")
    expect(open.sheet()).not.toContain("0-hour")
    await nextFrame()
    open.view.unmount()
  })
})

describe("A long hold's sheet", () => {
  it("says what holds the messages and shows the terminal, answering nothing", async () => {
    const { trouble: _, ...item } = limit(null, 0) as Extract<InboxItem, { kind: "trouble" }>
    const open = mount({ ...item, trouble: { type: "waits", waits: "draft", count: 2 } })

    expect(open.sheet()).toContain("2 messages for @moth wait behind text in its box")
    expect(open.sheet()).toContain("There's text in its box, so they wait.")
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".inbox-sheet .inbox-actions button"),
    ).find((each) => each.textContent?.trim() === "Show terminal")!
    act(() => button.click())

    expect(open.revealed).toEqual(["t"])
    expect(open.sent).toEqual([])
    await nextFrame()
    open.view.unmount()
  })
})

describe("A failed turn's sheet", () => {
  const failed = (stopped: boolean): InboxItem => ({
    ...(limit(null, 0) as Extract<InboxItem, { kind: "trouble" }>),
    stopped,
    trouble: { type: "failed", error: "API Error: 529" },
  })
  const press = (label: string): void =>
    act(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".inbox-sheet button"))
        .find((each) => each.textContent?.trim() === label)!
        .click(),
    )

  it("offers to fix the current end of an agent at rest", async () => {
    const open = mount(failed(true))

    expect(open.sheet()).toContain("API Error: 529")
    expect(open.sheet()).not.toContain("Mark read")
    press("Ask it to fix")
    expect(open.sent).toMatchObject([{ kind: "trouble", action: { type: "nudge" } }])
    await nextFrame()
    open.view.unmount()
  })

  it("offers only Mark read for an older end, or one whose agent works again", async () => {
    const open = mount(failed(false))

    expect(open.sheet()).not.toContain("Ask it to fix")
    press("Mark read")
    expect(open.sent).toEqual([{ kind: "trouble", action: { type: "read" } }])
    await nextFrame()
    open.view.unmount()
  })
})

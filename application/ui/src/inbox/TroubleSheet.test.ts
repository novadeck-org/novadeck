import { act, createElement } from "react"

import { emptyInbox, type Inbox, type InboxAnswer, type InboxItem } from "../model/inbox"
import { createStore } from "../model/store"
import { describe, expect, it } from "../test"
import { render } from "../test/render"
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

// The sheet of one limit item, open, and the answers it gives.
const mount = (item: InboxItem) => {
  const sent: InboxAnswer[] = []
  const inbox: Inbox = {
    state: createStore({ ...emptyInbox, items: [item] }),
    answer: (_id, answer) => sent.push(answer),
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
  const sheet = (): string => document.querySelector(".inbox-sheet")?.textContent ?? ""
  return { view, sent, sheet }
}

describe("A usage limit's sheet", () => {
  it("offers the auto-resume switch where Novadeck can resume the agent", () => {
    const open = mount(limit(true, Date.now() + 3_600_000))

    expect(
      document.querySelector('.inbox-sheet [role="switch"], .inbox-sheet input'),
    ).not.toBeNull()
    open.view.unmount()
  })

  it("offers no switch where Novadeck can't, and says it stays stopped", () => {
    const open = mount(limit(null, Date.now() + 3_600_000))

    expect(document.querySelector(".inbox-switch-row")).toBeNull()
    expect(open.sheet()).toContain("It stays stopped until you continue it.")
    open.view.unmount()
  })

  it("offers Continue once the limit has reset", () => {
    const open = mount(limit(null, Date.now() - 60_000))
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".inbox-sheet button"),
    ).find((each) => each.textContent?.trim() === "Continue now")!
    act(() => button.click())

    expect(open.sent).toEqual([{ kind: "trouble", action: { type: "continue" } }])
    open.view.unmount()
  })

  it("names a window of unknown length plainly", () => {
    const open = mount(limit(null, Date.now() + 3_600_000, 0))

    expect(open.sheet()).toContain("used up its usage window")
    expect(open.sheet()).not.toContain("0-hour")
    open.view.unmount()
  })
})

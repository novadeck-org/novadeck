import { act, createElement } from "react"

import { emptyInbox, type Inbox, type InboxItem, type InboxState } from "../model/inbox"
import { createStore } from "../model/store"
import { context, describe, expect, it } from "../test"
import { render } from "../test/render"
import { HeldPill, InboxList } from "./InboxList"
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

const source: InboxItem["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "moth",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}

const permission = (id: string, at: number): InboxItem => ({
  id,
  source,
  at,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id,
    kind: "permission",
    tool: "Bash",
    subject: id,
    choices: [],
    subagent: false,
    answered: false,
    dialog: {
      type: "choices",
      id,
      title: null,
      detail: id,
      options: [
        { id: "yes", label: "Yes", text: null },
        { id: "no", label: "No", text: null },
      ],
    },
  },
})

// An Inbox whose items the test changes, with the list, the held pill and the sheets as the
// sidebar and the workspace wire them.
const mount = (items: readonly InboxItem[]) => {
  const state = createStore<InboxState>({ ...emptyInbox, items })
  const answered: string[] = []
  const inbox: Inbox = {
    state,
    answer: (id) => answered.push(id),
    see: () => {},
    readAll: () => {},
  }
  const view = render(
    createElement(
      InboxProvider,
      { inbox, reveal: () => {} },
      createElement(
        "div",
        { id: "inbox-panel" },
        createElement(HeldPill),
        createElement(InboxList),
      ),
      createElement(InboxSheet, { active: true }),
    ),
  )
  const subjects = (): string[] =>
    Array.from(view.container.querySelectorAll(".inbox-row-subject")).map(
      (element) => element.textContent ?? "",
    )
  const pill = (): HTMLElement | null => view.container.querySelector(".inbox-held")
  const open = (id: string): void =>
    act(() =>
      view.container
        .querySelector<HTMLElement>(`[data-inbox-item="${id}"] .inbox-row-select`)!
        .click(),
    )
  const arrive = (item: InboxItem): void =>
    act(() => {
      state.update((current) => ({ ...current, items: [...current.items, item] }))
    })
  const press = (key: string): void =>
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
    })
  return { view, subjects, pill, open, arrive, press, answered }
}

describe("The Inbox's list", () => {
  context("when nothing waits", () => {
    it("says so", () => {
      const inbox = mount([])

      expect(inbox.view.container.textContent).toContain("Nothing needs you")
      inbox.view.unmount()
    })
  })

  context("when an item arrives with no sheet open", () => {
    it("joins the list at once", () => {
      const inbox = mount([permission("a", 1)])
      inbox.arrive(permission("b", 2))

      expect(inbox.subjects()).toEqual(
        ["Run `a`?", "Run `b`?"].map((each) => each.replaceAll("`", "")),
      )
      expect(inbox.pill()).toBeNull()
      inbox.view.unmount()
    })
  })

  context("when an item arrives while a sheet is open", () => {
    it("is held: the list stays as it was, and the header counts it", () => {
      const inbox = mount([permission("a", 1), permission("b", 2)])
      inbox.open("a")
      inbox.arrive(permission("c", 3))

      expect(inbox.subjects()).toHaveLength(2)
      expect(inbox.pill()?.textContent).toBe("1 new · show")
      inbox.view.unmount()
    })

    it("joins when the pill is pressed, while the sheet stays open", () => {
      const inbox = mount([permission("a", 1)])
      inbox.open("a")
      inbox.arrive(permission("c", 3))
      act(() => inbox.pill()!.click())

      expect(inbox.subjects()).toHaveLength(2)
      expect(inbox.pill()).toBeNull()
      expect(document.querySelector(".inbox-sheet")).not.toBeNull()
      inbox.view.unmount()
    })

    it("joins, marked as arrived, when the sheet closes on Esc", () => {
      const inbox = mount([permission("a", 1)])
      inbox.open("a")
      inbox.arrive(permission("c", 3))
      inbox.press("Escape")

      expect(inbox.subjects()).toHaveLength(2)
      expect(
        inbox.view.container.querySelector('[data-inbox-item="c"]')?.getAttribute("data-arrived"),
      ).toBe("true")
      inbox.view.unmount()
    })
  })

  context("when moving with j and k", () => {
    it("opens the item below and above, within the list", () => {
      const inbox = mount([permission("a", 1), permission("b", 2), permission("c", 3)])
      inbox.open("a")
      const current = (): string | null =>
        inbox.view.container
          .querySelector('[aria-current="true"]')
          ?.closest("[data-inbox-item]")
          ?.getAttribute("data-inbox-item") ?? null

      inbox.press("j")
      expect(current()).toBe("b")
      inbox.press("j")
      inbox.press("j")
      expect(current()).toBe("c")
      inbox.press("k")
      expect(current()).toBe("b")
      inbox.view.unmount()
    })
  })
})

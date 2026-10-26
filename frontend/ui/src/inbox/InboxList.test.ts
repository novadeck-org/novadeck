import { emptyInbox, type Inbox, type InboxItem, type InboxState } from "@novadeck/core/inbox"
import { createStore } from "@novadeck/core/store"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { context, describe, expect, it } from "../test"
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

const told = (id: string, at: number): InboxItem => ({
  id,
  source,
  at,
  stopped: false,
  seen: false,
  kind: "update",
  update: { type: "told", subject: id, body: "" },
})

// An Inbox whose items the test changes, with the list, the held pill and the sheets as the
// sidebar and the workspace wire them.
const mount = (items: readonly InboxItem[], working = false) => {
  const state = createStore<InboxState>({ ...emptyInbox, items })
  const answered: string[] = []
  const inbox: Inbox = {
    state,
    answer: (id) => answered.push(id),
    see: (id) =>
      state.update((current) => ({
        ...current,
        items: current.items.map((item) => (item.id === id ? { ...item, seen: true } : item)),
      })),
    readAll: () => {},
  }
  const view = render(
    createElement(
      InboxProvider,
      { inbox, reveal: () => {}, working },
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
  const row = (id: string): HTMLElement =>
    view.container.querySelector<HTMLElement>(`[data-inbox-item="${id}"]`)!
  return { view, subjects, pill, open, arrive, press, answered, row }
}

describe("The Inbox's list", () => {
  context("when nothing waits", () => {
    it("says so", async () => {
      const inbox = mount([])

      expect(inbox.view.container.textContent).toContain("Nothing needs you")
      await nextFrame()
      inbox.view.unmount()
    })

    it("says agents are working only while one is", async () => {
      const idle = mount([])
      expect(idle.view.container.textContent).not.toContain("working")
      expect(idle.view.container.textContent).toContain("When an agent needs you")
      idle.view.unmount()

      const busy = mount([], true)
      expect(busy.view.container.textContent).toContain("Your agents are working.")
      await nextFrame()
      busy.view.unmount()
    })
  })

  context("when an item arrives with no sheet open", () => {
    it("joins the list at once", async () => {
      const inbox = mount([permission("a", 1)])
      inbox.arrive(permission("b", 2))

      expect(inbox.subjects()).toEqual(
        ["Run `a`?", "Run `b`?"].map((each) => each.replaceAll("`", "")),
      )
      expect(inbox.pill()).toBeNull()
      await nextFrame()
      inbox.view.unmount()
    })
  })

  context("when an item arrives while a sheet is open", () => {
    it("is held: the list stays as it was, and the header counts it", async () => {
      const inbox = mount([permission("a", 1), permission("b", 2)])
      inbox.open("a")
      inbox.arrive(permission("c", 3))

      expect(inbox.subjects()).toHaveLength(2)
      expect(inbox.pill()?.textContent).toBe("1 new · show")
      await nextFrame()
      inbox.view.unmount()
    })

    it("joins when the pill is pressed, while the sheet stays open", async () => {
      const inbox = mount([permission("a", 1)])
      inbox.open("a")
      inbox.arrive(permission("c", 3))
      act(() => inbox.pill()!.click())

      expect(inbox.subjects()).toHaveLength(2)
      expect(inbox.pill()).toBeNull()
      expect(document.querySelector(".inbox-sheet")).not.toBeNull()
      await nextFrame()
      inbox.view.unmount()
    })

    it("joins, marked as arrived, when the sheet closes on Esc", async () => {
      const inbox = mount([permission("a", 1)])
      inbox.open("a")
      inbox.arrive(permission("c", 3))
      inbox.press("Escape")

      expect(inbox.subjects()).toHaveLength(2)
      expect(
        inbox.view.container.querySelector('[data-inbox-item="c"]')?.getAttribute("data-arrived"),
      ).toBe("true")
      await nextFrame()
      inbox.view.unmount()
    })
  })

  context("when moving with j and k", () => {
    it("opens the item below and above, within the list", async () => {
      const inbox = mount([permission("a", 1), permission("b", 2), permission("c", 3)])
      inbox.open("a")
      await nextFrame()
      const current = (): string | null =>
        inbox.view.container
          .querySelector('[aria-current="true"]')
          ?.closest("[data-inbox-item]")
          ?.getAttribute("data-inbox-item") ?? null

      // A frame between keys, as a person's presses have: each sheet opened finds itself.
      const press = async (key: string) => {
        inbox.press(key)
        await nextFrame()
      }
      await press("j")
      expect(current()).toBe("b")
      // Two quick presses, with no frame between them, still both move.
      inbox.press("j")
      await press("j")
      expect(current()).toBe("c")
      await press("k")
      expect(current()).toBe("b")
      await nextFrame()
      inbox.view.unmount()
    })
  })

  context("when a row that asks has been opened", () => {
    it("keeps it asking, marked as opened", async () => {
      const inbox = mount([permission("a", 1), permission("b", 2)])
      expect(inbox.row("a").dataset).toMatchObject({ needs: "true", seen: "false" })

      inbox.open("a")
      await nextFrame()
      inbox.press("Escape")
      await nextFrame()

      expect(inbox.row("a").dataset).toMatchObject({ needs: "true", seen: "true" })
      inbox.view.unmount()
    })
  })

  context("when updates follow what asks", () => {
    it("marks the updates as asking nothing, with a line above the first", async () => {
      const inbox = mount([told("u1", 1), permission("a", 2), told("u2", 3)])

      expect(inbox.subjects()).toEqual(["Run a?", "u1", "u2"])
      expect(inbox.row("a").dataset).toMatchObject({ needs: "true", updatesStart: "false" })
      expect(inbox.row("u1").dataset).toMatchObject({ needs: "false", updatesStart: "true" })
      expect(inbox.row("u2").dataset).toMatchObject({ needs: "false", updatesStart: "false" })
      await nextFrame()
      inbox.view.unmount()
    })

    it("draws no line when only updates wait", async () => {
      const inbox = mount([told("u1", 1), told("u2", 2)])

      expect(inbox.row("u1").dataset.updatesStart).toBe("false")
      await nextFrame()
      inbox.view.unmount()
    })
  })
})

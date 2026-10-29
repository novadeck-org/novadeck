import {
  emptyInbox,
  withSnoozes,
  type Inbox,
  type InboxRow,
  type InboxState,
} from "@novadeck/core/inbox"
import { createStore } from "@novadeck/core/store"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { context, describe, expect, it } from "../test"
import { HeldPill, InboxClear, InboxCount, InboxList } from "./InboxList"
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

const source: InboxRow["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "moth",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}

const permission = (id: string, at: number): InboxRow => ({
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

const told = (id: string, at: number): InboxRow => ({
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
const agentAsk = (id: string, at: number, settled?: InboxRow["settled"]): InboxRow => ({
  id,
  source,
  at,
  stopped: !settled,
  seen: false,
  kind: "ask",
  ask: { subject: id, body: "", details: null, hardToUndo: null, shape: { type: "text" } },
  ...(settled ? { settled } : {}),
})

const mount = (
  items: readonly InboxRow[],
  working = false,
  dismissing = false,
  arranging = false,
  snoozing = false,
) => {
  const state = createStore<InboxState>({ ...emptyInbox, items })
  const answered: string[] = []
  const order = createStore<readonly string[]>([])
  const inbox: Inbox = {
    state,
    answer: (id) => answered.push(id),
    see: (id) =>
      state.update((current) => ({
        ...current,
        items: current.items.map((item) => (item.id === id ? { ...item, seen: true } : item)),
      })),
    readAll: () => {},
    ...(dismissing
      ? {
          dismiss: (id: string) =>
            state.update((current) => ({
              ...current,
              items: current.items.map((item) =>
                item.id === id ? { ...item, settled: { how: "dismissed", at: 99 } } : item,
              ),
            })),
          clear: (ids: readonly string[]) =>
            state.update((current) => ({
              ...current,
              items: current.items.filter((item) => !ids.includes(item.id)),
            })),
        }
      : {}),
    ...(arranging ? { order, arrange: (ids: readonly string[]) => order.update(() => ids) } : {}),
  }
  const view = render(
    createElement(
      InboxProvider,
      {
        inbox: snoozing ? withSnoozes(inbox, [], () => {}) : inbox,
        reveal: () => {},
        working,
        active: true,
      },
      createElement(
        "div",
        { id: "inbox-panel" },
        snoozing ? createElement("span", { className: "count" }, createElement(InboxCount)) : null,
        createElement(HeldPill),
        createElement(InboxClear),
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
        .querySelector<HTMLElement>(`[data-inbox-row="${id}"] .inbox-row-select`)!
        .click(),
    )
  const arrive = (item: InboxRow): void =>
    act(() => {
      state.update((current) => ({ ...current, items: [...current.items, item] }))
    })
  const press = (key: string): void =>
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
    })
  const row = (id: string): HTMLElement =>
    view.container.querySelector<HTMLElement>(`[data-inbox-row="${id}"]`)!
  // Alt and an arrow on a row's button, which moves a row that drags.
  const step = (id: string, key: "ArrowUp" | "ArrowDown"): void =>
    act(() => {
      row(id)
        .querySelector(".inbox-row-select")!
        .dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true }))
    })
  return { view, subjects, pill, open, arrive, press, answered, row, order, step }
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
        inbox.view.container.querySelector('[data-inbox-row="c"]')?.getAttribute("data-arrived"),
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
          ?.closest("[data-inbox-row]")
          ?.getAttribute("data-inbox-row") ?? null

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

  context("when moving with the left and right arrows", () => {
    it("opens the item after and before from the sheet, and keeps the keyboard there", async () => {
      const inbox = mount([permission("a", 1), permission("b", 2), permission("c", 3)])
      inbox.open("a")
      await nextFrame()
      const current = (): string | null =>
        inbox.view.container
          .querySelector('[aria-current="true"]')
          ?.closest("[data-inbox-row]")
          ?.getAttribute("data-inbox-row") ?? null
      const press = async (key: string): Promise<void> => {
        const from = document.activeElement ?? document.body
        act(() => {
          from.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
        })
        // The next sheet takes the keyboard once it has mounted.
        await nextFrame()
        await nextFrame()
      }

      await press("ArrowRight")
      expect(current()).toBe("b")
      expect(document.activeElement?.closest(".inbox-sheet")).not.toBeNull()
      await press("ArrowRight")
      expect(current()).toBe("c")
      await press("ArrowLeft")
      expect(current()).toBe("b")
      await nextFrame()
      inbox.view.unmount()
    })

    it("leaves them to a field in the sheet, and to the list's rows", async () => {
      const inbox = mount([agentAsk("a", 1), agentAsk("b", 2)])
      inbox.open("a")
      await nextFrame()
      const field = document.querySelector<HTMLElement>(".inbox-sheet textarea, .inbox-sheet input")
      expect(field).not.toBeNull()
      act(() => {
        field!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
      })
      act(() => {
        inbox
          .row("a")
          .querySelector(".inbox-row-select")!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
      })
      await nextFrame()
      expect(inbox.row("a").dataset.selected).toBe("true")
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

  context("when an ask can be dismissed", () => {
    const dismissButton = (inbox: ReturnType<typeof mount>, id: string): HTMLElement | null =>
      inbox.row(id).querySelector<HTMLElement>(".inbox-row-dismiss")

    it("offers it on a Novadeck ask only, and only where the backend can", async () => {
      const inbox = mount([agentAsk("a", 1), permission("p", 2), told("u", 3)], false, true)

      expect(dismissButton(inbox, "a")?.getAttribute("aria-label")).toBe("Dismiss: a")
      expect(dismissButton(inbox, "p")).toBeNull()
      expect(dismissButton(inbox, "u")).toBeNull()
      inbox.view.unmount()

      const without = mount([agentAsk("a", 1)])
      expect(without.row("a").querySelector(".inbox-row-dismiss")).toBeNull()
      await nextFrame()
      without.view.unmount()
    })

    it("settles the row in place on the button, and the count and Clear follow", async () => {
      const inbox = mount([agentAsk("a", 1), agentAsk("b", 2), told("u", 3)], false, true)
      expect(inbox.view.container.querySelector('[aria-label="Clear settled"]')).toBeNull()
      act(() => dismissButton(inbox, "a")!.click())

      expect(inbox.subjects()).toEqual(["a", "b", "u"])
      expect(inbox.row("a").dataset).toMatchObject({ settled: "dismissed", needs: "false" })
      expect(inbox.row("a").querySelector(".inbox-row-extra")?.textContent).toBe("· Dismissed")
      expect(dismissButton(inbox, "a")).toBeNull()
      expect(inbox.view.container.querySelector('[aria-label="Clear settled"]')).not.toBeNull()
      await nextFrame()
      inbox.view.unmount()
    })

    it("settles on Delete, and the keyboard goes on to the next row", async () => {
      const inbox = mount([agentAsk("a", 1), agentAsk("b", 2)], false, true)
      const select = (id: string): HTMLElement =>
        inbox.row(id).querySelector<HTMLElement>(".inbox-row-select")!
      select("a").focus()
      act(() => {
        select("a").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
        )
      })

      expect(inbox.row("a").dataset.settled).toBe("dismissed")
      expect(document.activeElement).toBe(select("b"))
      await nextFrame()
      inbox.view.unmount()
    })

    it("opens no sheet once settled, and j and k skip it", async () => {
      const inbox = mount(
        [agentAsk("a", 1), agentAsk("b", 2, { how: "withdrawn", at: 5 }), agentAsk("c", 3)],
        false,
        true,
      )
      inbox.open("b")
      expect(document.querySelector(".inbox-sheet")).toBeNull()
      inbox.open("a")
      inbox.press("j")

      expect(inbox.row("c").dataset.selected).toBe("true")
      await nextFrame()
      inbox.view.unmount()
    })

    it("keeps the sheet of an ask that settles open, saying so in place of its answers", async () => {
      const inbox = mount([agentAsk("a", 1), agentAsk("b", 2)], false, true)
      inbox.open("a")
      expect(document.querySelector(".inbox-sheet [role=menu]")).not.toBeNull()
      act(() => dismissButton(inbox, "a")!.click())
      await nextFrame()

      expect(document.querySelector(".console-tag")?.textContent).toBe("Dismissed")
      expect(document.querySelector(".console-settled")?.textContent).toBe(
        "You dismissed this ask; @moth was told.",
      )
      expect(document.querySelector(".inbox-sheet [role=menu]")).toBeNull()
      inbox.press("j")
      expect(inbox.row("b").dataset.selected).toBe("true")
      inbox.view.unmount()
    })

    it("clears every settled ask", async () => {
      const inbox = mount(
        [agentAsk("a", 1), agentAsk("b", 2, { how: "replied", at: 5 })],
        false,
        true,
      )
      expect(inbox.row("b").dataset.settledStart).toBe("true")
      act(() =>
        inbox.view.container.querySelector<HTMLElement>('[aria-label="Clear settled"]')!.click(),
      )

      expect(inbox.subjects()).toEqual(["a"])
      await nextFrame()
      inbox.view.unmount()
    })
  })

  context("where the backend keeps an order", () => {
    it("moves a row that asks a place with Alt and an arrow, and keeps the new order", async () => {
      const inbox = mount(
        [permission("a", 1), permission("b", 2), told("u", 0)],
        false,
        false,
        true,
      )
      inbox.step("a", "ArrowDown")

      expect(inbox.order.getSnapshot()).toEqual(["b", "a"])
      expect(inbox.subjects()).toEqual(["Run b?", "Run a?", "u"])
      // The last row that asks goes no further: the updates below it never move.
      inbox.step("a", "ArrowDown")
      expect(inbox.order.getSnapshot()).toEqual(["b", "a"])
      expect(inbox.row("u").querySelector(".inbox-row-select")?.ariaKeyShortcuts).toBeNull()
      await nextFrame()
      inbox.view.unmount()
    })

    it("puts what comes after ahead of a row put off", async () => {
      const inbox = mount([permission("a", 1), permission("b", 2)], false, false, true)
      inbox.step("a", "ArrowDown")
      inbox.arrive(permission("c", 3))

      expect(inbox.subjects()).toEqual(["Run c?", "Run b?", "Run a?"])
      await nextFrame()
      inbox.view.unmount()
    })
  })

  context("where the backend keeps no order", () => {
    it("moves no row", async () => {
      const inbox = mount([permission("a", 1), permission("b", 2)])
      inbox.step("a", "ArrowDown")

      expect(inbox.subjects()).toEqual(["Run a?", "Run b?"])
      expect(inbox.row("a").querySelector(".inbox-row-select")?.ariaKeyShortcuts).toBeNull()
      await nextFrame()
      inbox.view.unmount()
    })
  })

  context("where the backend keeps snoozes", () => {
    const current = (inbox: ReturnType<typeof mount>): string | null =>
      inbox.view.container
        .querySelector('[aria-current="true"]')
        ?.closest("[data-inbox-row]")
        ?.getAttribute("data-inbox-row") ?? null
    const count = (inbox: ReturnType<typeof mount>): string =>
      inbox.view.container.querySelector(".count")?.textContent ?? ""
    const keyOn = (element: Element, key: string): void =>
      act(() => {
        element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
      })

    it("snoozes a row with S: it keeps its place, says so, and stops counting", async () => {
      const inbox = mount([permission("a", 1), permission("b", 2)], false, false, true, true)
      expect(count(inbox)).toBe("2 waiting")
      keyOn(inbox.row("a").querySelector(".inbox-row-select")!, "s")

      expect(inbox.row("a").dataset.snoozed).toBe("true")
      expect(inbox.row("a").textContent).toContain("Snoozed")
      expect(inbox.subjects()).toEqual(["Run a?", "Run b?"])
      expect(count(inbox)).toBe("1 waiting")
      // It still drags with the rest.
      expect(inbox.row("a").querySelector(".inbox-row-select")?.ariaKeyShortcuts).toContain(
        "Alt+ArrowUp",
      )
      keyOn(inbox.row("a").querySelector(".inbox-row-select")!, "S")
      expect(inbox.row("a").dataset.snoozed).toBeUndefined()
      expect(count(inbox)).toBe("2 waiting")
      await nextFrame()
      inbox.view.unmount()
    })

    it("is stepped past by the arrows from an open sheet", async () => {
      const inbox = mount(
        [permission("a", 1), permission("b", 2), permission("c", 3)],
        false,
        false,
        false,
        true,
      )
      keyOn(inbox.row("b").querySelector(".inbox-row-select")!, "s")
      inbox.open("a")
      await nextFrame()
      keyOn(document.querySelector(".inbox-sheet-title") ?? document.body, "ArrowRight")
      await nextFrame()
      expect(current(inbox)).toBe("c")
      await nextFrame()
      inbox.view.unmount()
    })

    it("snoozed from its sheet, opens what asks next, past any other snoozed", async () => {
      const inbox = mount(
        [permission("a", 1), permission("b", 2), permission("c", 3)],
        false,
        false,
        false,
        true,
      )
      keyOn(inbox.row("b").querySelector(".inbox-row-select")!, "s")
      inbox.open("a")
      await nextFrame()
      act(() => document.querySelector<HTMLElement>('.inbox-sheet [aria-label="Snooze"]')!.click())
      await nextFrame()

      expect(inbox.row("a").dataset.snoozed).toBe("true")
      expect(current(inbox)).toBe("c")
      expect(count(inbox)).toBe("1 waiting")
      await nextFrame()
      inbox.view.unmount()
    })
  })
})

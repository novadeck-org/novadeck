import { createStore } from "@novadeck/core/store"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { createDebugPanel } from "./DebugPanel"
import { context, describe, expect, it } from "./test"
import type { DemoActionGroup, DemoStates } from "./types"
import type { DemoLaunch, DemoShell } from "./with-debug"

// The shell's groups stand aside, so the panel shows these and the real Portable group.
vi.mock("./shell-groups", () => ({ shellGroups: () => [] }))

const groups: readonly DemoActionGroup[] = [
  {
    section: "Terminals",
    title: "Selected terminal",
    actions: [
      {
        label: "Exit code 3",
        hint: "Ending bar with Restart",
        run: ({ note }) => note("Select a terminal first."),
      },
      { label: "Work", hint: "Spinner and the status line", run: () => {} },
      { label: "Again", hint: "Says the same each time", run: ({ note }) => note("Same again.") },
    ],
  },
  {
    section: "Agents",
    title: "Agent",
    targets: true,
    actions: [{ label: "Ask", hint: "A permission prompt", run: () => {} }],
  },
  {
    section: "App",
    title: "Updates",
    actions: [{ label: "Offer a release", hint: "Banner in the sidebar", run: () => {} }],
  },
]

const mounted: Rendered[] = []
beforeEach(() => window.sessionStorage.clear())
afterEach(() => mounted.splice(0).forEach((view) => view.unmount()))

const click = (element: HTMLElement): void => act(() => element.click())
const press = (element: HTMLElement, key: string): void =>
  act(() => void element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })))
const mount = () => {
  const Panel = createDebugPanel({
    launch: {
      variant: "full",
      switchVariant: () => {},
      setPortable: () => {},
    } as unknown as DemoLaunch,
    shell: {
      connection: createStore("connected"),
      crashes: createStore(0),
      terminals: () => 0,
    } as unknown as DemoShell,
    states: { groups, Notices: () => null } as unknown as DemoStates,
    dispatch: () => undefined,
    workspace: () => undefined,
    addInBackground: () => ({ projectId: "p", workspaceSessionId: "s", terminalId: "01" }),
  })
  const view = render(
    createElement(Panel, {
      addTerminal: () => ({ projectId: "p", workspaceSessionId: "s", terminalId: "01" }),
      startFresh: () => {},
      selected: () => undefined,
    }),
  )
  mounted.push(view)
  const { container } = view
  const handle = (): HTMLButtonElement => container.querySelector(".debug-handle")!
  const search = (): HTMLInputElement => container.querySelector('input[type="search"]')!
  const toggles = (): HTMLButtonElement[] => [
    ...container.querySelectorAll<HTMLButtonElement>(".debug-group"),
  ]
  const toggle = (title: string): HTMLButtonElement =>
    toggles().find((each) => each.textContent?.includes(title))!
  const actions = (): string[] =>
    [...container.querySelectorAll(".debug-action")].map(
      (each) => each.firstElementChild!.textContent!,
    )
  const type = (text: string): void =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search(),
        text,
      )
      search().dispatchEvent(new Event("input", { bubbles: true }))
    })
  const pressed = (): string | undefined =>
    [...container.querySelectorAll('[aria-label="Target"] [aria-pressed="true"]')][0]
      ?.textContent ?? undefined
  return { view, handle, search, toggle, toggles, actions, click, type, press, pressed }
}

describe("demo debug panel", () => {
  context("searching", () => {
    it("matches a word of the group, the label or the hint", () => {
      const panel = mount()
      panel.click(panel.handle())
      panel.type("agent")
      expect(panel.actions()).toEqual(["Ask"])
      panel.type("exit")
      expect(panel.actions()).toEqual(["Exit code 3"])
      panel.type("restart")
      expect(panel.actions()).toEqual(["Exit code 3"])
    })

    it("needs every word to match, in any order", () => {
      const panel = mount()
      panel.click(panel.handle())
      panel.type("spinner terminal")
      expect(panel.actions()).toEqual(["Work"])
      panel.type("spinner agent")
      expect(panel.actions()).toEqual([])
    })

    it("shows the matches of folded groups too", () => {
      const panel = mount()
      panel.click(panel.handle())
      expect(panel.actions()).toEqual([])
      panel.type("banner")
      expect(panel.actions()).toEqual(["Offer a release"])
    })

    it("says so when nothing matches", () => {
      const panel = mount()
      panel.click(panel.handle())
      panel.type("zzz")
      expect(panel.view.container.textContent).toContain("No state matches “zzz”.")
      expect(panel.actions()).toEqual([])
      panel.type("")
      expect(panel.view.container.textContent).not.toContain("No state matches")
    })
  })

  context("folding", () => {
    it("opens and folds a group", () => {
      const panel = mount()
      panel.click(panel.handle())
      expect(panel.actions()).toEqual([])
      panel.click(panel.toggle("Selected terminal"))
      expect(panel.actions()).toEqual(["Exit code 3", "Work", "Again"])
      expect(panel.toggle("Selected terminal").getAttribute("aria-expanded")).toBe("true")
      panel.click(panel.toggle("Selected terminal"))
      expect(panel.actions()).toEqual([])
    })

    it("keeps the opened groups across remounts, in this tab", () => {
      const first = mount()
      first.click(first.handle())
      first.click(first.toggle("Updates"))
      first.view.unmount()
      mounted.splice(0)
      const second = mount()
      second.click(second.handle())
      expect(second.actions()).toEqual(["Offer a release"])
      second.click(second.toggle("Updates"))
      second.view.unmount()
      mounted.splice(0)
      const third = mount()
      third.click(third.handle())
      expect(third.actions()).toEqual([])
    })
  })

  context("the target switch", () => {
    it("starts on the selected terminal and keeps a choice across remounts", () => {
      const first = mount()
      first.click(first.handle())
      first.click(first.toggle("Agent"))
      expect(first.pressed()).toBe("Selected")
      first.click(
        [
          ...first.view.container.querySelectorAll<HTMLButtonElement>(
            '[aria-label="Target"] button',
          ),
        ].find((each) => each.textContent === "Other project")!,
      )
      expect(first.pressed()).toBe("Other project")
      first.view.unmount()
      mounted.splice(0)
      const second = mount()
      second.click(second.handle())
      expect(second.pressed()).toBe("Other project")
    })
  })

  context("the target switch", () => {
    it("shows with a search hit in its group, and not with one elsewhere", () => {
      const panel = mount()
      panel.click(panel.handle())
      panel.type("permission")
      expect(panel.actions()).toEqual(["Ask"])
      expect(panel.pressed()).toBe("Selected")
      panel.type("banner")
      expect(panel.actions()).toEqual(["Offer a release"])
      expect(panel.pressed()).toBeUndefined()
    })
  })

  context("actions that boot the demo again", () => {
    it("carry the mark, and the others do not", () => {
      const panel = mount()
      panel.click(panel.handle())
      panel.click(panel.toggle("Portable"))
      const marked = (): boolean[] =>
        [...panel.view.container.querySelectorAll(".debug-action")].map(
          (each) => each.querySelector(".debug-reboots") !== null,
        )
      expect(marked().length).toBeGreaterThan(0)
      expect(marked().every(Boolean)).toBe(true)
      expect(panel.view.container.querySelector(".debug-reboots")?.textContent).toBe(
        "(boots the demo again)",
      )
      panel.click(panel.toggle("Selected terminal"))
      const own = [...panel.view.container.querySelectorAll(".debug-action")].find((each) =>
        each.textContent?.startsWith("Work"),
      )
      expect(own).toBeDefined()
      expect(own?.querySelector(".debug-reboots")).toBeNull()
    })
  })

  context("the keyboard", () => {
    it("clears the search on Escape first, then closes and returns to the handle", () => {
      const panel = mount()
      panel.click(panel.handle())
      expect(document.activeElement).toBe(panel.search())
      panel.type("exit")
      panel.press(panel.search(), "Escape")
      expect(panel.search().value).toBe("")
      expect(panel.handle().getAttribute("aria-expanded")).toBe("true")
      panel.press(panel.search(), "Escape")
      expect(panel.handle().getAttribute("aria-expanded")).toBe("false")
      expect(document.activeElement).toBe(panel.handle())
    })

    it("goes from the search to the first group toggle with every group folded", () => {
      const panel = mount()
      panel.click(panel.handle())
      panel.press(panel.search(), "ArrowDown")
      expect(document.activeElement).toBe(panel.toggles()[0])
    })

    it("goes to the first group toggle, not an action, with groups open", () => {
      const panel = mount()
      panel.click(panel.handle())
      panel.click(panel.toggle("Selected terminal"))
      panel.press(panel.search(), "ArrowDown")
      expect(document.activeElement).toBe(panel.toggles()[0])
    })

    it("goes to the first result while searching, when the group toggles are disabled", () => {
      const panel = mount()
      panel.click(panel.handle())
      panel.type("spinner")
      panel.press(panel.search(), "ArrowDown")
      expect(document.activeElement?.textContent).toContain("Work")
    })
  })

  context("its note", () => {
    it("keeps one status region, mounted before it has anything to say", () => {
      const panel = mount()
      panel.click(panel.handle())
      const region = panel.view.container.querySelector('[role="status"]')
      expect(region?.textContent).toBe("")
      panel.click(panel.toggle("Selected terminal"))
      panel.click(panel.view.container.querySelector<HTMLElement>(".debug-action")!)
      expect(panel.view.container.querySelector('[role="status"]')).toBe(region)
      expect(region?.textContent).toBe("Select a terminal first.")
    })

    it("renders a repeated note anew, so it is announced again", () => {
      const panel = mount()
      panel.click(panel.handle())
      panel.click(panel.toggle("Selected terminal"))
      const again = [...panel.view.container.querySelectorAll<HTMLElement>(".debug-action")].find(
        (each) => each.textContent?.startsWith("Again"),
      )!
      const region = (): Element => panel.view.container.querySelector('[role="status"]')!
      panel.click(again)
      const first = region().firstElementChild
      expect(region().textContent).toBe("Same again.")
      panel.click(again)
      expect(region().textContent).toBe("Same again.")
      expect(region().firstElementChild).not.toBe(first)
    })
  })
})

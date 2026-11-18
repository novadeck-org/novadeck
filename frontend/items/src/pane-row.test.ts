import { itemFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { Pause, RotateCw, ArrowLeft } from "lucide-react"
import { createElement } from "react"
import { afterEach } from "vitest"

import { PaneChrome, PaneTools, tabTip, usePaneNote, type PaneTool } from "./pane-row"
import { context, describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const now = 10 * 60_000
const shownAgo = (minutes: number): number => now - minutes * 60_000

describe("what a tab's tooltip says of its item", () => {
  it("is where it points, then its facts, then who showed it and when", () => {
    const file = itemFixture("f", "01", {
      kind: "file",
      name: "projects.json",
      path: "/p/src/projects.json",
      lines: { from: 2, to: 10 },
      from: { terminalId: "01", handle: "moth" },
      shownAt: shownAgo(2),
    })
    expect(tabTip(file, [], now)).toEqual([
      "/p/src/projects.json",
      "lines 2–10 · @moth showed it 2m ago",
    ])
  })

  it("says a plan's version and that its agent wrote it, and what its viewer adds", () => {
    const plan = itemFixture("p", "01", {
      kind: "plan",
      name: "A home for Studio",
      path: "plans/studio.md",
      version: 2,
      from: { terminalId: "01", handle: "moth" },
      shownAt: shownAgo(4),
    })
    expect(tabTip(plan, ["Fox resolved 1 note"], now)).toEqual([
      "plans/studio.md",
      "v2 · Fox resolved 1 note · @moth wrote it 4m ago",
    ])
  })

  it("says what a person attached as theirs, and nothing of a change's time", () => {
    const own = itemFixture("i", "01", {
      kind: "image",
      name: "hero.png",
      path: "/p/hero.png",
      detail: "120 KB PNG",
      by: "person",
      shownAt: now,
    })
    expect(tabTip(own, [], now)).toEqual(["/p/hero.png", "120 KB PNG · You added it just now"])
    const change = itemFixture("c", "01", {
      kind: "changes",
      name: "feat/x",
      path: "/p",
      from: { terminalId: "01", handle: "moth" },
    })
    expect(tabTip(change, ["against main"], now)).toEqual(["/p", "against main"])
  })

  it("has nothing to say of an item with nothing to point at", () => {
    const shells = itemFixture("s", "01", { kind: "shells", name: "Shells", path: null })
    expect(tabTip(shells, [], now)).toEqual([])
  })
})

const noop = (): void => {}
const tool = (key: string, icon = Pause): PaneTool => ({
  key,
  icon,
  label: `Tool ${key}`,
  onClick: noop,
})

const Told = ({ facts }: { facts: readonly string[] }): null => {
  usePaneNote(facts, true)
  return null
}

describe("the tools in a pane's row", () => {
  const draw = (tools: readonly PaneTool[]) => {
    const view = render(
      createElement(
        PaneChrome,
        {
          renderRow: () => createElement("span", { className: "tabs" }, "tabs"),
          end: createElement("i", { className: "end" }),
        },
        createElement(PaneTools, { tools }),
      ),
    )
    unmounts.push(view.unmount)
    return view.container
  }
  const row = (container: HTMLElement) => container.querySelector(".pane-row")!

  context("with one or two", () => {
    it("are icon buttons in the row's end, named in full, with their state", () => {
      const container = draw([
        { ...tool("a"), pressed: true, badge: 3 },
        { ...tool("b", RotateCw), pending: true },
      ])
      const buttons = [
        ...row(container).querySelectorAll<HTMLButtonElement>(".pane-end .pane-tool"),
      ]
      expect(buttons.map((each) => each.getAttribute("aria-label"))).toEqual(["Tool a", "Tool b"])
      expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true")
      expect(buttons[0]!.querySelector(".pane-tool-badge")?.textContent).toBe("3")
      // A tool on its way keeps focus, so it's not disabled, only said to be.
      expect(buttons[1]!.getAttribute("aria-disabled")).toBe("true")
      expect(buttons[1]!.disabled).toBe(false)
      expect(row(container).querySelector(".pane-tools-more")).toBeNull()
    })
  })

  context("with more than two", () => {
    it("fold into a menu as well, for a narrow pane", () => {
      const container = draw([tool("a"), tool("b", RotateCw), tool("c", ArrowLeft)])
      expect(row(container).querySelector(".pane-tools-inline[data-fold]")).not.toBeNull()
      expect(row(container).querySelector("button[aria-label='More tools']")).not.toBeNull()
    })
  })

  context("without a row", () => {
    it("are a line at the viewer's top instead", () => {
      const view = render(createElement(PaneTools, { tools: [tool("a")] }))
      unmounts.push(view.unmount)
      expect(view.container.querySelector(".pane-tools-alone .pane-tool")).not.toBeNull()
    })
  })
})

describe("what a viewer tells its tab", () => {
  it("reaches the row's tab", () => {
    const seen: string[] = []
    const view = render(
      createElement(
        PaneChrome,
        {
          renderRow: (note) => {
            seen.push(`${note.facts.join("|")}:${note.gone}`)
            return null
          },
        },
        createElement(Told, { facts: ["a", "b"] }),
      ),
    )
    expect(seen.at(-1)).toBe("a|b:true")
    unmounts.push(view.unmount)
  })
})

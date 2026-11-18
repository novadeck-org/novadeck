import { itemFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { Pause, RotateCw, ArrowLeft } from "lucide-react"
import { createElement } from "react"
import { afterEach } from "vitest"

import {
  describeTab,
  PaneChrome,
  PaneTitle,
  PaneTools,
  tabTip,
  usePaneNote,
  type PaneTool,
} from "./pane-row"
import { context, describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const now = 10 * 60_000
const shownAgo = (minutes: number): number => now - minutes * 60_000

describe("what a tab's tooltip says of its item", () => {
  it("is where it points, then its facts, then who showed it and when, for another terminal's item", () => {
    const file = itemFixture("f", "01", {
      kind: "file",
      name: "projects.json",
      path: "/p/src/projects.json",
      lines: { from: 2, to: 10 },
      from: { terminalId: "01", handle: "moth" },
      shownAt: shownAgo(2),
    })
    expect(tabTip(file, [], { now })).toEqual([
      "/p/src/projects.json",
      "lines 2–10 · @moth showed it 2m ago",
    ])
  })

  it("leaves out who showed it in its own agent's pane, which says it already", () => {
    const file = itemFixture("f", "01", {
      kind: "file",
      path: "/p/a.ts",
      from: { terminalId: "01", handle: "moth" },
      shownAt: shownAgo(2),
    })
    expect(tabTip(file, [], { own: true, now })).toEqual(["/p/a.ts", "shown 2m ago"])
    const plan = itemFixture("p", "01", { kind: "plan", path: "plan.md", shownAt: shownAgo(4) })
    expect(tabTip(plan, [], { own: true, now })).toEqual(["plan.md", "v1 · written 4m ago"])
  })

  it("says where a page is now, over where it was shown", () => {
    const page = itemFixture("w", "01", {
      kind: "page",
      path: null,
      url: "http://a/",
      shownAt: now,
    })
    expect(tabTip(page, [], { own: true, where: "http://a/next", now })[0]).toBe("http://a/next")
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
    expect(tabTip(plan, ["Fox resolved 1 note"], { now })).toEqual([
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
    expect(tabTip(own, [], { now })).toEqual(["/p/hero.png", "120 KB PNG · You added it just now"])
    const change = itemFixture("c", "01", {
      kind: "changes",
      name: "feat/x",
      path: "/p",
      from: { terminalId: "01", handle: "moth" },
    })
    expect(tabTip(change, ["against main"], { now })).toEqual(["/p", "against main"])
  })

  it("has nothing to say of an item with nothing to point at", () => {
    const shells = itemFixture("s", "01", { kind: "shells", name: "Shells", path: null })
    expect(tabTip(shells, [], { now })).toEqual([])
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

const look = (over: Partial<Parameters<typeof PaneTitle>[0]["look"]> = {}) => ({
  tip: [],
  origin: undefined,
  failed: false,
  ...over,
})

describe("a lone title", () => {
  const draw = (props: Partial<Parameters<typeof PaneTitle>[0]>) => {
    const view = render(
      createElement(PaneTitle, {
        icon: Pause,
        name: "Shells",
        look: look(),
        gone: false,
        ...props,
      }),
    )
    unmounts.push(view.unmount)
    return view.container
  }

  it("has an icon that turns red when what it holds failed", () => {
    expect(
      draw({ look: look({ failed: true }) }).querySelector(".pane-tab[data-failed]"),
    ).not.toBeNull()
    expect(draw({}).querySelector("[data-failed]")).toBeNull()
  })

  it("strikes its name through once what it shows is gone, as its viewer tells", () => {
    const view = render(
      createElement(
        PaneChrome,
        {
          renderRow: (note) =>
            createElement(PaneTitle, {
              icon: Pause,
              name: "old.md",
              look: look(),
              gone: note.gone,
            }),
        },
        createElement(Told, { facts: [] }),
      ),
    )
    unmounts.push(view.unmount)
    expect(view.container.querySelector(".pane-tab[data-gone] .pane-tab-name")?.textContent).toBe(
      "old.md",
    )
  })

  it("describes a moved item's origin to a screen reader, with or without a tooltip", () => {
    expect(describeTab(look({ origin: "Build Studio" }))).toBe("From Build Studio")
    expect(describeTab(look({ tip: ["/p/a.ts", "shown 2m ago"], origin: "Build Studio" }))).toBe(
      "/p/a.ts. shown 2m ago. From Build Studio",
    )
    expect(describeTab(look())).toBeUndefined()
    const title = draw({ look: look({ origin: "Build Studio" }) }).querySelector(".pane-tab-open")!
    expect(title.getAttribute("aria-description")).toBe("From Build Studio")
  })
})

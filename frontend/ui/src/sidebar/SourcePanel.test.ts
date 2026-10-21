import type { SourceProject } from "@novadeck/core/source"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { pulseMs, SourcePanel } from "./SourcePanel"

// jsdom has no layout and no ResizeObserver, which the header's tooltip and the tree's chip
// folding both watch with. The stub lets a test set the tree's width and resize it.
let treeWidth = 0
const observers = new Set<() => void>()
Object.assign(globalThis, {
  ResizeObserver: class {
    constructor(private readonly callback: () => void) {}
    observe(): void {
      observers.add(this.callback)
    }
    unobserve(): void {}
    disconnect(): void {
      observers.delete(this.callback)
    }
  },
})
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get(this: HTMLElement) {
    return this.getAttribute("role") === "tree" ? treeWidth : 0
  },
})
// The panel measures names on a canvas where there is one; jsdom has none and says so loudly.
// A test that wants one sets `measured` to the context it measures with.
let measured: { font: string; measureText: (text: string) => { width: number } } | null = null
HTMLCanvasElement.prototype.getContext = (() => measured) as never
const resizeTree = (width: number): void => {
  treeWidth = width
  act(() => observers.forEach((callback) => callback()))
}

afterEach(() => {
  vi.useRealTimers()
  treeWidth = 0
  measured = null
  observers.clear()
})

const recent = Date.now() - 1000

const work = (parts: Partial<SourceProject> = {}): SourceProject => ({
  entries: ["src/cart/useCart.ts", "src/cart/Cart.tsx", "docs/readme.md", "package.json"],
  ignored: ["node_modules/"],
  changes: {
    "src/cart/useCart.ts": { kind: "modified", touched: { moth: recent, crow: recent - 5000 } },
    "src/cart/new.ts": { kind: "added", touched: { moth: recent } },
  },
  writing: { moth: "src/cart/useCart.ts" },
  ...parts,
})

const mount = (
  project: SourceProject | undefined,
  selectedHandle?: string,
  agents: { roster: string[]; squads: string[][] } = { roster: [], squads: [] },
) => {
  let visible = true
  const props = (next: SourceProject | undefined, handle: string | undefined) => ({
    project: next,
    selectedHandle: handle,
    roster: agents.roster,
    squads: agents.squads,
    active: true,
    visible,
    onHide: () => {},
  })
  const view = render(createElement(SourcePanel, props(project, selectedHandle)))
  const rows = (): string[] =>
    Array.from(view.container.querySelectorAll(".source-name")).map((el) => el.textContent ?? "")
  const row = (name: string): HTMLElement =>
    Array.from(view.container.querySelectorAll<HTMLElement>(".source-row")).find(
      (el) => el.querySelector(".source-name")?.textContent === name,
    )!
  const click = (name: string): void =>
    act(() => row(name).querySelector<HTMLElement>(".source-row-select")!.click())
  const update = (next: SourceProject): void =>
    view.rerender(createElement(SourcePanel, props(next, selectedHandle)))
  let latest = project
  const show = (next: boolean): void => {
    visible = next
    view.rerender(createElement(SourcePanel, props(latest, selectedHandle)))
  }
  return {
    view,
    rows,
    row,
    click,
    update: (next: SourceProject): void => {
      latest = next
      update(next)
    },
    show,
  }
}

describe("The Source panel", () => {
  context("when no agent has changed anything in the project", () => {
    it("says so in one plain line", async () => {
      const panel = mount(undefined)

      expect(panel.view.container.textContent).toContain("No agent has changed anything here yet.")
      expect(panel.view.container.querySelector("[role=tree]")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when it first shows a project", () => {
    it("opens the folders with a changed file and leaves the rest shut", async () => {
      const panel = mount(work())

      expect(panel.rows()).toEqual([
        "docs",
        "src",
        "cart",
        "Cart.tsx",
        "new.ts",
        "useCart.ts",
        "package.json",
      ])
      expect(panel.row("src").querySelector("[role=treeitem]")?.getAttribute("aria-expanded")).toBe(
        "true",
      )
      expect(
        panel.row("docs").querySelector("[role=treeitem]")?.getAttribute("aria-expanded"),
      ).toBe("false")
      await nextFrame()
      panel.view.unmount()
    })

    it("does not open or close anything when later changes arrive", async () => {
      const panel = mount(work())
      panel.update(
        work({
          changes: {
            ...work().changes,
            "docs/readme.md": { kind: "modified", touched: { crow: recent } },
          },
        }),
      )

      expect(panel.rows()).not.toContain("readme.md")
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when the person clicks", () => {
    it("toggles a folder, and the collapse button shuts them all", async () => {
      const panel = mount(work())
      panel.click("docs")
      expect(panel.rows()).toContain("readme.md")
      panel.click("docs")
      expect(panel.rows()).not.toContain("readme.md")

      act(() =>
        panel.view.container.querySelector<HTMLElement>("[aria-label='Collapse folders']")!.click(),
      )

      expect(panel.rows()).toEqual(["docs", "src", "package.json"])
      await nextFrame()
      panel.view.unmount()
    })

    it("selects a file", async () => {
      const panel = mount(work())
      panel.click("package.json")

      expect(panel.row("package.json").getAttribute("data-selected")).toBe("true")
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when agents have worked on files", () => {
    it("shows how each changed and who did it", async () => {
      const panel = mount(work())

      expect(panel.row("useCart.ts").getAttribute("data-kind")).toBe("modified")
      expect(panel.row("new.ts").getAttribute("data-kind")).toBe("added")
      expect(panel.row("useCart.ts").textContent).toContain("@moth")
      expect(panel.row("useCart.ts").textContent).toContain("@crow")
      await nextFrame()
      panel.view.unmount()
    })

    it("draws a cursor for a file being written and a trail for the other changed ones", async () => {
      const panel = mount(work())

      expect(panel.row("useCart.ts").querySelectorAll(".source-cursor")).toHaveLength(1)
      expect(panel.row("useCart.ts").querySelector(".source-trail")).toBeNull()
      expect(panel.row("new.ts").querySelector(".source-trail")).not.toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("draws no cursor for a file hidden in a closed folder, and names the agents on the folder", async () => {
      const panel = mount(work())
      panel.click("src")

      expect(panel.view.container.querySelector(".source-cursor")).toBeNull()
      expect(panel.row("src").querySelector(".source-chips")?.textContent).toContain("@moth")
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when an agent is lit", () => {
    it("dims the rows it did not touch", async () => {
      const panel = mount(
        work({
          changes: {
            ...work().changes,
            "docs/readme.md": { kind: "modified", touched: { crow: recent } },
          },
        }),
        "crow",
      )

      expect(panel.row("readme.md").getAttribute("data-dim")).toBe("false")
      expect(panel.row("new.ts").getAttribute("data-dim")).toBe("true")
      expect(panel.row("package.json").getAttribute("data-dim")).toBe("true")
      await nextFrame()
      panel.view.unmount()
    })

    it("dims nothing when the selected agent has no work here", async () => {
      const panel = mount(work(), "wren")

      expect(panel.row("package.json").getAttribute("data-dim")).toBe("false")
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when agents have work here", () => {
    // moth leads crow; wren works alone. Everyone changed a file of their own.
    const team = (): SourceProject =>
      work({
        changes: {
          ...work().changes,
          "docs/readme.md": { kind: "modified", touched: { crow: recent } },
          "package.json": { kind: "modified", touched: { wren: recent } },
        },
      })
    const agents = { roster: ["wren", "moth", "crow"], squads: [["moth", "crow"]] }
    const mountTeam = (selected?: string) => mount(team(), selected, agents)
    const chip = (panel: ReturnType<typeof mount>, handle: string): HTMLElement =>
      Array.from(
        panel.view.container.querySelectorAll<HTMLElement>(".source-strip .source-agent"),
      ).find((el) => el.textContent === `@${handle}`)!
    const press = (panel: ReturnType<typeof mount>, handle: string): void =>
      act(() => chip(panel, handle).click())
    const pressed = (panel: ReturnType<typeof mount>): string[] =>
      Array.from(panel.view.container.querySelectorAll(".source-agent[aria-pressed=true]")).map(
        (el) => el.textContent ?? "",
      )
    const dimmed = (panel: ReturnType<typeof mount>): string[] =>
      Array.from(
        panel.view.container.querySelectorAll(".source-row[data-dim=true][data-folder=false]"),
      ).map((el) => el.querySelector(".source-name")?.textContent ?? "")
    const hover = (el: Element, type: "pointerover" | "pointerout"): void =>
      act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true })))

    it("shows a chip for each, a squad in a labelled track with its lead first", async () => {
      const panel = mountTeam()

      const strip = panel.view.container.querySelector("[aria-label='Light agents']")!
      expect(strip.getAttribute("role")).toBe("group")
      expect(
        Array.from(strip.querySelectorAll(".source-agent")).map((el) => el.textContent),
      ).toEqual(["@wren", "@moth", "@crow"])
      const squad = strip.querySelector('[aria-label="@moth\'s squad"]')!
      expect(Array.from(squad.querySelectorAll("button")).map((el) => el.textContent)).toEqual([
        "@moth",
        "@crow",
      ])
      await nextFrame()
      panel.view.unmount()
    })

    it("has no strip while nobody has worked here", async () => {
      const panel = mount(work({ changes: {}, writing: {} }), undefined, agents)

      expect(panel.view.container.querySelector(".source-strip")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("lights the union of the agents kept, and releases one on a second click", async () => {
      const panel = mountTeam()

      press(panel, "wren")
      expect(dimmed(panel)).toEqual(["readme.md", "Cart.tsx", "new.ts", "useCart.ts"])
      press(panel, "crow")

      expect(pressed(panel)).toEqual(["@wren", "@crow"])
      expect(dimmed(panel)).toEqual(["Cart.tsx", "new.ts"])
      expect(
        panel.view.container.querySelector("[role=tree]")?.getAttribute("aria-description"),
      ).toBe("The work of @wren and @crow is lit; files and folders they did not touch are dimmed.")
      press(panel, "wren")
      expect(pressed(panel)).toEqual(["@crow"])
      await nextFrame()
      panel.view.unmount()
    })

    it("keeps or releases the whole squad from its lead, and one member from the member", async () => {
      const panel = mountTeam()

      // Nothing marks a lead, so its hint names the squad.
      expect(chip(panel, "moth").getAttribute("title")).toBe("Keep @moth's squad lit")
      expect(chip(panel, "crow").getAttribute("title")).toBe("Keep @crow lit")
      press(panel, "moth")
      expect(chip(panel, "moth").getAttribute("title")).toBe("Let @moth's squad go")
      expect(pressed(panel)).toEqual(["@moth", "@crow"])
      expect(panel.view.container.querySelector(".source-squad")?.getAttribute("data-kept")).toBe(
        "true",
      )
      press(panel, "crow")
      expect(pressed(panel)).toEqual(["@moth"])
      // Not every member is kept, so the lead keeps them all rather than releasing.
      press(panel, "moth")
      expect(pressed(panel)).toEqual(["@moth", "@crow"])
      press(panel, "moth")
      expect(pressed(panel)).toEqual([])
      await nextFrame()
      panel.view.unmount()
    })

    it("follows the selected terminal's agent until something is kept, and again after Escape", async () => {
      const panel = mountTeam("wren")

      expect(chip(panel, "wren").getAttribute("data-following")).toBe("true")
      expect(dimmed(panel)).toEqual(["readme.md", "Cart.tsx", "new.ts", "useCart.ts"])
      press(panel, "crow")
      expect(chip(panel, "wren").getAttribute("data-following")).toBe("false")
      expect(dimmed(panel)).toEqual(["Cart.tsx", "new.ts", "package.json"])

      act(() => {
        chip(panel, "crow").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        )
      })

      expect(pressed(panel)).toEqual([])
      expect(dimmed(panel)).toEqual(["readme.md", "Cart.tsx", "new.ts", "useCart.ts"])
      await nextFrame()
      panel.view.unmount()
    })

    it("clears what is kept on Escape in the tree too", async () => {
      const panel = mountTeam()
      press(panel, "wren")

      act(() => {
        panel
          .row("package.json")
          .querySelector("[role=treeitem]")!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })

      expect(pressed(panel)).toEqual([])
      await nextFrame()
      panel.view.unmount()
    })

    it("lights an agent while its chip is pointed at, its whole squad for a lead, without reordering", async () => {
      const panel = mountTeam()
      const order = (): string[] =>
        Array.from(panel.row("useCart.ts").querySelectorAll(".source-chip")).map(
          (el) => el.textContent ?? "",
        )
      const before = order()

      hover(chip(panel, "wren"), "pointerover")
      expect(dimmed(panel)).toEqual(["readme.md", "Cart.tsx", "new.ts", "useCart.ts"])
      hover(chip(panel, "wren"), "pointerout")
      hover(chip(panel, "moth"), "pointerover")
      expect(dimmed(panel)).toEqual(["Cart.tsx", "package.json"])
      expect(order()).toEqual(before)
      hover(chip(panel, "moth"), "pointerout")

      expect(dimmed(panel)).toEqual([])
      await nextFrame()
      panel.view.unmount()
    })

    it("puts the kept agents first on a row's chips", async () => {
      const panel = mountTeam()
      const shown = (): string[] =>
        Array.from(panel.row("useCart.ts").querySelectorAll(".source-chip")).map(
          (el) => el.textContent ?? "",
        )
      expect(shown()).toEqual(["@moth", "@crow"])

      press(panel, "crow")

      expect(shown()).toEqual(["@crow", "@moth"])
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when an agent writes again", () => {
    it("pulses the file's row, or the closed folder hiding it, but not on first mount", async () => {
      const panel = mount(work())
      expect(panel.view.container.querySelector("[data-pulse]")).toBeNull()

      panel.update(
        work({
          changes: {
            ...work().changes,
            "src/cart/new.ts": { kind: "added", touched: { moth: recent + 500 } },
          },
        }),
      )
      expect(panel.row("new.ts").getAttribute("data-pulse")).toBe("a")

      panel.click("src")
      panel.update(
        work({
          changes: {
            ...work().changes,
            "src/cart/new.ts": { kind: "added", touched: { moth: recent + 900 } },
          },
        }),
      )
      expect(panel.row("src").getAttribute("data-pulse")).toBe("a")
      await nextFrame()
      panel.view.unmount()
    })
  })
  context("when a write lands while the panel is hidden", () => {
    const written = (at: number) =>
      work({
        changes: {
          ...work().changes,
          "src/cart/new.ts": { kind: "added", touched: { moth: at } },
        },
      })

    it("does not pulse it, now or when the panel comes back", async () => {
      const panel = mount(work())
      panel.show(false)
      panel.update(written(recent + 500))
      panel.show(true)

      expect(panel.view.container.querySelector("[data-pulse]")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("starts the trails over when the panel is shown again", async () => {
      const panel = mount(work())
      const before = panel.row("new.ts").querySelector(".source-trail")
      panel.show(false)
      panel.show(true)

      expect(panel.row("new.ts").querySelector(".source-trail")).not.toBe(before)
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when a pulse has played", () => {
    it("forgets it on a timer, with no animation to end", () => {
      vi.useFakeTimers()
      const panel = mount(work())
      panel.update(
        work({
          changes: {
            ...work().changes,
            "src/cart/new.ts": { kind: "added", touched: { moth: recent + 500 } },
          },
        }),
      )
      expect(panel.row("new.ts").getAttribute("data-pulse")).toBe("a")

      act(() => vi.advanceTimersByTime(pulseMs + 1))

      expect(panel.view.container.querySelector("[data-pulse]")).toBeNull()
      panel.view.unmount()
    })
  })

  context("when the pointer is over a chip", () => {
    it("lights the agent without reordering the chips", async () => {
      const panel = mount(
        work({
          changes: {
            "src/cart/useCart.ts": {
              kind: "modified",
              touched: { moth: recent, crow: recent - 5000, wren: recent - 9000 },
            },
          },
        }),
      )
      const names = (): string[] =>
        Array.from(panel.row("useCart.ts").querySelectorAll(".source-chip")).map(
          (chip) => chip.textContent ?? "",
        )
      const before = names()
      const second = panel.row("useCart.ts").querySelectorAll(".source-chip")[1]!
      act(() => void second.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })))

      expect(panel.view.container.querySelector("[data-lit]")?.getAttribute("data-lit")).toBe(
        "crow",
      )
      expect(names()).toEqual(before)
      await nextFrame()
      panel.view.unmount()
    })

    it("stops lighting the agent once a write folds its chip away from the pointer", async () => {
      const panel = mount(
        work({
          changes: {
            "src/cart/useCart.ts": {
              kind: "modified",
              touched: { moth: recent, crow: recent - 5000 },
            },
          },
        }),
      )
      const second = panel.row("useCart.ts").querySelectorAll(".source-chip")[1]!
      act(() => void second.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })))
      expect(panel.view.container.querySelector("[data-lit]")?.getAttribute("data-lit")).toBe(
        "crow",
      )
      panel.update(
        work({
          changes: {
            "src/cart/useCart.ts": {
              kind: "modified",
              touched: { moth: recent, crow: recent - 5000, wren: recent + 1000 },
            },
          },
        }),
      )

      expect(panel.view.container.querySelector("[role=tree]")?.hasAttribute("data-lit")).toBe(
        false,
      )
      await nextFrame()
      panel.view.unmount()
    })

    it("leaves the chips out of the tab order and names everyone on the row", async () => {
      const panel = mount(
        work({
          changes: {
            "src/cart/useCart.ts": {
              kind: "modified",
              touched: { moth: recent, crow: recent - 5000, wren: recent - 9000 },
            },
          },
        }),
      )
      const row = panel.row("useCart.ts")

      expect(row.querySelector(".source-chip[tabindex]")).toBeNull()
      expect(row.querySelector("[role=treeitem]")?.getAttribute("aria-label")).toBe(
        "useCart.ts, modified, @moth @crow @wren",
      )
      expect(row.querySelector(".source-chips")?.getAttribute("aria-hidden")).toBe("true")
      expect(row.querySelector(".source-more")?.getAttribute("title")).toContain("@wren")
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when a folder's contents are not listed", () => {
    it("is not expandable", async () => {
      const panel = mount(work({ entries: [...work().entries, "node_modules/"] }))
      const item = panel.row("node_modules").querySelector("[role=treeitem]")!

      expect(item.hasAttribute("aria-expanded")).toBe(false)
      expect(panel.row("node_modules").querySelector("svg[data-open]")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when the person uses the keyboard", () => {
    const press = (panel: ReturnType<typeof mount>, name: string, key: string): void => {
      const button = panel.row(name).querySelector<HTMLElement>("[role=treeitem]")!
      act(() => {
        button.focus()
        button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      })
    }
    const focused = (): string | null =>
      document.activeElement?.closest(".source-row")?.querySelector(".source-name")?.textContent ??
      null

    it("keeps one tab stop and moves through the rows with the arrows", async () => {
      const panel = mount(work())
      document.body.append(panel.view.container)
      const stops = panel.view.container.querySelectorAll("[role=treeitem][tabindex='0']")
      expect(stops).toHaveLength(1)

      press(panel, "docs", "ArrowDown")
      expect(focused()).toBe("src")
      press(panel, "src", "End")
      expect(focused()).toBe("package.json")
      press(panel, "package.json", "Home")
      expect(focused()).toBe("docs")
      expect(panel.view.container.querySelectorAll("[role=treeitem][tabindex='0']")).toHaveLength(1)
      await nextFrame()
      panel.view.unmount()
    })

    it("opens and closes folders and walks to the parent with Right and Left", async () => {
      const panel = mount(work())
      document.body.append(panel.view.container)

      press(panel, "docs", "ArrowRight")
      expect(panel.rows()).toContain("readme.md")
      press(panel, "docs", "ArrowRight")
      expect(focused()).toBe("readme.md")
      press(panel, "readme.md", "ArrowLeft")
      expect(focused()).toBe("docs")
      press(panel, "docs", "ArrowLeft")
      expect(panel.rows()).not.toContain("readme.md")
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when a row is too narrow for its name beside two chips", () => {
    const deep = "a/b/c/CheckoutSummaryPanel.tsx"
    const crowded = (touched: Record<string, number>): SourceProject => ({
      entries: [],
      ignored: [],
      changes: { [deep]: { kind: "modified", touched }, "short.ts": { kind: "modified", touched } },
      writing: {},
    })
    const shown = (panel: ReturnType<typeof mount>, name: string): string[] =>
      Array.from(panel.row(name).querySelectorAll(".source-chip")).map((el) => el.textContent ?? "")
    const more = (panel: ReturnType<typeof mount>, name: string): string | undefined =>
      panel.row(name).querySelector(".source-more")?.textContent ?? undefined

    it("folds a long deep name to one chip and a count when the tree is narrow", async () => {
      treeWidth = 260
      const panel = mount(crowded({ moth: recent, crow: recent - 1000, wren: recent - 2000 }))

      expect(shown(panel, "CheckoutSummaryPanel.tsx")).toEqual(["@moth"])
      expect(more(panel, "CheckoutSummaryPanel.tsx")).toBe("+2")
      expect(
        panel.row("CheckoutSummaryPanel.tsx").querySelector<HTMLElement>(".source-more")?.title,
      ).toContain("@wren")
      expect(panel.row("CheckoutSummaryPanel.tsx").querySelector("button")?.ariaLabel).toContain(
        "@crow",
      )
      await nextFrame()
      panel.view.unmount()
    })

    it("keeps two chips on the same row when the tree is wide", async () => {
      treeWidth = 400
      const panel = mount(crowded({ moth: recent, crow: recent - 1000, wren: recent - 2000 }))

      expect(shown(panel, "CheckoutSummaryPanel.tsx")).toEqual(["@moth", "@crow"])
      expect(more(panel, "CheckoutSummaryPanel.tsx")).toBe("+1")
      await nextFrame()
      panel.view.unmount()
    })

    it("keeps two chips on a short name even when the tree is narrow", async () => {
      treeWidth = 228
      const panel = mount(crowded({ moth: recent, crow: recent - 1000 }))

      expect(shown(panel, "short.ts")).toEqual(["@moth", "@crow"])
      expect(more(panel, "short.ts")).toBeUndefined()
      await nextFrame()
      panel.view.unmount()
    })

    it("folds and unfolds as the sidebar is resized", async () => {
      treeWidth = 400
      const panel = mount(crowded({ moth: recent, crow: recent - 1000 }))
      expect(shown(panel, "CheckoutSummaryPanel.tsx")).toHaveLength(2)

      resizeTree(228)
      expect(shown(panel, "CheckoutSummaryPanel.tsx")).toEqual(["@moth"])
      expect(more(panel, "CheckoutSummaryPanel.tsx")).toBe("+1")

      resizeTree(400)
      expect(shown(panel, "CheckoutSummaryPanel.tsx")).toHaveLength(2)
      await nextFrame()
      panel.view.unmount()
    })

    it("never changes a row with one agent", async () => {
      treeWidth = 120
      const panel = mount(crowded({ moth: recent }))

      expect(shown(panel, "CheckoutSummaryPanel.tsx")).toEqual(["@moth"])
      expect(more(panel, "CheckoutSummaryPanel.tsx")).toBeUndefined()
      await nextFrame()
      panel.view.unmount()
    })

    it("measures the name on a canvas in the font of its computed longhands", async () => {
      const fonts: string[] = []
      measured = {
        set font(value: string) {
          fonts.push(value)
        },
        // Wide enough that two chips cannot sit beside "short.ts" at this width.
        measureText: () => ({ width: 300 }),
      } as never
      const real = window.getComputedStyle.bind(window)
      vi.spyOn(window, "getComputedStyle").mockImplementation((element, ...rest) =>
        element.classList.contains("source-name")
          ? ({
              fontStyle: "normal",
              fontWeight: "450",
              fontSize: "13px",
              fontFamily: "Measured Sans",
              font: "",
            } as CSSStyleDeclaration)
          : // The chips' font stays unknown, so they are estimated and nothing of them is kept.
            element.classList.contains("handle-chip")
            ? ({ fontSize: "", fontFamily: "" } as CSSStyleDeclaration)
            : real(element, ...rest),
      )
      treeWidth = 400
      const panel = mount(crowded({ moth: recent, crow: recent - 1000 }))

      expect(fonts).toContain("normal 450 13px Measured Sans")
      expect(shown(panel, "short.ts")).toEqual(["@moth"])
      expect(more(panel, "short.ts")).toBe("+1")
      await nextFrame()
      panel.view.unmount()
    })

    it("keeps the room for a trail that has aged out, so the fold never depends on the time", async () => {
      // "short.ts" and two chips fit in 190px without a mark, and not with one.
      treeWidth = 190
      const old = Date.now() - 20 * 60_000
      const fresh = mount(crowded({ moth: recent, crow: recent - 1000 }))
      const aged = mount(crowded({ moth: old, crow: old - 1000 }))

      expect(shown(fresh, "short.ts")).toHaveLength(1)
      expect(shown(aged, "short.ts")).toHaveLength(1)
      const trail = (panel: ReturnType<typeof mount>) =>
        panel.row("short.ts").querySelector<HTMLElement>(".source-trail")!
      expect(trail(fresh).style.visibility).toBe("")
      expect(trail(aged).style.visibility).toBe("hidden")
      await nextFrame()
      fresh.view.unmount()
      aged.view.unmount()
    })

    context("when the chips and the theme set their own fonts", () => {
      // A chip in "Wide Mono" measures 90px a text, any other font 8px.
      let family = "Narrow Mono"
      const measureFonts = (): void => {
        measured = {
          font: "",
          measureText(this: { font: string }) {
            return { width: this.font.includes("Wide Mono") ? 90 : 8 }
          },
        } as never
        const real = window.getComputedStyle.bind(window)
        vi.spyOn(window, "getComputedStyle").mockImplementation((element, ...rest) =>
          element.classList.contains("source-name")
            ? ({
                fontStyle: "normal",
                fontWeight: "400",
                fontSize: "13px",
                fontFamily: "Narrow Name",
                font: "",
              } as CSSStyleDeclaration)
            : element.classList.contains("handle-chip") || element.classList.contains("source-more")
              ? ({
                  fontStyle: "normal",
                  fontWeight: "400",
                  fontSize: "11px",
                  fontFamily: family,
                  font: "",
                } as CSSStyleDeclaration)
              : real(element, ...rest),
        )
      }
      afterEach(() => {
        vi.restoreAllMocks()
        family = "Narrow Mono"
        delete document.documentElement.dataset["theme"]
      })

      it("folds by the width the chips measure in their own font, not by an estimate", async () => {
        measureFonts()
        family = "Wide Mono"
        treeWidth = 220
        const panel = mount(crowded({ moth: recent, crow: recent - 1000 }))

        // The estimate (6.6px a glyph) would keep both chips of "short.ts" here.
        expect(shown(panel, "short.ts")).toEqual(["@moth"])
        await nextFrame()
        panel.view.unmount()
      })

      it("folds again when a theme changes the fonts", async () => {
        measureFonts()
        treeWidth = 220
        const panel = mount(crowded({ moth: recent, crow: recent - 1000 }))
        expect(shown(panel, "short.ts")).toHaveLength(2)

        family = "Wide Mono"
        await act(async () => {
          document.documentElement.dataset["theme"] = "phosphor"
          await nextFrame()
        })
        expect(shown(panel, "short.ts")).toEqual(["@moth"])

        family = "Narrow Mono"
        await act(async () => {
          document.documentElement.dataset["theme"] = "graphite"
          await nextFrame()
        })
        expect(shown(panel, "short.ts")).toHaveLength(2)
        await nextFrame()
        panel.view.unmount()
      })
    })

    it("stops lighting an agent whose chip a narrower tree folded away", async () => {
      treeWidth = 400
      const panel = mount(crowded({ moth: recent, crow: recent - 1000 }))
      const second = panel.row("CheckoutSummaryPanel.tsx").querySelectorAll(".source-chip")[1]!
      act(() => void second.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })))
      // The row the pointer was on folds crow away, though the short row still shows its chip.
      resizeTree(228)
      expect(panel.view.container.querySelector("[role=tree]")?.hasAttribute("data-lit")).toBe(
        false,
      )
      await nextFrame()
      panel.view.unmount()
    })
  })
})

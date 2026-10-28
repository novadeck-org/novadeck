import type { SourceListing, SourceProject } from "@novadeck/core/source"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement, StrictMode } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { folderListings } from "../test/source"
import { pulseMs, readTimeoutMs, SourcePanel } from "./SourcePanel"

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
  changes: {
    "src/cart/useCart.ts": { kind: "modified", touched: { moth: recent, crow: recent - 5000 } },
    "src/cart/new.ts": { kind: "added", touched: { moth: recent } },
  },
  writing: { moth: "src/cart/useCart.ts" },
  ...parts,
})

const files = ["src/cart/useCart.ts", "src/cart/Cart.tsx", "docs/readme.md", "package.json"]

// The backend a test gives the panel: the folders of `files` unless a test says otherwise. Every
// read it gets is recorded, and `answer` can hold one back until the test lets it go.
type Reads = {
  readonly folders: string[]
  readonly list: (folder: string) => Promise<SourceListing>
}

const backend = (
  answer: (folder: string, listing: SourceListing) => Promise<SourceListing> | SourceListing = (
    _,
    listing,
  ) => listing,
  entries: readonly string[] = files,
): Reads => {
  const listings = folderListings(entries)
  const folders: string[] = []
  return {
    folders,
    list: async (folder) => {
      folders.push(folder)
      const listing = listings.get(folder)
      if (!listing && folder !== "") throw new Error("There is no such folder")
      return answer(folder, listing ?? { entries: [], truncated: false })
    },
  }
}

// Lets reads that were asked for come back, and the reads they ask for in turn.
const settle = async (): Promise<void> => {
  for (let round = 0; round < 6; round++)
    // eslint-disable-next-line no-await-in-loop -- One round of reads after another.
    await act(async () => {
      await Promise.resolve()
    })
}

const mount = async (
  project: SourceProject | undefined,
  selectedHandle?: string,
  agents: { roster: string[]; squads: string[][] } = { roster: [], squads: [] },
  reads: Reads = backend(),
  onOpenFile: (path: string) => Promise<void> = () => Promise.resolve(),
) => {
  let visible = true
  let turn = 0
  const props = (next: SourceProject | undefined, handle: string | undefined) => ({
    project: next,
    list: reads.list,
    turn,
    onOpenFile,
    selectedHandle: handle,
    roster: agents.roster,
    squads: agents.squads,
    active: true,
    visible,
    onHide: () => {},
  })
  const view = render(createElement(SourcePanel, props(project, selectedHandle)))
  await settle()
  const rows = (): string[] =>
    Array.from(view.container.querySelectorAll(".source-name")).map((el) => el.textContent ?? "")
  const row = (name: string): HTMLElement =>
    Array.from(view.container.querySelectorAll<HTMLElement>(".source-row")).find(
      (el) => el.querySelector(".source-name")?.textContent === name,
    )!
  const click = async (name: string): Promise<void> => {
    act(() => row(name).querySelector<HTMLElement>(".source-row-select")!.click())
    await settle()
  }
  let latest = project
  const redraw = async (): Promise<void> => {
    view.rerender(createElement(SourcePanel, props(latest, selectedHandle)))
    await settle()
  }
  const show = async (next: boolean): Promise<void> => {
    visible = next
    await redraw()
  }
  return {
    view,
    reads,
    rows,
    row,
    click,
    settle,
    update: async (next: SourceProject): Promise<void> => {
      latest = next
      await redraw()
    },
    show,
    // An agent's turn ends in the project.
    endTurn: async (): Promise<void> => {
      turn += 1
      await redraw()
    },
  }
}

describe("The Source panel", () => {
  context("when it first shows a project", () => {
    it("opens the folders with a changed file and leaves the rest shut", async () => {
      const panel = await mount(work())

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
      const panel = await mount(work())
      await panel.update(
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
      const panel = await mount(work())
      await panel.click("docs")
      expect(panel.rows()).toContain("readme.md")
      await panel.click("docs")
      expect(panel.rows()).not.toContain("readme.md")

      act(() =>
        panel.view.container.querySelector<HTMLElement>("[aria-label='Collapse folders']")!.click(),
      )

      expect(panel.rows()).toEqual(["docs", "src", "package.json"])
      await nextFrame()
      panel.view.unmount()
    })

    it("selects a file", async () => {
      const panel = await mount(work())
      await panel.click("package.json")

      expect(panel.row("package.json").getAttribute("data-selected")).toBe("true")
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when agents have worked on files", () => {
    it("shows how each changed and who did it", async () => {
      const panel = await mount(work())

      expect(panel.row("useCart.ts").getAttribute("data-kind")).toBe("modified")
      expect(panel.row("new.ts").getAttribute("data-kind")).toBe("added")
      expect(panel.row("useCart.ts").textContent).toContain("@moth")
      expect(panel.row("useCart.ts").textContent).toContain("@crow")
      await nextFrame()
      panel.view.unmount()
    })

    it("draws a cursor for a file being written and a trail for the other changed ones", async () => {
      const panel = await mount(work())

      expect(panel.row("useCart.ts").querySelectorAll(".source-cursor")).toHaveLength(1)
      expect(panel.row("useCart.ts").querySelector(".source-trail")).toBeNull()
      expect(panel.row("new.ts").querySelector(".source-trail")).not.toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("draws no cursor for a file hidden in a closed folder, and names the agents on the folder", async () => {
      const panel = await mount(work())
      await panel.click("src")

      expect(panel.view.container.querySelector(".source-cursor")).toBeNull()
      expect(panel.row("src").querySelector(".source-chips")?.textContent).toContain("@moth")
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when an agent is lit", () => {
    it("dims the rows it did not touch", async () => {
      const panel = await mount(
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
      const panel = await mount(work(), "wren")

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
    const chip = (panel: Awaited<ReturnType<typeof mount>>, handle: string): HTMLElement =>
      Array.from(
        panel.view.container.querySelectorAll<HTMLElement>(".source-strip .source-agent"),
      ).find((el) => el.textContent === `@${handle}`)!
    const press = (panel: Awaited<ReturnType<typeof mount>>, handle: string): void =>
      act(() => chip(panel, handle).click())
    const pressed = (panel: Awaited<ReturnType<typeof mount>>): string[] =>
      Array.from(panel.view.container.querySelectorAll(".source-agent[aria-pressed=true]")).map(
        (el) => el.textContent ?? "",
      )
    const dimmed = (panel: Awaited<ReturnType<typeof mount>>): string[] =>
      Array.from(
        panel.view.container.querySelectorAll(".source-row[data-dim=true][data-folder=false]"),
      ).map((el) => el.querySelector(".source-name")?.textContent ?? "")
    const hover = (el: Element, type: "pointerover" | "pointerout"): void =>
      act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true })))

    it("shows a chip for each, a squad in a labelled track with its lead first", async () => {
      const panel = await mountTeam()

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
      const panel = await mount(work({ changes: {}, writing: {} }), undefined, agents)

      expect(panel.view.container.querySelector(".source-strip")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("lights the union of the agents kept, and releases one on a second click", async () => {
      const panel = await mountTeam()

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
      const panel = await mountTeam()

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
      expect(pressed(panel)).toEqual([])
      expect(chip(panel, "moth").getAttribute("aria-pressed")).toBe("mixed")
      // Not every member is kept, so the lead keeps them all rather than releasing.
      press(panel, "moth")
      expect(pressed(panel)).toEqual(["@moth", "@crow"])
      press(panel, "moth")
      expect(pressed(panel)).toEqual([])
      await nextFrame()
      panel.view.unmount()
    })

    it("follows the selected terminal's agent until something is kept, and again after Escape", async () => {
      const panel = await mountTeam("wren")

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

    it("leaves Escape to others while nothing is kept", async () => {
      const panel = await mountTeam()
      const seen: boolean[] = []
      const listen = (event: Event): void => void seen.push(event.defaultPrevented)
      document.body.addEventListener("keydown", listen)

      act(() => {
        chip(panel, "wren").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        )
      })
      press(panel, "wren")
      act(() => {
        chip(panel, "wren").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        )
      })

      // The first Escape propagated to the body, the second (which let go) did not.
      expect(seen).toHaveLength(1)
      document.body.removeEventListener("keydown", listen)
      await nextFrame()
      panel.view.unmount()
    })

    it("marks a lead pressed for its squad: true when all are kept, mixed when some are", async () => {
      const panel = await mountTeam()
      const state = (handle: string): string | null =>
        chip(panel, handle).getAttribute("aria-pressed")
      expect(state("moth")).toBe("false")

      press(panel, "crow")
      expect(state("moth")).toBe("mixed")
      expect(state("crow")).toBe("true")
      press(panel, "moth")
      expect(state("moth")).toBe("true")
      press(panel, "crow")
      expect(state("moth")).toBe("mixed")
      press(panel, "moth")
      press(panel, "moth")
      expect(state("moth")).toBe("false")
      await nextFrame()
      panel.view.unmount()
    })

    it("lets go of a kept agent that leaves the project, so nothing stays dimmed for it", async () => {
      const panel = await mountTeam()
      press(panel, "wren")
      expect(dimmed(panel)).not.toEqual([])

      await panel.update(work())

      expect(pressed(panel)).toEqual([])
      expect(dimmed(panel)).toEqual([])
      await nextFrame()
      panel.view.unmount()
    })

    it("forgets a hover on a chip that leaves the strip", async () => {
      const panel = await mountTeam()
      hover(chip(panel, "wren"), "pointerover")
      expect(dimmed(panel)).not.toEqual([])

      await panel.update(work())

      expect(dimmed(panel)).toEqual([])
      await nextFrame()
      panel.view.unmount()
    })

    it("clears what is kept on Escape in the tree too", async () => {
      const panel = await mountTeam()
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
      const panel = await mountTeam()
      const order = (): string[] =>
        Array.from(panel.row("useCart.ts").querySelectorAll(".source-chip")).map(
          (el) => el.textContent ?? "",
        )
      const before = order()

      hover(chip(panel, "wren"), "pointerover")
      expect(dimmed(panel)).toEqual(["readme.md", "Cart.tsx", "new.ts", "useCart.ts"])
      hover(chip(panel, "wren"), "pointerout")
      // A member alone would rank its chip first on a row if hover fed the ranking.
      hover(chip(panel, "crow"), "pointerover")
      expect(dimmed(panel)).toEqual(["Cart.tsx", "new.ts", "package.json"])
      expect(order()).toEqual(before)
      hover(chip(panel, "crow"), "pointerout")
      hover(chip(panel, "moth"), "pointerover")
      expect(dimmed(panel)).toEqual(["Cart.tsx", "package.json"])
      expect(order()).toEqual(before)
      hover(chip(panel, "moth"), "pointerout")

      expect(dimmed(panel)).toEqual([])
      await nextFrame()
      panel.view.unmount()
    })

    it("puts the kept agents first on a row's chips", async () => {
      const panel = await mountTeam()
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
      const panel = await mount(work())
      expect(panel.view.container.querySelector("[data-pulse]")).toBeNull()

      await panel.update(
        work({
          changes: {
            ...work().changes,
            "src/cart/new.ts": { kind: "added", touched: { moth: recent + 500 } },
          },
        }),
      )
      expect(panel.row("new.ts").getAttribute("data-pulse")).toBe("a")

      await panel.click("src")
      await panel.update(
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
      const panel = await mount(work())
      await panel.show(false)
      await panel.update(written(recent + 500))
      await panel.show(true)

      expect(panel.view.container.querySelector("[data-pulse]")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("starts the trails over when the panel is shown again", async () => {
      const panel = await mount(work())
      const before = panel.row("new.ts").querySelector(".source-trail")
      await panel.show(false)
      await panel.show(true)

      expect(panel.row("new.ts").querySelector(".source-trail")).not.toBe(before)
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when a pulse has played", () => {
    it("forgets it on a timer, with no animation to end", async () => {
      vi.useFakeTimers()
      const panel = await mount(work())
      await panel.update(
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
      const panel = await mount(
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
      const panel = await mount(
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
      await panel.update(
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
      const panel = await mount(
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

  context("when a folder is empty", () => {
    it("opens onto a note saying so, and is read again with the rest", async () => {
      let entries = [...files, "dist/"]
      const reads: Reads = {
        folders: [],
        list: (folder) => backend(undefined, entries).list(folder),
      }
      const panel = await mount(work(), undefined, undefined, reads)
      await panel.click("dist")

      expect(
        panel.row("dist").querySelector("[role=treeitem]")!.getAttribute("aria-expanded"),
      ).toBe("true")
      expect(panel.view.container.querySelector("[data-note=empty]")?.textContent).toBe("Empty")

      entries = [...files, "dist/a.js"]
      await panel.endTurn()

      expect(panel.rows()).toContain("a.js")
      expect(panel.view.container.querySelector("[data-note=empty]")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when the project's root is read", () => {
    it("says plainly that it can't be, in place of the tree", async () => {
      const reads = backend((folder, listing) => {
        if (folder === "") throw new Error("gone")
        return listing
      })
      const panel = await mount(undefined, undefined, undefined, reads)

      expect(panel.view.container.textContent).toContain("Can't read this project's files.")
      expect(panel.view.container.querySelector("[role=tree]")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("says plainly that it is empty", async () => {
      const panel = await mount(undefined, undefined, undefined, backend(undefined, []))

      expect(panel.view.container.textContent).toContain("This project's folder is empty.")
      await nextFrame()
      panel.view.unmount()
    })

    it("says it is empty though agents are said to have changed files in it", async () => {
      const panel = await mount(work(), undefined, undefined, backend(undefined, []))

      expect(panel.view.container.textContent).toContain("This project's folder is empty.")
      expect(panel.view.container.querySelector("[role=tree]")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("lists nothing until it is read, and reads nothing while the panel is hidden", async () => {
      const reads = backend()
      const view = render(
        createElement(SourcePanel, {
          project: undefined,
          list: reads.list,
          turn: 0,
          onOpenFile: () => Promise.resolve(),
          selectedHandle: undefined,
          roster: [],
          squads: [],
          active: false,
          visible: true,
          onHide: () => {},
        }),
      )
      await settle()

      expect(reads.folders).toEqual([])
      expect(view.container.querySelector("[role=tree]")).toBeNull()
      view.unmount()
    })

    it("ends a root that lists only part with a muted note", async () => {
      const reads = backend((folder, listing) =>
        folder === "" ? { ...listing, truncated: true } : listing,
      )
      const panel = await mount(undefined, undefined, undefined, reads)

      expect(panel.view.container.querySelector("[data-note=truncated]")?.textContent).toBe(
        "More not shown",
      )
      await nextFrame()
      panel.view.unmount()
    })

    it("shows a note beside a file named like it without a clash", async () => {
      const reads = backend(
        (folder, listing) => (folder === "" ? { ...listing, truncated: true } : listing),
        ["truncated", "failed"],
      )
      const panel = await mount(undefined, undefined, undefined, reads)

      expect(panel.rows()).toEqual(["failed", "truncated"])
      expect(panel.view.container.querySelectorAll("[data-note]")).toHaveLength(1)
      await nextFrame()
      panel.view.unmount()
    })

    it("shows the plain tree where the backend tells of no changes, with nothing open", async () => {
      const panel = await mount(undefined)

      expect(panel.rows()).toEqual(["docs", "src", "package.json"])
      expect(panel.view.container.querySelector(".source-strip")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when a folder is read", () => {
    it("reads it as it opens, and shows what it lists", async () => {
      const reads = backend()
      const panel = await mount(undefined, undefined, undefined, reads)
      expect(reads.folders).toEqual([""])

      await panel.click("docs")

      expect(reads.folders).toEqual(["", "docs"])
      expect(panel.rows()).toContain("readme.md")
      await nextFrame()
      panel.view.unmount()
    })

    it("shows a muted row in a folder that can't be read, and reads it again on reopening", async () => {
      let broken = true
      const reads = backend((folder, listing) => {
        if (folder === "docs" && broken) throw new Error("denied")
        return listing
      })
      const panel = await mount(undefined, undefined, undefined, reads)
      await panel.click("docs")

      const note = panel.view.container.querySelector("[data-note=failed]")
      expect(note?.textContent).toBe("Can't read this folder")
      expect(panel.rows()).not.toContain("readme.md")

      broken = false
      await panel.click("docs")
      await panel.click("docs")

      expect(panel.view.container.querySelector("[data-note=failed]")).toBeNull()
      expect(panel.rows()).toContain("readme.md")
      await nextFrame()
      panel.view.unmount()
    })

    it("says what a folder that lists only part lacks", async () => {
      const reads = backend((folder, listing) =>
        folder === "docs" ? { ...listing, truncated: true } : listing,
      )
      const panel = await mount(undefined, undefined, undefined, reads)
      await panel.click("docs")

      expect(panel.view.container.querySelector("[data-note=truncated]")?.textContent).toBe(
        "More not shown",
      )
      expect(panel.rows()).toContain("readme.md")
      await nextFrame()
      panel.view.unmount()
    })

    it("reads the folders opened for the changes in them", async () => {
      const reads = backend()
      await mount(work(), undefined, undefined, reads)

      expect(reads.folders.toSorted()).toEqual(["", "src", "src/cart"])
    })

    it("lists a file an agent added that its folder's listing lacks", async () => {
      const panel = await mount(work())

      expect(panel.rows()).toContain("new.ts")
    })
  })

  context("when the folders are read again", () => {
    it("does so when the panel is shown again, for the root and the open folders only", async () => {
      const reads = backend()
      const panel = await mount(undefined, undefined, undefined, reads)
      await panel.click("docs")
      reads.folders.length = 0

      await panel.show(false)
      expect(reads.folders).toEqual([])
      await panel.show(true)

      expect(reads.folders.toSorted()).toEqual(["", "docs"])
      await nextFrame()
      panel.view.unmount()
    })

    it("does so for the folders left open inside one opened again", async () => {
      let entries = files
      const reads: Reads = {
        folders: [],
        list: (folder) => backend(undefined, entries).list(folder),
      }
      const panel = await mount(undefined, undefined, undefined, reads)
      await panel.click("src")
      await panel.click("cart")
      await panel.click("src")

      entries = [...files, "src/cart/total.ts"]
      await panel.click("src")

      expect(panel.rows()).toContain("total.ts")
      await nextFrame()
      panel.view.unmount()
    })

    it("does so when an agent's turn ends, and not when it ends while the panel is hidden", async () => {
      const reads = backend()
      const panel = await mount(undefined, undefined, undefined, reads)
      reads.folders.length = 0

      await panel.endTurn()
      expect(reads.folders).toEqual([""])
      await panel.show(false)
      reads.folders.length = 0
      await panel.endTurn()
      expect(reads.folders).toEqual([])
      await panel.show(true)

      expect(reads.folders).toEqual([""])
      await nextFrame()
      panel.view.unmount()
    })

    it("shows a file that appeared, and drops the folder that vanished with its listing", async () => {
      let entries = files
      const reads: Reads = {
        folders: [],
        list: (folder) => backend(undefined, entries).list(folder),
      }
      const panel = await mount(undefined, undefined, undefined, reads)
      await panel.click("docs")
      expect(panel.rows()).toContain("readme.md")

      entries = [...files, "docs/new.md"]
      await panel.endTurn()
      expect(panel.rows()).toContain("new.md")

      entries = ["package.json"]
      await panel.endTurn()
      expect(panel.rows()).toEqual(["package.json"])

      entries = files
      await panel.endTurn()
      expect(panel.rows()).toContain("readme.md")
      await nextFrame()
      panel.view.unmount()
    })

    it("reads a folder once more, not at once again, when asked while a read is out", async () => {
      const slow: ((listing: SourceListing) => void)[] = []
      let reading = 0
      const reads = backend((folder, listing) => {
        if (folder !== "docs") return listing
        reading += 1
        if (reading > 1)
          return { ...listing, entries: [{ name: "newer.md", folder: false, ignored: false }] }
        return new Promise<SourceListing>((resolve) => slow.push(resolve))
      })
      const panel = await mount(undefined, undefined, undefined, reads)
      await panel.click("docs")
      await panel.endTurn()
      await panel.endTurn()
      await panel.endTurn()
      expect(reads.folders.filter((folder) => folder === "docs")).toHaveLength(1)

      await act(async () => {
        slow[0]!({
          entries: [{ name: "older.md", folder: false, ignored: false }],
          truncated: false,
        })
      })
      await panel.settle()

      expect(reads.folders.filter((folder) => folder === "docs")).toHaveLength(2)
      expect(panel.rows()).toContain("newer.md")
      expect(panel.rows()).not.toContain("older.md")
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when the person opens a file", () => {
    const keyOn = (panel: Awaited<ReturnType<typeof mount>>, name: string, key: string): void =>
      act(() => {
        const button = panel.row(name).querySelector<HTMLElement>("[role=treeitem]")!
        button.focus()
        button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      })

    it("opens it on a double click, and only selects it on a single one", async () => {
      const opened: string[] = []
      const panel = await mount(undefined, undefined, undefined, backend(), (path) => {
        opened.push(path)
        return Promise.resolve()
      })
      await panel.click("package.json")
      expect(opened).toEqual([])

      act(() =>
        panel
          .row("package.json")
          .querySelector<HTMLElement>("[role=treeitem]")!
          .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
      )

      expect(opened).toEqual(["package.json"])
      expect(panel.row("package.json").getAttribute("data-selected")).toBe("true")
      await nextFrame()
      panel.view.unmount()
    })

    it("opens it on Enter, by its path from the root, and a folder on Enter only toggles", async () => {
      const opened: string[] = []
      const panel = await mount(undefined, undefined, undefined, backend(), (path) => {
        opened.push(path)
        return Promise.resolve()
      })
      await panel.click("docs")

      keyOn(panel, "readme.md", "Enter")
      keyOn(panel, "docs", "Enter")
      await panel.settle()

      expect(opened).toEqual(["docs/readme.md"])
      await nextFrame()
      panel.view.unmount()
    })

    it("opens it once however long Enter is held", async () => {
      const opened: string[] = []
      const panel = await mount(undefined, undefined, undefined, backend(), (path) => {
        opened.push(path)
        return Promise.resolve()
      })
      await panel.click("docs")
      const button = panel.row("readme.md").querySelector<HTMLElement>("[role=treeitem]")!

      act(() => {
        button.focus()
        for (const repeat of [false, true, true])
          button.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", repeat, bubbles: true, cancelable: true }),
          )
      })

      expect(opened).toEqual(["docs/readme.md"])
      await nextFrame()
      panel.view.unmount()
    })

    it("reads its folder again when it can't be opened", async () => {
      const reads = backend()
      const panel = await mount(undefined, undefined, undefined, reads, () =>
        Promise.reject(new Error("gone")),
      )
      await panel.click("docs")
      reads.folders.length = 0

      keyOn(panel, "readme.md", "Enter")
      await panel.settle()

      expect(reads.folders).toEqual(["docs"])
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when the person uses the keyboard", () => {
    const press = (panel: Awaited<ReturnType<typeof mount>>, name: string, key: string): void => {
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
      const panel = await mount(work())
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
      const panel = await mount(work())
      document.body.append(panel.view.container)

      press(panel, "docs", "ArrowRight")
      await panel.settle()
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

  context("when the keyboard meets a folder with no rows inside", () => {
    it("keeps ArrowRight on an open empty folder where it is", async () => {
      const panel = await mount(
        undefined,
        undefined,
        undefined,
        backend(undefined, [...files, "dist/"]),
      )
      document.body.append(panel.view.container)
      await panel.click("dist")
      const button = panel.row("dist").querySelector<HTMLElement>("[role=treeitem]")!

      act(() => {
        button.focus()
        for (const _ of [1, 2])
          button.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
          )
      })

      expect(document.activeElement).toBe(button)
      await nextFrame()
      panel.view.unmount()
    })

    it("leaves a repeated Enter on a folder unhandled by the click, so a held key toggles it once", async () => {
      const panel = await mount(undefined)
      const button = panel.row("docs").querySelector<HTMLElement>("[role=treeitem]")!
      const enter = (repeat: boolean): KeyboardEvent => {
        const event = new KeyboardEvent("keydown", {
          key: "Enter",
          repeat,
          bubbles: true,
          cancelable: true,
        })
        act(() => void button.dispatchEvent(event))
        return event
      }

      // The first Enter is the button's own click; a repeat is stopped from becoming another.
      expect(enter(false).defaultPrevented).toBe(false)
      expect(enter(true).defaultPrevented).toBe(true)
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when a folder never answers", () => {
    it("is given up on under StrictMode too, whose remount starts the reads over", async () => {
      vi.useFakeTimers()
      const view = render(
        createElement(
          StrictMode,
          null,
          createElement(SourcePanel, {
            project: undefined,
            list: () => new Promise<SourceListing>(() => {}),
            turn: 0,
            onOpenFile: () => Promise.resolve(),
            selectedHandle: undefined,
            roster: [],
            squads: [],
            active: true,
            visible: true,
            onHide: () => {},
          }),
        ),
      )
      await settle()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(readTimeoutMs + 1)
      })

      expect(view.container.textContent).toContain("Can't read this project's files.")
      view.unmount()
    })

    it("is given up on as unreadable, and can be read again", async () => {
      vi.useFakeTimers()
      let hang = true
      const reads = backend((folder, listing) =>
        folder === "docs" && hang ? new Promise<SourceListing>(() => {}) : listing,
      )
      const panel = await mount(undefined, undefined, undefined, reads)
      await panel.click("docs")
      expect(panel.view.container.querySelector("[data-note=failed]")).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(readTimeoutMs + 1)
      })
      expect(panel.view.container.querySelector("[data-note=failed]")).not.toBeNull()

      hang = false
      await panel.endTurn()
      expect(panel.rows()).toContain("readme.md")
      panel.view.unmount()
    })
  })

  context("when a row is too narrow for its name beside two chips", () => {
    const deep = "a/b/c/CheckoutSummaryPanel.tsx"
    const crowded = (touched: Record<string, number>): SourceProject => ({
      changes: { [deep]: { kind: "modified", touched }, "short.ts": { kind: "modified", touched } },
      writing: {},
    })
    const shown = (panel: Awaited<ReturnType<typeof mount>>, name: string): string[] =>
      Array.from(panel.row(name).querySelectorAll(".source-chip")).map((el) => el.textContent ?? "")
    const more = (panel: Awaited<ReturnType<typeof mount>>, name: string): string | undefined =>
      panel.row(name).querySelector(".source-more")?.textContent ?? undefined

    it("folds a long deep name to one chip and a count when the tree is narrow", async () => {
      treeWidth = 260
      const panel = await mount(crowded({ moth: recent, crow: recent - 1000, wren: recent - 2000 }))

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
      const panel = await mount(crowded({ moth: recent, crow: recent - 1000, wren: recent - 2000 }))

      expect(shown(panel, "CheckoutSummaryPanel.tsx")).toEqual(["@moth", "@crow"])
      expect(more(panel, "CheckoutSummaryPanel.tsx")).toBe("+1")
      await nextFrame()
      panel.view.unmount()
    })

    it("keeps two chips on a short name even when the tree is narrow", async () => {
      treeWidth = 228
      const panel = await mount(crowded({ moth: recent, crow: recent - 1000 }))

      expect(shown(panel, "short.ts")).toEqual(["@moth", "@crow"])
      expect(more(panel, "short.ts")).toBeUndefined()
      await nextFrame()
      panel.view.unmount()
    })

    it("folds and unfolds as the sidebar is resized", async () => {
      treeWidth = 400
      const panel = await mount(crowded({ moth: recent, crow: recent - 1000 }))
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
      const panel = await mount(crowded({ moth: recent }))

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
      const panel = await mount(crowded({ moth: recent, crow: recent - 1000 }))

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
      const fresh = await mount(crowded({ moth: recent, crow: recent - 1000 }))
      const aged = await mount(crowded({ moth: old, crow: old - 1000 }))

      expect(shown(fresh, "short.ts")).toHaveLength(1)
      expect(shown(aged, "short.ts")).toHaveLength(1)
      const trail = (panel: Awaited<ReturnType<typeof mount>>) =>
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
        const panel = await mount(crowded({ moth: recent, crow: recent - 1000 }))

        // The estimate (6.6px a glyph) would keep both chips of "short.ts" here.
        expect(shown(panel, "short.ts")).toEqual(["@moth"])
        await nextFrame()
        panel.view.unmount()
      })

      it("folds again when a theme changes the fonts", async () => {
        measureFonts()
        treeWidth = 220
        const panel = await mount(crowded({ moth: recent, crow: recent - 1000 }))
        expect(shown(panel, "short.ts")).toHaveLength(2)

        family = "Wide Mono"
        await act(async () => {
          document.documentElement.dataset["theme"] = "phosphor"
          await nextFrame()
        })
        expect(shown(panel, "short.ts")).toEqual(["@moth"])

        family = "Narrow Mono"
        await act(async () => {
          document.documentElement.dataset["theme"] = "coolant"
          await nextFrame()
        })
        expect(shown(panel, "short.ts")).toHaveLength(2)
        await nextFrame()
        panel.view.unmount()
      })
    })

    it("stops lighting an agent whose chip a narrower tree folded away", async () => {
      treeWidth = 400
      const panel = await mount(crowded({ moth: recent, crow: recent - 1000 }))
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

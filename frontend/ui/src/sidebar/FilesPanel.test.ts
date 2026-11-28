import type {
  FolderListing,
  FilesProject,
  ProjectFiles,
  RepoSync,
  SyncLanding,
} from "@novadeck/core/files"
import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement, StrictMode } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { folderListings } from "../test/files"
import {
  createSyncFeed,
  syncPollMs,
  type SyncFeed,
  type SyncTerminals,
  type TerminalProgress,
} from "./files-sync"
import { FilesPanel } from "./FilesPanel"
import { readTimeoutMs } from "./useFolderReader"
import { pulseMs } from "./usePulses"

// jsdom has no layout and no ResizeObserver, which the header's tooltip and the tree's chip
// folding both watch with. The stub lets a test set the tree's width and height and resize it.
// The tree draws only the rows in view, so it is tall enough for every row unless a test says so.
let treeWidth = 0
const tallEnough = 100_000
let treeHeight = tallEnough
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
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.getAttribute("role") === "tree" ? treeHeight : 0
  },
})
// The panel measures names on a canvas where there is one; jsdom has none and says so loudly.
// A test that wants one sets `measured` to the context it measures with.
let measured: { font: string; measureText: (text: string) => { width: number } } | null = null
HTMLCanvasElement.prototype.getContext = (() => measured) as never
const resizeTree = (width: number, height: number = treeHeight): void => {
  treeWidth = width
  treeHeight = height
  act(() => observers.forEach((callback) => callback()))
}

afterEach(() => {
  vi.useRealTimers()
  treeWidth = 0
  treeHeight = tallEnough
  measured = null
  observers.clear()
})

const recent = Date.now() - 1000

const work = (parts: Partial<FilesProject> = {}): FilesProject => ({
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
  readonly list: (folder: string) => Promise<FolderListing>
}

const backend = (
  answer: (folder: string, listing: FolderListing) => Promise<FolderListing> | FolderListing = (
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
  project: FilesProject | undefined,
  selectedHandle?: string,
  agents: { roster: string[]; squads: string[][] } = { roster: [], squads: [] },
  reads: Reads = backend(),
  onOpenFile: (path: string) => Promise<void> = () => Promise.resolve(),
  watch?: () => () => void,
  sync?: SyncFeed,
  terminals?: SyncTerminals,
) => {
  let visible = true
  let turn = 0
  const props = (next: FilesProject | undefined, handle: string | undefined) => ({
    project: next,
    list: reads.list,
    turn,
    sync,
    terminals,
    watch,
    onOpenFile,
    selectedHandle: handle,
    roster: agents.roster,
    squads: agents.squads,
    active: true,
    visible,
    onHide: () => {},
  })
  const view = render(createElement(FilesPanel, props(project, selectedHandle)))
  await settle()
  const rows = (): string[] =>
    Array.from(view.container.querySelectorAll(".files-name")).map((el) => el.textContent ?? "")
  const row = (name: string): HTMLElement =>
    Array.from(view.container.querySelectorAll<HTMLElement>(".files-row")).find(
      (el) => el.querySelector(".files-name")?.textContent === name,
    )!
  const click = async (name: string): Promise<void> => {
    act(() => row(name).querySelector<HTMLElement>(".files-row-select")!.click())
    await settle()
  }
  let latest = project
  const redraw = async (): Promise<void> => {
    view.rerender(createElement(FilesPanel, props(latest, selectedHandle)))
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
    update: async (next: FilesProject): Promise<void> => {
      latest = next
      await redraw()
    },
    show,
    redraw,
    // An agent's turn ends in the project.
    endTurn: async (): Promise<void> => {
      turn += 1
      await redraw()
    },
  }
}

describe("The Files panel", () => {
  context("when its changes come from the works", () => {
    it("follows them while it shows, and lets go while it is hidden", async () => {
      const released = vi.fn<() => void>()
      const watch = vi.fn<() => () => void>(() => released)
      const panel = await mount(undefined, undefined, undefined, undefined, undefined, watch)
      expect(watch).toHaveBeenCalledTimes(1)
      expect(released).not.toHaveBeenCalled()

      await panel.show(false)
      expect(released).toHaveBeenCalledTimes(1)

      await panel.show(true)
      expect(watch).toHaveBeenCalledTimes(2)
    })
  })

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

    it("does not close anything, nor re-open a folder, when later changes arrive", async () => {
      const panel = await mount(work())
      await panel.click("cart")
      await panel.update(
        work({
          changes: {
            ...work().changes,
            "src/cart/Cart.tsx": { kind: "modified", touched: { crow: recent } },
          },
        }),
      )

      expect(panel.rows()).toEqual(["docs", "src", "cart", "package.json"])
      await nextFrame()
      panel.view.unmount()
    })
  })

  context("when a change lands after the tree loaded", () => {
    const quiet = work({ changes: {}, writing: {} })
    const inDocs = work({
      changes: { "docs/readme.md": { kind: "modified", touched: { moth: recent } } },
      writing: {},
    })

    it("opens the folder that now holds it, and not again once the person closed it", async () => {
      const panel = await mount(quiet)
      expect(panel.rows()).toEqual(["docs", "src", "package.json"])

      await panel.update(inDocs)
      expect(panel.rows()).toContain("readme.md")

      await panel.click("docs")
      await panel.update(
        work({
          changes: {
            ...inDocs.changes,
            "docs/new.md": { kind: "added", touched: { moth: recent } },
          },
        }),
      )
      expect(panel.rows()).not.toContain("readme.md")
      panel.view.unmount()
    })

    it("keeps shut a folder shut by Collapse folders, until the person opens it", async () => {
      const panel = await mount(work())
      act(() =>
        panel.view.container.querySelector<HTMLElement>("[aria-label='Collapse folders']")!.click(),
      )
      await panel.update(
        work({ changes: { "src/cart/Cart.tsx": { kind: "modified", touched: { crow: recent } } } }),
      )
      expect(panel.rows()).toEqual(["docs", "src", "package.json"])
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

      expect(panel.row("useCart.ts").querySelectorAll(".files-cursor")).toHaveLength(1)
      expect(panel.row("useCart.ts").querySelector(".files-trail")).toBeNull()
      expect(panel.row("new.ts").querySelector(".files-trail")).not.toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("draws no cursor for a file hidden in a closed folder, and names the agents on the folder", async () => {
      const panel = await mount(work())
      await panel.click("src")

      expect(panel.view.container.querySelector(".files-cursor")).toBeNull()
      expect(panel.row("src").querySelector(".files-chips")?.textContent).toContain("@moth")
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
    const team = (): FilesProject =>
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
        panel.view.container.querySelectorAll<HTMLElement>(".files-strip .files-agent"),
      ).find((el) => el.textContent === `@${handle}`)!
    const press = (panel: Awaited<ReturnType<typeof mount>>, handle: string): void =>
      act(() => chip(panel, handle).click())
    const pressed = (panel: Awaited<ReturnType<typeof mount>>): string[] =>
      Array.from(panel.view.container.querySelectorAll(".files-agent[aria-pressed=true]")).map(
        (el) => el.textContent ?? "",
      )
    const dimmed = (panel: Awaited<ReturnType<typeof mount>>): string[] =>
      Array.from(
        panel.view.container.querySelectorAll(".files-row[data-dim=true][data-folder=false]"),
      ).map((el) => el.querySelector(".files-name")?.textContent ?? "")
    const fileRows = (panel: Awaited<ReturnType<typeof mount>>): string[] =>
      Array.from(panel.view.container.querySelectorAll(".files-row[data-folder=false]")).map(
        (el) => el.querySelector(".files-name")?.textContent ?? "",
      )
    const everyFile = ["readme.md", "Cart.tsx", "new.ts", "useCart.ts", "package.json"]
    const hover = (el: Element, type: "pointerover" | "pointerout"): void =>
      act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true })))

    it("shows a chip for each, a squad in a labelled track with its lead first", async () => {
      const panel = await mountTeam()

      const strip = panel.view.container.querySelector(`[aria-label="Show agents' work"]`)!
      expect(strip.getAttribute("role")).toBe("group")
      expect(
        Array.from(strip.querySelectorAll(".files-agent")).map((el) => el.textContent),
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

      expect(panel.view.container.querySelector(".files-strip")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("shows only the work of the agents kept, and releases one on a second click", async () => {
      const panel = await mountTeam()
      const folders = (): string[] =>
        Array.from(panel.view.container.querySelectorAll(".files-row[data-folder=true]")).map(
          (el) => el.querySelector(".files-name")?.textContent ?? "",
        )
      expect(fileRows(panel)).toEqual(everyFile)

      press(panel, "wren")
      expect(fileRows(panel)).toEqual(["package.json"])
      expect(folders()).toEqual([])
      press(panel, "crow")

      expect(pressed(panel)).toEqual(["@wren", "@crow"])
      expect(fileRows(panel)).toEqual(["readme.md", "useCart.ts", "package.json"])
      expect(folders()).toEqual(["docs", "src", "cart"])
      expect(dimmed(panel)).toEqual([])
      expect(
        panel.view.container.querySelector("[role=tree]")?.getAttribute("aria-description"),
      ).toBe("Only the work of @wren and @crow is shown.")
      press(panel, "wren")
      expect(pressed(panel)).toEqual(["@crow"])
      expect(fileRows(panel)).toEqual(["readme.md", "useCart.ts"])
      press(panel, "crow")
      expect(fileRows(panel)).toEqual(everyFile)
      await nextFrame()
      panel.view.unmount()
    })

    it("keeps or releases the whole squad from its lead, and one member from the member", async () => {
      const panel = await mountTeam()

      // Nothing marks a lead, so its hint names the squad.
      expect(chip(panel, "moth").getAttribute("title")).toBe("Show only @moth's squad's work")
      expect(chip(panel, "crow").getAttribute("title")).toBe("Show only @crow's work")
      press(panel, "moth")
      expect(chip(panel, "moth").getAttribute("title")).toBe("Let @moth's squad go")
      expect(chip(panel, "wren").getAttribute("title")).toBe("Show @wren's work too")
      expect(pressed(panel)).toEqual(["@moth", "@crow"])
      expect(panel.view.container.querySelector(".files-squad")?.getAttribute("data-kept")).toBe(
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
      expect(fileRows(panel)).toEqual(["readme.md", "useCart.ts"])
      expect(dimmed(panel)).toEqual([])

      act(() => {
        chip(panel, "crow").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        )
      })

      expect(pressed(panel)).toEqual([])
      expect(fileRows(panel)).toEqual(everyFile)
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

    it("lets go of a kept agent that leaves the project, so every file shows again", async () => {
      const panel = await mountTeam()
      press(panel, "wren")
      expect(fileRows(panel)).toEqual(["package.json"])

      await panel.update(work())

      expect(pressed(panel)).toEqual([])
      expect(fileRows(panel)).toEqual([
        "readme.md",
        "Cart.tsx",
        "new.ts",
        "useCart.ts",
        "package.json",
      ])
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
        Array.from(panel.row("useCart.ts").querySelectorAll(".files-chip")).map(
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

    it("still reads again the open folders that the kept agents' work leaves out", async () => {
      const reads = backend()
      const panel = await mount(team(), undefined, agents, reads)
      press(panel, "wren")
      expect(panel.rows()).toEqual(["package.json"])
      reads.folders.length = 0

      await panel.endTurn()

      expect(reads.folders.toSorted()).toEqual(["", "docs", "src", "src/cart"])
      await nextFrame()
      panel.view.unmount()
    })

    it("steps the keyboard over the rows the kept agents' work leaves out", async () => {
      const panel = await mountTeam()
      press(panel, "crow")
      const focused = (): string | null | undefined =>
        document.activeElement?.querySelector(".files-name")?.textContent
      const key = (name: string): void =>
        act(() => {
          document.activeElement!.dispatchEvent(
            new KeyboardEvent("keydown", { key: name, bubbles: true }),
          )
        })
      act(() => panel.row("readme.md").querySelector<HTMLElement>("[role=treeitem]")!.focus())

      key("ArrowDown")
      expect(focused()).toBe("src")
      key("End")
      expect(focused()).toBe("useCart.ts")
      key("ArrowUp")
      expect(focused()).toBe("cart")
      await nextFrame()
      panel.view.unmount()
    })

    it("dims, among the kept agents' work, what a chip pointed at did not touch", async () => {
      const panel = await mountTeam()
      press(panel, "wren")
      press(panel, "crow")

      hover(chip(panel, "wren"), "pointerover")
      expect(fileRows(panel)).toEqual(["readme.md", "useCart.ts", "package.json"])
      expect(dimmed(panel)).toEqual(["readme.md", "useCart.ts"])
      expect(
        panel.view.container.querySelector("[role=tree]")?.getAttribute("aria-description"),
      ).toBe(
        "Only the work of @wren and @crow is shown. Of that, the work of @wren is lit; the rest is dimmed.",
      )
      hover(chip(panel, "wren"), "pointerout")

      expect(dimmed(panel)).toEqual([])
      await nextFrame()
      panel.view.unmount()
    })

    it("puts the kept agents first on a row's chips", async () => {
      const panel = await mountTeam()
      const shown = (): string[] =>
        Array.from(panel.row("useCart.ts").querySelectorAll(".files-chip")).map(
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
      const before = panel.row("new.ts").querySelector(".files-trail")
      await panel.show(false)
      await panel.show(true)

      expect(panel.row("new.ts").querySelector(".files-trail")).not.toBe(before)
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
        Array.from(panel.row("useCart.ts").querySelectorAll(".files-chip")).map(
          (chip) => chip.textContent ?? "",
        )
      const before = names()
      const second = panel.row("useCart.ts").querySelectorAll(".files-chip")[1]!
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
      const second = panel.row("useCart.ts").querySelectorAll(".files-chip")[1]!
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

      expect(row.querySelector(".files-chip[tabindex]")).toBeNull()
      expect(row.querySelector("[role=treeitem]")?.getAttribute("aria-label")).toBe(
        "useCart.ts, modified, @moth @crow @wren",
      )
      expect(row.querySelector(".files-chips")?.getAttribute("aria-hidden")).toBe("true")
      expect(row.querySelector(".files-more")?.getAttribute("title")).toContain("@wren")
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
        createElement(FilesPanel, {
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
      expect(panel.view.container.querySelector(".files-strip")).toBeNull()
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
      const slow: ((listing: FolderListing) => void)[] = []
      let reading = 0
      const reads = backend((folder, listing) => {
        if (folder !== "docs") return listing
        reading += 1
        if (reading > 1)
          return { ...listing, entries: [{ name: "newer.md", folder: false, ignored: false }] }
        return new Promise<FolderListing>((resolve) => slow.push(resolve))
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

    it("opens it on a click, and once on a double click's two", async () => {
      const opened: string[] = []
      const panel = await mount(undefined, undefined, undefined, backend(), (path) => {
        opened.push(path)
        return Promise.resolve()
      })
      await panel.click("package.json")
      expect(opened).toEqual(["package.json"])
      expect(panel.row("package.json").getAttribute("data-selected")).toBe("true")

      // A double click's second click comes with a count of two.
      act(() =>
        panel
          .row("package.json")
          .querySelector<HTMLElement>("[role=treeitem]")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })),
      )

      expect(opened).toEqual(["package.json"])
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
      document.activeElement?.closest(".files-row")?.querySelector(".files-name")?.textContent ??
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
          createElement(FilesPanel, {
            project: undefined,
            list: () => new Promise<FolderListing>(() => {}),
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
        folder === "docs" && hang ? new Promise<FolderListing>(() => {}) : listing,
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
    const crowded = (touched: Record<string, number>): FilesProject => ({
      changes: { [deep]: { kind: "modified", touched }, "short.ts": { kind: "modified", touched } },
      writing: {},
    })
    const shown = (panel: Awaited<ReturnType<typeof mount>>, name: string): string[] =>
      Array.from(panel.row(name).querySelectorAll(".files-chip")).map((el) => el.textContent ?? "")
    const more = (panel: Awaited<ReturnType<typeof mount>>, name: string): string | undefined =>
      panel.row(name).querySelector(".files-more")?.textContent ?? undefined

    it("folds a long deep name to one chip and a count when the tree is narrow", async () => {
      treeWidth = 260
      const panel = await mount(crowded({ moth: recent, crow: recent - 1000, wren: recent - 2000 }))

      expect(shown(panel, "CheckoutSummaryPanel.tsx")).toEqual(["@moth"])
      expect(more(panel, "CheckoutSummaryPanel.tsx")).toBe("+2")
      expect(
        panel.row("CheckoutSummaryPanel.tsx").querySelector<HTMLElement>(".files-more")?.title,
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
        element.classList.contains("files-name")
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
        panel.row("short.ts").querySelector<HTMLElement>(".files-trail")!
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
          element.classList.contains("files-name")
            ? ({
                fontStyle: "normal",
                fontWeight: "400",
                fontSize: "13px",
                fontFamily: "Narrow Name",
                font: "",
              } as CSSStyleDeclaration)
            : element.classList.contains("handle-chip") || element.classList.contains("files-more")
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
      const second = panel.row("CheckoutSummaryPanel.tsx").querySelectorAll(".files-chip")[1]!
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

  context("when repositories stand against their origins' main", () => {
    const landing = (parts: Partial<SyncLanding> = {}): SyncLanding => ({
      from: "a1",
      to: "b2",
      at: Date.now() - 120_000,
      commits: 3,
      merges: [
        {
          subject: "Add the cart",
          pr: 12,
          commit: "c1c1c1c1",
          own: true,
          by: "fable",
          latest: true,
        },
        { subject: "Fix prices", pr: null, commit: "d2d2d2d2", own: false, latest: true },
      ],
      files: ["packages/api/src/index.ts"],
      filesTotal: 14,
      dependencies: {
        file: "packages/api/pnpm-lock.yaml",
        command: "pnpm install",
        dir: "/work/packages/api",
      },
      dependenciesLatest: true,
      ...parts,
    })
    const repo = (parts: Partial<RepoSync> = {}): RepoSync => ({
      path: "packages/api",
      name: "api",
      branch: "main",
      behind: null,
      ahead: 0,
      landing: null,
      moved: 0,
      head: "h1",
      ...parts,
    })
    const behind = {
      remote: "origin/main",
      count: 2,
      why: "You have edits in src/a.ts",
      command: "git merge --ff-only origin/main",
      merges: [{ subject: "Waiting merge", pr: 7, commit: "e3e3e3e3", own: false, latest: true }],
    }
    // A backend that tells `current`, and records what was asked of it.
    const stand = (first: readonly RepoSync[]) => {
      let current = first
      const asked: string[] = []
      const update = vi.fn<NonNullable<ProjectFiles["update"]>>(async () => ({ ok: true }))
      const feed = createSyncFeed(
        {
          sync: async () => ({ repos: current }),
          seen: async (_project, path, to) => {
            asked.push(`seen ${path} ${to}`)
            current = current.map((each) =>
              each.path === path ? { ...each, landing: null } : each,
            )
          },
          update,
        },
        "p",
      )!
      return { feed, asked, update, set: (next: readonly RepoSync[]) => (current = next) }
    }
    const tree = ["packages/api/src/index.ts", "packages/web/index.ts", "README.md"]
    const mountWith = (feed: SyncFeed, entries: readonly string[] = tree) =>
      mount(
        undefined,
        undefined,
        undefined,
        backend(undefined, entries),
        undefined,
        undefined,
        feed,
      )
    const marks = (panel: Awaited<ReturnType<typeof mountWith>>, name: string): string[] =>
      Array.from(panel.row(name).querySelectorAll(".files-mark")).map((el) => el.textContent ?? "")

    it("marks a repository's folder with what landed, what is behind and what is ahead", async () => {
      const held = stand([
        repo({ landing: landing(), behind, ahead: 1 }),
        repo({ path: "packages/web", name: "web", ahead: 2 }),
      ])
      const panel = await mountWith(held.feed)
      await panel.click("packages")
      expect(marks(panel, "api")).toEqual(["2 new", "↓2", "↑1"])
      expect(marks(panel, "web")).toEqual(["↑2"])
      expect(panel.row("api").querySelector("[data-kind=new]")?.getAttribute("aria-label")).toBe(
        "2 merges from origin",
      )
      expect(panel.row("api").querySelector("[data-kind=behind]")?.getAttribute("aria-label")).toBe(
        "2 behind origin: you have edits in src/a.ts",
      )
      expect(panel.row("web").querySelector(".files-mark")?.getAttribute("aria-hidden")).toBe(
        "true",
      )
      await nextFrame()
      panel.view.unmount()
    })

    it("shows nothing for repositories that are up to date", async () => {
      const panel = await mountWith(stand([repo()]).feed)
      expect(
        panel.view.container.querySelector(".files-mark, .files-dot, .files-sync-line"),
      ).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("puts a dot on a closed folder that hides news, and not on an open one or for what is ahead", async () => {
      const held = stand([repo({ landing: landing() })])
      const panel = await mountWith(held.feed)
      expect(panel.row("packages").querySelector(".files-dot")).not.toBeNull()
      await panel.click("packages")
      expect(panel.row("packages").querySelector(".files-dot")).toBeNull()
      act(() => held.set([repo({ ahead: 3 })]))
      held.feed.refresh()
      await panel.settle()
      await panel.click("packages")
      expect(panel.row("packages").querySelector(".files-dot")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    // Terminals the card can open, record what it asked of them and tell what `state.progress` says.
    const terminalsFor = () => {
      const state: { progress: TerminalProgress } = { progress: { phase: "running", ms: 0 } }
      const listeners = new Set<() => void>()
      const terminals: SyncTerminals = {
        run: vi.fn<SyncTerminals["run"]>(() => "t1"),
        show: vi.fn<SyncTerminals["show"]>(),
        follow: () => ({
          subscribe: (listener) => {
            listeners.add(listener)
            return () => void listeners.delete(listener)
          },
          get: () => state.progress,
        }),
      }
      const tell = (progress: TerminalProgress): void => {
        state.progress = progress
        act(() => listeners.forEach((listener) => listener()))
      }
      return { terminals, tell }
    }
    const mountWithTerminals = (
      feed: SyncFeed,
      terminals: SyncTerminals,
      entries: readonly string[] = tree,
    ) =>
      mount(
        undefined,
        undefined,
        undefined,
        backend(undefined, entries),
        undefined,
        undefined,
        feed,
        terminals,
      )
    const openMark = async (
      panel: Awaited<ReturnType<typeof mountWith>>,
      kind: "new" | "behind",
    ): Promise<Element> => {
      if (!panel.row("api")) await panel.click("packages")
      act(() => panel.row("api").querySelector<HTMLElement>(`[data-kind=${kind}]`)!.click())
      await panel.settle()
      return document.querySelector(".files-card")!
    }
    const button = (card: Element, label: string): HTMLButtonElement =>
      card.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    const closeCard = async (panel: Awaited<ReturnType<typeof mountWith>>): Promise<void> => {
      act(() => {
        document
          .querySelector(".files-card")!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      await panel.settle()
      await vi.waitFor(() => expect(document.querySelector(".files-card")).toBeNull())
    }

    it("opens what landed as a terminal's readout, which marks it seen once it closes, and pulses the files that came in", async () => {
      const held = stand([
        repo({
          landing: landing(),
          pullUrl: "https://github.com/o/api/pull/{number}",
        }),
      ])
      const panel = await mountWith(held.feed, [...tree, "packages/api/pnpm-lock.yaml"])
      const card = await openMark(panel, "new")
      expect(card.querySelector(".files-readout-head")?.textContent).toContain("api")
      expect(card.querySelector(".files-route")?.textContent).toBe("main ‹ origin")
      const merges = Array.from(card.querySelectorAll(".files-merge")).map((el) => el.textContent)
      // The short commit, dimmed, the number and the subject; a merge with no pull request still shows.
      expect(merges).toEqual(["c1c1c1c#12Add the cart@fable", "d2d2d2dFix prices"])
      expect(card.querySelector(".files-pr")?.textContent).toBe("#12")
      expect(card.querySelector(".files-comment")?.textContent).toBe("# pnpm-lock.yaml changed")
      expect(card.querySelector(".files-command .files-t")?.textContent).toBe("pnpm install")
      expect(card.querySelector(".files-readout-foot")?.textContent).toBe(
        "2 merges · 2 min ago · changed files pulse in the tree",
      )
      // Open, the mark stays (pressed) and nothing is seen yet; the files pulse.
      expect(held.asked).toEqual([])
      expect(marks(panel, "api")).toEqual(["2 new"])
      expect(panel.row("api").querySelector("[data-kind=new]")?.getAttribute("data-open")).toBe(
        "true",
      )
      expect(panel.view.container.querySelector("[data-pulse]")).not.toBeNull()
      // Closing it is seeing it: the mark goes.
      await closeCard(panel)
      expect(held.asked).toEqual(["seen packages/api b2"])
      expect(marks(panel, "api")).toEqual([])
      await nextFrame()
      panel.view.unmount()
    })

    it("pulses no file for a landing that moved the branch alone, whose checkout's files didn't change", async () => {
      const held = stand([repo({ landing: landing({ ref: true }) })])
      const panel = await mountWith(held.feed, [...tree, "packages/api/pnpm-lock.yaml"])
      const card = await openMark(panel, "new")
      expect(panel.view.container.querySelector("[data-pulse]")).toBeNull()
      expect(card.querySelector(".files-readout-foot")?.textContent).toContain("your files didn't")
      await nextFrame()
      panel.view.unmount()
    })

    it("lists five merges, then how many more there are, which open in place", async () => {
      const many = Array.from({ length: 9 }, (_, at) => ({
        subject: `Merge ${at}`,
        pr: 100 + at,
        commit: `${at}abcdef0`,
        own: false,
        latest: true,
      }))
      const held = stand([repo({ landing: landing({ merges: many, dependencies: null }) })])
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "new")
      expect(card.querySelectorAll(".files-merge")).toHaveLength(5)
      const more = card.querySelector<HTMLButtonElement>(".files-more-button")!
      expect(more.textContent).toBe("# 4 more merges")
      act(() => more.click())
      expect(card.querySelectorAll(".files-merge")).toHaveLength(9)
      expect(card.querySelector(".files-more-button")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("opens a merge's pull request on the forge when clicked, and has no link where none is known", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null)
      const held = stand([
        repo({ landing: landing(), pullUrl: "https://github.com/o/api/pull/{number}" }),
      ])
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "new")
      act(() => button(card, "#12 Add the cart, open the pull request").click())
      expect(open).toHaveBeenCalledWith(
        "https://github.com/o/api/pull/12",
        "_blank",
        "noopener,noreferrer",
      )
      // A merge with no number has nothing to open.
      expect(card.querySelectorAll(".files-merge button")).toHaveLength(1)
      await closeCard(panel)
      act(() => held.set([repo({ landing: landing({ to: "c3" }), pullUrl: null })]))
      held.feed.refresh()
      await panel.settle()
      const again = await openMark(panel, "new")
      expect(again.querySelectorAll(".files-merge button")).toHaveLength(0)
      open.mockRestore()
      await nextFrame()
      panel.view.unmount()
    })

    it("puts Copy and Run on every command, and no Update or Retry anywhere in the card", async () => {
      const held = stand([repo({ landing: landing(), behind })])
      const panel = await mountWith(held.feed)
      for (const kind of ["new", "behind"] as const) {
        // eslint-disable-next-line no-await-in-loop -- One card after the other.
        const card = await openMark(panel, kind)
        const commands = card.querySelectorAll(".files-command")
        expect(commands.length).toBeGreaterThan(0)
        for (const line of commands) {
          const command = line.querySelector(".files-t")!.textContent
          expect(line.querySelector(`button[aria-label="Copy ${command}"]`)).not.toBeNull()
          expect(line.querySelector(`button[aria-label="Run ${command}"]`)).not.toBeNull()
        }
        expect(card.textContent).not.toMatch(/update|retry/i)
        // eslint-disable-next-line no-await-in-loop -- One card after the other.
        await closeCard(panel)
      }
      await nextFrame()
      panel.view.unmount()
    })

    it("copies the command it shows", async () => {
      const written: string[] = []
      const clipboard = {
        writeText: vi.fn<(text: string) => Promise<void>>(
          async (text: string) => void written.push(text),
        ),
      }
      vi.stubGlobal("navigator", { ...navigator, clipboard })
      const held = stand([repo({ landing: landing() })])
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "new")
      act(() => button(card, "Copy pnpm install").click())
      expect(written).toEqual(["pnpm install"])
      vi.unstubAllGlobals()
      await nextFrame()
      panel.view.unmount()
    })

    it("opens what is behind with its reason, the waiting merges and the command that moves main", async () => {
      const off = {
        ...behind,
        why: "Keeping main current is off.",
        command: "git fetch . origin/main:main",
        local: "4f0e2aa9",
      }
      const held = stand([repo({ behind: off })])
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "behind")
      expect(card.querySelector(".files-route")?.textContent).toBe("main · 2 behind origin")
      expect(card.querySelector(".files-merge")?.textContent).toBe("e3e3e3e#7Waiting merge")
      expect(card.querySelector(".files-comment")?.textContent).toBe(
        "# left as it is: keeping main current is off",
      )
      expect(card.querySelector(".files-command .files-t")?.textContent).toBe(
        "git fetch . origin/main:main",
      )
      // Nothing runs until Run is pressed.
      expect(held.update).not.toHaveBeenCalled()
      await nextFrame()
      panel.view.unmount()
    })

    it("shows the facts alone, with no command to run, where the runner names none (a runner before it did)", async () => {
      const { command: _none, ...bare } = behind
      const held = stand([repo({ behind: bare })])
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "behind")
      expect(card.querySelector(".files-merge")).not.toBeNull()
      expect(card.querySelector(".files-comment")?.textContent).toContain("left as it is")
      expect(card.querySelector(".files-command")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("runs the git command in place, and shows the move done with a check and nothing more", async () => {
      const held = stand([repo({ behind })])
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "behind")
      act(() => button(card, "Run git merge --ff-only origin/main").click())
      await panel.settle()
      expect(held.update).toHaveBeenCalledWith("p", "packages/api")
      const done = document.querySelector(".files-card")!
      expect(done.querySelector(".files-readout-head [data-phase=done]")).not.toBeNull()
      expect(done.querySelector(".files-route")?.textContent).toBe("main ‹ origin")
      const last = done.querySelector(".files-command")!
      expect(last.querySelector("[data-phase=done]")).not.toBeNull()
      expect(last.querySelector("button")).toBeNull()
      expect(done.querySelector(".files-err")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("prints git's own refusal in red, says where main stays, and keeps Run on the line to run it again", async () => {
      const held = stand([repo({ behind: { ...behind, local: "4f0e2aa9" } })])
      held.update.mockResolvedValueOnce({
        ok: false,
        said: "Your changes to functions/api.ts would be overwritten.",
        git: [
          "error: Your local changes to the following",
          "files would be overwritten by merge:",
          "    functions/api.ts",
        ],
      })
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "behind")
      act(() => button(card, "Run git merge --ff-only origin/main").click())
      await panel.settle()
      const refused = document.querySelector(".files-card")!
      expect(
        Array.from(refused.querySelectorAll(".files-err")).map((el) => el.textContent),
      ).toEqual([
        "error: Your local changes to the following",
        "files would be overwritten by merge:",
        "    functions/api.ts",
      ])
      expect(refused.querySelector(".files-readout-head [data-failed]")).not.toBeNull()
      expect(refused.querySelector(".files-comment")?.textContent).toBe(
        "# main stays at 4f0e2aa, your files as they are",
      )
      expect(refused.querySelector(".files-readout-foot")?.textContent).toContain(
        "Commit or set aside the edit",
      )
      expect(button(refused, "Run git merge --ff-only origin/main")).not.toBeNull()
      expect(refused.textContent).not.toMatch(/retry|update/i)
      await nextFrame()
      panel.view.unmount()
    })

    it("says Novadeck's own words as a comment, not as git's red output", async () => {
      const held = stand([repo({ behind })])
      held.update.mockResolvedValueOnce({ ok: false, said: "A rebase is in progress." })
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "behind")
      act(() => button(card, "Run git merge --ff-only origin/main").click())
      await panel.settle()
      const refused = document.querySelector(".files-card")!
      expect(refused.querySelector(".files-err")).toBeNull()
      expect(
        Array.from(refused.querySelectorAll(".files-comment")).map((el) => el.textContent),
      ).toContain("# a rebase is in progress")
      await nextFrame()
      panel.view.unmount()
    })

    it("says how many more lines git printed than it shows", async () => {
      const held = stand([repo({ behind })])
      held.update.mockResolvedValueOnce({
        ok: false,
        said: "x",
        git: ["error: a", "    f"],
        more: 3,
      })
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "behind")
      act(() => button(card, "Run git merge --ff-only origin/main").click())
      await panel.settle()
      expect(
        Array.from(document.querySelectorAll(".files-card .files-comment")).map(
          (el) => el.textContent,
        ),
      ).toContain("# … 3 more lines")
      await nextFrame()
      panel.view.unmount()
    })

    it("puts no check on a run where nothing moved, or what moved wasn't the command run", async () => {
      const held = stand([repo({ behind })])
      held.update.mockResolvedValueOnce({ ok: true, moved: false })
      const panel = await mountWith(held.feed)
      let card = await openMark(panel, "behind")
      act(() => button(card, "Run git merge --ff-only origin/main").click())
      await panel.settle()
      card = document.querySelector(".files-card")!
      expect(card.querySelector(".files-command [data-phase=done]")).toBeNull()
      expect(button(card, "Run git merge --ff-only origin/main")).not.toBeNull()
      // A ref move ran where the merge was shown: the branch changed since the card was drawn.
      held.update.mockResolvedValueOnce({ ok: true, moved: true, ref: true })
      act(() => button(card, "Run git merge --ff-only origin/main").click())
      await panel.settle()
      card = document.querySelector(".files-card")!
      expect(card.querySelector(".files-command [data-phase=done]")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("keeps a run for each repository, and drops a refusal once its repository stands otherwise", async () => {
      const web = { ...behind, command: "git fetch . origin/main:main" }
      const held = stand([
        repo({ behind }),
        repo({ path: "packages/web", name: "web", behind: web }),
      ])
      let release: (() => void) | undefined
      held.update.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve({ ok: true, moved: true }))),
      )
      held.update.mockResolvedValueOnce({ ok: false, said: "Nope." })
      const panel = await mountWith(held.feed)
      let card = await openMark(panel, "behind")
      act(() => button(card, "Run git merge --ff-only origin/main").click())
      await closeCard(panel)
      // The first is still running when the other is run.
      if (!panel.row("web")) await panel.click("packages")
      act(() => panel.row("web").querySelector<HTMLElement>("[data-kind=behind]")!.click())
      await panel.settle()
      card = document.querySelector(".files-card")!
      act(() => button(card, "Run git fetch . origin/main:main").click())
      await panel.settle()
      expect(held.update).toHaveBeenCalledTimes(2)
      expect(held.update).toHaveBeenLastCalledWith("p", "packages/web")
      expect(document.querySelector(".files-card .files-comment")?.textContent).toContain("nope")
      // Its repository stands otherwise (it is further behind): the refusal is no longer of it.
      act(() =>
        held.set([
          repo({ behind }),
          repo({ path: "packages/web", name: "web", behind: { ...web, count: 5 } }),
        ]),
      )
      held.feed.refresh()
      await panel.settle()
      expect(document.querySelector(".files-card .files-comment")?.textContent).not.toContain(
        "nope",
      )
      release?.()
      await nextFrame()
      panel.view.unmount()
    })

    it("runs the dependency command in a terminal of its own, in the repository, and follows it there", async () => {
      const held = stand([repo({ landing: landing() })])
      const { terminals, tell } = terminalsFor()
      const panel = await mountWithTerminals(held.feed, terminals)
      const card = await openMark(panel, "new")
      expect(terminals.run).not.toHaveBeenCalled()
      act(() => button(card, "Run pnpm install").click())
      expect(terminals.run).toHaveBeenCalledWith({
        directory: "/work/packages/api",
        command: "pnpm install",
      })
      // Under way: the spinner and "in a terminal", where it runs, and Show it.
      tell({ phase: "running" })
      const running = document.querySelector(".files-card")!
      expect(running.querySelector(".files-command [data-phase=running]")).not.toBeNull()
      expect(running.querySelector(".files-command .files-dim")?.textContent).toBe("in a terminal")
      expect(running.querySelector(".files-command button")).toBeNull()
      expect(running.querySelector(".files-readout-foot")?.textContent).toBe(
        "Runs in its own terminal, in packages/apiShow it",
      )
      expect(running.querySelector("[role=status]")?.textContent).toBe(
        "Running pnpm install in a terminal",
      )
      act(() => running.querySelector<HTMLButtonElement>(".files-show")!.click())
      expect(terminals.show).toHaveBeenCalledWith("t1")
      // The terminal is forward, so the card gives way; its install is running, so it isn't seen.
      await panel.settle()
      await vi.waitFor(() => expect(document.querySelector(".files-card")).toBeNull())
      expect(held.asked).toEqual([])
      const again = await openMark(panel, "new")
      expect(again.querySelector(".files-command .files-dim")?.textContent).toBe("in a terminal")
      // Over, with no word of whether it worked: a muted mark and how long it took, never a check.
      tell({ phase: "finished", ms: 12_000 })
      const done = document.querySelector(".files-card")!
      expect(done.querySelector(".files-command [data-phase=unheard]")).not.toBeNull()
      expect(done.querySelector(".files-command [data-phase=done]")).toBeNull()
      expect(done.querySelector(".files-command .files-dim")?.textContent).toBe("finished · 12 s")
      expect(done.querySelector(".files-command .sr-only")?.textContent).toBe("Finished")
      expect(done.querySelector("[role=status]")?.textContent).toBe("pnpm install finished")
      expect(done.querySelector(".files-readout-foot")?.textContent).toContain("2 merges")
      // Failed: a cross and the time, with the command offered again.
      tell({ phase: "failed", ms: 3000 })
      const failed = document.querySelector(".files-card")!
      expect(failed.querySelector(".files-command [data-failed]")).not.toBeNull()
      expect(failed.querySelector(".files-command .sr-only")?.textContent).toBe("Failed")
      expect(button(failed, "Run pnpm install")).not.toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("says a nested lockfile by its path from the repository and runs its command in the lockfile's own folder", async () => {
      const held = stand([
        repo({
          landing: landing({
            dependencies: {
              file: "packages/api/web/pnpm-lock.yaml",
              command: "pnpm install",
              dir: "/work/packages/api/web",
            },
          }),
        }),
      ])
      const { terminals } = terminalsFor()
      const panel = await mountWithTerminals(held.feed, terminals)
      const card = await openMark(panel, "new")
      expect(card.querySelector(".files-comment")?.textContent).toBe("# web/pnpm-lock.yaml changed")
      act(() => button(card, "Run pnpm install").click())
      expect(terminals.run).toHaveBeenCalledWith({
        directory: "/work/packages/api/web",
        command: "pnpm install",
      })
      await nextFrame()
      panel.view.unmount()
    })

    it("only says the command, with nothing to run it in, where the runner names no folder for it", async () => {
      const held = stand([
        repo({
          landing: landing({
            dependencies: { file: "packages/api/pnpm-lock.yaml", command: "pnpm install" },
          }),
        }),
      ])
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "new")
      expect(card.querySelector(".files-comment")?.textContent).toBe(
        "# pnpm-lock.yaml changed: pnpm install",
      )
      expect(card.querySelector(".files-command")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("starts each repository's card with its merges folded, whatever another opened", async () => {
      const many = Array.from({ length: 8 }, (_, at) => ({
        subject: `Merge ${at}`,
        pr: 100 + at,
        commit: `${at}abcdef0`,
        own: false,
        latest: true,
      }))
      const held = stand([
        repo({ landing: landing({ merges: many, dependencies: null }) }),
        repo({
          path: "packages/web",
          name: "web",
          landing: landing({ to: "c3", merges: many, dependencies: null }),
        }),
      ])
      const panel = await mountWith(held.feed)
      let card = await openMark(panel, "new")
      act(() => card.querySelector<HTMLButtonElement>(".files-more-button")!.click())
      expect(card.querySelectorAll(".files-merge")).toHaveLength(8)
      // Another repository's mark, with the card still open: its merges are folded.
      act(() => panel.row("web").querySelector<HTMLElement>("[data-kind=new]")!.click())
      await panel.settle()
      card = document.querySelector(".files-card")!
      expect(card.querySelectorAll(".files-merge")).toHaveLength(5)
      await nextFrame()
      panel.view.unmount()
    })

    it("keeps focus on the command's line, not the page, once Run is pressed and gives way", async () => {
      const held = stand([repo({ landing: landing(), behind })])
      const { terminals } = terminalsFor()
      const panel = await mountWithTerminals(held.feed, terminals)
      const card = await openMark(panel, "new")
      act(() => button(card, "Run pnpm install").focus())
      act(() => button(card, "Run pnpm install").click())
      expect(document.activeElement?.classList.contains("files-command")).toBe(true)
      await closeCard(panel)
      const behindCard = await openMark(panel, "behind")
      act(() => button(behindCard, "Run git merge --ff-only origin/main").click())
      await panel.settle()
      // The card is the move done, and focus is on its line.
      expect(document.activeElement?.classList.contains("files-command")).toBe(true)
      await nextFrame()
      panel.view.unmount()
    })

    it("offers no terminal run where the app has none", async () => {
      const held = stand([repo({ landing: landing() })])
      const panel = await mountWith(held.feed)
      const card = await openMark(panel, "new")
      expect(() => act(() => button(card, "Run pnpm install").click())).not.toThrow()
      expect(card.querySelector(".files-show")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("says what a single-repository project's own repository holds on a line over the tree, with the mark alone to open the card", async () => {
      const held = stand([repo({ path: "", name: "storefront", landing: landing() })])
      const panel = await mountWith(held.feed)
      const line = panel.view.container.querySelector(".files-sync-line")!
      expect(line.textContent).toContain("main")
      expect(line.textContent).toContain("just caught up")
      expect(line.textContent).toContain("2 new")
      expect(line.querySelector("button:not(.files-mark)")).toBeNull()
      act(() => held.set([repo({ path: "", name: "storefront", behind })]))
      held.feed.refresh()
      await panel.settle()
      const behindLine = panel.view.container.querySelector(".files-sync-line")!
      expect(behindLine.textContent).toContain("is behind")
      expect(behindLine.textContent).toContain("↓2")
      expect(behindLine.textContent).not.toMatch(/update|retry|can't/i)
      act(() => behindLine.querySelector<HTMLElement>("[data-kind=behind]")!.click())
      await panel.settle()
      act(() =>
        button(
          document.querySelector(".files-card")!,
          "Run git merge --ff-only origin/main",
        ).click(),
      )
      await panel.settle()
      expect(held.update).toHaveBeenCalledWith("p", "")
      await nextFrame()
      panel.view.unmount()
    })

    it("keeps a mark on the line in the tab order and a mark in a row out of it and out of what is read", async () => {
      const held = stand([
        repo({ path: "", name: "storefront", landing: landing() }),
        repo({ path: "packages/web", name: "web", landing: landing({ to: "c3" }) }),
      ])
      const panel = await mountWith(held.feed)
      const onLine = panel.view.container.querySelector<HTMLElement>(
        ".files-sync-line .files-mark",
      )!
      expect(onLine.getAttribute("tabindex")).toBe("0")
      expect(onLine.getAttribute("aria-hidden")).toBeNull()
      await panel.click("packages")
      const inRow = panel.row("web").querySelector<HTMLElement>(".files-mark")!
      expect(inRow.getAttribute("tabindex")).toBe("-1")
      expect(inRow.getAttribute("aria-hidden")).toBe("true")
      await nextFrame()
      panel.view.unmount()
    })

    it("has no line for a repository that is only ahead", async () => {
      const panel = await mountWith(stand([repo({ path: "", name: "storefront", ahead: 2 })]).feed)
      expect(panel.view.container.querySelector(".files-sync-line")).toBeNull()
      await nextFrame()
      panel.view.unmount()
    })

    it("reads the folders again when the backend moved a checkout, or the commit it is at changed", async () => {
      vi.useFakeTimers()
      const held = stand([repo({ path: "", name: "storefront" })])
      const panel = await mountWith(held.feed)
      const before = panel.reads.folders.length
      held.set([repo({ path: "", name: "storefront", moved: 1 })])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(syncPollMs)
      })
      await panel.settle()
      expect(panel.reads.folders.length).toBeGreaterThan(before)
      const moved = panel.reads.folders.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(syncPollMs * 2)
      })
      expect(panel.reads.folders.length).toBe(moved)
      held.set([repo({ path: "", name: "storefront", moved: 1, head: "h2" })])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(syncPollMs)
      })
      await panel.settle()
      expect(panel.reads.folders.length).toBeGreaterThan(moved)
      panel.view.unmount()
    })

    it("asks again only once the last answer is in", async () => {
      vi.useFakeTimers()
      let asked = 0
      const feed = createSyncFeed(
        {
          sync: () => {
            asked += 1
            return new Promise(() => {})
          },
        },
        "p",
      )!
      const panel = await mountWith(feed)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(syncPollMs * 3)
      })
      expect(asked).toBe(1)
      panel.view.unmount()
    })
  })

  context("when the tree is long", () => {
    // 300 files at the root: 26px each, so a 260px view holds ten of them.
    const many = Array.from({ length: 300 }, (_, at) => `f${String(at).padStart(3, "0")}.ts`)
    const long = async (height: number) => {
      treeHeight = height
      const panel = await mount(undefined, undefined, undefined, backend(undefined, many))
      const tree = panel.view.container.querySelector<HTMLElement>("[role=tree]")!
      const scrollTo = (top: number): void => {
        act(() => {
          tree.scrollTop = top
          tree.dispatchEvent(new Event("scroll"))
        })
      }
      const press = (path: string, key: string): void => {
        const button = panel.view.container.querySelector<HTMLElement>(`[data-path="${path}"]`)!
        act(() => {
          button.focus()
          button.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          )
        })
      }
      return { panel, tree, scrollTo, press }
    }

    it("draws only the rows in view and a few past each edge, in a box as tall as the tree", async () => {
      const { panel, tree } = await long(260)

      expect(panel.rows()).toHaveLength(20)
      expect(panel.rows()[0]).toBe("f000.ts")
      expect(tree.querySelector<HTMLElement>(".files-rows")!.style.height).toBe(`${300 * 26}px`)
      panel.view.unmount()
    })

    it("draws other rows as the tree scrolls", async () => {
      const { panel, scrollTo } = await long(260)

      scrollTo(26 * 150)

      // Thirty in and around the view, and the first row, which holds the Tab stop.
      expect(panel.rows()).toHaveLength(31)
      expect(panel.rows()).toContain("f150.ts")
      expect(panel.rows()).not.toContain("f139.ts")
      expect(panel.row("f150.ts").parentElement!.style.top).toBe(`${150 * 26}px`)
      panel.view.unmount()
    })

    it("tells a screen reader the tree's shape despite the rows it does not draw", async () => {
      const { panel, scrollTo } = await long(260)
      scrollTo(26 * 150)

      const item = panel.row("f150.ts").querySelector("[role=treeitem]")!
      expect(item.getAttribute("aria-posinset")).toBe("151")
      expect(item.getAttribute("aria-setsize")).toBe("300")
      expect(item.getAttribute("aria-level")).toBe("1")
      panel.view.unmount()
    })

    it("moves focus to a row that is not drawn, scrolling it into view first", async () => {
      const { panel, tree, press } = await long(260)

      press("f000.ts", "End")

      expect(document.activeElement?.getAttribute("data-path")).toBe("f299.ts")
      expect(tree.scrollTop).toBeGreaterThan(26 * 280)
      expect(panel.rows()).toContain("f299.ts")
      press("f299.ts", "Home")
      expect(document.activeElement?.getAttribute("data-path")).toBe("f000.ts")
      expect(tree.scrollTop).toBe(0)
      panel.view.unmount()
    })

    it("keeps the focused row drawn when it scrolls out of the view", async () => {
      const { panel, scrollTo } = await long(260)
      const first = panel.view.container.querySelector<HTMLElement>("[data-path='f000.ts']")!
      act(() => first.focus())

      scrollTo(26 * 150)

      expect(panel.rows()).toContain("f000.ts")
      expect(panel.view.container.querySelector("[data-path='f000.ts']")).toBe(first)
      expect(first.tabIndex).toBe(0)
      panel.view.unmount()
    })

    it("draws the last rows when the tree shrinks under a scroll, and keeps focus", async () => {
      const { panel, scrollTo } = await long(260)
      const last = panel.view.container.querySelector<HTMLElement>("[data-path='f000.ts']")!
      act(() => last.focus())
      scrollTo(26 * 250)
      // The browser clamps the scroll as the tree shrinks, but not before the next render.
      const reads = backend(undefined, many.slice(0, 40))
      panel.view.rerender(
        createElement(FilesPanel, {
          project: undefined,
          list: reads.list,
          turn: 1,
          onOpenFile: () => Promise.resolve(),
          selectedHandle: undefined,
          roster: [],
          squads: [],
          active: true,
          visible: true,
          onHide: () => {},
        }),
      )
      await panel.settle()

      expect(panel.rows().length).toBeGreaterThan(10)
      expect(panel.rows()).toContain("f039.ts")
      expect(panel.rows()).toContain("f000.ts")
      expect(document.activeElement).toBe(last)
      panel.view.unmount()
    })

    it("keeps the Tab stop below the view drawn, so Tab enters the tree there", async () => {
      const { panel, scrollTo, press } = await long(260)
      press("f000.ts", "End")
      scrollTo(0)

      const stop = panel.view.container.querySelector<HTMLElement>("[data-path='f299.ts']")!
      expect(stop.tabIndex).toBe(0)
      expect(panel.view.container.querySelectorAll("[role=treeitem][tabindex='0']")).toHaveLength(1)
      panel.view.unmount()
    })

    it("counts a note among its siblings", async () => {
      const panel = await mount(
        undefined,
        undefined,
        undefined,
        backend((folder, listing) => (folder === "" ? { ...listing, truncated: true } : listing)),
      )

      const note = panel.view.container.querySelector("[data-note=truncated]")!
      expect(note.getAttribute("aria-posinset")).toBe("4")
      expect(note.getAttribute("aria-setsize")).toBe("4")
      panel.view.unmount()
    })

    it("draws no rows while the panel has no height or is not measured", async () => {
      const { panel } = await long(0)

      expect(panel.rows()).toEqual([])
      resizeTree(0, 260)
      expect(panel.rows()).toHaveLength(20)
      resizeTree(0, 0)
      expect(panel.rows()).toEqual([])
      panel.view.unmount()
    })
  })
})

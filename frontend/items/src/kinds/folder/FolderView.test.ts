import type { Companions, FolderEntry, ItemContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { ItemCommandsContext } from "../../item-commands"
import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { folder as registration } from "./index"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

const entry = (name: string, extra: Partial<FolderEntry> = {}): FolderEntry => ({
  name,
  kind: "image",
  size: 2048,
  modifiedAt: 1_000,
  children: null,
  secret: false,
  link: false,
  stamp: `${name}-stamp`,
  ...extra,
})

const top = [
  entry("shot.png", { modifiedAt: 5_000 }),
  entry("clip.mp4", { kind: "video", modifiedAt: 4_000 }),
  entry("old-runs", { kind: "folder", size: 0, children: 3, modifiedAt: 1_000 }),
  entry(".env", { kind: "other", secret: true, stamp: "", modifiedAt: 3_000 }),
  entry("latest", { kind: "other", link: true, stamp: "", modifiedAt: 2_000 }),
]

const listing = (
  entries: readonly FolderEntry[],
  { path = "/tmp/render", within = "", total = entries.length, truncated = false } = {},
): ItemContent => ({
  state: "ready",
  stamp: JSON.stringify([within, entries]),
  content: { kind: "folder", path, within, entries, total, truncated },
})

// The folder item in a terminal's pane, over a runner that lists `listings` by the folder asked for.
const shown = async ({
  listings = { "": listing(top) },
  part = null,
  fromTerminal = "01",
}: {
  listings?: Record<string, ItemContent>
  part?: Companions["part"] | null
  fromTerminal?: string
} = {}) => {
  const item = itemFixture("render", fromTerminal, {
    kind: "folder",
    name: "render",
    path: "/tmp/render",
  })
  const followers = new Map<string, (content: ItemContent) => void>()
  const followed: string[] = []
  // Folders the runner is slow to answer.
  const quiet = new Set<string>()
  const attached: { terminalId: string; path: string }[] = []
  const closed: string[] = []
  const companions: Companions = {
    follow: (_target, _id, { within }, on) => {
      const folder = within ?? ""
      followed.push(folder)
      followers.set(folder, on)
      const content = listings[folder]
      if (content && !quiet.has(folder)) on(content)
      return () => followers.delete(folder)
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
    attach: async (_target, terminalId, path) => {
      attached.push({ terminalId, path })
      return item
    },
    ...(part ? { part } : {}),
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  const rendered = render(
    createElement(
      ItemCommandsContext,
      { value: { closeItem: (id) => closed.push(id) } },
      createElement(registration.View, { item, itemStore, target }),
    ),
  )
  unmounts.push(rendered.unmount)
  await settle()
  const root = rendered.container
  return {
    root,
    itemStore,
    attached,
    closed,
    followed,
    quiet,
    // The runner lists the folder again.
    list: async (content: ItemContent, folder = "") => {
      act(() => followers.get(folder)?.(content))
      await settle()
    },
    names: () =>
      [...root.querySelectorAll(".folder-name-text")].map((element) => element.textContent),
    tile: (name: string) =>
      [...root.querySelectorAll<HTMLElement>(".folder-tile, .folder-row")].find(
        (element) => element.querySelector(".folder-name-text")?.textContent === name,
      )!,
    open: async (name: string) => {
      const element = [...root.querySelectorAll<HTMLElement>(".folder-tile, .folder-row")].find(
        (each) => each.querySelector(".folder-name-text")?.textContent === name,
      )!
      act(() => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
      await settle()
    },
    click: async (element: Element) => {
      act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
      await settle()
    },
    pointer: async (inside: boolean) => {
      const scroll = root.querySelector(".folder-scroll")!
      act(() => {
        scroll.dispatchEvent(
          new MouseEvent(inside ? "pointerover" : "pointerout", { bubbles: true }),
        )
      })
      await settle()
    },
  }
}

const inFolder = {
  "": listing(top),
  "old-runs": listing([entry("run-1.png"), entry("notes", { kind: "folder", children: 0 })], {
    path: "/tmp/render/old-runs",
    within: "old-runs",
  }),
  "old-runs/notes": listing([], { path: "/tmp/render/old-runs/notes", within: "old-runs/notes" }),
}

describe("a folder in the pane", () => {
  context("as a grid", () => {
    it("lists what it holds newest first, its folder and its count on the first line", async () => {
      const app = await shown()
      expect(app.names()).toEqual(["shot.png", "clip.mp4", ".env", "latest", "old-runs"])
      expect(app.root.querySelector(".folder-count")?.textContent).toBe("5 items")
      expect(app.root.querySelector(".folder-tile[data-folder] .folder-meta")?.textContent).toBe(
        "3 items",
      )
    })

    it("names a secret and a link out, and marks them so they are never opened", async () => {
      const app = await shown()
      expect(app.tile(".env").hasAttribute("data-secret")).toBe(true)
      expect(app.tile(".env").getAttribute("title")).toContain("may hold secrets")
      expect(app.tile("latest").hasAttribute("data-link")).toBe(true)
      expect(app.tile("latest").getAttribute("title")).toContain("leads out of this folder")
    })

    it("sorts by the tool, and shows as a list by the other", async () => {
      const app = await shown()
      await app.click(app.root.querySelector('button[aria-label="Sort"]')!)
      expect(app.names()).toEqual(["old-runs", ".env", "clip.mp4", "latest", "shot.png"])
      await app.click(app.root.querySelector('button[aria-label="Show as a list"]')!)
      expect(app.root.querySelector("table.folder-list")).not.toBeNull()
      expect([...app.root.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
        "Name",
        "Modified",
        "Size",
        "Kind",
      ])
      expect(app.root.querySelector('button[aria-label="Show as a grid"]')).not.toBeNull()
    })
  })

  context("its crumbs", () => {
    it("start at the folder that was opened, the path above it muted, with Up off there", async () => {
      const app = await shown()
      expect(app.root.querySelector(".folder-above")?.textContent).toBe("/tmp/")
      expect(
        [...app.root.querySelectorAll(".folder-crumb")].map((each) => each.textContent),
      ).toEqual(["render"])
      const up = app.root.querySelector<HTMLElement>(".folder-up")!
      expect(up.getAttribute("aria-disabled")).toBe("true")
      await app.click(up)
      // Only the item's own follow, of its top.
      expect(app.followed).toEqual([""])
    })

    it("go into a folder in the same tab and back out, by Up or Backspace, never higher", async () => {
      const app = await shown({ listings: inFolder })
      await app.open("old-runs")
      expect(app.followed).toEqual(["", "old-runs"])
      expect(app.names()).toEqual(["notes", "run-1.png"])
      expect(
        [...app.root.querySelectorAll(".folder-crumb")].map((each) => each.textContent),
      ).toEqual(["render", "old-runs"])
      const up = app.root.querySelector<HTMLElement>(".folder-up")!
      expect(up.hasAttribute("aria-disabled")).toBe(false)
      await app.open("notes")
      expect(app.root.querySelector(".folder-empty")?.textContent).toContain("Nothing in notes yet")
      const viewer = app.root.querySelector<HTMLElement>(".folder-viewer")!
      act(() => {
        viewer.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }))
      })
      await settle()
      expect(app.names()).toEqual(["notes", "run-1.png"])
      await app.click(app.root.querySelector(".folder-crumb")!)
      expect(app.names()).toEqual(["shot.png", "clip.mp4", ".env", "latest", "old-runs"])
      act(() => {
        viewer.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }))
      })
      await settle()
      expect(app.root.querySelector(".folder-up")?.getAttribute("aria-disabled")).toBe("true")
      expect(app.names()).toHaveLength(5)
    })

    it("draw a folder that is entered whole, though the pointer is in the grid", async () => {
      const app = await shown({ listings: inFolder })
      await app.pointer(true)
      await app.open("old-runs")
      expect(app.names()).toEqual(["notes", "run-1.png"])
      expect(app.root.querySelector(".folder-arrivals")).toBeNull()
    })

    it("keep the folder a pane was in when it comes back", async () => {
      const app = await shown({ listings: inFolder })
      await app.open("old-runs")
      app.root.ownerDocument.body.innerHTML = ""
      const again = render(
        createElement(registration.View, {
          item: itemFixture("render", "01", {
            kind: "folder",
            name: "render",
            path: "/tmp/render",
          }),
          itemStore: app.itemStore,
          target,
        }),
      )
      unmounts.push(again.unmount)
      await settle()
      expect(again.container.querySelectorAll(".folder-crumb")).toHaveLength(2)
    })
  })

  context("moving between folders", () => {
    // `a` holds a file of the name the top's has, of another size.
    const sized = (name: string, size: number) => entry(name, { size })
    const tree = (topSize: number) => ({
      "": listing([
        sized("same.png", topSize),
        entry("a", { kind: "folder", size: 0, children: 1 }),
      ]),
      a: listing([sized("same.png", 7)], { path: "/tmp/render/a", within: "a" }),
    })

    it("marks no file written for being another folder's of the same name", async () => {
      const app = await shown({ listings: tree(1) })
      await app.open("a")
      await app.click(app.root.querySelector(".folder-crumb")!)
      expect(app.root.querySelector(".files-cursor")).toBeNull()
      // A real write to the folder the view is in still shows.
      await app.list(
        listing([sized("same.png", 99), entry("a", { kind: "folder", size: 0, children: 1 })]),
      )
      expect(app.tile("same.png").querySelector(".files-cursor")).not.toBeNull()
    })

    it("shows nothing of a folder's earlier visit while it is read again", async () => {
      const app = await shown({ listings: tree(1) })
      await app.open("a")
      expect(app.names()).toEqual(["same.png"])
      await app.click(app.root.querySelector(".folder-crumb")!)
      app.quiet.add("a")
      await app.open("a")
      expect(app.names()).toEqual([])
      await app.list(tree(1).a, "a")
      expect(app.names()).toEqual(["same.png"])
    })
  })

  context("being mounted and unmounted", () => {
    it("opens one stream however fast a pane shows it and puts it away", async () => {
      const app = await shown()
      const again = () =>
        render(
          createElement(registration.View, {
            item: itemFixture("render", "01", {
              kind: "folder",
              name: "render",
              path: "/tmp/render",
            }),
            itemStore: app.itemStore,
            target,
          }),
        )
      for (let time = 0; time < 5; time += 1) {
        const mounted = again()
        mounted.unmount()
      }
      await settle()
      // The item's own, followed whether shown or not; a pane shown or put away asks for no other.
      expect(app.followed).toEqual([""])
    })
  })

  context("opening a file", () => {
    it("asks the runner to show it on its terminal's bar by its absolute path, as its kind", async () => {
      const app = await shown()
      await app.open("shot.png")
      expect(app.attached).toEqual([{ terminalId: "01", path: "/tmp/render/shot.png" }])
    })

    it("opens a file of a folder inside it by the folder's own path", async () => {
      const app = await shown({ listings: inFolder })
      await app.open("old-runs")
      await app.open("run-1.png")
      expect(app.attached).toEqual([{ terminalId: "01", path: "/tmp/render/old-runs/run-1.png" }])
    })

    it("opens neither a secret nor a link out", async () => {
      const app = await shown()
      await app.open(".env")
      await app.open("latest")
      expect(app.attached).toEqual([])
      expect(app.followed).toEqual([""])
    })

    it("says so when it can't be opened", async () => {
      const app = await shown()
      vi.spyOn(app.itemStore, "attach").mockRejectedValue(new Error("no"))
      await app.open("shot.png")
      expect(app.root.querySelector(".pane-notice")?.textContent).toBe(
        "shot.png couldn't be opened.",
      )
    })
  })

  context("live", () => {
    it("takes new files at the top", async () => {
      const app = await shown()
      await app.list(listing([entry("new.png", { modifiedAt: 9_000 }), ...top]))
      expect(app.names()[0]).toBe("new.png")
      expect(app.root.querySelector(".folder-new")).not.toBeNull()
    })

    it("holds new files in a pill while the pointer is in the grid, and lets them in when asked", async () => {
      const app = await shown()
      await app.pointer(true)
      await app.list(
        listing([
          entry("one.png", { modifiedAt: 9_000 }),
          entry("two.png", { modifiedAt: 9_500 }),
          ...top,
        ]),
      )
      expect(app.names()).not.toContain("one.png")
      const pill = app.root.querySelector<HTMLElement>(".folder-arrivals")!
      expect(pill.textContent).toBe("2 new files")
      await app.click(pill)
      expect(app.names().slice(0, 2)).toEqual(["two.png", "one.png"])
      expect(app.root.querySelector(".folder-arrivals")).toBeNull()
    })

    it("lets held files in once the pointer leaves", async () => {
      const app = await shown()
      await app.pointer(true)
      await app.list(listing([entry("one.png", { modifiedAt: 9_000 }), ...top]))
      expect(app.root.querySelector(".folder-arrivals")?.textContent).toBe("1 new file")
      await app.pointer(false)
      expect(app.names()[0]).toBe("one.png")
    })

    it("shows the write cursor on a file whose size is changing", async () => {
      const app = await shown()
      expect(app.root.querySelector(".files-cursor")).toBeNull()
      await app.list(
        listing(top.map((each) => (each.name === "clip.mp4" ? { ...each, size: 9_999 } : each))),
      )
      expect(app.tile("clip.mp4").querySelector(".files-cursor")).not.toBeNull()
      expect(app.tile("clip.mp4").hasAttribute("data-pulse")).toBe(true)
      expect(app.tile("shot.png").querySelector(".files-cursor")).toBeNull()
    })
  })

  context("its states", () => {
    it("says a folder holds nothing yet", async () => {
      const app = await shown({ listings: { "": listing([]) } })
      expect(app.root.querySelector(".folder-empty")?.textContent).toBe(
        "Nothing in render yetFiles show here as they're written.",
      )
    })

    it("says a folder is gone, with a way to close it, and keeps its last listing faded", async () => {
      const app = await shown()
      await app.list({ state: "unavailable", reason: "gone", size: null })
      const notice = app.root.querySelector(".pane-notice")!
      expect(notice.textContent).toContain("render is gone: it was moved or deleted.")
      await app.click(notice.querySelector("button")!)
      expect(app.closed).toEqual(["render"])
      expect(app.root.querySelector(".folder-scroll")?.hasAttribute("data-faded")).toBe(true)
      expect(app.names()).toHaveLength(5)
    })

    it("refuses a folder that may hold secrets whole, with no tools and no way up", async () => {
      const app = await shown({
        listings: { "": { state: "unavailable", reason: "secret", size: null } },
      })
      const refused = app.root.querySelector(".folder-refused")!
      expect(refused.textContent).toBe(
        "/tmp/render isn't shownIt may hold secrets, so Novadeck doesn't open it or list what's in it.",
      )
      expect(refused.querySelector("svg")).not.toBeNull()
      expect(app.names()).toEqual([])
      expect(app.root.querySelector(".folder-crumbs")).toBeNull()
      expect(app.root.querySelector('button[aria-label="Sort"]')).toBeNull()
    })

    it("says a folder inside it is gone, and lets the person go up", async () => {
      const app = await shown({
        listings: {
          ...inFolder,
          "old-runs": { state: "unavailable", reason: "missing", size: null },
        },
      })
      await app.open("old-runs")
      expect(app.root.querySelector(".pane-notice")?.textContent).toBe(
        "old-runs isn't there any more.",
      )
      expect(app.root.querySelector(".folder-up")?.hasAttribute("aria-disabled")).toBe(false)
    })

    it("never calls a folder empty that holds more than is listed", async () => {
      const app = await shown({ listings: { "": listing([], { total: 5000, truncated: true }) } })
      expect(app.root.querySelector(".folder-empty")).toBeNull()
    })

    it("says a folder is too large to list whole", async () => {
      const app = await shown({
        listings: { "": listing(top, { total: 5000, truncated: true }) },
      })
      expect(app.root.querySelector(".artifact-cut")?.textContent).toBe(
        "render holds 5,000 items, which is more than Novadeck lists whole: the first 5 are shown.",
      )
    })
  })
})

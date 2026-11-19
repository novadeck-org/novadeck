import type { Companions, FolderEntry, ItemContent, ItemId } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeAll, vi } from "vitest"

import { coverKey } from "../../homes/terminal/cover-keys"
import { ItemCommandsContext } from "../../item-commands"
import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { useFileView } from "../file/view-choice"
import { registerEntryThumb, unregisterEntryThumb } from "./entry-thumbs"
import { folder as registration } from "./index"
import type { FolderView } from "./model"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))
// The view loads when a folder first shows: it is loaded before, so each test's first render
// suspends only until the next tick.
beforeAll(() => import("./FolderView"))

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
  into,
}: {
  listings?: Record<string, ItemContent>
  part?: Companions["part"] | null
  fromTerminal?: string
  // The pane the folder is drawn in, as the terminal's pane reader is.
  into?: HTMLElement
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
  const heard: string[] = []
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
      {
        value: {
          closeItem: (id) => closed.push(id),
          openBarTab: () => {},
          undock: () => {},
        },
      },
      // What an ancestor of the view, as the pane is, hears of the keys.
      createElement(
        "div",
        { onKeyDown: (event: React.KeyboardEvent) => void heard.push(event.key) },
        createElement(registration.View, { item, itemStore, target }),
      ),
    ),
  )
  unmounts.push(rendered.unmount)
  into?.append(rendered.container)
  await settle()
  const root = rendered.container
  return {
    root,
    unmount: rendered.unmount,
    itemStore,
    heard,
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
      app.unmount()
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

  context("a file asked to be selected from outside", () => {
    // What a file's "Show in" leaves in the store: the folder it is in, and its name.
    const asked = (app: Awaited<ReturnType<typeof shown>>, change: Partial<FolderView>) =>
      act(() => app.itemStore.folder("render" as ItemId, change))

    it("is selected in the folder it is in, scrolled into view, and let go of in the store", async () => {
      const scrolled = vi.fn<() => void>()
      Element.prototype.scrollIntoView = scrolled
      const app = await shown({ listings: inFolder })
      asked(app, { within: "old-runs", selected: "run-1.png" })
      await settle()
      expect(app.names()).toEqual(["notes", "run-1.png"])
      expect(app.tile("run-1.png").getAttribute("data-selected")).toBe("true")
      expect(app.tile("notes").hasAttribute("data-selected")).toBe(false)
      expect(scrolled).toHaveBeenCalledWith({ block: "nearest" })
      // Coming back to the folder later finds it as it left it, not selecting the file again.
      expect(app.itemStore.store.getSnapshot().folders["render" as ItemId]).toMatchObject({
        within: "old-runs",
        selected: undefined,
      })
    })

    it("is selected once the folder it is in has been listed, if that takes a while", async () => {
      Element.prototype.scrollIntoView = vi.fn<() => void>()
      const app = await shown({ listings: inFolder })
      app.quiet.add("old-runs")
      asked(app, { within: "old-runs", selected: "run-1.png" })
      await settle()
      expect(app.names()).toEqual([])
      await app.list(inFolder["old-runs"]!, "old-runs")
      expect(app.tile("run-1.png").getAttribute("data-selected")).toBe("true")
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    })

    it("is selected in the list too", async () => {
      Element.prototype.scrollIntoView = vi.fn<() => void>()
      const app = await shown({ listings: inFolder })
      asked(app, { layout: "list", selected: "shot.png" })
      await settle()
      expect(app.tile("shot.png").getAttribute("aria-selected")).toBe("true")
    })

    it("leaves a folder looked at as it was when nothing is asked", async () => {
      const app = await shown({ listings: inFolder })
      expect(app.root.querySelector("[data-selected]")).toBeNull()
      expect(app.itemStore.store.getSnapshot().folders["render" as ItemId]).toBeUndefined()
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

    it("hands the focus it held to the pane as it goes, so the file opened in its place has its keys", async () => {
      const pane = document.createElement("section")
      pane.setAttribute("data-workspace-companion", "")
      pane.tabIndex = -1
      document.body.append(pane)
      const app = await shown({ into: pane })
      await app.open("shot.png")
      // The tile double-clicked holds focus.
      app.tile("shot.png").focus()
      // The file's tab takes the folder's place in the pane, whenever the pane gets to it.
      app.unmount()
      await settle()
      expect(document.activeElement).toBe(pane)
      pane.remove()
    })

    it("leaves focus alone as it goes where the folder didn't hold it", async () => {
      const pane = document.createElement("section")
      pane.setAttribute("data-workspace-companion", "")
      pane.tabIndex = -1
      const elsewhere = document.createElement("button")
      document.body.append(pane, elsewhere)
      const app = await shown({ into: pane })
      elsewhere.focus()
      app.unmount()
      await settle()
      expect(document.activeElement).toBe(elsewhere)
      pane.remove()
      elsewhere.remove()
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

// A file's menu and its quick look.
describe("a file's menu and quick look", () => {
  const files = [
    entry("shot.png", { modifiedAt: 5_000 }),
    entry("mid", { kind: "folder", size: 0, children: 2, modifiedAt: 4_000 }),
    entry("song.mp3", { kind: "audio", modifiedAt: 3_000 }),
    entry("notes.md", { kind: "text", modifiedAt: 2_500 }),
    entry("main.ts", { kind: "text", modifiedAt: 2_000 }),
    entry(".env", { kind: "other", secret: true, stamp: "", modifiedAt: 1_500 }),
    entry("latest", { kind: "other", link: true, stamp: "", modifiedAt: 1_000 }),
    entry("clip.mp4", { kind: "video", modifiedAt: 500 }),
  ]

  const doc = () => document
  // What the menu's items say: their label and, after it, the key they name.
  const itemTexts = (): string[] =>
    [...doc().querySelectorAll<HTMLElement>('[data-scope="menu"][data-part="item"]')].map(
      (each) => each.textContent ?? "",
    )
  // A menu runs what was chosen once it has closed and focus has settled: a few frames.
  const frames = () =>
    act(async () => {
      for (let frame = 0; frame < 6; frame += 1)
        // eslint-disable-next-line no-await-in-loop -- Each frame comes after the one before.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
  const choose = async (label: string) => {
    const item = [
      ...doc().querySelectorAll<HTMLElement>('[data-scope="menu"][data-part="item"]'),
    ].find((each) => each.textContent?.startsWith(label))!
    act(() => item.click())
    await frames()
    await settle()
  }
  const menuOn = async (on: Element) => {
    act(() => {
      on.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      )
    })
    await settle()
  }
  const key = async (on: Element, name: string, extra: KeyboardEventInit = {}) => {
    act(() => {
      on.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra }),
      )
    })
    await settle()
  }
  const dialog = (root: Element) => root.querySelector<HTMLElement>('[role="dialog"]')
  // The view a file would open on, as an item's own viewer reads it.
  const itemId = itemFixture("render", "01").id
  const probe = (name: string) => {
    let view = "?"
    const Probe = () => {
      view = useFileView(itemId, `/tmp/render/${name}`)[0]
      return null
    }
    const mounted = render(createElement(Probe))
    unmounts.push(mounted.unmount)
    return () => view
  }

  context("its menu", () => {
    it("offers a picture Open, Quick look and Copy path, with the keys it answers to", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await menuOn(app.tile("shot.png"))
      expect(itemTexts()).toEqual(["OpenDouble-click", "Quick lookSpace", "Copy path"])
    })

    it("adds Open as text for a file whose type has a preview with a source", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await menuOn(app.tile("notes.md"))
      expect(itemTexts()).toEqual([
        "OpenDouble-click",
        "Open as textAlt+double-click",
        "Quick lookSpace",
        "Copy path",
      ])
      // A source file has only its source, so there is nothing to switch to.
      await menuOn(app.tile("main.ts"))
      expect(itemTexts()).not.toContain("Open as textAlt+double-click")
    })

    it("offers a folder Open and Copy path, and a secret or a link out only Copy path", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await menuOn(app.tile("mid"))
      expect(itemTexts()).toEqual(["OpenDouble-click", "Copy path"])
      await menuOn(app.tile(".env"))
      expect(itemTexts()).toEqual(["Copy path"])
      await menuOn(app.tile("latest"))
      expect(itemTexts()).toEqual(["Copy path"])
    })

    it("selects the entry it was asked on, in the list too", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await app.click(app.root.querySelector('button[aria-label="Show as a list"]')!)
      await menuOn(app.tile("song.mp3"))
      expect(app.tile("song.mp3").getAttribute("aria-selected")).toBe("true")
      expect(itemTexts()).toContain("Quick lookSpace")
    })

    it("keeps its own keys: Escape closes the menu and goes no further, so the pane stays", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await menuOn(app.tile("shot.png"))
      const open = () =>
        document.querySelector('[data-scope="menu"][data-part="content"][data-state="open"]')
      expect(open()).not.toBeNull()
      await key(open()!.querySelector('[data-part="item"]')!, "Escape")
      await frames()
      expect(open()).toBeNull()
      expect(app.heard).toEqual([])
    })

    it("opens the file as Open does", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await menuOn(app.tile("shot.png"))
      await choose("Open")
      expect(app.attached).toEqual([{ terminalId: "01", path: "/tmp/render/shot.png" }])
    })

    it("opens a file on its source with Open as text, though its viewer is already showing", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      const view = probe("notes.md")
      expect(view()).toBe("preview")
      await menuOn(app.tile("notes.md"))
      await choose("Open as text")
      expect(app.attached).toEqual([{ terminalId: "01", path: "/tmp/render/notes.md" }])
      expect(view()).toBe("source")
    })

    it("opens on the source a viewer that mounts after, and keeps it as the person's choice", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await menuOn(app.tile("notes.md"))
      await choose("Open as text")
      const later = probe("notes.md")
      expect(later()).toBe("source")
      // The same item, shown again, still opens on it.
      expect(probe("notes.md")()).toBe("source")
    })

    it("opens on the preview with a plain Open", async () => {
      const app = await shown({
        listings: { "": listing([...files, entry("readme.md", { kind: "text" })]) },
      })
      const view = probe("readme.md")
      await app.open("readme.md")
      expect(view()).toBe("preview")
    })

    it("copies a file's absolute path, and the folder's own from off an entry", async () => {
      const copied: string[] = []
      vi.stubGlobal("navigator", {
        ...navigator,
        clipboard: { writeText: async (text: string) => void copied.push(text) },
      })
      try {
        const app = await shown({ listings: { "": listing(files) } })
        await menuOn(app.tile("shot.png"))
        await choose("Copy path")
        await menuOn(app.tile("latest"))
        await choose("Copy path")
        await menuOn(app.root.querySelector(".folder-scroll")!)
        expect(itemTexts()).toEqual(["Copy path"])
        await choose("Copy path")
        expect(copied).toEqual(["/tmp/render/shot.png", "/tmp/render/latest", "/tmp/render"])
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  context("Alt+double-click", () => {
    const altOpen = async (app: Awaited<ReturnType<typeof shown>>, name: string) => {
      act(() =>
        app.tile(name).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, altKey: true })),
      )
      await settle()
    }

    it("opens a file with a source on it", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      const view = probe("plan.md")
      await app.list(listing([...files, entry("plan.md", { kind: "text" })]))
      await altOpen(app, "plan.md")
      expect(app.attached).toEqual([{ terminalId: "01", path: "/tmp/render/plan.md" }])
      expect(view()).toBe("source")
    })

    it("opens any other file as it opens, and a folder in place", async () => {
      const app = await shown({ listings: { ...inFolder, "": listing(files) } })
      const view = probe("main.ts")
      await altOpen(app, "main.ts")
      expect(app.attached).toEqual([{ terminalId: "01", path: "/tmp/render/main.ts" }])
      expect(view()).toBe("preview")
      await altOpen(app, ".env")
      expect(app.attached).toHaveLength(1)
    })
  })

  context("the quick look", () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      unregisterEntryThumb("audio")
      unregisterEntryThumb("video")
    })

    const looking = async (...[options]: Parameters<typeof shown>) => {
      const app = await shown({ listings: { "": listing(files) }, ...options })
      await app.click(app.tile("shot.png"))
      await key(app.tile("shot.png"), " ")
      return app
    }

    it("opens on Space over the selected file, floating on the peek's surface, and opens no tab", async () => {
      const app = await looking()
      const look = dialog(app.root)!
      expect(look.getAttribute("aria-label")).toBe("Quick look at shot.png")
      expect(look.classList.contains("floating") && look.classList.contains("peek")).toBe(true)
      expect(look.textContent).toContain("shot.png")
      expect(look.querySelector(".folder-look-keys")?.textContent).toBe(
        "←→ step · Enter open in a tab · Space close",
      )
      expect(app.attached).toEqual([])
    })

    it("opens from the menu, and takes no Space with nothing selected", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await key(app.root.querySelector(".folder-viewer")!, " ")
      expect(dialog(app.root)).toBeNull()
      await menuOn(app.tile("song.mp3"))
      await choose("Quick look")
      expect(dialog(app.root)?.getAttribute("aria-label")).toBe("Quick look at song.mp3")
    })

    it("steps the selection with the arrows through the files in view order, skipping folders", async () => {
      const app = await looking()
      const name = () => dialog(app.root)?.querySelector(".folder-look-name")?.textContent
      const selected = () =>
        app.root.querySelector("[data-selected] .folder-name-text")?.textContent
      expect(name()).toBe("shot.png")
      await key(dialog(app.root)!, "ArrowRight")
      // `mid` is a folder.
      expect(name()).toBe("song.mp3")
      expect(selected()).toBe("song.mp3")
      await key(dialog(app.root)!, "ArrowRight")
      expect(name()).toBe("notes.md")
      await key(dialog(app.root)!, "ArrowLeft")
      await key(dialog(app.root)!, "ArrowLeft")
      expect(name()).toBe("shot.png")
      // The first has nothing before it.
      await key(dialog(app.root)!, "ArrowLeft")
      expect(name()).toBe("shot.png")
      expect(app.attached).toEqual([])
    })

    it("opens the file in a tab with Enter, as Open does, and closes", async () => {
      const app = await looking()
      await key(dialog(app.root)!, "ArrowRight")
      await key(dialog(app.root)!, "Enter")
      expect(app.attached).toEqual([{ terminalId: "01", path: "/tmp/render/song.mp3" }])
      expect(dialog(app.root)).toBeNull()
    })

    it("closes on Space, on Escape and on a click outside, focus back on the folder's body", async () => {
      const app = await looking()
      const viewer = app.root.querySelector<HTMLElement>(".folder-viewer")!
      expect(document.activeElement).toBe(dialog(app.root))
      await key(dialog(app.root)!, " ")
      expect(dialog(app.root)).toBeNull()
      expect(document.activeElement).toBe(viewer)
      await key(app.tile("shot.png"), " ")
      await key(dialog(app.root)!, "Escape")
      expect(dialog(app.root)).toBeNull()
      expect(document.activeElement).toBe(viewer)
      await key(app.tile("shot.png"), " ")
      await app.click(app.root.querySelector(".folder-look-backdrop")!)
      expect(dialog(app.root)).toBeNull()
      expect(document.activeElement).toBe(viewer)
      expect(app.attached).toEqual([])
    })

    it("shows a video's frame, drawn larger than its tile's, with its length, read through the same reader", async () => {
      vi.stubGlobal("URL", { createObjectURL: () => "blob:frame", revokeObjectURL: () => {} })
      const boxes: unknown[] = []
      registerEntryThumb("video", async (file, box, signal) => {
        boxes.push(box)
        await file.read(0, signal)
        return { blob: new Blob(["drawn"]), duration: 12 }
      })
      const part = vi.fn<NonNullable<Companions["part"]>>(
        async () => ({ state: "part", bytes: new Uint8Array(2048) }) as const,
      )
      const app = await shown({ listings: { "": listing(files) }, part })
      await app.click(app.tile("clip.mp4"))
      await key(app.tile("clip.mp4"), " ")
      await settle()
      const look = dialog(app.root)!
      expect(look.querySelector("img")?.getAttribute("src")).toBe("blob:frame")
      expect(look.querySelector(".folder-look-meta")?.textContent).toBe("0:12 · 2 KB")
      expect(part).toHaveBeenCalledWith(target, "render", {
        stamp: "clip.mp4-stamp",
        offset: 0,
        reveal: undefined,
        path: "clip.mp4",
      })
      expect(boxes).toEqual([
        { width: 320, height: 200 },
        { width: 960, height: 540 },
      ])
    })

    it("shows what another kind registered through its renderer, as its tile's picture", async () => {
      vi.stubGlobal("URL", { createObjectURL: () => "blob:song", revokeObjectURL: () => {} })
      registerEntryThumb("audio", async (file, _box, signal) => {
        await file.read(0, signal)
        return { blob: new Blob(["drawn"]) }
      })
      const part = vi.fn<NonNullable<Companions["part"]>>(
        async () => ({ state: "part", bytes: new Uint8Array(2048) }) as const,
      )
      const app = await shown({ listings: { "": listing(files) }, part })
      await app.click(app.tile("song.mp3"))
      await key(app.tile("song.mp3"), " ")
      await settle()
      expect(dialog(app.root)!.querySelector("img")?.getAttribute("src")).toBe("blob:song")
    })

    it("shows an image's icon and kind where its picture can't be drawn", async () => {
      // The page can't decode these bytes, as one being written or misnamed.
      const part = vi.fn<NonNullable<Companions["part"]>>(
        async () => ({ state: "part", bytes: new Uint8Array(2048) }) as const,
      )
      const app = await looking({ part })
      await settle()
      const look = dialog(app.root)!
      expect(look.querySelector("img")).toBeNull()
      expect(look.querySelector(".folder-look-icon")?.textContent).toContain("Image")
      expect(look.querySelector(".folder-look-meta")?.textContent).toBe("2 KB")
    })

    it("shows the kind's icon, its kind and when it changed, for a file with no picture", async () => {
      const app = await looking()
      await key(dialog(app.root)!, "ArrowRight")
      await key(dialog(app.root)!, "ArrowRight")
      const look = dialog(app.root)!
      expect(look.querySelector("img")).toBeNull()
      expect(look.querySelector(".folder-look-icon svg")).not.toBeNull()
      expect(look.querySelector(".folder-look-icon")?.textContent).toContain("Text")
      expect(look.querySelector(".folder-look-name")?.textContent).toBe("notes.md")
      expect(look.querySelector(".folder-look-meta")?.textContent).toBe("2 KB")
    })

    it("shows a secret as it is listed, reading nothing", async () => {
      const part = vi.fn<NonNullable<Companions["part"]>>()
      const app = await looking({ part })
      await key(dialog(app.root)!, "ArrowRight")
      await key(dialog(app.root)!, "ArrowRight")
      await key(dialog(app.root)!, "ArrowRight")
      await key(dialog(app.root)!, "ArrowRight")
      expect(dialog(app.root)!.querySelector(".folder-look-name")?.textContent).toBe(".env")
      expect(dialog(app.root)!.querySelector(".folder-look-icon")?.textContent).toContain(
        "May hold secrets",
      )
      expect(part).not.toHaveBeenCalled()
    })

    it("closes if its file goes away", async () => {
      const app = await looking()
      await app.list(listing(files.filter((each) => each.name !== "shot.png")))
      expect(dialog(app.root)).toBeNull()
    })
  })

  context("on a pane that covers its terminal", () => {
    // What the pane's capture listener (cover-keys.ts) does with a key, as TerminalCompanion mounts it.
    const covered = (app: Awaited<ReturnType<typeof shown>>) => {
      const uncovered: string[] = []
      const typed: string[] = []
      const listener = (event: KeyboardEvent) =>
        coverKey(event, {
          covering: () => true,
          terminal: document.createElement("div"),
          pane: app.root,
          uncover: () => void uncovered.push(event.key),
          type: (typing) => void typed.push(typing.key),
        })
      document.addEventListener("keydown", listener, true)
      unmounts.push(() => document.removeEventListener("keydown", listener, true))
      return { uncovered, typed }
    }

    it("keeps Space, the arrows and Backspace for the folder, from its body, a row and the look", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      const cover = covered(app)
      await app.click(app.root.querySelector('button[aria-label="Show as a list"]')!)
      await app.click(app.tile("shot.png"))
      await key(app.tile("shot.png"), " ")
      expect(dialog(app.root)).not.toBeNull()
      await key(dialog(app.root)!, "ArrowRight")
      await key(dialog(app.root)!, " ")
      await key(app.root.querySelector(".folder-viewer")!, " ")
      expect(dialog(app.root)).not.toBeNull()
      await key(app.root.querySelector(".folder-viewer")!, "Backspace")
      expect(cover).toEqual({ uncovered: [], typed: [] })
    })

    it("lets Escape through to the pane when nothing is being looked at, and keeps it for the look", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      const cover = covered(app)
      await app.click(app.tile("shot.png"))
      await key(app.tile("shot.png"), " ")
      await key(dialog(app.root)!, "Escape")
      expect(dialog(app.root)).toBeNull()
      expect(app.heard).toEqual([" "])
      // With no look, it goes up to the pane (whose own handler hides it).
      await key(app.tile("shot.png"), "Escape")
      expect(app.heard).toEqual([" ", "Escape"])
      expect(cover.typed).toEqual([])
    })
  })

  context("keys on the focused entry and the body", () => {
    it("looks at the focused entry on one Space, not the selected one", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await app.click(app.tile("shot.png"))
      await key(app.tile("song.mp3"), " ")
      expect(dialog(app.root)?.getAttribute("aria-label")).toBe("Quick look at song.mp3")
      expect(app.tile("song.mp3").hasAttribute("data-selected")).toBe(true)
    })

    it("looks at the selected one from the body, and at none when none is selected", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      const viewer = app.root.querySelector(".folder-viewer")!
      await key(viewer, " ")
      expect(dialog(app.root)).toBeNull()
      await app.click(app.tile("notes.md"))
      await key(viewer, " ")
      expect(dialog(app.root)?.getAttribute("aria-label")).toBe("Quick look at notes.md")
    })

    it("opens its menu from the body on the selected entry, and from an entry on that one", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      const viewer = app.root.querySelector(".folder-viewer")!
      await app.click(app.tile("notes.md"))
      await menuOn(viewer)
      expect(itemTexts()).toContain("Open as textAlt+double-click")
      await key(document.activeElement!, "Escape")
      await frames()
      await menuOn(app.tile("shot.png"))
      expect(itemTexts()).toEqual(["OpenDouble-click", "Quick lookSpace", "Copy path"])
    })

    it("opens the folder's own menu from the body with nothing selected", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await menuOn(app.root.querySelector(".folder-viewer")!)
      expect(itemTexts()).toEqual(["Copy path"])
    })

    it("acts once on a Space or Enter held down", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await key(app.tile("shot.png"), " ")
      await key(dialog(app.root)!, " ", { repeat: true })
      expect(dialog(app.root)).not.toBeNull()
      await key(dialog(app.root)!, "Enter", { repeat: true })
      expect(app.attached).toEqual([])
      await key(dialog(app.root)!, "ArrowRight", { repeat: true })
      expect(dialog(app.root)?.getAttribute("aria-label")).toBe("Quick look at song.mp3")
      await key(app.tile("shot.png"), "Enter", { repeat: true })
      expect(app.attached).toEqual([])
    })
  })

  context("the look ending", () => {
    it("holds Tab in the dialog, its only stop", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await key(app.tile("shot.png"), " ")
      expect(dialog(app.root)?.hasAttribute("aria-modal")).toBe(false)
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      act(() => void dialog(app.root)!.dispatchEvent(tab))
      expect(tab.defaultPrevented).toBe(true)
      expect(dialog(app.root)).not.toBeNull()
    })

    it("holds Backspace and Alt+Up, which would go up behind it", async () => {
      const app = await shown({ listings: inFolder })
      await app.open("old-runs")
      await key(app.tile("run-1.png"), " ")
      await key(dialog(app.root)!, "Backspace")
      await key(dialog(app.root)!, "ArrowUp", { altKey: true })
      expect(dialog(app.root)).not.toBeNull()
      expect(app.names()).toEqual(["notes", "run-1.png"])
    })

    it("closes when the folder changes from outside, and never comes back by itself", async () => {
      const app = await shown({ listings: inFolder })
      await app.open("old-runs")
      await key(app.tile("run-1.png"), " ")
      act(() => app.itemStore.folder(itemFixture("render", "01").id, { within: "" }))
      await settle()
      expect(dialog(app.root)).toBeNull()
      act(() => app.itemStore.folder(itemFixture("render", "01").id, { within: "old-runs" }))
      await settle()
      expect(app.names()).toEqual(["notes", "run-1.png"])
      expect(dialog(app.root)).toBeNull()
    })

    it("closes with focus on the body when its file goes", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await key(app.tile("shot.png"), " ")
      await app.list(listing(files.filter((each) => each.name !== "shot.png")))
      expect(dialog(app.root)).toBeNull()
      expect(document.activeElement).toBe(app.root.querySelector(".folder-viewer"))
    })
  })

  context("a menu that is open", () => {
    it("keeps the entry it was asked for when the file goes, and says so if it is then used", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      vi.spyOn(app.itemStore, "attach").mockRejectedValue(new Error("gone"))
      await menuOn(app.tile("shot.png"))
      await app.list(listing(files.filter((each) => each.name !== "shot.png")))
      expect(itemTexts()).toEqual(["OpenDouble-click", "Quick lookSpace", "Copy path"])
      await choose("Open")
      expect(app.root.querySelector(".pane-notice")?.textContent).toBe(
        "shot.png couldn't be opened.",
      )
    })
  })

  context("a look that is transient", () => {
    const outside = () => {
      const button = document.createElement("button")
      document.body.append(button)
      unmounts.push(() => button.remove())
      return button
    }

    it("ends on a press anywhere outside it, and not on one inside", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await key(app.tile("shot.png"), " ")
      act(
        () =>
          void dialog(app.root)!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
      )
      expect(dialog(app.root)).not.toBeNull()
      const away = outside()
      act(() => void away.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })))
      await settle()
      expect(dialog(app.root)).toBeNull()
    })

    it("ends when focus goes out of the folder, and leaves it there", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await key(app.tile("shot.png"), " ")
      const away = outside()
      act(() => away.focus())
      await settle()
      expect(dialog(app.root)).toBeNull()
      expect(document.activeElement).toBe(away)
    })

    it("doesn't take focus back from where the person went when its file goes", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await key(app.tile("shot.png"), " ")
      const away = outside()
      away.focus()
      await app.list(listing(files.filter((each) => each.name !== "shot.png")))
      expect(dialog(app.root)).toBeNull()
      expect(document.activeElement).toBe(away)
    })

    it("swallows the repeats of a held Escape, which would hide the pane", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      await key(app.tile("shot.png"), " ")
      await key(dialog(app.root)!, "Escape")
      await key(app.tile("shot.png"), "Escape", { repeat: true })
      expect(app.heard).toEqual([" "])
      act(() => void document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" })))
      await key(app.tile("shot.png"), "Escape", { repeat: true })
      expect(app.heard).toEqual([" ", "Escape"])
    })
  })

  context("Space and the menu in other places", () => {
    it("leaves Space to a folder's button, which a look has nothing to show of", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })
      act(() => void app.tile("mid").dispatchEvent(space))
      expect(space.defaultPrevented).toBe(false)
      expect(dialog(app.root)).toBeNull()
    })

    it("acts in the folder a menu was asked in, and a look of a file that went does nothing", async () => {
      const app = await shown({ listings: inFolder })
      await app.open("old-runs")
      await menuOn(app.tile("run-1.png"))
      act(() => app.itemStore.folder(itemFixture("render", "01").id, { within: "" }))
      await settle()
      await choose("Open")
      expect(app.attached).toEqual([{ terminalId: "01", path: "/tmp/render/old-runs/run-1.png" }])
      await menuOn(app.tile("shot.png"))
      await app.list(listing(files.filter((each) => each.name !== "shot.png")))
      await choose("Quick look")
      expect(dialog(app.root)).toBeNull()
      expect(app.root.querySelector("[data-selected]")).toBeNull()
    })

    it("gives focus back to the body when the menu opened from it closes", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      const viewer = app.root.querySelector<HTMLElement>(".folder-viewer")!
      viewer.focus()
      await app.click(app.tile("notes.md"))
      viewer.focus()
      await menuOn(viewer)
      await key(document.activeElement!, "Escape")
      await frames()
      expect(document.activeElement).toBe(viewer)
    })
  })

  context("on a pane that covers its terminal, a letter", () => {
    it("still uncovers it and types, from a row, while Space stays for the look", async () => {
      const app = await shown({ listings: { "": listing(files) } })
      const uncovered: string[] = []
      const typed: string[] = []
      const listener = (event: KeyboardEvent) =>
        coverKey(event, {
          covering: () => true,
          terminal: document.createElement("div"),
          pane: app.root,
          uncover: () => void uncovered.push(event.key),
          type: (typing) => void typed.push(typing.key),
        })
      document.addEventListener("keydown", listener, true)
      unmounts.push(() => document.removeEventListener("keydown", listener, true))
      await app.click(app.root.querySelector('button[aria-label="Show as a list"]')!)
      await key(app.tile("shot.png"), "q")
      expect({ uncovered, typed }).toEqual({ uncovered: ["q"], typed: ["q"] })
      await key(app.tile("shot.png"), " ")
      expect(dialog(app.root)).not.toBeNull()
      expect({ uncovered, typed }).toEqual({ uncovered: ["q"], typed: ["q"] })
    })
  })
})

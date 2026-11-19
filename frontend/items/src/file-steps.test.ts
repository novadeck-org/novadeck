import type { Companions, FolderEntry, Item, ItemContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeAll } from "vitest"

import { ItemBody } from "./item-body"
import { ItemCommandsContext } from "./item-commands"
import { createItemStore } from "./store/item-store"
import { context, describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))
// The steps load after the body: they are loaded before, so each test settles in a tick.
beforeAll(() => import("./file-steps"))

const target = { projectId: "project", workspaceSessionId: "initial" }
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

const entry = (name: string, extra: Partial<FolderEntry> = {}): FolderEntry => ({
  name,
  kind: "image",
  size: 1_000,
  modifiedAt: 1_000,
  children: null,
  secret: false,
  link: false,
  stamp: `${name}-stamp`,
  ...extra,
})

const listing = (
  entries: readonly FolderEntry[],
  path = "/tmp/render",
  within = "",
): ItemContent => ({
  state: "ready",
  stamp: JSON.stringify([within, entries]),
  content: { kind: "folder", path, within, entries, total: entries.length, truncated: false },
})

// What the render folder holds: three stills (newest a, then c, then b), a clip, a folder, a
// secret still and a link out.
const held = [
  entry("b.png", { modifiedAt: 5_000, size: 10 }),
  entry("a.png", { modifiedAt: 9_000, size: 30 }),
  entry("c.png", { modifiedAt: 7_000, size: 20 }),
  entry("clip.mp4", { kind: "video", modifiedAt: 8_000 }),
  entry("old", { kind: "folder", modifiedAt: 10_000, children: 1 }),
  entry(".env.png", { secret: true, modifiedAt: 11_000 }),
  entry("latest.png", { link: true, modifiedAt: 12_000 }),
  entry("notes.md", { kind: "text", modifiedAt: 2_000 }),
]

const folderItem = (extra: Partial<Item> = {}): Item =>
  itemFixture("render", "01", { kind: "folder", name: "render", path: "/tmp/render", ...extra })

// A file of the render folder shown in a pane, over a runner that lists `listings` by the folder
// asked for. `items` are what else the session holds.
const shown = async ({
  file = {},
  items = [folderItem()],
  listings = { "": listing(held) },
  repoint = true,
  commands = true,
}: {
  file?: Partial<Item>
  items?: readonly Item[]
  listings?: Record<string, ItemContent>
  repoint?: boolean
  commands?: boolean
} = {}) => {
  const item = itemFixture("file", "01", {
    by: "person",
    kind: "image",
    name: "c.png",
    path: "/tmp/render/c.png",
    ...file,
  })
  // The listings followed for the file, apart from the folder item's own follow of its top.
  const followed: { id: string; within: string }[] = []
  const released: string[] = []
  const repointed: { itemId: string; path: string }[] = []
  const opened: { terminalId: string; key: string }[] = []
  const undocked: string[] = []
  const companions: Companions = {
    follow: (_target, id, { within }, on) => {
      if (within !== undefined) followed.push({ id, within })
      if (id === folderItem().id) {
        const content = listings[within ?? ""]
        if (content) on(content)
      } else on({ state: "unavailable", reason: "missing", size: null })
      return () => released.push(`${id}:${within ?? ""}`)
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
    ...(repoint
      ? {
          repoint: async (_target, itemId, path) => {
            repointed.push({ itemId, path })
            return item
          },
        }
      : {}),
  }
  const workspace = createWorkspaceStore(
    [...items, item].reduce(
      (state, each) => workspaceReducer(state, { type: "item/upsert", target, item: each }),
      workspaceFixture(),
    ),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  const body = createElement(ItemBody, { item, itemStore, target })
  const rendered = render(
    commands
      ? createElement(
          ItemCommandsContext,
          {
            value: {
              closeItem: () => {},
              openBarTab: (terminalId, key) => opened.push({ terminalId, key }),
              undock: (id) => undocked.push(id),
            },
          },
          body,
        )
      : body,
  )
  unmounts.push(rendered.unmount)
  await settle()
  const root = rendered.container
  const tool = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  return {
    root,
    itemStore,
    item,
    followed,
    released,
    repointed,
    opened,
    undocked,
    unmount: rendered.unmount,
    tool,
    previous: () => tool("Previous image in render"),
    next: () => tool("Next image in render"),
    click: async (element: Element | null) => {
      act(() => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
      await settle()
    },
    // A key pressed in the body, as it reaches the pane; `taken` is a viewer that took it first.
    press: async (
      key: string,
      {
        taken = false,
        ...modifiers
      }: { taken?: boolean; shiftKey?: boolean; ctrlKey?: boolean } = {},
    ) => {
      const element = root.querySelector(".artifact-viewer") ?? root
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      })
      if (taken)
        element.addEventListener("keydown", (pressed) => pressed.preventDefault(), { once: true })
      act(() => void element.dispatchEvent(event))
      await settle()
      return event
    },
  }
}

describe("a file in a folder the session has open", () => {
  context("its tools", () => {
    it("are ‹ ›, named by the kind and the folder, and Show in the folder", async () => {
      const app = await shown()
      expect(app.previous()).not.toBeNull()
      expect(app.next()).not.toBeNull()
      expect(app.tool("Show in render")).not.toBeNull()
      expect(app.root.querySelector(".item-body")).not.toBeNull()
    })

    it("name a PDF, a recording and a file as the kind's own word does", async () => {
      const pdf = await shown({ file: { kind: "pdf", name: "r.pdf", path: "/tmp/render/r.pdf" } })
      expect(pdf.tool("Previous PDF in render")).not.toBeNull()
      pdf.unmount()
      const audio = await shown({
        file: { kind: "audio", name: "r.mp3", path: "/tmp/render/r.mp3" },
      })
      expect(audio.tool("Next recording in render")).not.toBeNull()
    })

    it("name the folder the file sits in when it is inside the one that was opened", async () => {
      const app = await shown({
        file: { path: "/tmp/render/old/x.png", name: "x.png" },
        listings: { old: listing([entry("x.png")], "/tmp/render/old", "old") },
      })
      expect(app.tool("Show in old")).not.toBeNull()
      expect(app.followed.filter(({ id }) => id === "render")).toEqual([
        { id: "render", within: "old" },
      ])
    })

    it("are none where the session has no folder above the file", async () => {
      const app = await shown({ items: [folderItem({ path: "/tmp/elsewhere" })] })
      expect(app.root.querySelector(".pane-tool")).toBeNull()
      expect(app.followed.filter(({ id }) => id === "render")).toEqual([])
    })

    it("are none for an item that is no file's", async () => {
      const app = await shown({
        file: { kind: "page", name: "page", path: null, url: "http://localhost:5173/" },
      })
      expect(app.root.querySelector(".pane-tool")).toBeNull()
      expect(app.root.querySelector(".item-body")).toBeNull()
    })

    it("are only Show in where the backend can't point a file at another", async () => {
      const app = await shown({ repoint: false })
      expect(app.previous()).toBeNull()
      expect(app.tool("Show in render")).not.toBeNull()
    })

    it("are only the steps where the place can't bring the folder forward, as a window", async () => {
      const app = await shown({ commands: false })
      expect(app.next()).not.toBeNull()
      expect(app.tool("Show in render")).toBeNull()
    })
  })

  context("stepping", () => {
    it("points the same item at the file after it, by its absolute path", async () => {
      const app = await shown()
      await app.click(app.next())
      expect(app.repointed).toEqual([{ itemId: "file", path: "/tmp/render/b.png" }])
    })

    it("points it at the file before it", async () => {
      const app = await shown()
      await app.click(app.previous())
      expect(app.repointed).toEqual([{ itemId: "file", path: "/tmp/render/a.png" }])
    })

    it("follows the sort the folder item is in", async () => {
      const app = await shown()
      act(() => app.itemStore.folder(folderItem().id, { sort: "name" }))
      await settle()
      await app.click(app.next())
      // By name: a, b, c: c is the last.
      expect(app.repointed).toEqual([])
      await app.click(app.previous())
      expect(app.repointed).toEqual([{ itemId: "file", path: "/tmp/render/b.png" }])
    })

    it("goes through the files of its own kind only, never a folder, a secret or a link out", async () => {
      const first = await shown({ file: { path: "/tmp/render/a.png", name: "a.png" } })
      // Newest first: the secret and the link, newer, are passed over, so a is the first.
      expect(first.previous()?.getAttribute("aria-disabled")).toBe("true")
      await first.click(first.next())
      expect(first.repointed).toEqual([{ itemId: "file", path: "/tmp/render/c.png" }])
    })

    it("reads the folder it is in, with a path from there", async () => {
      const app = await shown({
        file: { path: "/tmp/render/old/x.png", name: "x.png" },
        listings: {
          old: listing(
            [entry("x.png", { modifiedAt: 1 }), entry("y.png", { modifiedAt: 2 })],
            "/tmp/render/old",
            "old",
          ),
        },
      })
      await app.click(app.tool("Previous image in old"))
      expect(app.repointed).toEqual([{ itemId: "file", path: "/tmp/render/old/y.png" }])
    })

    it("is off at the first and the last, with a tooltip saying so, and asks nothing there", async () => {
      const first = await shown({ file: { path: "/tmp/render/a.png", name: "a.png" } })
      expect(first.previous()?.getAttribute("aria-disabled")).toBe("true")
      expect(first.next()?.getAttribute("aria-disabled")).toBeNull()
      await first.click(first.previous())
      expect(first.repointed).toEqual([])
      first.unmount()
      const last = await shown({ file: { path: "/tmp/render/b.png", name: "b.png" } })
      expect(last.next()?.getAttribute("aria-disabled")).toBe("true")
      await last.click(last.next())
      expect(last.repointed).toEqual([])
    })

    it("is off both ways for the only file of its kind", async () => {
      const app = await shown({
        file: { kind: "file", name: "notes.md", path: "/tmp/render/notes.md" },
      })
      expect(app.tool("Previous file in render")?.getAttribute("aria-disabled")).toBe("true")
      expect(app.tool("Next file in render")?.getAttribute("aria-disabled")).toBe("true")
    })

    it("is off until the folder is listed, and when it can't be", async () => {
      const waiting = await shown({ listings: {} })
      expect(waiting.previous()?.getAttribute("aria-disabled")).toBe("true")
      expect(waiting.next()?.getAttribute("aria-disabled")).toBe("true")
      waiting.unmount()
      const gone = await shown({
        listings: { "": { state: "unavailable", reason: "gone", size: null } },
      })
      expect(gone.next()?.getAttribute("aria-disabled")).toBe("true")
      expect(gone.tool("Show in render")).not.toBeNull()
    })

    it("is off for a file the listing doesn't hold", async () => {
      const app = await shown({ file: { path: "/tmp/render/new.png", name: "new.png" } })
      expect(app.next()?.getAttribute("aria-disabled")).toBe("true")
    })

    it("leaves the folder item's own view where it was", async () => {
      const app = await shown({
        file: { path: "/tmp/render/old/x.png", name: "x.png" },
        listings: { old: listing([entry("x.png")], "/tmp/render/old", "old") },
      })
      expect(app.itemStore.store.getSnapshot().folders).toEqual({})
      expect(app.itemStore.store.getSnapshot().listings).toEqual({})
    })

    it("is followed only while the file is shown", async () => {
      const app = await shown()
      expect(app.released).toEqual([])
      app.unmount()
      expect(app.released).toContain("render:")
    })
  })

  context("the arrow keys", () => {
    it("step an image: → to the next file, ← to the one before", async () => {
      const app = await shown()
      const event = await app.press("ArrowRight")
      expect(event.defaultPrevented).toBe(true)
      expect(app.repointed).toEqual([{ itemId: "file", path: "/tmp/render/b.png" }])
      await app.press("ArrowLeft")
      expect(app.repointed.at(-1)).toEqual({ itemId: "file", path: "/tmp/render/a.png" })
    })

    it("say so in the tooltips and the shortcuts of an image's tools, and in no other kind's", async () => {
      const image = await shown()
      expect(image.next()?.getAttribute("aria-keyshortcuts")).toBe("ArrowRight")
      expect(image.previous()?.getAttribute("aria-keyshortcuts")).toBe("ArrowLeft")
      image.unmount()
      const video = await shown({
        file: { kind: "video", name: "clip.mp4", path: "/tmp/render/clip.mp4" },
        listings: {
          "": listing([
            entry("clip.mp4", { kind: "video" }),
            entry("two.mp4", { kind: "video", modifiedAt: 2 }),
          ]),
        },
      })
      expect(video.tool("Next video in render")?.getAttribute("aria-keyshortcuts")).toBeNull()
    })

    it("do nothing at an end, and leave the key to whoever wants it", async () => {
      const app = await shown({ file: { path: "/tmp/render/a.png", name: "a.png" } })
      const event = await app.press("ArrowLeft")
      expect(event.defaultPrevented).toBe(false)
      expect(app.repointed).toEqual([])
    })

    it("leave a key the viewer took, as an image does while it pans", async () => {
      const app = await shown()
      await app.press("ArrowRight", { taken: true })
      expect(app.repointed).toEqual([])
    })

    it("leave a key pressed with a modifier, or any other key", async () => {
      const app = await shown()
      await app.press("ArrowRight", { shiftKey: true })
      await app.press("ArrowRight", { ctrlKey: true })
      await app.press("ArrowDown")
      await app.press("a")
      expect(app.repointed).toEqual([])
    })

    it("leave a key typed in a field", async () => {
      const app = await shown()
      const field = document.createElement("input")
      app.root.querySelector(".item-body")?.appendChild(field)
      act(
        () =>
          void field.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
          ),
      )
      await settle()
      expect(app.repointed).toEqual([])
    })

    // Their viewers use ← and →: a player seeks, a PDF turns pages, a text file's caret, scroll and
    // data tree move. Their tools are there, though.
    for (const [kind, name] of [
      ["video", "clip.mp4"],
      ["audio", "take.mp3"],
      ["pdf", "report.pdf"],
      ["file", "notes.md"],
    ] as const)
      it(`are not the keys of a ${kind}, whose viewer uses them`, async () => {
        const entryKind = kind === "file" ? "text" : kind
        const app = await shown({
          file: { kind, name, path: `/tmp/render/${name}` },
          listings: {
            "": listing([
              entry(name, { kind: entryKind, modifiedAt: 5 }),
              entry(`later-${name}`, { kind: entryKind, modifiedAt: 9 }),
            ]),
          },
        })
        await app.press("ArrowLeft")
        expect(app.repointed).toEqual([])
        expect(app.root.querySelector("[aria-keyshortcuts]")).toBeNull()
      })
  })

  context("Show in", () => {
    it("sets the folder's view to where the file is, with the file selected, and opens the folder's tab", async () => {
      const app = await shown({
        file: { path: "/tmp/render/old/x.png", name: "x.png" },
        listings: { old: listing([entry("x.png")], "/tmp/render/old", "old") },
      })
      await app.click(app.tool("Show in old"))
      expect(app.itemStore.store.getSnapshot().folders["render" as never]).toMatchObject({
        within: "old",
        selected: "x.png",
      })
      expect(app.opened).toEqual([{ terminalId: "01", key: "render" }])
    })

    it("selects the file at the top of the folder it is directly in", async () => {
      const app = await shown()
      await app.click(app.tool("Show in render"))
      expect(app.itemStore.store.getSnapshot().folders["render" as never]).toMatchObject({
        within: "",
        selected: "c.png",
      })
    })

    it("brings a folder in a window forward where it is", async () => {
      const app = await shown({ items: [folderItem({ holder: { windowId: "w" } })] })
      await app.click(app.tool("Show in render"))
      expect(app.undocked).toEqual(["render"])
      expect(app.opened).toEqual([])
    })
  })
})

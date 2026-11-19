import type { Companions, FolderEntry, Item, ItemContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement, useSyncExternalStore } from "react"
import { afterEach, beforeAll, vi } from "vitest"

import { ItemBody } from "./item-body"
import { ItemCommandsContext } from "./item-commands"
import { createItemStore } from "./store/item-store"
import { itemIn } from "./store/pointing"
import { context, describe, expect, it } from "./test"

// jsdom has no layout and no resizes; the image viewer asks for them.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

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
  steps = true,
  failing,
}: {
  file?: Partial<Item>
  items?: readonly Item[]
  listings?: Record<string, ItemContent>
  repoint?: boolean
  commands?: boolean
  steps?: boolean
  // A repoint the runner refuses, with its words.
  failing?: string
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
      } else if (item.kind === "image")
        // A picture the viewer really draws, so it is drawn again as the item is shown another.
        on({
          state: "ready",
          stamp: String(item.version),
          content: { kind: "image", src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
        })
      else on({ state: "unavailable", reason: "missing", size: null })
      return () => released.push(`${id}:${within ?? ""}`)
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
    ...(repoint
      ? {
          repoint: async (_target, itemId, path) => {
            repointed.push({ itemId, path })
            if (failing !== undefined) throw new Error(failing)
            // As the runner does: the same item, shown the other file, a version later.
            const now = itemIn(workspace.getSnapshot(), item.id)!
            const next = {
              ...now,
              path,
              name: path.split("/").at(-1)!,
              version: now.version + 1,
            }
            act(() => workspace.dispatch({ type: "item/upsert", target, item: next }))
            return next
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
  // The item as the workspace holds it, which a step changes, in a pane that stays through it.
  const Shown = () => {
    const now = useSyncExternalStore(
      workspace.subscribe,
      () => itemIn(workspace.getSnapshot(), item.id) ?? item,
    )
    return createElement(
      "section",
      { "data-workspace-companion": "", tabIndex: -1, className: "pane-reader" },
      createElement(ItemBody, { item: now, itemStore, target, steps }),
    )
  }
  const body = createElement(Shown)
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
        from = "body",
        ...modifiers
      }: {
        taken?: boolean
        from?: "body" | "pane"
        shiftKey?: boolean
        ctrlKey?: boolean
      } = {},
    ) => {
      const element =
        (from === "pane" ? root.querySelector("section") : null) ??
        root.querySelector(".artifact-viewer") ??
        root
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
      // After the viewer's own tools, whichever is drawn first.
      expect(app.root.querySelector(".pane-tools-inline")?.hasAttribute("data-after")).toBe(true)
    })

    it("name a PDF, a recording and a file as the kind's own word does", async () => {
      const pdf = await shown({
        file: { kind: "pdf", name: "r.pdf", path: "/tmp/render/r.pdf" },
        listings: { "": listing([entry("r.pdf", { kind: "pdf" })]) },
      })
      expect(pdf.tool("Previous PDF in render")).not.toBeNull()
      pdf.unmount()
      const audio = await shown({
        file: { kind: "audio", name: "r.mp3", path: "/tmp/render/r.mp3" },
        listings: { "": listing([entry("r.mp3", { kind: "audio" })]) },
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

    it("shows no ‹ › until the file's place among its neighbours is known: not listed yet, the folder gone, the file not in the list", async () => {
      const waiting = await shown({ listings: {} })
      expect(waiting.previous()).toBeNull()
      expect(waiting.next()).toBeNull()
      expect(waiting.tool("Show in render")).not.toBeNull()
      waiting.unmount()
      const gone = await shown({
        listings: { "": { state: "unavailable", reason: "gone", size: null } },
      })
      expect(gone.next()).toBeNull()
      expect(gone.tool("Show in render")).not.toBeNull()
      gone.unmount()
      const unlisted = await shown({ file: { path: "/tmp/render/new.png", name: "new.png" } })
      expect(unlisted.next()).toBeNull()
      expect(unlisted.tool("Show in render")).not.toBeNull()
    })

    it("shows none for a file in the project window, which keeps its one file", async () => {
      const app = await shown({ steps: false })
      expect(app.root.querySelector(".pane-tool")).toBeNull()
    })

    it("says why a step failed, under the viewer, until the file is another", async () => {
      const app = await shown({ failing: "That file doesn't exist." })
      await app.click(app.next())
      expect(app.root.querySelector("[role='alert']")?.textContent).toBe(
        "Couldn't open b.png: That file doesn't exist.",
      )
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
    it("step an image: → to the next file, ← to the one before, the item moving as it goes", async () => {
      const app = await shown()
      const event = await app.press("ArrowRight")
      expect(event.defaultPrevented).toBe(true)
      expect(app.repointed).toEqual([{ itemId: "file", path: "/tmp/render/b.png" }])
      await app.press("ArrowLeft")
      expect(app.repointed.at(-1)).toEqual({ itemId: "file", path: "/tmp/render/c.png" })
    })

    it("step twice running, though the viewer is drawn again for each file, as its name and path change", async () => {
      // Newest first: a, c, b. From a, two presses reach b.
      const app = await shown({ file: { path: "/tmp/render/a.png", name: "a.png" } })
      // What the viewer library mounts into the pane's element, which it takes down and makes
      // anew as the file's name changes, with the focus it held.
      const viewer = () => app.root.querySelector<HTMLElement>(".artifact-image > *")
      const first = viewer()
      expect(first).not.toBeNull()
      first!.focus()
      expect(document.activeElement).toBe(first)
      await app.press("ArrowRight")
      await app.press("ArrowRight")
      expect(app.repointed).toEqual([
        { itemId: "file", path: "/tmp/render/c.png" },
        { itemId: "file", path: "/tmp/render/b.png" },
      ])
      expect(viewer()).not.toBe(first)
      // Focus came back to the pane when the viewer that held it went.
      expect(document.activeElement?.tagName).not.toBe("BODY")
    })

    it("step with focus on the pane itself, as a tab opened from the taskbar leaves it", async () => {
      const app = await shown()
      app.root.querySelector("section")?.focus()
      await app.press("ArrowRight", { from: "pane" })
      expect(app.repointed).toEqual([{ itemId: "file", path: "/tmp/render/b.png" }])
    })

    it("step with focus on a tool of the row, and leave the pane's own tab list its arrows", async () => {
      const app = await shown()
      const tool = app.next()!
      act(
        () =>
          void tool.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
          ),
      )
      await settle()
      expect(app.repointed).toHaveLength(1)
      const tabs = document.createElement("div")
      tabs.setAttribute("role", "tablist")
      app.root.querySelector("section")?.appendChild(tabs)
      act(
        () =>
          void tabs.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
          ),
      )
      await settle()
      expect(app.repointed).toHaveLength(1)
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

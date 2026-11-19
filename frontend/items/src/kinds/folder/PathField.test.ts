import type {
  Companions,
  FolderEntry,
  FolderMatch,
  Item,
  ItemContent,
  WroteFolder,
} from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeAll, vi } from "vitest"

import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { folder as registration } from "./index"

// jsdom has no resizes; the tooltip over Up asks for them as it shows.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))
beforeAll(() => import("./FolderView"))

const target = { projectId: "project", workspaceSessionId: "initial" }
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
// Past the pause after typing, before the runner is asked which folders the text may be.
const typingPause = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 200)))

const entry = (name: string): FolderEntry => ({
  name,
  kind: "image",
  size: 2048,
  modifiedAt: 1_000,
  children: null,
  secret: false,
  link: false,
  stamp: `${name}-stamp`,
})

const listing: ItemContent = {
  state: "ready",
  stamp: "top",
  content: {
    kind: "folder",
    path: "/tmp/render",
    within: "",
    entries: [entry("shot.png")],
    total: 1,
    truncated: false,
  },
}

const minute = 60_000

// The folder item in a terminal's pane, over a runner that knows these folders and writes, and
// answers the attach as `attach` says.
const shown = async ({
  matches = [],
  wrote = [],
  others = [],
  attach = async () => {},
  item: itemOver = {},
}: {
  item?: Partial<Item>
  matches?: readonly FolderMatch[]
  wrote?: readonly WroteFolder[]
  others?: readonly Item[]
  attach?: (path: string) => Promise<void>
} = {}) => {
  const item = itemFixture("render", "01", {
    kind: "folder",
    name: "render",
    path: "/tmp/render",
    shownAt: Date.now() - 2 * minute,
    ...itemOver,
  })
  const attached: string[] = []
  const asked: string[] = []
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      on(listing)
      return () => {}
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
    attach: async (_target, _terminal, path) => {
      attached.push(path)
      await attach(path)
      return item
    },
    folders: async (_target, _terminal, path) => {
      asked.push(path)
      return matches
    },
    wroteTo: async () => wrote,
  }
  const workspace = createWorkspaceStore(
    [item, ...others].reduce(
      (state, each) => workspaceReducer(state, { type: "item/upsert", target, item: each }),
      workspaceFixture(),
    ),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  // What reaches the pane around the folder, as its taskbar hears every key from inside it.
  const heard: string[] = []
  const rendered = render(
    createElement(
      "div",
      { onKeyDown: (event: { key: string }) => heard.push(event.key) },
      createElement(registration.View, { item, itemStore, target }),
    ),
  )
  unmounts.push(rendered.unmount)
  await settle()
  const root = rendered.container
  const field = () => root.querySelector<HTMLInputElement>(".folder-field-input")
  const keydown = async (
    init: KeyboardEventInit,
    on: Element = field() ?? root.firstElementChild!,
  ) => {
    act(() => {
      on.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
    })
    await settle()
  }
  return {
    root,
    attached,
    asked,
    heard,
    field,
    keydown,
    // Ctrl+L, in the folder's body.
    open: async () => {
      await keydown({ key: "l", ctrlKey: true }, root.querySelector(".folder-viewer")!)
      await settle()
    },
    // Types the text and returns at once, before the runner could have been asked.
    typeNow: (text: string) =>
      act(() => {
        const input = field()!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      }),
    type: async (text: string) => {
      act(() => {
        const input = field()!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await typingPause()
    },
    options: () =>
      [...root.querySelectorAll(".folder-field-option")].map((each) => ({
        path: each.querySelector("code")!.textContent,
        meta: each.querySelector("small")!.textContent,
        highlighted: each.hasAttribute("data-highlighted"),
      })),
    labels: () => [...root.querySelectorAll(".folder-field-label")].map((each) => each.textContent),
  }
}

const moth = (path: string, over: Partial<Item> = {}) =>
  itemFixture(`id${path}`, "01", {
    kind: "folder",
    name: path.split("/").at(-1)!,
    path,
    shownAt: Date.now() - 2 * minute,
    ...over,
  })

describe("a folder's path field", () => {
  context("opening it", () => {
    it("is the crumbs line until Ctrl+L turns it into a field holding the folder's path, selected", async () => {
      const app = await shown()
      expect(app.field()).toBeNull()
      await app.open()
      const field = app.field()!
      expect(field.value).toBe("/tmp/render")
      expect(field.selectionStart).toBe(0)
      expect(field.selectionEnd).toBe("/tmp/render".length)
      expect(document.activeElement).toBe(field)
      expect(app.root.querySelector(".folder-path")).toBeNull()
    })

    it("opens on a click on the path's text, but a click on a crumb goes to its folder", async () => {
      const app = await shown()
      const click = async (element: Element) => {
        act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
        await settle()
      }
      await click(app.root.querySelector(".folder-crumb")!)
      expect(app.field()).toBeNull()
      await click(app.root.querySelector(".folder-above")!)
      expect(app.field()).not.toBeNull()
    })

    it("leaves Backspace to the text, not to the way up", async () => {
      const app = await shown()
      await app.open()
      await app.keydown({ key: "Backspace" })
      expect(app.field()).not.toBeNull()
    })

    it("tells Up's tooltip at the top that Ctrl+L opens another", async () => {
      const app = await shown()
      const up = app.root.querySelector<HTMLElement>(".folder-up")!
      act(() => {
        up.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }))
      })
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)))
      expect(document.body.textContent).toContain("render is the top of this folder · ")
      expect(document.body.textContent).toMatch(/(Ctrl\+L|⌘L) opens another/)
    })
  })

  context("closing it", () => {
    it("puts the crumbs back on Escape, with focus on the folder", async () => {
      const app = await shown()
      await app.open()
      await app.keydown({ key: "Escape" })
      expect(app.field()).toBeNull()
      expect(app.root.querySelector(".folder-crumb")).not.toBeNull()
      expect(document.activeElement).toBe(app.root.querySelector(".folder-viewer"))
    })

    it("keeps its Escape to itself, which would otherwise hide the pane", async () => {
      const app = await shown()
      await app.open()
      await app.keydown({ key: "Escape" })
      expect(app.heard).not.toContain("Escape")
    })

    it("puts the crumbs back as focus leaves the field", async () => {
      const app = await shown()
      await app.open()
      act(() => app.field()!.blur())
      await settle()
      expect(app.field()).toBeNull()
    })
  })

  context("opening what is typed", () => {
    it("asks the runner to show it on the terminal's bar on Enter, and puts the crumbs back", async () => {
      const app = await shown()
      await app.open()
      await app.type("/tmp/other/")
      await app.keydown({ key: "Enter" })
      expect(app.attached).toEqual(["/tmp/other"])
      expect(app.field()).toBeNull()
    })

    it("shows the runner's reason under the field and keeps it open when the path can't be shown", async () => {
      const app = await shown({
        attach: () => Promise.reject(new Error("That file doesn't exist.")),
      })
      await app.open()
      await app.type("/tmp/nothing.txt")
      await app.keydown({ key: "Enter" })
      expect(app.root.querySelector(".folder-field-problem")?.textContent).toBe(
        "That file doesn't exist.",
      )
      expect(app.field()?.getAttribute("aria-invalid")).toBe("true")
      // Typing again clears it.
      await app.type("/tmp/")
      expect(app.root.querySelector(".folder-field-problem")).toBeNull()
    })

    it("opens nothing for an empty field", async () => {
      const app = await shown()
      await app.open()
      await app.type("  ")
      await app.keydown({ key: "Enter" })
      expect(app.attached).toEqual([])
    })
  })

  context("its suggestions", () => {
    const matches: FolderMatch[] = [
      { path: "/tmp/render", count: 7, more: false, open: true },
      { path: "/tmp/release-notes", count: 2, more: false, open: false },
      { path: "/tmp/rebig", count: 1000, more: true, open: false },
    ]
    const wrote: WroteFolder[] = [
      { path: "/tmp/notes", handle: "raven", harness: "Codex", at: Date.now() - 4 * minute },
      {
        path: "~/.cache/probe",
        handle: "kite",
        harness: "Antigravity",
        at: Date.now() - 20 * minute,
      },
      { path: "/tmp/copy", handle: "moth", harness: "Claude Code", at: Date.now() - 6 * minute },
    ]
    const others = [
      moth("/work/by-agent"),
      moth("/work/by-person", { by: "person", from: null, shownAt: Date.now() - 60 * minute }),
      moth("/work/file", { kind: "file" }),
    ]

    it("show the groups that have something, in their order, each folder with its small text", async () => {
      const app = await shown({ matches, wrote, others })
      await app.open()
      // Until the text is changed there are no folders to find, only what was shown and written.
      expect(app.labels()).toEqual([
        "Shown by agents",
        "Agents wrote to, outside the project",
        "You opened",
      ])
      await app.type("/tmp/re")
      expect(app.labels()).toEqual([
        "Shown by agents",
        "Agents wrote to, outside the project",
        "You opened",
      ])
      expect(app.options()).toEqual([
        { path: "/tmp/render", meta: "open", highlighted: false },
        { path: "/tmp/release-notes", meta: "2 items", highlighted: false },
        { path: "/tmp/rebig", meta: "1000+ items", highlighted: false },
        { path: "/work/by-agent", meta: "@moth · 2m ago", highlighted: false },
        { path: "/tmp/notes", meta: "@raven · Codex · 4m ago", highlighted: false },
        { path: "~/.cache/probe", meta: "@kite · Antigravity · 20m ago", highlighted: false },
        { path: "/tmp/copy", meta: "@moth · Claude Code · 6m ago", highlighted: false },
        { path: "/work/by-person", meta: "1h ago", highlighted: false },
      ])
      expect(app.asked).toEqual(["/tmp/re"])
    })

    it("never complete or open a folder of an earlier prefix, while the runner has yet to answer", async () => {
      const app = await shown({ matches, wrote, others })
      await app.open()
      await app.type("/tmp/re")
      // Typed on at once: the answers still held are those of "/tmp/re".
      await app.typeNow("/tmp/ren")
      expect(app.options().map((each) => each.path)).toContain("/tmp/render")
      expect(app.options().map((each) => each.path)).not.toContain("/tmp/release-notes")
      await app.keydown({ key: "Tab" })
      expect(app.field()!.value).toBe("/tmp/render/")
      await app.typeNow("/tmp/x")
      expect(app.options().map((each) => each.path)).not.toContain("/tmp/release-notes")
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      act(() => void app.field()!.dispatchEvent(tab))
      expect(tab.defaultPrevented).toBe(true)
      await app.keydown({ key: "Enter" })
      expect(app.attached).toEqual(["/tmp/x"])
    })

    it("move with the arrows, wrapping round, and name the highlighted one to assistive technology", async () => {
      const app = await shown({ matches, wrote, others })
      await app.open()
      await app.type("/tmp/re")
      await app.keydown({ key: "ArrowDown" })
      expect(app.options().findIndex((each) => each.highlighted)).toBe(0)
      expect(app.field()!.getAttribute("aria-activedescendant")).toBe(
        app.root.querySelector("[data-highlighted]")!.id,
      )
      await app.keydown({ key: "ArrowUp" })
      expect(app.options().findIndex((each) => each.highlighted)).toBe(app.options().length - 1)
      await app.keydown({ key: "ArrowDown" })
      expect(app.options().findIndex((each) => each.highlighted)).toBe(0)
    })

    it("complete into the field on Tab, the highlighted one or else the first folder it may be", async () => {
      const app = await shown({ matches, wrote, others })
      await app.open()
      await app.type("/tmp/re")
      await app.keydown({ key: "Tab" })
      expect(app.field()!.value).toBe("/tmp/render/")
      expect(app.field()).not.toBeNull()
      await app.type("/tmp/re")
      await app.keydown({ key: "ArrowDown" })
      await app.keydown({ key: "ArrowDown" })
      await app.keydown({ key: "Tab" })
      expect(app.field()!.value).toBe("/tmp/release-notes/")
      expect(app.field()!.selectionStart).toBe("/tmp/release-notes/".length)
    })

    it("open the highlighted one on Enter, and one clicked, as the typed path opens", async () => {
      const app = await shown({ matches, wrote, others })
      await app.open()
      await app.type("/tmp/re")
      await app.keydown({ key: "ArrowDown" })
      await app.keydown({ key: "ArrowDown" })
      await app.keydown({ key: "Enter" })
      expect(app.attached).toEqual(["/tmp/release-notes"])
      await app.open()
      const written = app.root.querySelectorAll(".folder-field-option")
      act(() =>
        [...written]
          .find((each) => each.textContent?.includes("~/.cache/probe"))!
          .dispatchEvent(new MouseEvent("click", { bubbles: true })),
      )
      await settle()
      expect(app.attached).toEqual(["/tmp/release-notes", "~/.cache/probe"])
    })

    it("keep Tab in the field when there is no folder to complete, so the text isn't lost", async () => {
      const app = await shown({ others })
      await app.open()
      await app.type("/tmp/re")
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      act(() => void app.field()!.dispatchEvent(tab))
      expect(tab.defaultPrevented).toBe(true)
      expect(app.field()!.value).toBe("/tmp/re")
      // Pressed before the runner could have answered the text just typed: the same.
      const quick = await shown({ matches, others })
      await quick.open()
      await quick.typeNow("/tmp/zz")
      const early = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      act(() => void quick.field()!.dispatchEvent(early))
      expect(early.defaultPrevented).toBe(true)
      expect(quick.field()!.value).toBe("/tmp/zz")
    })

    it("lets Shift+Tab, and Tab in an empty field, go on as they do", async () => {
      const app = await shown({ matches, others })
      await app.open()
      await app.type("/tmp/re")
      const back = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
      act(() => void app.field()!.dispatchEvent(back))
      expect(back.defaultPrevented).toBe(false)
      await app.type("")
      const empty = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      act(() => void app.field()!.dispatchEvent(empty))
      expect(empty.defaultPrevented).toBe(false)
    })

    it("show no list at all, and say so, while nothing is near", async () => {
      const app = await shown({ item: { kind: "file" } })
      await app.open()
      await app.type("/tmp/re")
      expect(app.root.querySelector(".folder-field-list")).toBeNull()
      expect(app.field()!.getAttribute("aria-expanded")).toBe("false")
    })

    it("name no folder twice", async () => {
      const app = await shown({
        matches: [{ path: "/work/by-agent", count: 1, more: false, open: false }],
        others: [moth("/work/by-agent")],
      })
      await app.open()
      await app.type("/work/")
      expect(app.options().map((each) => each.path)).toEqual(["/work/by-agent", "/tmp/render"])
    })
  })
})

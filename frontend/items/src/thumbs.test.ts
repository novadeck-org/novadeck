import type { Companions, Item, ItemContent, ShownContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { registrationOf } from "./registry"
import { createItemStore } from "./state"
import { context, describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }

// A peek's miniature of `item`, which loads `load` once followed; `followed` counts the
// follows.
const peek = (item: Item, load: ItemContent) => {
  const followed: string[] = []
  const companions: Companions = {
    follow: (_target, id, _options, on) => {
      followed.push(id)
      on(load)
      return () => {}
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  const { Thumb } = registrationOf(item)
  const rendered = render(createElement(Thumb, { item, itemStore, target }))
  unmounts.push(rendered.unmount)
  return { ...rendered, followed }
}

const ready = (content: ShownContent): ItemContent => ({ state: "ready", stamp: "1", content })
const lines = ["# Brand voice", "", "## Words", "Plain.", "## Tone", "Warm."]

describe("a peek's miniature", () => {
  context("of something an agent showed", () => {
    it("shows an image, a code file's pointed lines, a document's outline and a page's frame", () => {
      const image = peek(
        itemFixture("hero", "01", { kind: "image", name: "hero.png" }),
        ready({ kind: "image", src: "blob:hero" }),
      )
      expect(image.container.querySelector("img")?.getAttribute("src")).toBe("blob:hero")

      const code = peek(
        itemFixture("app", "01", { kind: "file", name: "App.tsx" }),
        ready({
          kind: "file",
          path: "App.tsx",
          firstLine: 1,
          lines: ["a", "b", "c", "d"],
          from: 2,
          to: 3,
          total: 4,
          clamped: false,
          truncated: false,
        }),
      )
      expect(code.container.querySelector(".peek-code")?.textContent).toBe("b\nc")

      const document = peek(
        itemFixture("voice", "01", { kind: "file", name: "brand-voice.md" }),
        ready({
          kind: "file",
          path: "docs/brand-voice.md",
          firstLine: 1,
          lines,
          from: 1,
          to: lines.length,
          total: lines.length,
          clamped: false,
          truncated: false,
        }),
      )
      expect(document.container.querySelector(".peek-plan b")?.textContent).toBe("Brand voice")
      expect(
        [...document.container.querySelectorAll(".peek-plan span")].map((each) => each.textContent),
      ).toContain("Words")

      const page = peek(
        itemFixture("web", "01", { kind: "page", name: "localhost", path: null }),
        ready({ kind: "page", url: "http://localhost:5173/", shown: 1, live: false }),
      )
      expect(page.container.querySelector(".peek-page-url")?.textContent).toBe(
        "http://localhost:5173/",
      )
    })

    it("shows a change's size over its first paths", () => {
      const file = (path: string, status: "added" | "modified") => ({
        path,
        oldPath: null,
        status,
        added: 3,
        removed: 1,
        binary: false,
        held: false,
        listed: false,
        hunks: [],
      })
      const change = peek(
        itemFixture("change", "01", { kind: "changes", name: "Changes", path: "/repo" }),
        ready({
          kind: "changes",
          root: "/repo",
          base: "HEAD",
          truncated: false,
          files: [file("a.ts", "modified"), file("b.ts", "added")],
        }),
      )
      expect(
        [...change.container.querySelectorAll(".peek-changes span")].map(
          (each) => each.textContent,
        ),
      ).toEqual(["2 files  +6 −2", "a.ts", "b.ts"])
    })

    it("says why it can't show, and never loads one that may hold secrets", () => {
      const missing = peek(itemFixture("gone", "01"), {
        state: "unavailable",
        reason: "missing",
        size: null,
      })
      expect(missing.container.querySelector(".peek-held")?.textContent).toBe("Not there any more")

      const held = peek(
        itemFixture("env", "01", { held: true }),
        ready({
          kind: "page",
          url: "http://x/",
          shown: 1,
          live: false,
        }),
      )
      expect(held.container.querySelector(".peek-held")?.textContent).toBe(
        "May hold secrets. Click to open.",
      )
      expect(held.followed).toEqual([])
    })
  })
})

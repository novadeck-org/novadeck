import type { Companions, ItemContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { registry } from "./registry"
import { createItemStore } from "./state"
import { context, describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }
// A persisted item the runner now classifies as an image, while what it reports is still the
// file it was.
const item = itemFixture("clip", "01", { kind: "image", name: "clip.avif" })
const stale: ItemContent = {
  state: "ready",
  stamp: "1",
  content: {
    kind: "file",
    path: "clip.avif",
    firstLine: 1,
    lines: ["x"],
    total: 1,
    from: 1,
    to: 1,
    clamped: false,
    truncated: false,
  },
}

const show = () => {
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      on(stale)
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
  const rendered = render(
    createElement(registry.image.View, { item, itemStore, target, actions: undefined }),
  )
  unmounts.push(rendered.unmount)
  return rendered
}

describe("an artifact whose content is of another kind than its own", () => {
  context("while the runner reclassifies it", () => {
    it("stays blank and busy, as before any content, until what fits it arrives", () => {
      const { container } = show()
      const viewer = container.querySelector(".artifact-viewer")!
      expect(viewer.getAttribute("aria-busy")).toBe("true")
      expect(viewer.textContent).toBe("")
      expect(container.querySelector(".artifact-status")).not.toBeNull()
    })
  })
})

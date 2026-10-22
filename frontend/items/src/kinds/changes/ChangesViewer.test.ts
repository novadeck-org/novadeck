import type { ChangesContent, Companions } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { createItemStore } from "../../state"
import { context, describe, expect, it } from "../../test"
import { changes as registration } from "./index"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }
const item = itemFixture("change", "01", { kind: "changes", name: "Changes", path: "/repo" })

const change = (rest: Partial<ChangesContent> = {}): ChangesContent => ({
  kind: "changes",
  root: "/repo",
  base: "HEAD",
  truncated: false,
  files: [
    {
      path: "src/app.ts",
      oldPath: null,
      status: "modified",
      added: 2,
      removed: 1,
      binary: false,
      held: false,
      listed: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 3,
          lines: [
            { kind: "context", text: "a" },
            { kind: "remove", text: "b" },
            { kind: "add", text: "c" },
            { kind: "add", text: "d" },
          ],
        },
      ],
    },
    {
      path: "logo.png",
      oldPath: null,
      status: "added",
      added: 0,
      removed: 0,
      binary: true,
      held: false,
      listed: false,
      hunks: [],
    },
  ],
  ...rest,
})

// The pane's body for the change, loading what `content` holds through a fake backend.
const show = (content: ChangesContent) => {
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      on({ state: "ready", stamp: "1", content })
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
    createElement(registration.View, { item, itemStore, target, actions: undefined }),
  )
  unmounts.push(rendered.unmount)
  return rendered
}

describe("a change beside a terminal", () => {
  it("is registered as Changes", () => {
    expect(registration.kind).toBe("changes")
    expect(registration.names).toEqual({ one: "change", many: "Changes" })
  })

  context("with files", () => {
    it("says how much changed, and shows each file in the diff viewer", () => {
      const { container } = show(change())
      expect(container.querySelector(".artifact-meta")?.textContent).toContain(
        "2 files · +2 −1 · against HEAD · read-only",
      )
      expect(container.querySelectorAll(".diff-file")).toHaveLength(2)
      expect(container.querySelectorAll(".diff-line")).toHaveLength(4)
    })
  })

  context("with nothing changed", () => {
    it("says so", () => {
      const { container } = show(change({ files: [] }))
      expect(container.querySelector(".diff-empty")?.textContent).toBe("No changes against HEAD")
      expect(container.querySelector(".artifact-meta")?.textContent).toContain(
        "no changes against HEAD · read-only",
      )
    })
  })

  context("when it is larger than the backend shows", () => {
    it("says so", () => {
      const { container } = show(change({ truncated: true }))
      expect(container.querySelector(".diff-truncated")).not.toBeNull()
      expect(container.querySelector(".artifact-meta")?.textContent).toContain(
        "2 files, more than shown · +2 −1",
      )
    })
  })
})

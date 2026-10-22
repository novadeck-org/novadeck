import type { Companions, ItemContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { createItemStore } from "../../state"
import { context, describe, expect, it } from "../../test"
import { ProjectWindow } from "./ProjectWindow"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }

// The window over a file the backend reports as `load`, which no terminal shows.
const opened = async (item: ReturnType<typeof itemFixture>, load: ItemContent) => {
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
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
  const rendered = render(createElement(ProjectWindow, { itemStore, target, item }))
  unmounts.push(rendered.unmount)
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  return rendered
}

describe("the project window", () => {
  context("a Markdown file", () => {
    it("reads as a document labelled by the file's name, in no frame of a plan's", async () => {
      const item = itemFixture("readme", "01", {
        kind: "file",
        name: "README.md",
        path: "README.md",
      })
      const { container } = await opened(item, {
        state: "ready",
        stamp: "1",
        content: {
          kind: "file",
          path: "README.md",
          firstLine: 1,
          lines: ["# Hello"],
          from: 1,
          to: 1,
          total: 1,
          clamped: false,
          truncated: false,
        },
      })
      expect(container.querySelector("section.plan-reader[data-workspace-companion]")).toBeNull()
      expect(container.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("README.md")
    })
  })

  context("a file that may hold secrets", () => {
    it("offers to show it and to copy its path", async () => {
      const item = itemFixture("env", "01", { kind: "file", name: ".env", held: true })
      const { container } = await opened(item, { state: "unavailable", reason: "held", size: null })
      expect(
        [...container.querySelectorAll("div.artifact-window button")].map(
          (each) => each.textContent,
        ),
      ).toEqual(["Show it", "Copy path"])
    })
  })
})

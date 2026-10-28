import type { Companions, ItemContent, Item } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { createItemStore } from "../../state"
import { context, describe, expect, it } from "../../test"
import { UndockedWindow } from "./UndockedWindow"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }

const undocked = async (item: Item, load: ItemContent) => {
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
  const rendered = render(createElement(UndockedWindow, { itemStore, target, item }))
  unmounts.push(rendered.unmount)
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  return rendered
}

describe("an item undocked into a window", () => {
  context("a plan", () => {
    it("reads in the plan's frame, with its editor inside", async () => {
      const item = itemFixture("plan", "01", {
        kind: "plan",
        name: "plan.md",
        path: "plan.md",
        plan: { agent: "Codex", role: "root", source: "file" },
      })
      const { container } = await undocked(item, {
        state: "ready",
        stamp: "1",
        content: { kind: "plan", text: "# Plan\n", truncated: false, writable: true, skill: true },
      })
      const frame = container.querySelector(
        "div.artifact-window > section.plan-reader[data-workspace-companion]",
      )
      expect(frame?.getAttribute("aria-label")).toBe("Plan")
      expect(frame?.querySelector(".plan-editor")).not.toBeNull()
    })
  })

  context("an image that may hold secrets", () => {
    it("offers to show it and to copy its path, without a frame of its own", async () => {
      const item = itemFixture("env", "01", { kind: "image", name: "env.png", secret: true })
      const { container } = await undocked(item, {
        state: "unavailable",
        reason: "secret",
        size: null,
      })
      expect(container.querySelector("section.plan-reader")).toBeNull()
      expect(
        [...container.querySelectorAll("div.artifact-window button")].map(
          (each) => each.textContent,
        ),
      ).toEqual(["Show it", "Copy path"])
    })
  })

  context("a page", () => {
    it("shows its address in the browser frame", async () => {
      const url = "http://localhost:5173/"
      const item = itemFixture("web", "01", { kind: "page", name: "localhost", path: null, url })
      const { container } = await undocked(item, {
        state: "ready",
        stamp: "1",
        content: { kind: "page", url, shown: 1, live: false },
      })
      expect(container.querySelector("section.plan-reader")).toBeNull()
      expect(container.querySelector(".artifact-window .artifact-url")?.textContent).toBe(url)
    })
  })
})

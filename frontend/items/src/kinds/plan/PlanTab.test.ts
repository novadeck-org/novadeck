import type { Companions, ItemContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { PlanTab } from "./PlanTab"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const target = { projectId: "project", workspaceSessionId: "initial" }
const planItem = itemFixture("plan", "01", {
  kind: "plan",
  name: "Plan",
  path: "plan.md",
  plan: { agent: "Codex", role: "root", source: "file" },
})
const ready = (text: string, writable = true, stamp = "1"): ItemContent => ({
  state: "ready",
  stamp,
  content: { kind: "plan", text, truncated: false, writable, skill: true },
})

// A plan the test gives the content of, which nothing can save.
const shown = async () => {
  let emit: (content: ItemContent) => void = () => {}
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      emit = on
      on(ready("# Plan\n"))
      return () => {}
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item: planItem }),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  const { container, unmount } = render(
    createElement(PlanTab, { itemStore, target, item: planItem }),
  )
  unmounts.push(unmount)
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  // A new content applies once what it loads has, as revising a plan imports its sync.
  const emitted = async (content: ItemContent): Promise<void> => {
    await act(async () => {
      emit(content)
      await vi.dynamicImportSettled()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  return { itemStore, container, emit: emitted }
}

describe("a plan whose file can't be read for now", () => {
  context("when the person has edits that aren't saved", () => {
    it("keeps the editor and offers to copy the edits or retry, instead of hiding them", async () => {
      const { itemStore, container, emit } = await shown()
      act(() => itemStore.plan(target, planItem.id).edit("# Plan\nMine\n", []))
      await emit({ state: "unavailable", reason: "unreadable", size: null })

      expect(container.querySelector(".artifact-unavailable")).toBeNull()
      expect(container.querySelector(".pane-notice")?.textContent).toContain(
        "Novadeck can't read this plan right now, so your edits can't be saved.",
      )
      const buttons = [...container.querySelectorAll(".pane-notice button")].map(
        (each) => each.textContent,
      )
      expect(buttons).toEqual(["Copy my edits", "Retry"])
    })
  })

  context("when the person has no edits", () => {
    it("says so as any unavailable item does", async () => {
      const { container, emit } = await shown()
      await emit({ state: "unavailable", reason: "unreadable", size: null })
      expect(container.querySelector(".artifact-unavailable")).not.toBeNull()
    })
  })
})

describe("a plan in its editor", () => {
  it("is a Markdown document with the plan's notes", async () => {
    const { container } = await shown()
    expect(container.querySelector(".document-editor .cm-editor")).not.toBeNull()
    expect(container.querySelector(".document-editor .cm-plan-note-gutter")).not.toBeNull()
  })
})

describe("a plan the agent revised", () => {
  it("has a tool in the row for the changes since it was read, a count on it, which hides and shows them", async () => {
    const { container, emit } = await shown()
    expect(container.querySelector(".pane-tool")).toBeNull()
    await emit(ready("# Plan\nA new line\n", true, "2"))

    const tool = container.querySelector<HTMLButtonElement>(".pane-tool")!
    // A revision shows its changes at once.
    expect(tool.getAttribute("aria-label")).toMatch(/^Hide the \d+ changes? since you last read$/)
    expect(tool.getAttribute("aria-pressed")).toBe("true")
    expect(tool.querySelector(".pane-tool-badge")?.textContent).toMatch(/^\d+$/)
    // No toggle with words in a line of its own: the row says it.
    expect(container.querySelector(".plan-changes-toggle")).toBeNull()

    await act(async () => tool.click())
    expect(container.querySelector(".pane-tool")?.getAttribute("aria-pressed")).toBe("false")
    expect(container.querySelector(".pane-tool")?.getAttribute("aria-label")).toMatch(/^Show the/)
  })

  it("says nothing of where its edits save, only when they can't", async () => {
    const { container } = await shown()
    expect(container.textContent).not.toContain("Edits save to")
    expect(container.querySelector(".pane-notice")).toBeNull()
  })
})

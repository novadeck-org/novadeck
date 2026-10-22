import { EditorView } from "@codemirror/view"
import type { Items, ItemContent } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { createItemStore } from "../../../state"
import { describe, expect, it } from "../../../test"
import { PlanTab } from "../PlanTab"

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

// A plan in the companion that the test gives the content of, which nothing can save.
const shown = async () => {
  let emit: (content: ItemContent) => void = () => {}
  const companions: Items = {
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

describe("a plan that stops being writable, and is again", () => {
  it("keeps its editor, its undo history and its text", async () => {
    const { container, emit } = await shown()
    const editor = container.querySelector<HTMLElement>(".cm-editor")!
    const view = EditorView.findFromDOM(editor)!
    act(() => view.dispatch({ changes: { from: 0, insert: "Mine " }, userEvent: "input.type" }))
    expect(view.state.doc.toString()).toBe("Mine # Plan\n")

    await emit(ready("Mine # Plan\n", false, "2"))
    expect(container.querySelector(".cm-editor")).toBe(editor)
    expect(container.querySelector(".plan-editor")?.hasAttribute("data-readonly")).toBe(true)
    expect(view.state.readOnly).toBe(true)

    await emit(ready("Mine # Plan\n", true, "3"))
    expect(container.querySelector(".cm-editor")).toBe(editor)
    expect(view.state.readOnly).toBe(false)
    // Ctrl-Z, as the editor's history keymap takes it.
    act(
      () =>
        void view.contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true }),
        ),
    )
    expect(view.state.doc.toString()).toBe("# Plan\n")
  })
})

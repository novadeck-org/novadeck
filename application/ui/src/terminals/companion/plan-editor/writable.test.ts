import { EditorView } from "@codemirror/view"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import type { Companions, ItemContent } from "../../../model/companion"
import { workspaceReducer } from "../../../model/state"
import { createWorkspaceStore } from "../../../model/store"
import { describe, expect, it } from "../../../test"
import { itemFixture, workspaceFixture } from "../../../test/fixtures"
import { render } from "../../../test/render"
import { PlanTab } from "../CompanionPane"
import { createPanes } from "../state"

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
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      emit = on
      on(ready("# Plan\n"))
      return () => {}
    },
    save: () => new Promise(() => {}),
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item: planItem }),
  )
  const panes = createPanes({ companions, workspace })
  unmounts.push(panes.connect())
  const { container, unmount } = render(createElement(PlanTab, { panes, target, item: planItem }))
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
  return { panes, container, emit: emitted }
}

describe("a plan that stops being writable, and is again", () => {
  it("keeps its editor, its undo history and its text", async () => {
    const { container, emit } = await shown()
    const editor = container.querySelector<HTMLElement>(".cm-editor")!
    const view = EditorView.findFromDOM(editor)!
    view.dispatch({ changes: { from: 0, insert: "Mine " }, userEvent: "input.type" })
    expect(view.state.doc.toString()).toBe("Mine # Plan\n")

    await emit(ready("Mine # Plan\n", false, "2"))
    expect(container.querySelector(".cm-editor")).toBe(editor)
    expect(container.querySelector(".plan-editor")?.hasAttribute("data-readonly")).toBe(true)
    expect(view.state.readOnly).toBe(true)

    await emit(ready("Mine # Plan\n", true, "3"))
    expect(container.querySelector(".cm-editor")).toBe(editor)
    expect(view.state.readOnly).toBe(false)
    // Ctrl-Z, as the editor's history keymap takes it.
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true }),
    )
    expect(view.state.doc.toString()).toBe("# Plan\n")
  })
})

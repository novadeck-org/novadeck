import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import type { Companions, ItemContent } from "../../model/companion"
import { workspaceReducer } from "../../model/state"
import { createWorkspaceStore } from "../../model/store"
import { context, describe, expect, it } from "../../test"
import { itemFixture, workspaceFixture } from "../../test/fixtures"
import { render } from "../../test/render"
import { PlanTab } from "./CompanionPane"
import { createPanes } from "./state"

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

describe("a plan whose file can't be read for now", () => {
  context("when the person has edits that aren't saved", () => {
    it("keeps the editor and offers to copy the edits or retry, instead of hiding them", async () => {
      const { panes, container, emit } = await shown()
      panes.plan(target, planItem.id).edit("# Plan\nMine\n", [])
      await emit({ state: "unavailable", reason: "unreadable", size: null })

      expect(container.querySelector(".artifact-unavailable")).toBeNull()
      expect(container.querySelector(".plan-notice")?.textContent).toContain(
        "Novadeck can't read this plan right now, so your edits can't be saved.",
      )
      const buttons = [...container.querySelectorAll(".plan-notice button")].map(
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

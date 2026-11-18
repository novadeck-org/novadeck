import { itemIdOf } from "@novadeck/core/items"
import type { BarKey } from "@novadeck/core/items/companion-bar"
import { barOf } from "@novadeck/core/items/transitions"
import { workspaceReducer } from "@novadeck/core/state"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import type { WorkspaceState } from "@novadeck/core/types"

import { barMembers, composeBar, shownTab, slotOf } from "../../bar/bar"
import { context, describe, expect, it } from "../../test"

const target = { projectId: "project", workspaceSessionId: "initial" }

// What a terminal's bar is once the runner reports its items, as the workspace takes them.
const reported = (...items: ReturnType<typeof itemFixture>[]) => {
  let workspace = workspaceFixture()
  for (const item of items)
    workspace = workspaceReducer(workspace, { type: "item/upsert", target, item })
  const state: WorkspaceState = workspace.projects[0]!.history[0]!.state
  const bar = barOf(state, "01")
  const members = barMembers({
    terminalId: "01",
    bar,
    items: state.items,
    fresh: state.fresh,
    messages: false,
  })
  const slots = composeBar(bar, members)
  const showing = shownTab(bar, members)
  return { bar, slots, showing, state, groupOf: (key: BarKey | null) => slotOf(slots, key) }
}

describe("a file opened from a folder", () => {
  const render = itemFixture("render", "01", {
    kind: "folder",
    name: "render",
    path: "/tmp/render",
    openAsked: true,
    by: "person",
  })
  const opened = (id: string, kind: "image" | "file" | "pdf") =>
    itemFixture(id, "01", {
      kind,
      name: `${id}.x`,
      path: `/tmp/render/${id}`,
      openAsked: true,
      by: "person",
      shownAt: 5,
    })

  context("as the pane takes it", () => {
    it("opens as a tab of its own kind's group on top, not in the folder's group", () => {
      const { showing, groupOf } = reported(render, opened("shot", "image"))
      expect(showing).toBe("shot")
      expect(groupOf(itemIdOf("shot"))?.stack).toBeNull()
      expect(groupOf(itemIdOf("render"))?.members.map((member) => member.key)).toEqual(["render"])
    })

    it("joins the group of files of its kind, each a tab, beside the folder's own", () => {
      const { showing, groupOf, slots } = reported(
        render,
        opened("one", "image"),
        opened("two", "image"),
        opened("report", "pdf"),
      )
      expect(showing).toBe("report")
      expect(groupOf(itemIdOf("two"))?.stack).toBe("image")
      expect(groupOf(itemIdOf("two"))?.members.map((member) => member.key)).toEqual(["one", "two"])
      // The folder and the PDF are groups of their own.
      expect(slots.map((slot) => slot.key)).toEqual(["render", "stack:image", "report"])
    })

    it("keeps open folders together in a group of their own", () => {
      const other = itemFixture("other", "01", {
        kind: "folder",
        name: "other",
        path: "/tmp/other",
      })
      const { groupOf } = reported(render, other, opened("shot", "image"))
      expect(groupOf(itemIdOf("other"))?.stack).toBe("folder")
      expect(groupOf(itemIdOf("render"))?.members.map((member) => member.key)).toEqual([
        "render",
        "other",
      ])
    })
  })
})

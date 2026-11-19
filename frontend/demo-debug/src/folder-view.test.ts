import { itemIdOf, type Item, type ItemContent } from "@novadeck/core/items"
import type { BackendAction } from "@novadeck/core/port"
import type { TerminalKey } from "@novadeck/core/types"
import { folderSamples } from "@novadeck/demo/showcase/folder-samples"
import { createShowcase } from "@novadeck/demo/showcase/simulation"
import { vi } from "vitest"

import { folderViewGroups } from "./folder-view"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

// The group's actions over a showcase, which reports what it shows as a session would.
const panel = () => {
  const showcase = createShowcase({ agents: [] })
  const reported: Item[] = []
  showcase.start(
    (actions: readonly BackendAction[]) => {
      for (const action of actions) if (action.type === "item/upsert") reported.push(action.item)
    },
    () => reported,
  )
  const [group] = folderViewGroups(showcase)
  const run = (label: string) =>
    void group!.actions
      .find((action) => action.label === label)!
      .run({
        selected: () => key,
        workspace: () => undefined,
        note: () => {},
      } as unknown as DemoActionContext)
  const listing = (id: string, within = "") => {
    let seen: ItemContent | undefined
    showcase.follow(key, itemIdOf(id), { reveal: undefined, within }, (next) => (seen = next))()
    return seen
  }
  return { showcase, reported, run, listing }
}

const names = (content: ItemContent | undefined) =>
  content?.state === "ready" && content.content.kind === "folder"
    ? content.content.entries.map((entry) => entry.name)
    : []

describe("the debug panel's folder group", () => {
  it("is absent where the demo has no showcase", () => {
    expect(folderViewGroups(undefined)).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = folderViewGroups(createShowcase({ agents: [] }))
    expect(group!.section).toBe("Agents")
    expect(group!.actions.map((action) => action.label)).toEqual([
      "Show a folder",
      "Open a file of the folder",
      "A file lands in the folder",
      "A file is being written",
      "Show a folder with nothing in it",
      "Show a folder too large to list whole",
      "Show a folder that may hold secrets",
      "The folder goes away",
      "Bring the folder back",
    ])
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("shows each state's folder on the selected terminal's bar", () => {
    const { run, reported, listing } = panel()
    run("Show a folder")
    run("Show a folder with nothing in it")
    run("Show a folder too large to list whole")
    run("Show a folder that may hold secrets")
    expect(reported.map((item) => [item.kind, item.name])).toEqual([
      ["folder", "render"],
      ["folder", "empty-run"],
      ["folder", "node_modules"],
      ["folder", ".ssh"],
    ])
    expect(names(listing("dev-render"))).toContain("order-summary.svg")
    expect(names(listing("debug-folder-empty"))).toEqual([])
    expect(listing("debug-folder-huge")).toMatchObject({
      state: "ready",
      content: { total: 5000, truncated: true },
    })
    expect(listing("debug-folder-secret")).toMatchObject({ state: "unavailable", reason: "secret" })
  })

  it("lists a folder inside the folder, and says one that isn't there is missing", () => {
    const { run, listing } = panel()
    run("Show a folder")
    expect(names(listing("dev-render", "old-runs"))).toEqual([
      "notes",
      "run-1-cart.svg",
      "run-1-home.svg",
    ])
    expect(listing("dev-render", "nowhere")).toMatchObject({
      state: "unavailable",
      reason: "missing",
    })
  })

  it("opens the newest still of the folder as a double-click would, in a kind of its own", async () => {
    const { run, reported } = panel()
    run("Show a folder")
    run("Open a file of the folder")
    // The showcase answers once the folders' samples have loaded.
    await vi.waitFor(() =>
      expect(reported.at(-1)).toMatchObject({
        kind: "image",
        name: "checkout-desktop.svg",
        path: "~/render/checkout-desktop.svg",
        by: "person",
      }),
    )
  })

  it("lands a file on top", () => {
    const { run, listing } = panel()
    run("Show a folder")
    const before = names(listing("dev-render")).length
    run("A file lands in the folder")
    expect(names(listing("dev-render"))).toHaveLength(before + 1)
    expect(names(listing("dev-render"))).toContain("checkout-run-1.svg")
  })

  it("takes the folder away and brings it back", () => {
    const { run, listing } = panel()
    run("Show a folder")
    run("The folder goes away")
    expect(listing("dev-render")).toMatchObject({ state: "unavailable", reason: "gone" })
    run("Bring the folder back")
    expect(listing("dev-render")?.state).toBe("ready")
    expect(folderSamples.render.folder.state).toBe("ready")
  })

  it("reads a file of the folder in parts, and holds a secret one back", async () => {
    const { showcase, run } = panel()
    run("Show a folder")
    const stamp = (name: string) => {
      const content = folderSamples.render.folder.list("")
      return content?.state === "ready" && content.content.kind === "folder"
        ? content.content.entries.find((entry) => entry.name === name)!.stamp
        : ""
    }
    const part = await showcase.part!(key, itemIdOf("dev-render"), {
      stamp: stamp("order-summary.svg"),
      offset: 0,
      reveal: undefined,
      path: "order-summary.svg",
    })
    expect(part.state).toBe("part")
    expect(
      await showcase.part!(key, itemIdOf("dev-render"), {
        stamp: "",
        offset: 0,
        reveal: undefined,
        path: ".env",
      }),
    ).toEqual({ state: "unavailable", reason: "secret" })
  })
})

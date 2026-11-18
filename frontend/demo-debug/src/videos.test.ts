import { itemIdOf, type Item, type ItemContent } from "@novadeck/core/items"
import type { BackendAction } from "@novadeck/core/port"
import type { TerminalKey } from "@novadeck/core/types"
import { createShowcase } from "@novadeck/demo/showcase/simulation"

import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"
import { videoGroups } from "./videos"

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
  const notes: string[] = []
  const [group] = videoGroups(showcase)
  const run = (label: string, selected: TerminalKey | null = key) =>
    void group!.actions
      .find((action) => action.label === label)!
      .run({
        selected: () => selected ?? undefined,
        workspace: () => undefined,
        note: (text: string) => notes.push(text),
      } as unknown as DemoActionContext)
  const content = (id: string) => {
    let seen: ItemContent | undefined
    showcase.follow(key, itemIdOf(id), { reveal: undefined }, (next) => (seen = next))()
    return seen
  }
  return { showcase, reported, notes, run, content }
}

describe("the debug panel's Video group", () => {
  it("is absent where the demo has no showcase", () => {
    expect(videoGroups(undefined)).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = videoGroups(createShowcase({ agents: [] }))
    expect(group!.section).toBe("Agents")
    expect(group!.actions.map((action) => action.label)).toContain("Show a video")
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("shows each state's video on the selected terminal's bar", () => {
    const { run, reported, content } = panel()
    run("Show a video")
    run("Show a video too large to play")
    run("Show a video that's gone")
    expect(reported.map((item) => [item.kind, item.name, item.holder])).toEqual([
      ["video", "walkthrough.webm", { terminalId: "01" }],
      ["video", "launch-film.webm", { terminalId: "01" }],
      ["video", "old-cut.webm", { terminalId: "01" }],
    ])
    expect(content("studio-walkthrough")).toMatchObject({
      state: "ready",
      content: { kind: "video", mime: "video/webm", shown: 1 },
    })
    expect(content("studio-large")).toMatchObject({ state: "unavailable", reason: "too-large" })
    expect(content("studio-gone")).toMatchObject({ state: "unavailable", reason: "missing" })
  })

  it("shows the video again from a second, or as a rewritten file, a later show each time", () => {
    const { run, content } = panel()
    run("Show a video")
    run("Show the video again from 0:02")
    expect(content("studio-walkthrough")).toMatchObject({
      stamp: "1",
      content: { shown: 2, at: 2 },
    })
    run("Rewrite the video")
    const rewritten = content("studio-walkthrough")
    expect(rewritten).toMatchObject({ content: { shown: 3 } })
    expect(rewritten?.state === "ready" && rewritten.stamp).not.toBe("1")
  })

  it("asks for a terminal first", () => {
    const { run, notes, reported } = panel()
    run("Show a video", null)
    expect(notes).toEqual(["Select a terminal first."])
    expect(reported).toEqual([])
  })
})

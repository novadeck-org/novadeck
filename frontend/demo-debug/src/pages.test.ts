import { itemIdOf, type Item, type ItemContent } from "@novadeck/core/items"
import type { BackendAction } from "@novadeck/core/port"
import type { TerminalKey } from "@novadeck/core/types"
import { createShowcase } from "@novadeck/demo/showcase/simulation"

import { pageGroups } from "./pages"
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
  const notes: string[] = []
  const [group] = pageGroups(showcase)
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
  // A file beside the page, read whole as the pane reads it.
  const beside = async (id: string, file: string) => {
    const read = await showcase.part!(key, itemIdOf(id), {
      stamp: "",
      offset: 0,
      reveal: undefined,
      file,
    })
    return read.state === "part" ? new TextDecoder().decode(read.bytes) : read
  }
  return { reported, notes, run, content, beside }
}

describe("the debug panel's web page group", () => {
  it("is absent where the demo has no showcase", () => {
    expect(pageGroups(undefined)).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = pageGroups(createShowcase({ agents: [] }))
    expect(group!.section).toBe("Agents")
    expect(group!.actions.map((action) => action.label)).toEqual([
      "Show a web page",
      "Show a web page that loads slowly",
      "Show a web page whose files are missing",
      "Show a web page with no styles",
      "Show a web page too long to draw",
      "Rewrite the page's stylesheet",
      "Stop the page viewer",
    ])
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("shows the strip as an HTML file with its stylesheet and pictures beside it", async () => {
    const { run, reported, content, beside } = panel()
    run("Show a web page")
    expect(reported.map((item) => [item.kind, item.name, item.holder])).toEqual([
      ["file", "strip.html", { terminalId: "01" }],
    ])
    const page = content("studio-strip")
    expect(page).toMatchObject({ state: "ready", content: { kind: "file", truncated: false } })
    const lines = page?.state === "ready" && page.content.kind === "file" ? page.content.lines : []
    expect(lines.join("\n")).toContain('<link rel="stylesheet" href="strip.css">')
    expect(await beside("studio-strip", "strip.css")).toContain(".strip { display: grid")
    expect(await beside("studio-strip", "img/one.svg")).toContain("<svg")
    expect(await beside("studio-strip", "img/missing.svg")).toEqual({
      state: "unavailable",
      reason: "missing",
    })
  })

  it("shows a page with nothing beside it, and one too long to draw", async () => {
    const { run, content, beside } = panel()
    run("Show a web page whose files are missing")
    run("Show a web page too long to draw")
    expect(await beside("studio-strip-bare", "strip.css")).toEqual({
      state: "unavailable",
      reason: "missing",
    })
    expect(content("studio-strip-long")).toMatchObject({
      state: "ready",
      content: { kind: "file", truncated: true },
    })
  })

  it("rewrites the stylesheet under a new stamp each time, on another ground", async () => {
    const { run, content, beside } = panel()
    run("Show a web page")
    const first = await beside("studio-strip", "strip.css")
    run("Rewrite the page's stylesheet")
    const rewritten = content("studio-strip")
    expect(rewritten?.state === "ready" && rewritten.stamp).toBe("rewritten-1")
    expect(await beside("studio-strip", "strip.css")).not.toBe(first)
    run("Rewrite the page's stylesheet")
    const again = content("studio-strip")
    expect(again?.state === "ready" && again.stamp).toBe("rewritten-2")
  })

  it("asks for a terminal first", () => {
    const { run, notes, reported } = panel()
    run("Show a web page", null)
    expect(notes).toEqual(["Select a terminal first."])
    expect(reported).toEqual([])
  })
})

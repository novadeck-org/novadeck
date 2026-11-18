import { itemIdOf, type Item, type ItemContent } from "@novadeck/core/items"
import type { BackendAction } from "@novadeck/core/port"
import type { TerminalKey } from "@novadeck/core/types"
import { createShowcase } from "@novadeck/demo/showcase/simulation"

import { pdfGroups } from "./pdfs"
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
  const [group] = pdfGroups(showcase)
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
  const read = (id: string, reveal?: string) =>
    showcase.part!(key, itemIdOf(id), { stamp: "1", offset: 0, reveal })
  return { reported, notes, run, content, read }
}

const header = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5))

describe("the debug panel's PDF group", () => {
  it("is absent where the demo has no showcase", () => {
    expect(pdfGroups(undefined)).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = pdfGroups(createShowcase({ agents: [] }))
    expect(group!.section).toBe("Agents")
    expect(group!.actions.map((action) => action.label)).toEqual([
      "Show a PDF",
      "Show a PDF that loads slowly",
      "Show a PDF too large to preview",
      "Show a PDF that may hold secrets",
      "Show a file that isn't a PDF",
      "Rewrite the PDF",
    ])
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("shows each state's PDF on the selected terminal's bar", async () => {
    const { run, reported, content, read } = panel()
    run("Show a PDF")
    run("Show a PDF too large to preview")
    run("Show a file that isn't a PDF")
    expect(reported.map((item) => [item.kind, item.name, item.holder])).toEqual([
      ["pdf", "quarterly-report.pdf", { terminalId: "01" }],
      ["pdf", "annual-review.pdf", { terminalId: "01" }],
      ["pdf", "broken.pdf", { terminalId: "01" }],
    ])
    expect(content("studio-report")).toMatchObject({ state: "ready", content: { kind: "pdf" } })
    expect(content("studio-report-large")).toMatchObject({
      state: "unavailable",
      reason: "too-large",
    })
    const real = await read("studio-report")
    expect(real.state === "part" && header(real.bytes)).toBe("%PDF-")
    const broken = await read("studio-report-broken")
    expect(broken.state === "part" && header(broken.bytes)).not.toBe("%PDF-")
  })

  it("reads the slow one in small parts, and holds the secret one back until revealed", async () => {
    const { run, reported, read } = panel()
    run("Show a PDF that loads slowly")
    run("Show a PDF that may hold secrets")
    expect(reported.find((item) => item.secret)?.name).toBe("salaries.pdf")
    const part = await read("studio-report-slow")
    expect(part.state === "part" && part.bytes.length).toBe(512)
    expect(await read("studio-report-private")).toEqual({
      state: "unavailable",
      reason: "secret",
    })
    const path = reported.find((item) => item.secret)?.path ?? undefined
    expect((await read("studio-report-private", path)).state).toBe("part")
  })

  it("rewrites the PDF under a new stamp each time", async () => {
    const { run, content, read } = panel()
    run("Show a PDF")
    run("Rewrite the PDF")
    const rewritten = content("studio-report")
    expect(rewritten?.state === "ready" && rewritten.stamp).toBe("rewritten-1")
    expect(await read("studio-report")).toEqual({ state: "changed" })
    run("Rewrite the PDF")
    const again = content("studio-report")
    expect(again?.state === "ready" && again.stamp).toBe("rewritten-2")
  })

  it("asks for a terminal first", () => {
    const { run, notes, reported } = panel()
    run("Show a PDF", null)
    expect(notes).toEqual(["Select a terminal first."])
    expect(reported).toEqual([])
  })
})

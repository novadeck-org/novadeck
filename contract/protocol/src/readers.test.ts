import { describe, expect, it } from "vitest"

import { isDropped, newer } from "./open.js"
import { answerReaders } from "./readers.js"

// What a UI of this build reads, through the contract's open schemas, of what a newer runner
// sends: values and variants this build doesn't know.
const read = (path: string, value: unknown): unknown => {
  const reader = answerReaders.reader(path.split("."))
  if (!reader) throw new Error(`${path} has no open parts`)
  return reader(value)
}

describe("answerReaders", () => {
  it("keeps an approval of an action it doesn't know, as one needing a newer Novadeck", () => {
    const approval = {
      type: "request",
      requestId: "r",
      from: "a",
      terminalId: "t",
      action: { type: "pause", for: 5 },
    }
    expect(read("terminals.approvals", approval)).toEqual({ ...approval, action: { type: newer } })
  })

  it("keeps a companion item of a kind it doesn't know", () => {
    const listed = read("companions.list", { items: [{ id: "i", kind: "hologram" }], windows: [] })
    expect(listed).toEqual({ items: [{ id: "i", kind: newer }], windows: [] })
  })

  // Never dropped, so the chat's items keep the runner's numbering.
  it("keeps a transcript item of a role or a note it doesn't know, as a placeholder", () => {
    const item = (fields: object) => ({
      index: 0,
      role: "assistant",
      kind: "text",
      text: "hi",
      ...fields,
    })
    const change = read("agents.transcript", {
      type: "items",
      items: [
        item({ role: "critic" }),
        item({ role: "note", note: { type: "weather" } }),
        item({}),
      ],
    })
    expect(change).toEqual({
      type: "items",
      items: [item({ role: newer }), item({ role: "note", note: { type: newer } }), item({})],
    })
  })

  it("reads an agent of a harness it doesn't know as `newer` wherever a terminal names it", () => {
    const summary = {
      id: "t",
      agent: "opencode",
      ready: "opencode",
      restingAgent: null,
      startup: null,
    }
    const listed = read("terminals.list", [summary]) as { agent: unknown; ready: unknown }[]
    expect([listed[0]!.agent, listed[0]!.ready]).toEqual([newer, newer])
  })

  it("reads a state it doesn't know as the catch-all its enum has", () => {
    const listed = read("terminals.list", [
      { id: "t", agent: null, activity: { state: "dreaming" } },
    ])
    expect(listed).toEqual([{ id: "t", agent: null, activity: { state: "unknown" } }])
  })

  it("drops a stream's item it can't keep, which the client then skips", () => {
    const rings = read("messages.rings", { rings: [{ parts: [{ kind: "telegram", text: "x" }] }] })
    expect(rings).toEqual({ rings: [{ parts: [] }] })
    expect(answerReaders.skips(read("agents.transcript", { type: "items", items: [] }))).toBe(false)
    expect(isDropped(undefined)).toBe(false)
  })

  it("reads the hottest streams as they come, at no cost", () => {
    expect(answerReaders.reader(["terminals", "attach"])).toBeUndefined()
    expect(answerReaders.reader(["terminals", "write"])).toBeUndefined()
  })
})

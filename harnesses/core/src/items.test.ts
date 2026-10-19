import { describe, expect, it } from "vitest"

import { entry } from "./items.js"
import type { ToolRun } from "./tools.js"

// A describe that shows what it was given.
const seen = (tool: string, input: string): ToolRun => ({
  kind: "other",
  title: tool,
  detail: input,
})

describe("an item's run", () => {
  it("is described on the call as the item carries it: its input cut at 16 KiB, its name at 256", () => {
    const call = entry("assistant", "tool-call", "x".repeat(20_000), {
      at: null,
      tool: "t".repeat(300),
      describe: seen,
    })
    expect(call.run).toEqual({ kind: "other", title: "t".repeat(256), detail: "x".repeat(16_384) })
  })

  it('describes a call whose tool is not text as "tool"', () => {
    expect(
      entry("assistant", "tool-call", "{}", { at: null, tool: 3, describe: seen }).run,
    ).toEqual({ kind: "other", title: "tool", detail: "{}" })
  })

  it("is null on every item that is not a call", () => {
    expect(entry("tool", "tool-result", "x", { at: null, describe: seen }).run).toBeNull()
    expect(entry("assistant", "text", "x", { at: null, describe: seen }).run).toBeNull()
  })
})

describe("an interrupted item", () => {
  const marker = "[Request interrupted by user for tool use]"

  it("is a user text item that is Claude Code's marker, however the harness wrote it", () => {
    expect(entry("user", "text", marker, { at: null }).interrupted).toBe(true)
    expect(
      entry("user", "text", `  [Request interrupted by user]\n`, { at: null }).interrupted,
    ).toBe(true)
  })

  it("is nothing else", () => {
    expect(entry("assistant", "text", marker, { at: null }).interrupted).toBe(false)
    expect(entry("user", "text", `${marker} and more`, { at: null }).interrupted).toBe(false)
    expect(entry("tool", "tool-result", marker, { at: null }).interrupted).toBe(false)
  })
})

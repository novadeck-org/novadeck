import { transcriptItem, type ToolRun } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { entry } from "./items.js"

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
    // Not a literal, so the types let a describe through where it isn't wanted.
    const fields = { at: null, describe: seen }
    expect(entry("tool", "tool-result", "x", fields).run).toBeNull()
    expect(entry("assistant", "text", "x", fields).run).toBeNull()
  })
})

describe("a tool call without a describe", () => {
  it("does not compile, and has no run if it gets past the types", () => {
    // @ts-expect-error A tool call must say how it is described.
    const call = entry("assistant", "tool-call", "{}", { at: null, tool: "Bash" })
    expect(call.run).toBeNull()
  })
})

describe("an interrupted item", () => {
  it("is a user text item its harness says records the interruption", () => {
    expect(entry("user", "text", "Interrupted", { at: null, interrupted: true }).interrupted).toBe(
      true,
    )
  })

  it("is nothing else, whatever its text holds", () => {
    const marker = "[Request interrupted by user]"
    expect(entry("user", "text", marker, { at: null }).interrupted).toBe(false)
    expect(entry("assistant", "text", marker, { at: null, interrupted: true }).interrupted).toBe(
      false,
    )
    expect(entry("tool", "tool-result", marker, { at: null, interrupted: true }).interrupted).toBe(
      false,
    )
  })
})

describe("the protocol's item", () => {
  const run: ToolRun = { kind: "run", title: "Ran", detail: "ls" }
  const call = {
    ...entry("assistant", "tool-call", "{}", { at: null, tool: "Bash", describe: seen }),
    index: 0,
  }

  it("has a run exactly on a tool call", () => {
    expect(transcriptItem.safeParse(call).success).toBe(true)
    expect(transcriptItem.safeParse({ ...call, run: null }).success).toBe(false)
    const text = { ...entry("user", "text", "hi", { at: null }), index: 1 }
    expect(transcriptItem.safeParse(text).success).toBe(true)
    expect(transcriptItem.safeParse({ ...text, run }).success).toBe(false)
  })
})

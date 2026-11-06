import { transcriptItem, transcriptLimits, type ToolRun } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import { entry } from "./items.js"

// A describe that shows what it was given.
const seen = (tool: string, input: string): ToolRun => ({
  kind: "other",
  title: tool,
  detail: input,
})

describe("an item's run", () => {
  it("is described on the call as the item carries it: its input and its name cut to the protocol's limits", () => {
    const call = entry("assistant", "tool-call", "x".repeat(transcriptLimits.text + 1000), {
      at: null,
      tool: "t".repeat(transcriptLimits.name + 50),
      describe: seen,
    })
    expect(call.run).toEqual({
      kind: "other",
      title: "t".repeat(transcriptLimits.name),
      detail: "x".repeat(transcriptLimits.text),
    })
    // Numbered as its harness's transcript reads it.
    expect(transcriptItem.safeParse({ ...call, index: 0 }).success).toBe(true)
  })

  it("leaves no half character where its text, tool or author is cut", () => {
    const at = (limit: number) => `${"x".repeat(limit - 1)}😀`
    const call = entry("assistant", "tool-call", at(transcriptLimits.text), {
      at: null,
      tool: at(transcriptLimits.name),
      author: at(transcriptLimits.name),
      describe: seen,
    })
    expect(call.text).toBe("x".repeat(transcriptLimits.text - 1))
    expect(call.truncated).toBe(true)
    expect(call.tool).toBe("x".repeat(transcriptLimits.name - 1))
    expect(call.author).toBe("x".repeat(transcriptLimits.name - 1))
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

describe("an item's outcome", () => {
  const known = { failed: true, exit: 3, running: false, size: null, change: null }

  it("stays on a tool call or its result", () => {
    expect(entry("tool", "tool-result", "x", { at: null, outcome: known }).outcome).toEqual(known)
    expect(
      entry("assistant", "tool-call", "{}", { at: null, outcome: known, describe: seen }).outcome,
    ).toEqual(known)
  })

  it("never reaches text, which the protocol refuses", () => {
    const item = entry("assistant", "text", "x", { at: null, outcome: known, scripted: true })
    expect(item).toMatchObject({ outcome: null, scripted: false })
    expect(() => transcriptItem.parse({ ...item, index: 0, outcome: known })).toThrow(
      /Only a tool call or its result/,
    )
  })

  it("is null where a decoder has none", () => {
    expect(entry("tool", "tool-result", "x", { at: null })).toMatchObject({
      outcome: null,
      scripted: false,
    })
  })
})

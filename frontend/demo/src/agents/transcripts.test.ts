import { describe, expect, it } from "vitest"

import { agentTranscripts, demoOutcome } from "./transcripts"

const run = { kind: "run", title: "Ran", detail: "" } as const

describe("what the demo's results say of their calls", () => {
  it("reads a command's code in each harness's words", () => {
    expect(demoOutcome(run, "{}", "Exit code 1\nboom")).toMatchObject({ failed: true, exit: 1 })
    expect(demoOutcome(run, "{}", "Exit code: 0\nOutput:\n")).toMatchObject({
      failed: false,
      exit: 0,
    })
    expect(demoOutcome(run, "{}", "Process exited with code 2\n")).toMatchObject({ exit: 2 })
    expect(demoOutcome(run, "{}", " M src/total.ts")).toMatchObject({ failed: false, exit: 0 })
  })

  it("says a command runs on in the background, with no word on how it ends", () => {
    expect(demoOutcome(run, "{}", "Command running in background with ID: 1.")).toMatchObject({
      failed: null,
      exit: null,
      running: true,
    })
  })

  it("counts what a read and a search found", () => {
    const read = { kind: "read", title: "Read", detail: "" } as const
    const search = { kind: "search", title: "Searched", detail: "" } as const
    expect(demoOutcome(read, "{}", "a\nb\n")?.size).toEqual({ count: 2, unit: "line" })
    expect(demoOutcome(search, "{}", "a\nb\nc")?.size).toEqual({ count: 3, unit: "match" })
  })

  it("reads an edit's lines from Claude Code's, Antigravity's and Codex's input", () => {
    const write = { kind: "write", title: "Edited", detail: "" } as const
    for (const input of [
      JSON.stringify({ old_string: "a", new_string: "b\nc" }),
      JSON.stringify({ TargetContent: "a", ReplacementContent: "b\nc" }),
      "*** Begin Patch\n*** Update File: x\n@@\n-a\n+b\n+c\n*** End Patch",
    ])
      expect(demoOutcome(write, input, "done")?.change).toEqual({
        added: 2,
        removed: 1,
        lines: [
          { sign: "-", text: "a", line: null },
          { sign: "+", text: "b", line: null },
          { sign: "+", text: "c", line: null },
        ],
      })
  })

  it("says nothing of a call of another kind", () => {
    expect(demoOutcome({ kind: "agent", title: "Subagent", detail: "" }, "{}", "ok")).toBeNull()
  })

  it("gives every harness's transcript the outcomes the look draws", () => {
    const items = Object.values(agentTranscripts(0)).flatMap((transcript) => transcript.items)
    const outcomes = items.flatMap((item) => (item.outcome ? [item.outcome] : []))
    expect(outcomes.some((outcome) => outcome.failed === true)).toBe(true)
    expect(outcomes.some((outcome) => outcome.running)).toBe(true)
    expect(outcomes.some((outcome) => outcome.size !== null)).toBe(true)
    expect(outcomes.some((outcome) => outcome.change !== null)).toBe(true)
    expect(items.some((item) => item.scripted)).toBe(true)
  })
})

describe("the demo's conversation with several turns", () => {
  it("gives Build three prompts for the chat's held prompt line to hand off between", () => {
    const { items } = agentTranscripts(Date.now())["06"]!
    const prompts = items.filter(({ role, kind }) => role === "user" && kind === "text")
    expect(prompts).toHaveLength(3)
    // The second is a prompt of several lines, so the line's cut and the peek show.
    expect(prompts[1]!.text).toContain("\n")
    // Each turn has an answer of its own after it.
    for (const prompt of prompts)
      expect(items.slice(items.indexOf(prompt)).some(({ role }) => role === "assistant")).toBe(true)
  })
})

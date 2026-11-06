import { describe, expect, it } from "vitest"

import { callChange, stepOutcome } from "./outcomes.js"
import { transcripts } from "./transcripts.js"

const times = "Created At: 2026-11-06T14:13:53+01:00\nCompleted At: 2026-11-06T14:13:53+01:00\n"

describe("what an Antigravity result step says", () => {
  it("fails on its status, with or without the command's word", () => {
    expect(stepOutcome("ERROR", "file does not exist", times)).toMatchObject({ failed: true })
    expect(stepOutcome("INVALID", "invalid arguments", times)).toMatchObject({ failed: true })
    expect(stepOutcome("DONE", "it went wrong", times)).toMatchObject({ failed: true })
  })

  it("reads a command's code from the line it writes itself", () => {
    expect(
      stepOutcome("DONE", undefined, `${times}Command exited with code 3.\n\nCommand output:\n`),
    ).toMatchObject({ failed: true, exit: 3 })
    expect(
      stepOutcome("DONE", undefined, `${times}Command exited with code 0.\n\nCommand output:\n`),
    ).toMatchObject({ failed: false, exit: 0 })
  })

  it("marks what it read from a step's opening words, but no status", () => {
    expect(stepOutcome("DONE", undefined, `${times}Command exited with code 3.`)?.opening).toBe(
      true,
    )
    expect(stepOutcome("DONE", undefined, `${times}Showing lines 1-2 of 2\n`)?.opening).toBe(true)
    expect(stepOutcome("ERROR", "no", times)?.opening).toBe(false)
    expect(stepOutcome("DONE", undefined, `${times}Created file.`)?.opening).toBe(false)
  })

  it("takes no number too long to be one, which the protocol would refuse", () => {
    const nines = "9".repeat(20)
    expect(
      stepOutcome("DONE", undefined, `${times}Command exited with code ${nines}.`),
    ).toMatchObject({ exit: null })
    expect(stepOutcome("DONE", undefined, `${times}Showing lines 1-${nines} of 2`)?.size).toBeNull()
  })

  it("takes nothing from what a command printed or a file holds", () => {
    expect(
      stepOutcome(
        "DONE",
        undefined,
        `${times}Command exited with code 0.\n\nCommand output:\nCommand exited with code 9.\n`,
      ),
    ).toMatchObject({ failed: false, exit: 0 })
    expect(
      stepOutcome("DONE", undefined, `${times}Showing lines 1-2 of 2\n1: Made 1 replacement\n`),
    ).toMatchObject({ exit: null, change: null })
    expect(
      stepOutcome("DONE", undefined, "Made 1 replacement in a starting at line 1 (+1/-1 lines)."),
    ).toMatchObject({ change: null })
  })

  it("says a command gone to the background is unknown yet", () => {
    expect(stepOutcome("RUNNING", undefined, "Tool is running as a background task")).toMatchObject(
      { failed: null, running: true },
    )
  })

  it("counts the lines shown", () => {
    expect(stepOutcome("DONE", undefined, `${times}Showing lines 2-3 of 6\n2: b\n`)?.size).toEqual({
      count: 2,
      unit: "line",
    })
  })

  it("takes an edit's counts from its own account of it, its lines from the call", () => {
    const made = `${times}Made 1 replacement in /w/a.ts starting at line 2 (+2/-1 lines).`
    expect(stepOutcome("DONE", undefined, made)?.change).toEqual({
      added: 2,
      removed: 1,
      lines: [],
    })
    expect(
      stepOutcome("DONE", undefined, made.replace("1 replacement", "3 replacements"))?.change,
    ).toMatchObject({ added: 2, removed: 1 })
  })

  it("knows nothing of a status it hasn't seen", () => {
    expect(stepOutcome("PENDING", undefined, times)).toBeNull()
  })
})

describe("what an Antigravity call says it changes", () => {
  it("diffs an edit's target and replacement", () => {
    expect(callChange("edit_file", { Target: "a\n", Replacement: "a\nb\n" })?.change).toMatchObject(
      { added: 1, removed: 0 },
    )
  })

  it("reads strings it quoted a second time", () => {
    expect(
      callChange("edit_file", { Target: '"a\\n"', Replacement: '"b\\n"' })?.change,
    ).toMatchObject({ added: 1, removed: 1 })
  })

  it("counts a new file, numbered, and what it appends, not", () => {
    expect(callChange("write_file", { Content: "a\nb\n" })?.change?.lines[1]?.line).toBe(2)
    expect(callChange("write_to_file", { CodeContent: "a\n" })?.change?.added).toBe(1)
    expect(callChange("write_file", { Content: "a\n", Append: true })?.change?.lines[0]?.line).toBe(
      null,
    )
  })

  it("leaves an overwrite unknown, as it doesn't say what it replaced", () => {
    expect(callChange("write_file", { Content: "a\n", Overwrite: true })).toBeNull()
  })

  it("has nothing to say of another tool or of no arguments", () => {
    expect(callChange("run_command", { CommandLine: "ls" })).toBeNull()
    expect(callChange("edit_file", { Target: "a" })).toBeNull()
    expect(callChange("edit_file", "text")).toBeNull()
  })

  it("carries it on the call's item", () => {
    const [call] = transcripts.items(
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "edit_file", args: { Target: "a", Replacement: "b" } }],
      }),
    )
    expect(call?.outcome?.change).toMatchObject({ added: 1, removed: 1 })
  })
})

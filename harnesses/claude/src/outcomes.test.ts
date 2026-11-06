import { describe, expect, it } from "vitest"

import { outcomeOf } from "./outcomes.js"
import { transcripts } from "./transcripts.js"

const result = (content: unknown, isError: boolean | undefined, detail?: unknown): string =>
  JSON.stringify({
    type: "user",
    timestamp: "2026-11-06T12:00:00.000Z",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content, is_error: isError }],
    },
    ...(detail === undefined ? {} : { toolUseResult: detail }),
  })

const outcome = (line: string) => transcripts.items(line)[0]!.outcome

describe("what a Claude Code result says", () => {
  it("fails only on its error mark, whatever the output says", () => {
    expect(outcome(result("Exit code 3\nnot really", false))).toMatchObject({
      failed: false,
      exit: null,
    })
  })

  it("reads a command's code from the line it opens a failure with", () => {
    expect(outcome(result("Exit code 3\nboom", true))).toMatchObject({ failed: true, exit: 3 })
    expect(outcome(result("boom\nExit code 3", true))).toMatchObject({ failed: true, exit: null })
  })

  it("reads a result with no mark as no failure", () => {
    expect(outcome(result("fine", undefined))).toMatchObject({ failed: false })
  })

  it("takes a command moved to the background past its timeout as running (2.1.319)", () => {
    const moved = {
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      backgroundTaskId: "bef890esj",
      timedOutAfterMs: 400_000,
    }
    expect(
      outcome(result("Command did not complete within its 400s timeout", false, moved)),
    ).toMatchObject({ failed: null, exit: null, running: true })
  })

  it("keeps a failed Edit's change out, as it never landed", () => {
    expect(
      outcomeOf(true, "no", { structuredPatch: [{ oldStart: 1, newStart: 1, lines: ["+a"] }] }),
    ).toMatchObject({ failed: true, change: null })
  })

  it("falls back on an Edit's strings where it recorded no patch", () => {
    expect(
      outcomeOf(false, "ok", { oldString: "a\n", newString: "a\nb\n", structuredPatch: [] }).change,
    ).toMatchObject({ added: 1, removed: 0 })
  })

  it("ignores a detail of no shape it knows", () => {
    expect(outcomeOf(false, "ok", { structuredPatch: [{ lines: [3] }] }).change).toBeNull()
    expect(outcomeOf(false, "ok", { type: "text", file: { numLines: "6" } }).size).toBeNull()
    expect(outcomeOf(false, "ok", "text").size).toBeNull()
  })

  it("counts a Read's lines, with no line after a final break", () => {
    const read = (content: string, numLines: number) =>
      outcomeOf(false, "ok", { type: "text", file: { content, numLines } }).size
    expect(read("a\nb\n", 3)).toEqual({ count: 2, unit: "line" })
    expect(read("a\nb", 2)).toEqual({ count: 2, unit: "line" })
    expect(read("", 1)).toEqual({ count: 1, unit: "line" })
  })

  it("takes a record's detail for its result only when it holds one result", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "a", content: "one" },
          { type: "tool_result", tool_use_id: "b", content: "two" },
        ],
      },
      toolUseResult: { type: "text", file: { content: "a", numLines: 1 } },
    })
    expect(transcripts.items(line).map((item) => item.outcome?.size)).toEqual([null, null])
  })

  it("says nothing of a person's shell command", () => {
    const line = JSON.stringify({
      type: "user",
      parentUuid: "p",
      message: { content: "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>" },
    })
    expect(transcripts.items(line)[0]!.outcome).toBeNull()
  })
})

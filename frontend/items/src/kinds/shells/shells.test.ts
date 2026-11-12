import type { ShellEntry } from "@novadeck/core/items"
import { describe, expect, it } from "vitest"

import {
  ageText,
  lastLineOf,
  orderedShells,
  plain,
  shownLines,
  stateText,
  summaryOf,
  tellText,
} from "./shells"

const shell = (id: string, since: number, exit: ShellEntry["exit"] = null): ShellEntry => ({
  id,
  command: `cmd ${id}`,
  since,
  exit,
  output: { state: "ready", firstLine: 1, lines: ["a", "boom"], total: 2 },
})

describe("orderedShells", () => {
  it("lists failed first, then running newest first, then the ended", () => {
    const list = [
      shell("old-run", 1),
      shell("ok", 2, { at: 50, code: 0 }),
      shell("new-run", 9),
      shell("bad", 3, { at: 40, code: 1 }),
      shell("stopped", 4, { at: 60, code: null }),
    ]
    expect(orderedShells(list).map((each) => each.id)).toEqual([
      "bad",
      "new-run",
      "old-run",
      "stopped",
      "ok",
    ])
  })
})

describe("how a shell reads", () => {
  it("says its time, its exit code or that it stopped", () => {
    expect(stateText(shell("a", 0), 12 * 60_000)).toBe("12m")
    expect(stateText(shell("a", 0, { at: 1, code: 1 }), 5)).toBe("exited 1")
    expect(stateText(shell("a", 0, { at: 1, code: 0 }), 5)).toBe("exited 0")
    expect(stateText(shell("a", 0, { at: 1, code: null }), 5)).toBe("stopped")
    expect(ageText(65 * 60_000)).toBe("1h 5m")
  })

  it("counts them for the header", () => {
    expect(
      summaryOf([
        shell("a", 0),
        shell("b", 0, { at: 1, code: 2 }),
        shell("c", 0, { at: 1, code: 0 }),
      ]),
    ).toBe("1 running · 1 failed · 1 ended")
    expect(summaryOf([])).toBe("none now")
  })
})

describe("output", () => {
  it("strips escape sequences and finds the last line that says something", () => {
    expect(plain("\u001b[31mred\u001b[0m")).toBe("red")
    expect(
      lastLineOf({
        state: "ready",
        firstLine: 1,
        lines: ["x", "\u001b[32my\u001b[0m", " "],
        total: 3,
      }),
    ).toBe("y")
    expect(lastLineOf({ state: "none" })).toBeNull()
  })

  it("folds to the last lines, keeping their numbers", () => {
    expect(shownLines(["a", "b", "c", "d", "e"], 10, "folded")).toEqual({
      firstLine: 12,
      lines: ["c", "d", "e"],
    })
    expect(shownLines(["a", "b"], 1, "beside")).toEqual({ firstLine: 2, lines: ["b"] })
    expect(shownLines(["a", "b"], 1, "open").lines).toHaveLength(2)
  })

  it("drafts the command, its code and the end of its output", () => {
    expect(tellText(shell("bad", 0, { at: 1, code: 1 }))).toBe(
      "`cmd bad` exited 1. The end of its output:\n\na\nboom",
    )
  })
})

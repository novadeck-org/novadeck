import type { ShellEntry } from "@novadeck/core/items"
import { describe, expect, it } from "vitest"

import {
  ageText,
  lastLineOf,
  missingText,
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

  it("strips character set designations, a cut-off title and other control characters", () => {
    expect(plain("\u001b[1mbold\u001b(B\u001b[m done")).toBe("bold done")
    expect(plain("kept\u001b]0;a title that never ends")).toBe("kept")
    expect(plain("\u001b]0;title\u0007shown")).toBe("shown")
    expect(plain("a\tb\u0000\u0007\u0008c\u007f\r")).toBe("a\tbc")
  })

  it("says why output is not there, as the agent and the shell's age call for", () => {
    const none = (since: number): ShellEntry => ({
      ...shell("a", since),
      output: { state: "none" },
    })
    const only = (state: "unreadable" | "gone"): ShellEntry => ({
      ...shell("a", 0),
      output: { state },
    })
    expect(missingText(none(1000), "Claude", 3000)).toBe("No output yet.")
    expect(missingText(none(0), "Claude", 60_000)).toBe(
      "Novadeck can't read this one's output; Claude shows what it read of it in its replies.",
    )
    expect(missingText(none(0), "Codex", 60_000)).toContain("ran it in a terminal of its own")
    expect(missingText(only("unreadable"), "Claude", 0)).toBe("Its output can't be read just now.")
    expect(missingText(only("gone"), "Claude", 0)).toBe(
      "Its output is gone. Claude cleared it with its session.",
    )
    expect(missingText(only("gone"), "Codex", 0)).toBe("Its output is gone.")
    expect(missingText(shell("a", 0), "Claude", 0)).toBeNull()
  })

  it("folds to the last lines, keeping their numbers", () => {
    expect(shownLines(["a", "b", "c", "d", "e"], 10, "folded")).toEqual({
      firstLine: 12,
      lines: ["c", "d", "e"],
    })
    expect(shownLines(["a", "b"], 1, "beside")).toEqual({ firstLine: 2, lines: ["b"] })
    expect(shownLines(["a", "b"], 1, "open").lines).toHaveLength(2)
  })

  it("fences a command that holds backticks with a longer run", () => {
    const bad = { ...shell("bad", 0, { at: 1, code: 2 }), command: "echo `date` ``x``" }
    expect(tellText(bad).startsWith("``` echo `date` ``x`` ``` exited 2.")).toBe(true)
    const edge = { ...bad, command: "`ls`" }
    expect(tellText(edge).startsWith("`` `ls` `` exited 2.")).toBe(true)
  })

  it("drafts the command, its code and the end of its output", () => {
    expect(tellText(shell("bad", 0, { at: 1, code: 1 }))).toBe(
      "`cmd bad` exited 1. The end of its output:\n\na\nboom",
    )
  })
})

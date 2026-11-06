import { outcomeLimits, toolChange } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import {
  addedFile,
  changeOf,
  deletedFile,
  exited,
  hunkChange,
  hunksOf,
  joinedChange,
  outcome,
  textChange,
} from "./outcomes.js"

describe("an outcome", () => {
  it("leaves what its harness doesn't say unknown", () => {
    expect(outcome({ failed: true })).toEqual({
      failed: true,
      exit: null,
      running: false,
      size: null,
      change: null,
    })
  })

  it("fails a command by its code", () => {
    expect(exited(0)).toMatchObject({ failed: false, exit: 0 })
    expect(exited(3)).toMatchObject({ failed: true, exit: 3 })
  })
})

describe("the change between two texts", () => {
  it("counts the lines that differ, with what surrounds them", () => {
    expect(textChange("a\nb\nc\n", "a\nB\nb2\nc\n")).toEqual({
      added: 2,
      removed: 1,
      lines: [
        { sign: " ", text: "a", line: null },
        { sign: "-", text: "b", line: null },
        { sign: "+", text: "B", line: null },
        { sign: "+", text: "b2", line: null },
        { sign: " ", text: "c", line: null },
      ],
    })
  })

  it("finds what stayed between two changes", () => {
    const before = ["a", "same", "b"].join("\n")
    const after = ["A", "same", "B"].join("\n")
    expect(textChange(before, after)).toMatchObject({ added: 2, removed: 2 })
  })

  it("takes a final line break for no line, and a text's change in break for one", () => {
    expect(textChange("a\n", "a")).toMatchObject({ added: 0, removed: 0 })
    expect(textChange("a\r\nb\r\n", "a\nb\n")).toMatchObject({ added: 0, removed: 0 })
  })

  it("adds or removes a whole text", () => {
    expect(textChange("", "a\nb\n")).toMatchObject({ added: 2, removed: 0 })
    expect(textChange("a\nb\n", "")).toMatchObject({ added: 0, removed: 2 })
  })

  it("leaves out what is far from any change", () => {
    const lines = Array.from({ length: 100 }, (_, at) => `line ${at}`)
    const after = lines.map((line, at) => (at === 50 ? "changed" : line))
    const change = textChange(lines.join("\n"), after.join("\n"))
    expect(change).toMatchObject({ added: 1, removed: 1 })
    expect(change.lines.map(({ text }) => text)).toEqual([
      "line 47",
      "line 48",
      "line 49",
      "line 50",
      "changed",
      "line 51",
      "line 52",
      "line 53",
    ])
  })

  it("counts true past what its lines carry", () => {
    const lines = Array.from({ length: 5000 }, (_, at) => `line ${at}`).join("\n")
    const change = textChange("", lines)
    expect(change.added).toBe(5000)
    expect(change.lines).toHaveLength(outcomeLimits.lines)
    expect(() => toolChange.parse(change)).not.toThrow()
  })

  it("reads two long texts that share nothing as one replacement", () => {
    const text = (word: string) =>
      Array.from({ length: 2000 }, (_, at) => `${word} ${at}`).join("\n")
    expect(textChange(text("old"), text("new"))).toMatchObject({ added: 2000, removed: 2000 })
  })
})

describe("the change of a harness's own diff", () => {
  it("numbers each line from its hunk's starts", () => {
    expect(
      hunkChange(hunksOf("@@ -5,3 +5,3 @@\n a\n-b\n+B\n c\n@@ -20 +20,2 @@\n d\n+e\n")).lines,
    ).toEqual([
      { sign: " ", text: "a", line: 5 },
      { sign: "-", text: "b", line: 6 },
      { sign: "+", text: "B", line: 6 },
      { sign: " ", text: "c", line: 7 },
      { sign: " ", text: "d", line: 20 },
      { sign: "+", text: "e", line: 21 },
    ])
  })

  it("leaves out a line of no diff", () => {
    expect(
      hunkChange(hunksOf("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n")).lines,
    ).toHaveLength(2)
  })
})

describe("a change", () => {
  it("numbers a whole file from its first line", () => {
    expect(addedFile("a\nb\n").lines.map(({ line }) => line)).toEqual([1, 2])
    expect(deletedFile("a\nb\n")).toMatchObject({ added: 0, removed: 2 })
  })

  it("cuts a long line, and only its text", () => {
    const text = "x".repeat(outcomeLimits.lineText + 10)
    const change = changeOf([{ sign: "+", text, line: 1 }])
    expect(change.lines[0]!.text).toHaveLength(outcomeLimits.lineText)
    expect(change.added).toBe(1)
  })

  it("joins a patch's files, bounded", () => {
    const file = addedFile(Array.from({ length: 30 }, (_, at) => `${at}`).join("\n"))
    const joined = joinedChange([file, file])
    expect(joined.added).toBe(60)
    expect(joined.lines).toHaveLength(outcomeLimits.lines)
  })
})

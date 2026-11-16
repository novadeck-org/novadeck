import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { refusalProblems } from "./refusal-guard.js"

const folders: string[] = []
const adapter = (source: string): string[] => {
  const folder = mkdtempSync(join(tmpdir(), "refusals-"))
  folders.push(folder)
  writeFileSync(join(folder, "x-dialog.ts"), source)
  return refusalProblems(folder)
}
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe("the refusal guard", () => {
  it("accepts static codes, and a bare undefined where a dialog is answered", () => {
    expect(
      adapter(
        [
          "export const read = (rows) => {",
          '  if (!rows) return refuse("x.read.1")',
          "  return {",
          "    keys: (answer) => {",
          "      if (!answer) return undefined",
          "    },",
          "  }",
          "}",
          "const keysFor = (",
          "  answer: string,",
          "): string | undefined => {",
          "  if (!answer) return undefined",
          "}",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  it("names a bare undefined in a read, a code built from text, and a code used twice", () => {
    const problems = adapter(
      [
        "export const read = (rows) => {",
        "  if (!rows) return undefined",
        "  if (rows.length) return refuse(`x.${rows[0]}`)",
        '  if (rows.length > 1) return refuse("x.read.1")',
        '  return refuse("x.read.1")',
        "}",
      ].join("\n"),
    )
    expect(problems).toHaveLength(3)
    expect(problems[0]).toContain("x-dialog.ts:2")
    expect(problems[1]).toContain("static code")
    expect(problems[2]).toContain("also at x-dialog.ts:4")
  })
})

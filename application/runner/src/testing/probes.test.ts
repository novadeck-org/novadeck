import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ScreenText } from "../terminals/screen.js"
import { describe, expect, it } from "../test.js"
import { loadProbe, screenOf, screenRecord } from "./probes.js"

describe("probe fixtures", () => {
  it("keeps a screen's text as rows up to the last that shows anything, and reads it back whole", () => {
    const record = screenRecord("one\n\n  three  \n\n\n", { columns: 60 })
    expect(record).toEqual({ height: 3, columns: 60, rows: { 0: "one", 2: "  three  " } })
    expect(screenOf(record)).toMatchObject({
      rows: ["one", "", "  three  "],
      bright: ["one", "", "  three  "],
      columns: 60,
      cursor: { row: 2, column: 0 },
      bracketedPaste: true,
    })
  })

  it("keeps what an emulator read of a screen, and gives the same screen back", () => {
    const read: ScreenText = {
      rows: ["› draft", "", "footer"],
      bright: ["›", "", "footer"],
      columns: 120,
      cursor: { row: 0, column: 9 },
      bracketedPaste: false,
      alternate: false,
    }
    const record = screenRecord(read)
    expect(record).toEqual({
      height: 3,
      columns: 120,
      cursor: { row: 0, column: 9 },
      rows: { 0: "› draft", 2: "footer" },
      bright: { 0: "›" },
      bracketedPaste: false,
    })
    expect(screenOf(JSON.parse(JSON.stringify(record)) as typeof record)).toEqual(read)
  })

  it("reads every screen of a fixture wherever it lies, and the rest as it is", () => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-probes-"))
    try {
      mkdirSync(join(folder, "fixtures"))
      writeFileSync(
        join(folder, "fixtures", "x.probe.json"),
        JSON.stringify({
          source: "by hand",
          scenarios: { a: { screens: [screenRecord("hi")], rows: ["not a screen"], height: 2 } },
        }),
      )
      const found = loadProbe<{
        source: string
        scenarios: { a: { screens: ScreenText[]; rows: string[]; height: number } }
      }>(folder, "x.probe.json")
      expect(found.source).toBe("by hand")
      expect(found.scenarios.a.screens[0]?.rows).toEqual(["hi"])
      expect(found.scenarios.a.rows).toEqual(["not a screen"])
      expect(found.scenarios.a.height).toBe(2)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

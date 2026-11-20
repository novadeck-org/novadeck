import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { isEmpty } from "@novadeck/tui-input/box"
import { describe, expect, it } from "vitest"

import { box } from "./box.js"
import { paneOf } from "./panes.js"

const { versions } = loadProbe<{
  readonly versions: { readonly [version: string]: { readonly [label: string]: ScreenText } }
}>(import.meta.dirname, "side.probe.json")

const wide = versions["0.171.0"]!
const whole = versions["0.170.0"]!

/** What the box reads as on `screen`: a view's, an empty root box, or the root's text. */
const reading = (screen: ScreenText): string => {
  if (box.overlay(screen)) return "view"
  const read = box.read(screen)
  if (!read) return "no box"
  return isEmpty(read) ? "empty" : read.text
}

describe("a /side conversation in a pane beside the root's", () => {
  it("is read as the pane holding the cursor, the other left out", () => {
    const { screen, sidebar } = paneOf(wide["side draft"]!)
    expect(sidebar).toBe(true)
    expect(screen.columns).toBe(40)
    expect(screen.rows[0]).toBe(" Side chat ×                         +")
    expect(box.read(wide["side draft"]!)?.text).toBe("Ask on the side")
    const root = paneOf(wide.switched!)
    expect(root.sidebar).toBe(false)
    expect(root.screen.columns).toBe(79)
    expect(root.screen.rows.join("\n")).not.toContain("│")
    expect(box.columns?.(wide.switched!)).toBe(79)
  })

  it("is never the root's box, open, asked, archiving or back from a narrower screen", () => {
    for (const label of ["side", "side draft", "side asked", "switched back", "closed"])
      expect([label, reading(wide[label]!)]).toEqual([label, "view"])
    for (const label of ["wide again", "wide closed"])
      expect([label, reading(wide[label]!)]).toEqual([label, "view"])
  })

  it("leaves the root's box as it is once the root's pane is in focus", () => {
    expect(reading(wide.root!)).toBe("empty")
    expect(reading(wide.switched!)).toBe("empty")
    expect(box.queued(wide.switched!)).toBe(false)
  })
})

describe("a /side conversation over the whole screen", () => {
  it("is never the root's box, closed by Ctrl-C (0.170.0) or archived by it (0.171.0)", () => {
    for (const label of ["narrow side", "narrow side draft"])
      expect([label, reading(wide[label]!)]).toEqual([label, "view"])
    for (const label of ["side", "side draft", "side asked", "switched back", "narrow side"])
      expect([label, reading(whole[label]!)]).toEqual([label, "view"])
    expect(paneOf(whole.side!).screen).toBe(whole.side)
  })

  it("leaves the root's box as it is once switched away or closed", () => {
    for (const label of ["root", "switched", "closed"])
      expect([label, reading(whole[label]!)]).toEqual([label, "empty"])
    expect(box.columns?.(whole.side!)).toBe(120)
  })

  it("says what the root waits on between its words", () => {
    const rows = [
      "› Ask a follow-up question",
      "",
      "  GPT-6.2-Sol default · Agent",
      "  Side from main thread · main needs input · ⌃/ to switch · ⌃c to close",
    ]
    const screen: ScreenText = {
      rows,
      bright: rows,
      bracketedPaste: true,
      alternate: false,
      columns: 99,
      cursor: { row: 0, column: 2 },
    }
    expect(box.overlay(screen)).toBe(true)
  })
})

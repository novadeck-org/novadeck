import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { answer, chat, Down, need, pressed, waits } from "./dialogs.test-support.js"

// 2.1.329 (the pin) and 2.1.331 alike, 2026-11-24 (e2e/probes/claude-narrow-preview.e2e.ts): on a
// narrow pane a previewed question's wrapped label may have its number a row down,
// `❯   Commit merge and` over ` 1.push (Recommended)`. Seen live at 49x36, where the question
// went to the Inbox as a dialog Novadeck couldn't read.
type Scenario = {
  input: unknown
  screens: { [size: string]: ScreenText }
  steps: { [name: string]: ScreenText }
}
const { scenarios } = loadProbe(import.meta.dirname, "narrow-preview.probe.json") as {
  scenarios: { [name: string]: Scenario }
}
const screen = (name: string, size: string): string[] => [...scenarios[name]!.screens[size]!.rows]
const step = (name: string, key: string): string[] => [...scenarios[name]!.steps[key]!.rows]
const facts = (name: string): RequestFacts => ({
  kind: "question",
  tool: "AskUserQuestion",
  input: scenarios[name]!.input,
  cwd: null,
})
const Up = "\x1b[A"
const split = /^ \d+\.\S/

describe("Claude Code's previewed question on a narrow pane", () => {
  it("reads the question whose first label's number went a row down, at 49x36", () => {
    const rows = screen("narrow-preview", "49x36")
    expect(rows.some((row) => /^❯ {3}Commit merge and/.test(row))).toBe(true)
    expect(rows.some((row) => split.test(row))).toBe(true)
    const dialog = need(dialogs.read(rows, facts("narrow-preview")))
    expect(dialog.dialog).toMatchObject({
      questions: [
        {
          header: "Merge+push",
          options: [
            { id: "1", label: "Commit merge and push (Recommended)" },
            { id: "2", label: "Don't push yet" },
          ],
          text: false,
        },
      ],
    })
    expect(pressed(dialog.keys(answer(["1"])))).toEqual(["\r"])
    const keys = dialog.keys(answer(["2"]))
    expect(pressed(keys)).toEqual([Down, "\r"])
    expect(waits(keys)[0]!.until(step("narrow-preview", "49x36-second"))).toBe(true)
    expect(waits(keys)[0]!.until(rows)).toBe(false)
    expect(pressed(dialog.keys(chat()))).toEqual([Down, Down, "\r"])
    expect(dialog.answered(rows)).toBe(false)
    expect(dialog.answered(step("narrow-preview", "49x36-second"))).toBe(false)
  })

  it.each(["120x40", "49x42", "60x36", "100x30"])("reads the same question at %s", (size) => {
    expect(dialogs.read(screen("narrow-preview", size), facts("narrow-preview"))).toBeDefined()
  })

  it("still refuses it where its top scrolled away, at 80x24", () => {
    const rows = screen("narrow-preview", "80x24")
    expect(rows.some((row) => /^ ↑ \d+ more lines?/.test(row))).toBe(true)
    expect(dialogs.read(rows, facts("narrow-preview"))).toBeUndefined()
  })

  it.each(["120x40", "40x30", "44x30", "49x30", "52x30", "56x30", "60x30", "64x30"])(
    "reads three labels, whichever wraps split, at %s",
    (size) => {
      const dialog = need(dialogs.read(screen("narrow-three", size), facts("narrow-three")))
      expect(dialog.dialog).toMatchObject({
        questions: [
          {
            options: [
              { label: "Short" },
              { label: "A much longer label that wraps over three rows here" },
              { label: "Commit merge and push (Recommended)" },
            ],
          },
        ],
      })
      expect(pressed(dialog.keys(answer(["3"])))).toEqual([Down, Down, "\r"])
    },
  )

  it("sees the highlight on a split option, and starts from it", () => {
    const shots: [string, number][] = [
      ["40x30-second", 2],
      ["40x30-third", 3],
      ["44x30-second", 2],
    ]
    const first = need(dialogs.read(step("narrow-three", "40x30-first"), facts("narrow-three")))
    const third = waits(first.keys(answer(["3"])))[0]!.until
    expect(step("narrow-three", "40x30-third").some((row) => /^❯ {3}Commit merge/.test(row))).toBe(
      true,
    )
    expect(third(step("narrow-three", "40x30-third"))).toBe(true)
    expect(third(step("narrow-three", "40x30-second"))).toBe(false)
    for (const [shot, at] of shots) {
      const dialog = need(dialogs.read(step("narrow-three", shot), facts("narrow-three")))
      expect(pressed(dialog.keys(answer([String(at)]))), shot).toEqual(["\r"])
      expect(pressed(dialog.keys(answer(["1"]))), shot).toEqual([
        ...Array<string>(at - 1).fill(Up),
        "\r",
      ])
    }
  })

  it("refuses a split label that isn't the option's whole label, or a number out of turn", () => {
    const rows = screen("narrow-preview", "49x36")
    const short = rows.map((row) => row.replace(" 1.push (Recommended)", " 1.push (Recommend)  "))
    expect(dialogs.read(short, facts("narrow-preview"))).toBeUndefined()
    const renumbered = rows.map((row) => row.replace(/^ 1\.push/, " 2.push"))
    expect(dialogs.read(renumbered, facts("narrow-preview"))).toBeUndefined()
    // A row of the label's rest alone, with no number under it, is no option.
    const lost = rows.map((row) => row.replace(/^ 1\.push/, "   push"))
    expect(dialogs.read(lost, facts("narrow-preview"))).toBeUndefined()
  })
})

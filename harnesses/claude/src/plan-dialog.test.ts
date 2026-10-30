import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import {
  choice,
  factsOf,
  need,
  pressed,
  readOf,
  screen,
  sizes,
  step,
  swap,
  waits,
} from "./dialogs.test-support.js"

describe("Claude Code's ExitPlanMode", () => {
  it.each(sizes)("reads Ready to code with its feedback field at %s", (size) => {
    const dialog = need(readOf("plan-file", size))
    expect(dialog.dialog).toEqual({
      type: "choices",
      title: "Ready to code?",
      detail: null,
      options: [
        { id: "1", label: "Yes, auto-accept edits", text: null },
        { id: "2", label: "Yes, manually approve edits", text: null },
        { id: "3", label: "Tell Claude what to change", text: "field" },
      ],
    })
    expect(pressed(dialog.keys(choice("2")))).toEqual(["2"])
    expect(dialog.keys(choice("3"))).toBeUndefined()
    expect(dialog.keys(choice("1", "x"))).toBeUndefined()
    const keys = dialog.keys(choice("3", "Add a rollback step please"))
    expect(keys).toMatchObject([
      { press: "3" },
      { until: expect.any(Function) },
      { type: "Add a rollback step please" },
      { until: expect.any(Function) },
      { press: "\r" },
    ])
    expect(waits(keys)[0]!.until(screen("plan-file", size))).toBe(false)
    expect(waits(keys)[1]!.until(step("k-plan-3-typed", "typed"))).toBe(true)
    expect(waits(keys)[1]!.until(step("k-plan-3-typed", "pressed-3"))).toBe(false)
    expect(dialog.answered(screen("plan-file", size))).toBe(false)
    expect(dialog.answered(step("plan-file", "pressed-2"))).toBe(true)
  })

  it("reads the live dialog, with blank rows between its parts", () => {
    const dialog = need(readOf("plan-live", "120x40"))
    expect(dialog.dialog).toMatchObject({
      title: "Ready to code?",
      options: [{ id: "1" }, { id: "2" }, { id: "3", text: "field" }],
    })
    expect(pressed(dialog.keys(choice("3", "more")))).toEqual(["3", "\r"])
    // Strict as ever: another file, a changed footer or a fourth option.
    const facts = factsOf("plan-live")
    const rows = screen("plan-live", "120x40")
    expect(
      dialogs.read(rows, { ...facts, input: { planFilePath: "/home/.claude/plans/other.md" } }),
    ).toBeUndefined()
    expect(dialogs.read(swap(rows, "ctrl+g to edit", "ctrl+x to edit"), facts)).toBeUndefined()
    // The editor ctrl+g opens is whichever its hint names: Notepad on Windows.
    expect(dialogs.read(swap(rows, "edit in Vim", "edit in Notepad"), facts)?.dialog).toEqual(
      dialog.dialog,
    )
    expect(
      dialogs.read(
        rows.flatMap((row) => (row.includes("3. Tell") ? [row, "     4. Other"] : [row])),
        facts,
      ),
    ).toBeUndefined()
    expect(dialogs.read(swap(rows, "❯ 1.", "> 1."), facts)).toBeUndefined()
  })

  it("waits for the feedback field to open", () => {
    const dialog = need(readOf("k-plan-3-feedback", "120x40"))
    const [focused] = waits(dialog.keys(choice("3", "text")))
    expect(focused!.until(step("k-plan-3-feedback", "pressed-3"))).toBe(true)
    expect(dialog.answered(step("k-plan-3-feedback", "after-enter"))).toBe(true)
    expect(dialog.answered(step("k-plan-esc", "after-esc"))).toBe(true)
  })

  it.each(sizes)("reads the short Exit plan mode dialog at %s", (size) => {
    const dialog = need(readOf("plan", size))
    expect(dialog.dialog).toEqual({
      type: "choices",
      title: "Exit plan mode?",
      detail: null,
      options: [
        {
          id: "1",
          label: "Yes, and switch to default (ask each time) for this session",
          text: null,
        },
        { id: "2", label: "No", text: null },
      ],
    })
    expect(pressed(dialog.keys(choice("1")))).toEqual(["1"])
    expect(dialog.answered(step("plan", "pressed-4"))).toBe(false)
    expect(dialog.answered(step("k-plan-1", "after-1"))).toBe(true)
  })

  it("refuses a plan whose file the screen doesn't name, and either dialog for the other", () => {
    const long = factsOf("plan-file")
    const short = factsOf("plan")
    const elsewhere = {
      ...long,
      input: { ...(long.input as object), planFilePath: "/home/.claude/plans/elsewhere.md" },
    }
    expect(dialogs.read(screen("plan-file", "120x40"), elsewhere)).toBeUndefined()
    expect(dialogs.read(screen("plan-file", "120x40"), short)).toBeUndefined()
    expect(dialogs.read(screen("plan", "120x40"), long)).toBeUndefined()
    expect(
      dialogs.read(screen("plan-file", "120x40"), { ...long, input: { plan: "# Plan\n" } }),
    ).toBeUndefined()
    expect(dialogs.read(screen("plan-file", "120x40"), { ...long, tool: "Bash" })).toBeUndefined()
  })

  it("refuses a plan dialog an update changed", () => {
    const long = factsOf("plan-file")
    const short = factsOf("plan")
    const cases: { name: string; facts: RequestFacts; rows: string[] }[] = []
    for (const size of sizes) {
      const rows = screen("plan-file", size)
      cases.push(
        {
          name: "reworded question",
          facts: long,
          rows: swap(rows, "ready to execute", "ready"),
        },
        {
          name: "renamed feedback",
          facts: long,
          rows: swap(rows, "Tell Claude what to change", "Give feedback"),
        },
        { name: "another marker", facts: long, rows: swap(rows, "❯ 1.", "> 1.") },
        {
          name: "an extra option",
          facts: long,
          rows: rows.flatMap((row) =>
            row.includes("2. Yes, manually") ? [row, "     2b. Yes, in a new session"] : [row],
          ),
        },
        {
          name: "a fourth option",
          facts: long,
          rows: rows.flatMap((row) =>
            row.includes("3. Tell Claude") ? [row, "     4. Yes, clear context"] : [row],
          ),
        },
        {
          name: "changed footer",
          facts: long,
          rows: swap(rows, "ctrl+g to edit in Vim", "ctrl+e to edit"),
        },
        {
          name: "short: reworded",
          facts: short,
          rows: swap(screen("plan", size), "wants to exit", "will exit"),
        },
        {
          name: "short: No renamed",
          facts: short,
          rows: swap(screen("plan", size), "2. No", "2. Stay"),
        },
        {
          name: "short: a third option",
          facts: short,
          rows: [...screen("plan", size), "      3. Maybe"],
        },
      )
    }
    for (const { name, facts, rows } of cases) {
      expect(dialogs.read(rows, facts), name).toBeUndefined()
    }
  })
})

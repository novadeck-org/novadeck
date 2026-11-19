import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"

// 2.1.328, 2026-11-19 (e2e/probes/claude-tall-dialogs.e2e.ts): a plan taller than the screen
// scrolls inside its box, under a `↓`, and draws no row of how many lines went; a question
// taller than the screen scrolls its own top away and says so under its options
// (` ↑ 4 more lines`), as a permission dialog does. 2.1.326 read the same screens alike.
const { scenarios } = loadProbe(import.meta.dirname, "tall-dialogs.probe.json") as {
  scenarios: { [name: string]: { screens: { [size: string]: ScreenText } } }
}
const rows = (name: string, size: string): string[] => [...scenarios[name]!.screens[size]!.rows]
const scrolledAway = /^ ↑ [\d,]+ more lines? *$/
const sizes = ["120x40", "120x34", "120x30", "120x26", "120x22", "120x18"]

const preview = Array.from({ length: 70 }, (_, n) => `line ${n + 1} of a preview`).join("\n")
const asking = (question: Record<string, unknown>): RequestFacts => ({
  kind: "question",
  tool: "AskUserQuestion",
  input: { questions: [{ header: "H", multiSelect: false, ...question }] },
  cwd: null,
})
const previewed = asking({
  question: "Which database should we use?",
  header: "Database",
  options: [
    { label: "Postgres", description: "Relational, battle tested, needs a server", preview },
    { label: "SQLite", description: "Embedded, zero setup, single writer", preview },
    { label: "DuckDB", description: "Analytical, columnar", preview },
  ],
})
const features = asking({
  question: "Which features should be enabled?",
  header: "Features",
  multiSelect: true,
  options: ["Auth", "Billing", "Search", "Export"].map((label) => ({
    label,
    description: `${label}: ${"a long description of what it does and why it matters. ".repeat(6)}`,
  })),
})
const planning = (name: string, size: string): RequestFacts => ({
  kind: "plan",
  tool: "ExitPlanMode",
  input:
    name === "tall-plan-input"
      ? {}
      : {
          planFilePath: `/home/user/.claude/plans/${
            rows(name, size)
              .join(" ")
              .match(/plans\/([\w.-]+\.md)/)?.[1]
          }`,
        },
  cwd: null,
})

describe("Claude Code's plan dialog, taller than the screen", () => {
  it.each(sizes)("reads Ready to code? with a plan of 120 steps at %s", (size) => {
    expect(rows("tall-plan-file", size).some((row) => scrolledAway.test(row))).toBe(false)
    const read = dialogs.read(rows("tall-plan-file", size), planning("tall-plan-file", size))
    expect(read?.dialog).toMatchObject({ type: "choices", title: "Ready to code?" })
  })

  it.each(sizes)("reads Exit plan mode? at %s", (size) => {
    const read = dialogs.read(rows("tall-plan-input", size), planning("tall-plan-input", size))
    expect(read?.dialog).toMatchObject({ type: "choices", title: "Exit plan mode?" })
  })
})

describe("Claude Code's question dialog, taller than the screen", () => {
  it.each(["120x40", "120x34", "120x30"])("reads a long multi-select at %s", (size) => {
    expect(dialogs.read(rows("tall-ask-long", size), features)?.dialog.type).toBe("questions")
  })

  it.each(sizes)("reads a question with long previews at %s", (size) => {
    expect(dialogs.read(rows("tall-ask-preview", size), previewed)?.dialog.type).toBe("questions")
  })

  it.each(["120x26", "120x22", "120x18"])(
    "refuses one whose question scrolled away at %s, with its row of how many or without",
    (size) => {
      const drawn = rows("tall-ask-long", size)
      expect(drawn.some((row) => scrolledAway.test(row))).toBe(true)
      expect(drawn.some((row) => row.includes("Which features should be enabled?"))).toBe(false)
      expect(dialogs.read(drawn, features)).toBeUndefined()
      expect(
        dialogs.read(
          drawn.filter((row) => !scrolledAway.test(row)),
          features,
        ),
      ).toBeUndefined()
    },
  )
})

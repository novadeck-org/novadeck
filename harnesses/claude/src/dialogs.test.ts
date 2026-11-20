import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { factsOf, probe, readOf, scenario, step } from "./dialogs.test-support.js"
import { hook } from "./report.test-support.js"

describe("Claude Code's highlighted fields", () => {
  it("refuses to read where a digit would be typed into a focused field", () => {
    expect(dialogs.read(step("ask-other", "pressed-4"), factsOf("ask-other"))).toBeUndefined()
    expect(
      dialogs.read(step("k-plan-3-feedback", "pressed-3"), factsOf("k-plan-3-feedback")),
    ).toBeUndefined()
    expect(
      dialogs.read(step("k-ask-multi-lone-other", "on-other"), factsOf("k-ask-multi-lone-other")),
    ).toBeUndefined()
  })
})

describe("Claude Code's unrecognised dialogs", () => {
  it("reads nothing from an elicitation or an unknown dialog", () => {
    const rows = ["❯ Ask now", " Provide your name", "   Name: Ada", " ❯ Accept", "   Decline"]
    expect(
      dialogs.read(rows, { kind: "permission", tool: "Elicitation", input: {}, cwd: null }),
    ).toBeUndefined()
    expect(
      dialogs.read([], { kind: "question", tool: "AskUserQuestion", input: {}, cwd: null }),
    ).toBeUndefined()
    expect(
      dialogs.read([], { kind: "plan", tool: "ExitPlanMode", input: {}, cwd: null }),
    ).toBeUndefined()
  })
})

describe("Claude Code's attention requests", () => {
  it("carry the tool's input, for the adapter to check the screen against", () => {
    const input = { command: "touch approved.txt", description: "Make a file" }
    const events = hook("PermissionRequest", { tool_name: "Bash", tool_input: input })
    expect(events).toMatchObject([{ type: "attention-requested", kind: "permission", input }])
  })
})

describe("Claude Code 2.1.291", () => {
  const tagged = Object.keys(probe.scenarios).filter((name) => name.endsWith("@2.1.291"))

  it("is captured for the dialogs that matter", () => {
    expect(tagged.length).toBeGreaterThanOrEqual(10)
    for (const name of tagged) expect(scenario(name).version).toBe("2.1.291")
  })

  it("reads wherever 2.1.287 does, and nowhere else", () => {
    for (const name of tagged) {
      const pinned = name.replace("@2.1.291", "")
      for (const size of Object.keys(scenario(name).screens)) {
        const was = readOf(pinned, size) !== undefined
        expect(readOf(name, size) !== undefined, `${name} ${size}`).toBe(was)
      }
    }
  })
})

describe("Claude Code's dialog held out of view", () => {
  const { states, facts } = loadProbe<{
    states: Record<string, ScreenText>
    facts: { question: { name: string; input: unknown } }
  }>(import.meta.dirname, "fullscreen-scrolled.probe.json")

  it.each([
    "questionHidden",
    "questionHiddenNarrow",
    "questionHiddenAgain",
    "permissionHidden",
    "permissionHiddenNarrow",
  ])("is revealed with Ctrl+End at %s, which answers nothing", (state) => {
    expect(dialogs.reveal?.(states[state]!.rows)).toBe("\x1b[1;5F")
  })

  // The probe ran on Linux at 120 columns. The pill's hint varies with the platform, the
  // person's keys and the width (2.1.328's bundle); macOS's is what the nightly E2E saw on
  // 2026-11-19. Its last row, with the hint swapped for each.
  const withPill = (state: string, pill: string): string[] => {
    const rows = [...states[state]!.rows]
    const last = rows.findLastIndex((each) => each !== "")
    rows[last] = rows[last]!.replace(/Waiting for your answer.*$/, pill)
    return rows
  }

  it.each([
    "Waiting for your answer · fn+↓ to scroll",
    "Waiting for your answer (click) ↓",
    "Waiting for your answer (alt+g) ↓",
    "Waiting for your answer ↓",
    "Waiting for your answer",
  ])("is revealed with Ctrl+End under a pill reading %j", (pill) => {
    for (const state of ["questionHidden", "permissionHidden"]) {
      expect(dialogs.reveal?.(withPill(state, pill)), state).toBe("\x1b[1;5F")
    }
  })

  it.each([
    "1 new message (ctrl+End) ↓",
    "Jump to bottom (ctrl+End) ↓",
    "the line said Waiting for your answer, then",
    "Waiting for your answer (ctrl+End) ↓ and more",
  ])("is not revealed under a last row ending %j", (line) => {
    expect(dialogs.reveal?.(withPill("questionHidden", line))).toBeUndefined()
  })

  it.each(["questionRevealed", "questionAnswered", "permissionRevealed"])(
    "is not revealed at %s",
    (state) => {
      expect(dialogs.reveal?.(states[state]!.rows)).toBeUndefined()
    },
  )

  it.each(["questionEscapeWhileHidden", "permissionEscapeWhileHidden"])(
    "is no longer held once Escape declined it where it stood, at %s",
    (state) => {
      const rows = states[state]!.rows
      expect(dialogs.reveal?.(rows)).toBeUndefined()
      expect(
        dialogs.read(rows, {
          kind: "question",
          tool: facts.question.name,
          input: facts.question.input,
          cwd: null,
        }),
      ).toBeUndefined()
    },
  )
})

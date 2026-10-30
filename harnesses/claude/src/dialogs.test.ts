import { describe, expect, it } from "vitest"

import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import {
  Down,
  factsOf,
  need,
  pressed,
  probe,
  readOf,
  scenario,
  screen,
  step,
  swap,
} from "./dialogs.test-support.js"

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

  it("moves to a multi-select's text row from where the highlight is", () => {
    const facts = factsOf("k-ask-multi-lone")
    const rows = swap(
      swap(screen("k-ask-multi-lone", "120x40"), "❯ 1.", "  1."),
      "  2. [ ]",
      "❯ 2. [ ]",
    )
    const dialog = need(dialogs.read(rows, facts))
    const keys = dialog.keys({
      type: "questions",
      dialog: "d",
      answers: [{ question: "q1", options: [], text: "words" }],
    })
    expect(pressed(keys)).toEqual([Down, Down, Down, "\r", "1"])
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
    const events = decode({
      terminalId: "t",
      token: "k",
      agent: "claude",
      event: "PermissionRequest",
      seq: 1,
      instance: "7",
      env: { cursor: false },
      payload: { session_id: "s", tool_name: "Bash", tool_input: input },
    })
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

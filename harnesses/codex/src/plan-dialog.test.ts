import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { choice, probe, read, replaced, screen, sizes } from "./dialogs.test-support.js"

describe("Codex's plan prompt", () => {
  const facts: RequestFacts = { kind: "plan", tool: "plan", input: null, cwd: null }

  it("is a request the screen tells, at both sizes", () => {
    for (const size of sizes) {
      expect(dialogs.screenRequest!(screen("plan-prompt", size))).toEqual({
        kind: "plan",
        tool: "plan",
        input: null,
        subject: "Implement this plan?",
      })
    }
    expect(dialogs.screenRequest!(screen("exec-approve"))).toBeUndefined()
    expect(dialogs.screenRequest!(screen("rui-default-on"))).toBeUndefined()
    expect(dialogs.screenRequest!([])).toBeUndefined()
  })

  it("reads three options, digits answering, with feedback as a prompt after 'stay in Plan mode'", () => {
    for (const size of sizes) {
      const found = read(screen("plan-prompt", size), facts)!
      expect(found.dialog).toEqual({
        type: "choices",
        title: "Implement this plan?",
        detail: null,
        options: [
          { id: "1", label: "Yes, implement this plan", text: null },
          { id: "2", label: "Yes, clear context and implement", text: null },
          { id: "3", label: "No, stay in Plan mode", text: "prompt" },
        ],
      })
      expect(found.keys(choice("1"))).toEqual([{ press: "1" }])
      expect(found.keys(choice("3", "split it"))).toEqual([{ press: "3" }])
      expect(found.keys(choice("2", "x"))).toBeUndefined()
      expect(found.answered(screen("plan-prompt", size))).toBe(false)
      expect(found.answered(probe.scenarios["plan-prompt-digit-3"]!.pressed![0]!.screen.rows)).toBe(
        true,
      )
    }
  })

  it("is no prompt when reworded, reordered or given a new option", () => {
    const rows = screen("plan-prompt")
    expect(
      dialogs.screenRequest!(replaced(rows, "Implement this plan?", "Build this plan?")),
    ).toBeUndefined()
    expect(
      read(replaced(rows, "No, stay in Plan mode", "No, keep planning"), facts),
    ).toBeUndefined()
    expect(
      read(replaced(rows, "Yes, clear context and implement", "Yes, compact and implement"), facts),
    ).toBeUndefined()
    const extra = [...rows]
    extra.splice(
      extra.findIndex((row) => row.includes("enter select")),
      0,
      "  4. Yes, and stop",
    )
    expect(read(extra, facts)).toBeUndefined()
    expect(dialogs.screenRequest!(extra)).toBeUndefined()
  })
})

describe("Codex's plan prompt, only as the bottom popup", () => {
  const facts: RequestFacts = { kind: "plan", tool: "plan", input: null, cwd: null }
  const popup = screen("plan-prompt")

  it("is not text in the agent's output", () => {
    const text = popup.slice(popup.findIndex((row) => row.includes("Implement this plan?")))
    const output = [
      ...popup.slice(0, 4),
      ...text,
      "  Worked for 2s",
      "› Ask Codex to do anything",
      "  ? for shortcuts",
    ]
    expect(dialogs.screenRequest!(output)).toBeUndefined()
    expect(read(output, facts)).toBeUndefined()
  })

  it("is not a popup with anything after its footer, or without it", () => {
    expect(dialogs.screenRequest!([...popup, "  more"])).toBeUndefined()
    expect(dialogs.screenRequest!(popup.slice(0, -1))).toBeUndefined()
    expect(dialogs.screenRequest!([...popup, "", "   "])).toBeDefined()
  })
})

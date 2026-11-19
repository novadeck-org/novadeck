import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs, pager } from "./dialogs.js"

// Probed on 0.170.0 (`e2e/probes/codex-hidden-dialog.e2e.ts`): the `/diff` pager, opened while a
// turn runs, takes the whole screen and hides an approval or a question that is asked under it.
// `q` closes it and shows the dialog; Escape answers the dialog hidden below.
const { facts, states } = loadProbe<{
  facts: { permission: { name: string; input: { cmd: string } } }
  states: Record<string, ScreenText>
}>(import.meta.dirname, "hidden-dialog.probe.json")
const rows = (name: string) => states[name]!.rows

const approval: RequestFacts = {
  kind: "permission",
  tool: "Bash",
  input: { command: "echo approved > probe-out.txt", description: "Echo outside the sandbox" },
  cwd: null,
}
const asking: RequestFacts = {
  kind: "question",
  tool: "request_user_input",
  input: {
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color should the button be?",
        options: [{ label: "Blue (Recommended)" }, { label: "Green" }],
      },
    ],
  },
  cwd: null,
}

describe("Codex's /diff pager over a dialog", () => {
  it("is revealed with q, which closes it and answers nothing", () => {
    expect(facts.permission.name).toBe("exec_command")
    for (const name of [
      "permissionHeld",
      "questionHeld",
      "permissionEscapeHeld",
      "questionEscapeHeld",
      // Escape answered the dialog under it and left the pager, still hiding the next.
      "permissionEscapeAfterEscape",
    ])
      expect(dialogs.reveal?.(rows(name)), name).toBe("q")
  })

  it("is the pager whether or not a request waits under it: the screen alone is what q needs", () => {
    expect(dialogs.reveal?.(rows("plainHeld"))).toBe("q")
  })

  it("reads no dialog from the pager, so the card stays the screen's raw text", () => {
    expect(dialogs.read(rows("permissionHeld"), approval)).toBeUndefined()
    expect(dialogs.read(rows("questionHeld"), asking)).toBeUndefined()
  })

  it("is not revealed once q closed it, with the dialog in view, or on the composer", () => {
    for (const name of ["permissionAfterQ", "questionAfterQ", "plainAfterQ"])
      expect(dialogs.reveal?.(rows(name)), name).toBeUndefined()
    expect(dialogs.read(rows("permissionAfterQ"), approval)).toBeDefined()
  })

  describe("is told from other screens, for a q typed anywhere else lands in the composer", () => {
    const view = rows("permissionHeld")
    const lines = [...view]
    const last = lines.findLastIndex((row) => row.trim() !== "")

    it("needs every part of it", () => {
      expect(pager(view)).toBe(true)
      // Without the header, the rule, the hint or the close row.
      expect(pager(lines.slice(1))).toBe(false)
      expect(pager(lines.map((row, at) => (at === last - 2 ? "─ 100% ─ x" : row)))).toBe(false)
      expect(pager(lines.map((row, at) => (at === last - 1 ? " ↑/↓ to scroll" : row)))).toBe(false)
      expect(pager(lines.map((row, at) => (at === last ? " q close later" : row)))).toBe(false)
      expect(pager(lines.map((row, at) => (at === last ? "" : row)))).toBe(false)
    })

    it("is not the composer, though a line of the transcript says q close", () => {
      const composer = [
        "  >_ OpenAI Codex (v0.170.0)",
        "",
        "› Run the thing",
        "",
        "• The /diff pager says",
        " q close",
        "",
        "› Ask Codex",
        "  ? for shortcuts",
      ]
      expect(dialogs.reveal?.(composer)).toBeUndefined()
      // Even with the pager's own last rows quoted at the end of the transcript.
      const quoted = [
        ...composer.slice(0, 5),
        " ↑/↓ to scroll · pgup/pgdn to page · home/end to jump",
        " q close",
      ]
      expect(dialogs.reveal?.(quoted)).toBeUndefined()
    })

    it("is not another full-screen view", () => {
      const other = [
        "T R A N S C R I P T / / / / / / / / / /",
        "• something",
        "─────── 100% ─",
        " ↑/↓ to scroll · pgup/pgdn to page · home/end to jump",
        " q close",
      ]
      expect(dialogs.reveal?.(other)).toBeUndefined()
      expect(dialogs.reveal?.([])).toBeUndefined()
    })
  })
})

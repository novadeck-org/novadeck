import type { DialogAdapter, DialogRead } from "@novadeck/harness-core/dialogs"

import { forms } from "./form-dialog.js"
import { permission } from "./permission-dialog.js"
import { plan } from "./plan-dialog.js"
import { questions } from "./question-dialog.js"

/**
 * Claude Code's dialogs as the person sees them in its TUI: a permission, an
 * AskUserQuestion, an ExitPlanMode, an MCP server's elicitation form. Read from the screen
 * in full and checked against what the hook said the request asks (the command, the file,
 * the questions and their options, the plan's file, the form's fields); anything else, or
 * anything an update changed, reads as undefined. Each dialog has its own file
 * (`*-dialog.ts`), and `dialog-screen.ts` holds what they share.
 *
 * Probed on 2026-10-06 (2.1.287, `fixtures/ask.probe.json`, 120x40 and 60x20), and again
 * on 2.1.291.
 */

const trimmed = (rows: readonly string[]): string[] => rows.map((each) => each.trimEnd())

// The read with every screen it is later given trimmed the way it was read.
const tidy = (read: DialogRead | undefined): DialogRead | undefined =>
  read && {
    dialog: read.dialog,
    keys: (answer) =>
      read
        .keys(answer)
        ?.map((step) =>
          "until" in step
            ? { ...step, until: (rows: readonly string[]) => step.until(trimmed(rows)) }
            : step,
        ),
    answered: (rows) => read.answered(trimmed(rows)),
  }

export const dialogs: DialogAdapter = {
  read: (rows, facts) => {
    const clean = trimmed(rows)
    switch (facts.kind) {
      case "question":
        return tidy(facts.tool.startsWith("mcp__") ? forms(clean, facts) : questions(clean, facts))
      case "plan":
        return tidy(plan(clean, facts))
      case "permission":
        return tidy(permission(clean, facts))
    }
  },
}

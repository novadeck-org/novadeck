import type { DialogAdapter } from "@novadeck/harness-core/dialogs"

import { modalTitle } from "./box.js"
import { permission } from "./permission-dialog.js"
import { planReview, questions } from "./question-dialog.js"

/**
 * opencode's dialogs, as its TUI draws them and takes keys (probed 2026-11-22, 1.19.6;
 * fixtures/dialogs.probe.json): a permission and a question, in the box's place. Each has its
 * own file (`*-dialog.ts`), and `dialog-screen.ts` holds what they share. Its plan review is a question
 * dialog (`plan_exit`, plan mode), and it has no elicitation form. Anything else, or any of these not read in full, is unrecognised.
 */

// A permission or question dialog's own rows that a modal dialog of opencode's left on screen.
const heldRows = /^ *┃ +(?:Allow once {2,}Allow always|↑↓ select|⇆ tab)/

// The subagent view's bar, which stands where the box is: `General (1 of 1)   Parent up  Prev
// left  Next right`. A permission a child session asked is up in the parent's view only.
const childBar = /^ *┃  .+ \(\d+ of \d+\) {2,}Parent up\b/

export const dialogs: DialogAdapter = {
  read: (rows, request, screen) => {
    switch (request.kind) {
      case "permission":
        return permission(rows, request, screen)
      case "question":
        return questions(rows, request)
      // Its experimental plan mode asks its review (`plan_exit`) through the question dialog; any
      // other plan request is not one this reads.
      case "plan":
        return request.tool === "plan_exit" ? planReview(rows, request) : undefined
    }
  },
  // Two views hide a waiting dialog, each probed 2026-11-22, 1.19.6:
  // - A subagent's own session (Ctrl-X Down from the parent): its permission shows in the parent
  //   session's view, and the child's shows the bar and nothing to answer. Up goes to the parent.
  // - Its modal dialogs (the command palette Ctrl-P, the session list, the model picker), drawn over
  //   the middle of the screen, over a dialog at the bottom, whose rows show under a tall one. Escape
  //   closes the modal; with none open it would reject the permission, so it goes only where a
  //   modal's title row and the dialog's own rows both show.
  reveal: (rows) => {
    if (rows.some((row) => childBar.test(row))) return "\x1b[A"
    return rows.some((row) => modalTitle.test(row)) && rows.some((row) => heldRows.test(row))
      ? "\x1b"
      : undefined
  },
}

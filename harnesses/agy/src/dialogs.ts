import type { DialogAdapter } from "@novadeck/harness-core/dialogs"

import { permission } from "./permission-dialog.js"
import { plan, screenRequest } from "./plan-dialog.js"
import { questions } from "./question-dialog.js"

/**
 * Antigravity's dialogs, as its TUI draws them and takes keys (probed 2026-10-06, 1.2.14;
 * fixtures/ask.probe.json): a confirmation, an ask_question, a plan's review. Each has its
 * own file (`*-dialog.ts`), and `dialog-screen.ts` holds what they share. Anything else,
 * or any of these not read in full, is unrecognised.
 */
export const dialogs: DialogAdapter = {
  read: (rows, request) => {
    switch (request.kind) {
      case "permission":
        return permission(rows, request)
      case "question":
        return questions(rows, request)
      case "plan":
        return plan(rows, request)
    }
  },
  screenRequest,
}

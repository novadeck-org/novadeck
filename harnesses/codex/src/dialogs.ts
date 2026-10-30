import type {
  DialogAdapter,
  DialogRead,
  RequestFacts,
  ScreenRequest,
} from "@novadeck/harness-core/dialogs"

import { asyncQuestions } from "./async-question-dialog.js"
import { asyncTool } from "./async-question.js"
import { clean, composerShown, type Parsed } from "./dialog-screen.js"
import { permission } from "./permission-dialog.js"
import { plan, planTitle } from "./plan-dialog.js"
import { questions } from "./question-dialog.js"

/**
 * How Codex's TUI asks the person, and the keys that answer it (probed 2026-10-06, 0.159.3;
 * source `codex-rs/tui/src/bottom_pane/`). Every dialog here is read in full or not at all:
 * its title, its header against what the request's hook said (the command, the files, the
 * tool, the questions), and each option's wording against the wordings Codex has for it.
 * An update that rewords, adds or reorders anything reads as no dialog, and the chat shows
 * the screen's text instead.
 *
 * - Approvals (a command, a patch, extra permissions) take each option's shortcut as the
 *   screen prints it, `(y)`, for the person may rebind them under `[tui.keymap.approval]`;
 *   an option whose shortcut isn't printed is not offered. "No, and tell Codex what to do
 *   differently" aborts the turn, and the words go as the next prompt.
 * - An MCP tool's approval is a form whose rows take their digit, which submits it.
 * - `request_user_input` takes a digit per question, which answers it and moves on; its
 *   words go in the notes (Tab) of the row they belong to, "None of the above" for words alone.
 * - The plan prompt after a plan takes the digits too.
 * - `request_user_input_async` asks without waiting: the turn runs on and the person
 *   answers when they like. Mid-turn its questions wait behind a panel (`? 1 question`,
 *   `shift+← to answer`) that shift+← opens as a picker, a question at a time, each
 *   taking its option's digit (a digit past the last picks "Other", whose words go in
 *   after it) or, with no options, the words alone, and Enter; the answers go to the
 *   model at its next call. The picker may already be open. Once the turn has ended Codex
 *   drops the questions, and the answer is a prompt of the person's, `> {question}`, a
 *   blank line, the answer, for each. Read only while the screen is that panel, that
 *   picker or an idle composer with nothing else on it; any other screen reads as none.
 * An MCP server's own elicitation form is not read. Each dialog has its own file
 * (`*-dialog.ts`), and `dialog-screen.ts` holds what they share.
 */

// The lines Codex leaves in its history once a dialog is answered.
const resulted =
  /^\s*(?:[✔✗] You |• Questions? \d+\/\d+ answered|You (?:granted|did not grant|denied|declined)\b)/

const marks = (rows: readonly string[]): number =>
  clean(rows).filter((line) => resulted.test(line)).length

const parse = (rows: readonly string[], facts: RequestFacts): Parsed | undefined => {
  const lines = clean(rows)
  if (facts.kind === "question") {
    return facts.tool === asyncTool ? asyncQuestions(lines, facts) : questions(lines, facts)
  }
  if (facts.kind === "plan") return plan(lines)
  return permission(lines, facts)
}

export const dialogs: DialogAdapter = {
  read: (rows, request): DialogRead | undefined => {
    const parsed = parse(rows, request)
    if (!parsed) return undefined
    return {
      ...parsed,
      // Gone: the dialog this request asked is no longer the one on screen (a queued
      // request's takes its place with its own command, or the answer's line took it).
      answered:
        parsed.answered ??
        ((later) =>
          marks(later) > marks(rows) ||
          (parse(later, request) === undefined && composerShown(later))),
    }
  },
  screenRequest: (rows): ScreenRequest | undefined =>
    plan(clean(rows)) === undefined
      ? undefined
      : { kind: "plan", tool: "plan", input: null, subject: planTitle },
}

import { refuse } from "@novadeck/harness-core/dialogs"
import type {
  DialogAdapter,
  DialogRead,
  RequestFacts,
  ScreenRequest,
} from "@novadeck/harness-core/dialogs"

import { asyncQuestions } from "./async-question-dialog.js"
import { asyncTool } from "./async-question.js"
import { clean, composerShown, type Parsed } from "./dialog-screen.js"
import { elicitation, elicitationRequest } from "./elicitation-dialog.js"
import { rootRows, sideFocused, sideToggle } from "./panes.js"
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
 * - An MCP server's own form (an elicitation) fires no hook: the screen alone raises its
 *   request (`screenRequest`), as it does the plan prompt's, and the person answers it in
 *   the terminal.
 * From 0.171.0 a `/side` conversation on a screen of 100 columns or more is a sidebar beside the
 * root's pane: the root's dialogs are read in its pane alone (`rootRows`), and one held while the
 * side has the focus is brought into view with Ctrl-/ (`sideFocused`), as on a narrower screen and
 * in 0.170.0, where the side takes the whole screen. A side conversation's own approval puts no
 * request on the terminal (probed both versions, both widths, 2026-11-20, `sideApproval*` in
 * fixtures/side-dialog.probe.json: the terminal's pending requests stay empty while it shows), so
 * none is read in the sidebar. Each dialog has its own file
 * (`*-dialog.ts`), and `dialog-screen.ts` holds what they share.
 */

const ctrlSlash = sideToggle()

// The lines Codex leaves in its history once a dialog is answered.
const resulted =
  /^\s*(?:[✔✗] You |• Questions? \d+\/\d+ answered|You (?:granted|did not grant|denied|declined)\b)/

const marks = (rows: readonly string[]): number =>
  clean(rootRows(rows)).filter((line) => resulted.test(line)).length

const parse = (rows: readonly string[], facts: RequestFacts): Parsed | undefined => {
  const lines = clean(rootRows(rows))
  if (facts.kind === "question") {
    return facts.tool === asyncTool ? asyncQuestions(lines, facts) : questions(lines, facts)
  }
  if (facts.kind === "plan") return plan(lines)
  return permission(lines, facts)
}

// Codex's `/diff` pager takes the whole screen: a `/ D I F F / / /` header, filler, a rule
// (with how far down it is), a scroll hint and ` q close`. A dialog asked while it is open
// (an approval, `request_user_input`) is drawn under it, and nothing on the pager says so;
// `q` closes it and shows the dialog, still pending, while Escape answers the hidden dialog
// (it cancels the approval, which ends the turn, or skips the question). Probed 2026-11-19,
// 0.170.0 (`fixtures/hidden-dialog.probe.json`, `e2e/probes/codex-hidden-dialog.e2e.ts`).
const pagerHeader = /^\/ D I F F \/ \/ \//
const pagerRule = /^─+(?: \d{1,3}% ─)?$/
const pagerHint = /^ ↑\/↓ to scroll · pgup\/pgdn to page · home\/end to jump$/
const pagerClose = /^ q close$/

/**
 * Whether the screen is the `/diff` pager, every part of it: the header on the first row, and
 * the rule, the scroll hint and ` q close` as the last three. Strict, for `q` pressed anywhere
 * else would be typed into the person's composer.
 */
export const pager = (rows: readonly string[]): boolean => {
  const lines = rows.map((row) => row.trimEnd())
  const last = lines.findLastIndex((row) => row !== "")
  return (
    last >= 3 &&
    pagerHeader.test(lines[0]!) &&
    pagerClose.test(lines[last]!) &&
    pagerHint.test(lines[last - 1]!) &&
    pagerRule.test(lines[last - 2]!)
  )
}

export const dialogs: DialogAdapter = {
  read: (rows, request): DialogRead | undefined => {
    const parsed = parse(rows, request)
    if (!parsed) return refuse("dialogs.read.1")
    return {
      ...parsed,
      // Gone: the dialog this request asked is no longer the one on screen (a queued
      // request's takes its place with its own command, or the answer's line took it).
      answered: (later) =>
        parsed.answered
          ? parsed.answered(rootRows(later))
          : marks(later) > marks(rows) ||
            (parse(later, request) === undefined && composerShown(rootRows(later))),
    }
  },
  // `q` closes the pager that holds a dialog out of view, and Ctrl-/ moves the focus from a
  // side conversation to the root, whose dialog then shows: neither answers anything.
  reveal: (rows, cursor) => {
    if (pager(rows)) return "q"
    return sideFocused(rows, cursor) ? ctrlSlash : undefined
  },
  // A second Ctrl-/ would move the focus back where it was.
  revealToggles: [ctrlSlash],
  // The prompt after a plan, and an MCP server's form (`elicitation-dialog.ts`): neither fires
  // a hook. Both are the root's, read in its pane.
  screenRequest: (rows): ScreenRequest | undefined => {
    const root = rootRows(rows)
    if (plan(clean(root)) !== undefined)
      return { kind: "plan", tool: "plan", input: null, subject: planTitle }
    const asked = elicitation(root)
    return asked === undefined ? undefined : elicitationRequest(asked)
  },
}

import type {
  AnswerableDialog,
  DialogRead,
  KeyStep,
  RequestFacts,
  ScreenRequest,
} from "@novadeck/harness-core/dialogs"

import { only, rowsLike, rule, shows, timeoutMs, typeable } from "./dialog-screen.js"

/**
 * Antigravity's plan review (probed 2026-10-06, 1.2.14; fixtures/ask.probe.json): a plan
 * asking for review is no modal: its screen is the prompt with a footer saying
 * "/artifact to review". The request comes from `screenRequest`, as no hook says it (the
 * status line says `reviewing`, which only a request of the screen can show without moving
 * the activity), and `/artifact` + Enter lists it, where y or n answers.
 */

// Its footer, above the prompt box: "1 artifact · /artifact to review". The review is at
// its start with the box empty (a draft there would take `/artifact` into itself) and
// the prompt idle (its bottom row offering shortcuts, not "esc to cancel"); the driver
// reads it again between keys, so it also reads with `/artifact` typed, or listed.
const reviewFooter = /^\d+ artifacts? · \/artifact to review$/

const reviewing = (rows: readonly string[]): { readonly start: boolean } | undefined => {
  const lines = rows.map((row) => row.trimEnd())
  const at = only(rowsLike(lines, reviewFooter))
  if (at === undefined || !lines[at]!.trim().startsWith("1 artifact · ")) return undefined
  if (!rule(lines[at + 1] ?? "") || !rule(lines[at + 3] ?? "")) return undefined
  const composer = lines[at + 2]?.trim()
  const last = lines.findLast((row) => row.trim() !== "")?.trim()
  const start = composer === ">" && last?.startsWith("? for shortcuts") === true
  // Words typed in the box, as feedback or a draft, leave it the same dialog, with no keys.
  const typed = composer?.startsWith(">") === true && composer !== ">"
  return start || typed || (composer === ">" && review(rows)) ? { start } : undefined
}

const review = (rows: readonly string[]): boolean =>
  rows.some((row) => /^Action required \(1 left\)$/.test(row.trim())) &&
  rows.some((row) => /^›\s+□\s+new\s+\S+/.test(row.trim()))

// The prompt box's row, below the footer.
const composerRow = (rows: readonly string[]): string | undefined => {
  const at = rows.findIndex((row) => reviewFooter.test(row.trim()))
  const row = at < 0 ? undefined : rows[at + 2]?.trim()
  return row?.startsWith(">") ? row.slice(1) : undefined
}

export const plan = (rows: readonly string[], request: RequestFacts): DialogRead | undefined => {
  const state = reviewing(rows)
  if (request.kind !== "plan" || request.tool !== "artifact" || !state) return undefined
  // `/artifact` lists what awaits review, where y approves and n rejects the first.
  const open: KeyStep[] = [
    { press: "/artifact" },
    { press: "\r" },
    { until: review, timeoutMs, why: "the artifact review listed" },
  ]
  const dialog: AnswerableDialog = {
    type: "choices",
    title: "1 artifact to review",
    detail: null,
    options: [
      { id: "approve", label: "Approve", text: null },
      { id: "reject", label: "Reject", text: null },
      { id: "feedback", label: "Tell it what to change", text: "field" },
    ],
  }
  return {
    dialog,
    keys: (answer) => {
      if (answer.type !== "choice" || !state.start) return undefined
      if (answer.option === "approve" && answer.text === undefined) return [...open, { press: "y" }]
      if (answer.option === "reject" && answer.text === undefined) return [...open, { press: "n" }]
      // A plain prompt while the review waits is its feedback (probed: the model gets it
      // as the person's request, and the review is gone): typed into the empty box, with
      // neither y nor n, which would start a "[Rejected]" turn of their own first.
      // Not words that would run a command (/), open help (?), a shell (!) or a file
      // picker (@, anywhere: its Enter would pick a file) from an empty box.
      if (
        answer.option === "feedback" &&
        answer.text !== undefined &&
        typeable(answer.text) &&
        !/^\s*[/?!]|@/.test(answer.text)
      )
        return [
          { type: answer.text },
          shows(answer.text, composerRow, "its words in the prompt box"),
          { press: "\r" },
        ]
      return undefined
    },
    answered: (later) =>
      !later.some((row) => /^Action required \(\d+ left\)$/.test(row.trim())) &&
      !later.some((row) => reviewFooter.test(row.trim())),
  }
}

export const screenRequest = (rows: readonly string[]): ScreenRequest | undefined =>
  !reviewing(rows)?.start
    ? undefined
    : { kind: "plan", tool: "artifact", input: null, subject: "1 artifact to review" }

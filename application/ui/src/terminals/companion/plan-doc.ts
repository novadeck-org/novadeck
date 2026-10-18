import type { ItemContent, PlanUnwritableReason, PlanVersion } from "#core/companion"

// A stretch of the text the agent's latest revision wrote.
export type Mark = { readonly from: number; readonly to: number }

// A plan as the pane holds it, by its item: the text the person edits, and how it
// stands against the file.
export type PlanDoc = {
  readonly writable: boolean
  readonly skill: boolean
  readonly truncated: boolean
  // The file as both sides last agreed on it, at `revision`, the backend's stamp: the
  // agent's rewrites and the person's edits merge against it.
  readonly base: string
  readonly revision: string
  // The file's line break, put back when saving. The editor and the merge work in LF.
  readonly eol: "\n" | "\r\n"
  // The file as the person sees it: `base` with their edits since.
  readonly text: string
  // What the latest rewrite wrote, valid for `marked` (the text it produced).
  readonly marks: readonly Mark[]
  readonly marked: string
  readonly changes: number
  readonly showChanges: boolean
  // Notes the agent removed in its latest rewrite, having applied them.
  readonly resolved: number
  // The last save didn't reach the file; it's tried again.
  readonly unsaved: boolean
  // The backend said saving won't work until the plan or its folder changes, and why:
  // saves stop until the person asks for another try.
  readonly blocked: PlanUnwritableReason | null
  // Saves failed too many times in a row: they stop until the person retries.
  readonly stalled: boolean
}

export const lf = (text: string): string => text.replace(/\r\n?/g, "\n")

// The file's line break: CRLF when every line ends so, LF otherwise.
export const eolOf = (text: string): "\n" | "\r\n" => {
  const breaks = text.split("\n").length - 1
  return breaks > 0 && text.split("\r\n").length - 1 === breaks ? "\r\n" : "\n"
}

export const docOf = ({ stamp, plan }: PlanVersion): PlanDoc => ({
  writable: plan.writable,
  skill: plan.skill,
  truncated: plan.truncated,
  base: lf(plan.text),
  revision: stamp,
  eol: eolOf(plan.text),
  text: lf(plan.text),
  marks: [],
  marked: "",
  changes: 0,
  showChanges: false,
  resolved: 0,
  unsaved: false,
  blocked: null,
  stalled: false,
})

// Why the person's edits can't reach the plan's file, if they can't: its content says it
// is gone, the backend can't write it, or a save said so. Saving can't work then until
// something changes.
// Whether the content says the file can't be read for now, which saves can't get past
// either, though trying again may help.
export const unreadableNow = (content: ItemContent | undefined): boolean =>
  content?.state === "unavailable" && content.reason === "unreadable"

// Edits the file doesn't hold and can't take for now: they live only in the pane, so
// closing the plan loses them.
export const stuckEdits = (plan: PlanDoc, content: ItemContent | undefined): boolean =>
  plan.writable &&
  plan.text !== plan.base &&
  (plan.blocked !== null ||
    plan.stalled ||
    blockOf(plan, content) === "gone" ||
    unreadableNow(content))

export const blockOf = (
  plan: PlanDoc,
  content: ItemContent | undefined,
): PlanUnwritableReason | null =>
  content?.state === "unavailable" && content.reason === "gone"
    ? "gone"
    : !plan.writable
      ? "transcript"
      : plan.blocked

// The latest rewrite's marks, while the text is still the one they describe.
export const currentMarks = (plan: PlanDoc): readonly Mark[] =>
  plan.marked === plan.text ? plan.marks : []

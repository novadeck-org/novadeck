import type { PlanSnapshot } from "../../model/companion"

// A stretch of the text the agent's latest revision wrote.
export type Mark = { readonly from: number; readonly to: number }

// A plan as the pane holds it.
export type PlanDoc = Omit<PlanSnapshot, "text" | "revision" | "truncated"> & {
  readonly truncated: boolean
  // The file as both sides last agreed on it, at `revision`: the agent's rewrites and
  // the user's edits merge against it.
  readonly base: string
  readonly revision: string
  // The file's line break, put back when saving. The editor and the merge work in LF.
  readonly eol: "\n" | "\r\n"
  // The file as the user sees it: `base` with their edits since.
  readonly text: string
  // How many times the agent rewrote it, and how many of those the user saw.
  readonly writes: number
  readonly seen: number
  // What the latest rewrite wrote, valid for `marked` (the text it produced).
  readonly marks: readonly Mark[]
  readonly marked: string
  readonly changes: number
  readonly showChanges: boolean
  // Notes the agent removed in its latest rewrite, having applied them.
  readonly resolved: number
  // The last save didn't reach the file; it's tried again.
  readonly unsaved: boolean
}

export const lf = (text: string): string => text.replace(/\r\n?/g, "\n")

// The file's line break: CRLF when every line ends so, LF otherwise.
export const eolOf = (text: string): "\n" | "\r\n" => {
  const breaks = text.split("\n").length - 1
  return breaks > 0 && text.split("\r\n").length - 1 === breaks ? "\r\n" : "\n"
}

export const docOf = (plan: PlanSnapshot): PlanDoc => ({
  ref: plan.ref,
  role: plan.role,
  path: plan.path,
  agent: plan.agent,
  skill: plan.skill,
  writable: plan.writable,
  truncated: Boolean(plan.truncated),
  base: lf(plan.text),
  revision: plan.revision,
  eol: eolOf(plan.text),
  text: lf(plan.text),
  writes: 0,
  seen: -1,
  marks: [],
  marked: "",
  changes: 0,
  showChanges: false,
  resolved: 0,
  unsaved: false,
})

// The root plan first, then subagents' plans in the order they came.
export const ordered = (plans: readonly PlanDoc[]): readonly PlanDoc[] => [
  ...plans.filter((plan) => plan.role === "root"),
  ...plans.filter((plan) => plan.role !== "root"),
]

// The latest rewrite's marks, while the text is still the one they describe.
export const currentMarks = (plan: PlanDoc): readonly Mark[] =>
  plan.marked === plan.text ? plan.marks : []

export const unread = (plan: PlanDoc): boolean => plan.seen < plan.writes

// A plan as its file is named, as the taskbar names everything.
export const fileOf = (plan: PlanDoc): string => plan.path.split("/").at(-1)!

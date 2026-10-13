import type { ViewMode } from "../model/types"
import { needsPerson, type ProjectStatus } from "../projects/project-status"

// What the person did that a hint asks for, each noticed once and kept.
export type Seen = "answer" | "grid" | "canvas" | "companion" | "project"

export type Hint = {
  readonly id: string
  readonly text: string
  // A hint is done once all of these were seen.
  readonly needs: readonly Seen[]
}

// The things a visitor is asked to try.
export const hints: readonly Hint[] = [
  { id: "answer", text: "Answer the permission request in Checkout review.", needs: ["answer"] },
  { id: "views", text: "Switch to Grid, then Canvas.", needs: ["grid", "canvas"] },
  {
    id: "companion",
    text: "Open an agent's companion pane from its taskbar.",
    needs: ["companion"],
  },
  { id: "project", text: "Open a project the switcher marked.", needs: ["project"] },
]

// What the app shows now of the things a hint asks for.
export type Signals = {
  readonly answered: boolean
  readonly view: ViewMode
  readonly companion: boolean
  // Whether the project now on screen was marked by the switcher when the person opened it.
  readonly marked: boolean
}

// Whether opening `project` followed a mark: the project changed, and `statuses`, what the
// switcher showed just before, marked it as asking for the person or as finished or failed.
export const openedMarked = (
  statuses: Readonly<Record<string, ProjectStatus>>,
  before: string,
  project: string,
): boolean => project !== before && needsPerson(statuses[project])

// What was seen, with whatever the signals show now.
export const noticed = (seen: ReadonlySet<Seen>, signals: Signals): ReadonlySet<Seen> => {
  const now: Seen[] = [
    ...(signals.answered ? (["answer"] as const) : []),
    ...(signals.view === "grid" || signals.view === "canvas" ? [signals.view] : []),
    ...(signals.companion ? (["companion"] as const) : []),
    ...(signals.marked ? (["project"] as const) : []),
  ]
  return now.every((each) => seen.has(each)) ? seen : new Set([...seen, ...now])
}

export const done = (hint: Hint, seen: ReadonlySet<Seen>): boolean =>
  hint.needs.every((each) => seen.has(each))

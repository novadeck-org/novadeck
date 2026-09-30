import { useSyncExternalStore } from "react"

import type { AgentPlan, CompanionEvent, CompanionSeed, Companions } from "../../model/companion"
import { createStore, type MutableStore } from "../../model/store"
import type { ViewMode } from "../../model/types"
import { openCompanion, planTab, selectTab, show, type Companion, type Shown } from "./pane"

// Where the pane opens: beside the terminal inside its window, or hanging off a canvas
// node.
export type PlanPresentation = "split" | "attached"

// A stretch of the text the agent's latest revision wrote.
export type Mark = { readonly from: number; readonly to: number }

// A terminal's companion pane: its plan, then what else its agent showed the user.
export type PlanState = Companion & {
  // How many times the agent has rewritten the plan, and how many of those the user saw.
  readonly revision: number
  readonly seen: number
  // The plan as the agent last wrote it, which its next revision is merged against.
  readonly base: string
  // The file: the agent writes it, the user edits it, notes live in it.
  readonly text: string
  // What the latest revision wrote, valid for `marked` (the text it produced).
  readonly marks: readonly Mark[]
  readonly marked: string
  readonly changes: number
  readonly showChanges: boolean
  // Notes the agent removed in the latest revision, having applied them.
  readonly resolved: number
}

// The editor and the merge work on LF text, whatever line endings the file has.
const lf = (text: string): string => text.replace(/\r\n?/g, "\n")

const initialState = ({ plan, shown }: CompanionSeed): PlanState => ({
  open: false,
  revision: 0,
  seen: -1,
  base: lf(plan.text),
  text: lf(plan.text),
  marks: [],
  marked: "",
  changes: 0,
  showChanges: false,
  resolved: 0,
  tab: planTab,
  artifacts: shown.map((artifact): Shown => ({ ...artifact, fresh: false, at: "1 min ago" })),
})

// Beside the terminal, or on the canvas, attached to the terminal's node.
export const presentationOf = (view: ViewMode): PlanPresentation =>
  view === "canvas" ? "attached" : "split"

// The latest revision's marks, while the text is still the one they describe.
export const currentMarks = (plan: PlanState): readonly Mark[] =>
  plan.marked === plan.text ? plan.marks : []

// Opening the pane goes to what's new, and counts as reading the plan's latest revision.
export const openPlan = (plan: PlanState): PlanState => ({
  ...openCompanion(plan),
  seen: plan.revision,
})

// Opening the pane to a chosen tab. Only the plan's own tab counts as reading the plan.
export const openTab = (plan: PlanState, tab: string): PlanState => ({
  ...selectTab(plan, tab),
  seen: tab === planTab ? plan.revision : plan.seen,
})

export const closePlan = (plan: PlanState): PlanState => ({ ...plan, open: false })

export const toggleChanges = (plan: PlanState): PlanState => ({
  ...plan,
  showChanges: !plan.showChanges,
})

type Panes = MutableStore<Readonly<Record<string, PlanState>>>

const change = (
  panes: Panes,
  terminalId: string,
  update: (plan: PlanState) => PlanState,
): PlanState | undefined => {
  let changed: PlanState | undefined
  panes.update((current) => {
    const plan = current[terminalId]
    if (!plan) return current
    const next = update(plan)
    if (next === plan) return current
    changed = next
    return { ...current, [terminalId]: next }
  })
  return changed
}

// The agent wrote its plan again, over the file as the user left it: its changes merge
// into the user's line by line, and notes it applied go. The merge code loads only when
// an agent writes, like the editor it shares.
const revise = (
  companions: Companions,
  panes: Panes,
  event: Extract<CompanionEvent, { type: "plan/revised" }>,
): void => {
  void import("./plan-editor/sync").then(({ merge, resolveNotes }) => {
    const text = lf(event.text)
    const revised = change(panes, event.terminalId, (plan) => {
      const written = merge(plan.base, plan.text, text)
      const result = event.appliedNotes
        ? resolveNotes(written.text, written.marks)
        : { ...written, resolved: 0 }
      if (text === plan.base && !result.resolved) return plan
      const revision = plan.revision + 1
      return {
        ...plan,
        revision,
        seen: plan.open && plan.tab === planTab ? revision : plan.seen,
        base: text,
        text: result.text,
        marks: result.marks,
        marked: result.text,
        changes: written.changes,
        showChanges: true,
        resolved: result.resolved,
      }
    })
    if (revised) companions.save(event.terminalId, revised.text)
  })
}

// One set of panes per backend's companions, following their events for as long as the
// backend lives.
const panesByCompanions = new WeakMap<Companions, Panes>()

const panesOf = (companions: Companions): Panes => {
  const existing = panesByCompanions.get(companions)
  if (existing) return existing
  const panes: Panes = createStore(
    Object.fromEntries(
      Object.entries(companions.terminals).map(([id, seed]) => [id, initialState(seed)]),
    ),
  )
  companions.subscribe((event) => {
    if (event.type === "plan/revised") revise(companions, panes, event)
    else change(panes, event.terminalId, (plan) => show(plan, event.artifact, event.asked))
  })
  panesByCompanions.set(companions, panes)
  return panes
}

// A terminal's pane as its components use it.
export type CompanionHandle = {
  readonly state: PlanState
  readonly plan: Omit<AgentPlan, "text">
  readonly update: (update: (plan: PlanState) => PlanState) => void
  // The user edited the plan: the file changes, for the agent to read. `marks` are the
  // latest revision's highlights, moved along with the edit.
  readonly edit: (text: string, marks: readonly Mark[]) => void
  // The editor closed: notes left empty in the file go, from the file as it now stands.
  readonly dropEmptyNotes: () => void
}

export const useCompanion = (companions: Companions, terminalId: string): CompanionHandle => {
  const panes = panesOf(companions)
  const state = useSyncExternalStore(panes.subscribe, () => panes.getSnapshot()[terminalId]!)
  return {
    state,
    plan: companions.terminals[terminalId]!.plan,
    update: (update) => {
      change(panes, terminalId, update)
    },
    edit: (text, marks) => {
      const edited = change(panes, terminalId, (plan) =>
        text === plan.text ? plan : { ...plan, text, marks, marked: text },
      )
      if (edited) companions.save(terminalId, text)
    },
    dropEmptyNotes: () => {
      // The note code is already loaded: the editor that closed shares it.
      void import("./plan-editor/notes").then(({ withoutEmptyNotes }) => {
        const cleaned = change(panes, terminalId, (plan) => {
          const kept = withoutEmptyNotes(plan.text, currentMarks(plan))
          return kept ? { ...plan, ...kept, marked: kept.text } : plan
        })
        if (cleaned) companions.save(terminalId, cleaned.text)
      })
    },
  }
}

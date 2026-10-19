import type { Backend } from "@novadeck/core/port"
import { isShowcase, type PlanFault } from "@novadeck/demo/showcase/simulation"

import type { DemoActionGroup } from "./types"

const faults: readonly {
  readonly label: string
  readonly fault: PlanFault | undefined
  readonly hint: string
}[] = [
  {
    label: "Plan in the agent's messages",
    fault: "transcript",
    hint: "Plan turns read-only, saying it lives in the agent's messages",
  },
  {
    label: "Plan file deleted",
    fault: "gone",
    hint: "Plan says its file was deleted; edits stay, with Copy my edits and Try saving again",
  },
  {
    label: "Plan folder can't be written",
    fault: "folder",
    hint: "Typing shows that Novadeck can't write to the folder, with Copy my edits and Try saving again",
  },
  {
    label: "Plan too large to save",
    fault: "too-large",
    hint: "Typing shows the plan is too large to save, with Copy my edits and Try saving again",
  },
  {
    label: "Plan saves keep failing",
    fault: "failing",
    hint: "Typing shows Not saved yet; after 5 tries, Retry (the 5th comes ~30 s after typing)",
  },
  {
    label: "Plan back to normal",
    fault: undefined,
    hint: "The plan saves again; Try saving again and Retry then succeed",
  },
]

// The panel's group for what can go wrong with a plan the person edits, on the selected
// terminal's agent. Only the showcase has agents with plans.
export const planGroups = (companions: Backend["companions"]): readonly DemoActionGroup[] =>
  companions && isShowcase(companions)
    ? [
        {
          section: "Agents",
          title: "Plan",
          actions: faults.map(({ label, fault, hint }) => ({
            label,
            hint,
            run: ({ selected, note }) => {
              const key = selected()
              if (!key || !companions.fault(key, fault))
                note("Select a terminal whose agent wrote a plan first.")
            },
          })),
        },
      ]
    : []

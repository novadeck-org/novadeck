import type { Backend } from "@novadeck/core/port"
import { isShowcase, type PlanFault } from "@novadeck/demo/showcase/simulation"

import type { DemoAction, DemoActionGroup } from "./types"

// Undoes the clipboard that refuses every copy, while one stands in for the browser's. It
// outlasts the demo's boots, as the page's clipboard does.
let restoreClipboard: (() => void) | undefined

// Has the browser refuse to copy, as where it denies the page the clipboard: a write rejects.
const refuseClipboard = (): void => {
  if (restoreClipboard) return
  const own = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.reject(new Error("The clipboard refused the copy.")) },
    configurable: true,
  })
  restoreClipboard = () => {
    if (own) Object.defineProperty(navigator, "clipboard", own)
    else Reflect.deleteProperty(navigator, "clipboard")
    restoreClipboard = undefined
  }
}

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
    label: "Plan outside the project and the agent's plans folder",
    fault: "outside",
    hint: "Typing shows that Novadeck saves plans only in the project's folder or the agent's own plans folder, with Copy my edits and Try saving again",
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
    hint: "The plan saves again and its edits copy; Try saving again and Retry then succeed",
  },
]

const copyFails: DemoAction = {
  label: "Copying plan edits fails",
  hint: "With a plan fault above: Copy my edits says Couldn't copy, and closing the plan with Copy my edits and close keeps it open, saying the edits couldn't be copied",
  run: refuseClipboard,
}

// The panel's group for what can go wrong with a plan the person edits, on the selected
// terminal's agent. Only a showcase with agents has plans.
export const planGroups = (companions: Backend["companions"]): readonly DemoActionGroup[] =>
  companions && isShowcase(companions) && companions.plans
    ? [
        {
          section: "Agents",
          title: "Plan",
          actions: faults.flatMap(({ label, fault, hint }): DemoAction[] => {
            const action: DemoAction = {
              label,
              hint,
              run: ({ selected, note }) => {
                if (fault === undefined) restoreClipboard?.()
                const key = selected()
                if (!key || !companions.fault(key, fault))
                  note("Select a terminal whose agent wrote a plan first.")
              },
            }
            // Copying fails beside the faults, and the plan back to normal copies again.
            return fault === undefined ? [copyFails, action] : [action]
          }),
        },
      ]
    : []

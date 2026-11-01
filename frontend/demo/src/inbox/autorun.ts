import { type AutoRun, type AutoRunState, noAutoRun } from "@novadeck/core/autorun"
import { createStore } from "@novadeck/core/store"

import { demoAutoRunOffer, demoAutoRunSilenced } from "./fixtures"

// The demo's cmd AutoRun: states of the card the runner reports on Windows, and the clicks as
// the runner answers them. The debug panel puts one on screen with `show`.

export type DemoAutoRun = AutoRun & {
  // The state the runner would report; `none` for a machine whose cmd prints nothing.
  readonly show: (state: AutoRunState) => void
}

export const createDemoAutoRun = (): DemoAutoRun => {
  const state = createStore<AutoRunState>(noAutoRun)
  return {
    state,
    show: (next) => state.update(() => next),
    silence: (value) => {
      const current = state.getSnapshot()
      // As the runner refuses a value that is no longer the one shown.
      state.update(() =>
        current.state === "offer" && current.next === value
          ? { ...demoAutoRunSilenced, current: current.next, restores: current.current }
          : { ...current, outcome: { kind: "conflict" } },
      )
    },
    undo: () => state.update(() => ({ ...demoAutoRunOffer, outcome: { kind: "undone" } })),
    dismiss: () => state.update(() => noAutoRun),
  }
}

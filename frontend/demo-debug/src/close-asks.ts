import type { BackendSink, CloseAsk, CloseAsks, TerminalKey } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { othersOf } from "./terminals"
import type { DemoActionGroup } from "./types"

// Agents' asks to close a terminal, as the runner's backend has them: the person's answer
// closes the terminal when they confirm, as the runner would.
export const createDemoCloseAsks = (
  dispatch: () => BackendSink["dispatch"] | undefined,
): {
  readonly closeAsks: CloseAsks
  // Makes `from` ask to close `terminal`, queued behind the asks already waiting.
  readonly ask: (from: TerminalKey, terminal: TerminalKey) => void
  // Takes back every ask waiting, as the runner does when the terminals closed.
  readonly withdraw: () => void
} => {
  const pending = createStore<readonly CloseAsk[]>([])
  // Where each ask's terminal lives, to close it on a confirmation.
  const targets = new Map<string, TerminalKey>()
  let count = 0
  return {
    closeAsks: {
      pending,
      answer: (requestId, close) => {
        const target = targets.get(requestId)
        targets.delete(requestId)
        pending.update((asks) => asks.filter((each) => each.requestId !== requestId))
        if (close && target)
          dispatch()?.([
            {
              type: "terminal/close",
              target: {
                projectId: target.projectId,
                workspaceSessionId: target.workspaceSessionId,
              },
              terminalId: target.terminalId,
            },
          ])
      },
    },
    ask: (from, terminal) => {
      count += 1
      const requestId = `close-ask-${count}`
      targets.set(requestId, terminal)
      pending.update((asks) => [
        ...asks,
        { requestId, from: from.terminalId, terminalId: terminal.terminalId },
      ])
    },
    withdraw: () => {
      targets.clear()
      pending.update(() => [])
    },
  }
}

// The Agents group for the close modal: the selected terminal is the one asked about, and
// another terminal of its session is the agent that asks.
export const closeAskGroups = (
  controls: ReturnType<typeof createDemoCloseAsks>,
  workspace: () => Workspace | undefined,
): readonly DemoActionGroup[] => [
  {
    section: "Agents",
    title: "Close asks",
    actions: [
      {
        label: "Ask to close selected",
        hint: "Modal: another terminal's agent asks to close the selected one; two clicks queue two",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          const [asker] = othersOf(workspace(), key)
          if (!asker) return note("Add a second terminal first.")
          controls.ask({ ...key, terminalId: asker.id }, key)
        },
      },
      {
        label: "Withdraw asks",
        hint: "The modal goes away unanswered",
        run: controls.withdraw,
      },
    ],
  },
]

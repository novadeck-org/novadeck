import type { Approval, Approvals, BackendSink, TerminalKey } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"
import { terminalOf } from "@novadeck/demo/terminals"

import { othersOf } from "./terminals"
import type { DemoActionGroup } from "./types"

// A brief as an agent would write one: long enough that the dialog has to scroll it.
const demoBrief = [
  "You are joining the migration of the billing service to the new events table.",
  "",
  "1. Read docs/billing-events.md and the two open PRs that touch it.",
  "2. In src/billing/ledger.ts, move every write to the new `ledger_events` table and keep the old writes behind the `LEGACY_LEDGER` flag until I say otherwise.",
  "3. Add a migration with a down step, and test it from the previous schema version.",
  "4. Run `pnpm test --filter billing` before you report; don't touch the invoices package.",
  "",
  "Ask me through the Inbox if the schema in the doc and the one in production disagree. Report with done when the PR is up.",
].join("\n")

const target = (key: TerminalKey) => ({
  projectId: key.projectId,
  workspaceSessionId: key.workspaceSessionId,
})

// What agents ask the person to allow, as the runner's backend has them: confirming a close
// closes the terminal, confirming a lead makes the asker its lead, as the runner would.
export const createDemoApprovals = (
  dispatch: () => BackendSink["dispatch"] | undefined,
  workspace: () => Workspace | undefined = () => undefined,
): {
  readonly approvals: Approvals
  // Makes `from` ask to close `terminal`, queued behind the approvals already waiting.
  readonly askToClose: (from: TerminalKey, terminal: TerminalKey) => void
  // Makes `from` ask to lead `terminal` with a brief.
  readonly askToLead: (from: TerminalKey, terminal: TerminalKey, brief: string) => void
  // The person ends `terminal`'s lead.
  readonly release: (terminal: TerminalKey) => void
  // Takes back every approval waiting, as the runner does when the terminals closed.
  readonly withdraw: () => void
} => {
  const pending = createStore<readonly Approval[]>([])
  // Where each approval's terminal lives, to act on it on a confirmation.
  const targets = new Map<string, { terminal: TerminalKey; from: TerminalKey }>()
  let count = 0
  const queue = (from: TerminalKey, terminal: TerminalKey, action: Approval["action"]): void => {
    count += 1
    const requestId = `approval-${count}`
    targets.set(requestId, { terminal, from })
    pending.update((waiting) => [
      ...waiting,
      { requestId, from: from.terminalId, terminalId: terminal.terminalId, action },
    ])
  }
  return {
    approvals: {
      pending,
      answer: (requestId, approved) => {
        const found = targets.get(requestId)
        const action = pending.getSnapshot().find((each) => each.requestId === requestId)?.action
        targets.delete(requestId)
        pending.update((waiting) => waiting.filter((each) => each.requestId !== requestId))
        if (!approved || !found || !action) return
        if (action.type === "close")
          dispatch()?.([
            {
              type: "terminal/close",
              target: target(found.terminal),
              terminalId: found.terminal.terminalId,
            },
          ])
        else {
          const handle = terminalOf(workspace(), found.from)?.handle
          if (handle)
            dispatch()?.([
              {
                type: "terminal/update",
                target: target(found.terminal),
                terminalId: found.terminal.terminalId,
                ledBy: handle,
              },
            ])
        }
      },
    },
    askToClose: (from, terminal) => queue(from, terminal, { type: "close" }),
    askToLead: (from, terminal, brief) => queue(from, terminal, { type: "lead", brief }),
    release: (terminal) =>
      dispatch()?.([
        {
          type: "terminal/update",
          target: target(terminal),
          terminalId: terminal.terminalId,
          ledBy: null,
        },
      ]),
    withdraw: () => {
      targets.clear()
      pending.update(() => [])
    },
  }
}

// The Agents group for the approval modal: the selected terminal is the one asked about,
// and another terminal of its session is the agent that asks.
export const approvalGroups = (
  controls: ReturnType<typeof createDemoApprovals>,
  workspace: () => Workspace | undefined,
): readonly DemoActionGroup[] => [
  {
    section: "Agents",
    title: "Approvals",
    actions: [
      {
        label: "Ask to close selected",
        hint: "Modal: another terminal's agent asks to close the selected one; two clicks queue two",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          const [asker] = othersOf(workspace(), key)
          if (!asker) return note("Add a second terminal first.")
          controls.askToClose({ ...key, terminalId: asker.id }, key)
        },
      },
      {
        label: "Ask to lead selected",
        hint: "Modal: another terminal's agent asks to lead the selected one with a long brief; confirming makes it the lead",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          const [asker] = othersOf(workspace(), key)
          if (!asker) return note("Add a second terminal first.")
          controls.askToLead({ ...key, terminalId: asker.id }, key, demoBrief)
        },
      },
      {
        label: "Withdraw approvals",
        hint: "The modal goes away unanswered",
        run: controls.withdraw,
      },
    ],
  },
]

import type { Approval, Approvals, BackendSink, TerminalKey } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"
import { terminalOf } from "@novadeck/demo/workspace"

import { othersOf, sessionTarget } from "./terminals"
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

// An introduction as an agent joining a team might write one.
const demoIntroduction =
  "I'm working on the billing ledger migration and need the events table you own: I'd like to join your team so you can direct the schema questions."

// A command as an agent might write one: long, with a pipe and a quote, so the dialog shows it whole.
const demoCommand =
  'curl -fsSL https://example.com/install.sh | sh -s -- --prefix "$HOME/.local" && pnpm install --frozen-lockfile && pnpm test --filter billing'

// What agents ask the person to allow, as the runner's backend has them: confirming a close
// closes the terminal, confirming a lead makes the asker its lead, as the runner would.
export const createDemoApprovals = (
  dispatch: () => BackendSink["dispatch"] | undefined,
  workspace: () => Workspace | undefined = () => undefined,
): {
  readonly approvals: Approvals
  // Makes `from` ask to close `terminal`, queued behind the approvals already waiting.
  readonly askToClose: (from: TerminalKey, terminal: TerminalKey) => void
  // Makes `from` ask to open a terminal running a command, confirmed or not; `answered` hears
  // whether the person allowed it (declined, or taken back, is false). The demo opens none: the
  // tour's story opens its own on a yes.
  readonly askToRun: (
    from: TerminalKey,
    command: string,
    cwd: string,
    answered?: (approved: boolean) => void,
  ) => void
  // Makes `from` ask to lead `terminal` with a brief.
  readonly askToLead: (from: TerminalKey, terminal: TerminalKey, brief: string) => void
  // Makes `from` ask to take `terminal`'s worktree on `branch` at `path`.
  readonly askToTake: (
    from: TerminalKey,
    terminal: TerminalKey,
    branch: string,
    path: string,
  ) => void
  // Makes `from` ask to join `terminal`'s team, with an introduction.
  readonly askToJoin: (from: TerminalKey, terminal: TerminalKey, message: string) => void
  // Makes `from` ask to leave the team of `terminal`, its lead.
  readonly askToLeave: (from: TerminalKey, terminal: TerminalKey) => void
  // Makes `from` ask to hand its team to `terminal`, which it leads.
  readonly askToHand: (from: TerminalKey, terminal: TerminalKey) => void
  // The person ends `terminal`'s lead.
  readonly release: (terminal: TerminalKey) => void
  // Takes back every approval waiting, as the runner does when the terminals closed.
  readonly withdraw: () => void
} => {
  const pending = createStore<readonly Approval[]>([])
  // Where each approval's terminal lives, to act on it on a confirmation.
  const targets = new Map<string, { terminal: TerminalKey; from: TerminalKey }>()
  // Who hears each run's answer.
  const heard = new Map<string, (approved: boolean) => void>()
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
        heard.get(requestId)?.(approved)
        heard.delete(requestId)
        if (!approved || !found || !action) return
        // A run's terminal would be new: the demo opens none.
        if (action.type === "run") return
        // The demo has no worktrees: the answer only goes away.
        if (action.type === "take") return
        // Teams: the demo's `ledBy` is the whole of it. A hand-over moves only the asker.
        if (action.type === "join" || action.type === "hand")
          return void dispatch()?.([
            {
              type: "terminal/update",
              target: sessionTarget(found.from),
              terminalId: found.from.terminalId,
              ledBy: found.terminal.terminalId,
            },
          ])
        if (action.type === "leave")
          return void dispatch()?.([
            {
              type: "terminal/update",
              target: sessionTarget(found.from),
              terminalId: found.from.terminalId,
              ledBy: null,
            },
          ])
        if (action.type === "close")
          dispatch()?.([
            {
              type: "terminal/close",
              target: sessionTarget(found.terminal),
              terminalId: found.terminal.terminalId,
            },
          ])
        else {
          if (terminalOf(workspace(), found.from)?.handle)
            dispatch()?.([
              {
                type: "terminal/update",
                target: sessionTarget(found.terminal),
                terminalId: found.terminal.terminalId,
                ledBy: found.from.terminalId,
              },
            ])
        }
      },
    },
    askToClose: (from, terminal) => queue(from, terminal, { type: "close" }),
    askToRun: (from, command, cwd, answered) => {
      if (answered) heard.set(`approval-${count + 1}`, answered)
      queue(from, from, { type: "run", command, cwd })
    },
    askToLead: (from, terminal, brief) => queue(from, terminal, { type: "lead", brief }),
    askToTake: (from, terminal, branch, path) =>
      queue(from, terminal, { type: "take", path, branch }),
    askToJoin: (from, terminal, message) => queue(from, terminal, { type: "join", message }),
    askToLeave: (from, terminal) => queue(from, terminal, { type: "leave" }),
    askToHand: (from, terminal) => queue(from, terminal, { type: "hand" }),
    release: (terminal) =>
      dispatch()?.([
        {
          type: "terminal/update",
          target: sessionTarget(terminal),
          terminalId: terminal.terminalId,
          ledBy: null,
        },
      ]),
    withdraw: () => {
      for (const answered of heard.values()) answered(false)
      heard.clear()
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
        label: "Ask to take selected's worktree",
        hint: "Modal: another terminal's agent asks to take the selected terminal's worktree; allowing changes nothing in the demo",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          const [asker] = othersOf(workspace(), key)
          if (!asker) return note("Add a second terminal first.")
          controls.askToTake(
            { ...key, terminalId: asker.id },
            key,
            "feat/billing-events",
            "~/.novadeck/worktrees/billing/feat-billing-events/api",
          )
        },
      },
      {
        label: "Ask to join selected's team",
        hint: "Modal: another terminal's agent asks to join the selected one's team with an introduction; confirming makes the selected one its lead",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          const [asker] = othersOf(workspace(), key)
          if (!asker) return note("Add a second terminal first.")
          controls.askToJoin({ ...key, terminalId: asker.id }, key, demoIntroduction)
        },
      },
      {
        label: "Ask to leave selected's team",
        hint: "Modal: another terminal's agent asks to leave the selected one's team; confirming ends its lead",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          const [asker] = othersOf(workspace(), key)
          if (!asker) return note("Add a second terminal first.")
          controls.askToLeave({ ...key, terminalId: asker.id }, key)
        },
      },
      {
        label: "Ask to hand its team to selected",
        hint: "Modal: another terminal's agent asks to hand its team to the selected one; confirming makes the selected one its lead in the demo",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          const [asker] = othersOf(workspace(), key)
          if (!asker) return note("Add a second terminal first.")
          controls.askToHand({ ...key, terminalId: asker.id }, key)
        },
      },
      {
        label: "Ask to run a command",
        hint: "Modal: the selected terminal's agent asks to open a terminal that runs a long command; confirming opens none in the demo",
        run: ({ selected, note }) => {
          const key = selected()
          if (!key) return note("Select a terminal first.")
          controls.askToRun(key, demoCommand, "~/projects/billing")
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

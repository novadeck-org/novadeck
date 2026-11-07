import { harnesses } from "@novadeck/core/harnesses"
import type { ClosedTerminal, ClosedTerminalState, HistoryState } from "@novadeck/core/history"
import type { Backend, BackendAction, BackendSink } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

import { demoHandle } from "./handles"
import { terminalsOf } from "./workspace"

// The demo's History: the terminals closed in the storefront project, one row for
// each state a row can be in, and the terminals the person closes here. It stands in for
// the runner, which keeps the rows, checks them and takes one back once it has restored it.

const minute = 60_000
const day = 24 * 60 * minute

// How long before the runner says a row is restoring, and before it confirms the restore
// and the row is gone.
export const restoringMs = 120
export const restoreMs = 900

type Sample = Omit<
  ClosedTerminal,
  "id" | "projectId" | "closedAt" | "closedBy" | "availability"
> & {
  readonly ago: number
  readonly state?: ClosedTerminalState
  readonly closedBy?: string
}

const agentRow = (
  agent: "claude" | "codex" | "agy",
  title: string,
  handle: string,
  summary: string,
  ago: number,
  state?: ClosedTerminalState,
): Sample => ({
  title,
  handle,
  summary,
  agent,
  program: agent,
  cwd: "~/projects/storefront",
  ago,
  ...(state && { state }),
})

const plainRow = (title: string, folder: string, ago: number, program = "pnpm"): Sample => ({
  title,
  handle: null,
  summary: null,
  agent: null,
  program,
  cwd: `~/projects/storefront/${folder}`,
  ago,
})

// The storefront's rows, newest first: what closed today, on earlier days, and each state a
// row can be in. The conversation and the folder it ran in are gone for two; Codex and
// Antigravity are not connected here, which the demo's Preferences can change for Codex;
// @fox's conversation is open in a terminal of the session.
const storefront: readonly Sample[] = [
  agentRow(
    "claude",
    "Coupon codes",
    "wren",
    "Coupon codes in the cart and at checkout",
    25 * minute,
  ),
  agentRow("codex", "Tax rounding", "pike", "One-cent tax rounding on split orders", 95 * minute),
  {
    ...agentRow(
      "agy",
      "Shipping rates",
      "reed",
      "Live carrier rates at checkout",
      day + 4 * 60 * minute,
    ),
    state: { state: "open", handle: demoHandle(2) },
  },
  plainRow("pnpm dev", "web", day + 5 * 60 * minute),
  {
    ...plainRow("Terminal", "", day + 6 * 60 * minute, "zsh"),
    cwd: "~/projects/storefront",
  },
  agentRow(
    "claude",
    "Refund flow for partial orders",
    "ash",
    "Partial refunds from the order page",
    day + 7 * 60 * minute,
  ),
  agentRow(
    "codex",
    "Release notes",
    "sage",
    "Release notes drafted from the merged changes",
    day + 8 * 60 * minute,
    { state: "disconnected", agent: "codex" },
  ),
  agentRow(
    "claude",
    "Payment retries",
    "wick",
    "Stripe webhook retries and signature checks",
    2 * day,
  ),
  agentRow(
    "agy",
    "Receipt emails",
    "fawn",
    "Order receipts sent after the payment webhook",
    2 * day + 4 * 60 * minute,
    { state: "disconnected", agent: "agy" },
  ),
  agentRow("codex", "Search index", "yew", "Product search index rebuild", 3 * day),
  plainRow("pnpm db:migrate", "api", 3 * day + 5 * 60 * minute),
  agentRow(
    "claude",
    "Checkout tests",
    "bram",
    "End-to-end checkout tests for guest orders",
    4 * day,
  ),
  agentRow(
    "claude",
    "Product filters",
    "lark",
    "Size and colour filters kept in the URL",
    25 * day,
    { state: "gone", reason: "conversation" },
  ),
  agentRow("agy", "Image CDN", "fern", "Product images behind the CDN", 26 * day, {
    state: "gone",
    reason: "folder",
  }),
]

const rowsOf = (projectId: string, samples: readonly Sample[], now: number): ClosedTerminal[] => {
  // What closed today is today: not earlier than the day began, whatever the hour.
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  return samples.map(({ ago, state, closedBy, ...sample }, index) => ({
    ...sample,
    id: `closed-${projectId}-${index + 1}`,
    projectId,
    closedAt: ago < day ? Math.max(now - ago, midnight + minute) : now - ago,
    closedBy: closedBy ?? null,
    availability: state ?? { state: "ready" },
  }))
}

// What the debug panel changes: the demo's agents are all restorable, so this is the way to
// see the close question for one that can't be (no session yet, or not connected).
export type DemoHistoryControl = {
  readonly setRestorable: (terminalId: string, restorable: boolean) => void
  readonly isRestorable: (terminalId: string) => boolean
  // Called whenever a terminal's restorable state changes by `setRestorable`.
  readonly onRestorable: (listener: () => void) => void
}

// Whether a backend's History is the demo's, which the debug panel changes.
export const isDemoHistory = (
  history: Backend["history"],
): history is NonNullable<Backend["history"]> & DemoHistoryControl =>
  history !== undefined && "setRestorable" in history

export type DemoHistory = {
  readonly history: NonNullable<Backend["history"]> & DemoHistoryControl
  // Takes the row a terminal is restored from: it shows as restoring, then goes.
  readonly restore: (id: string) => ClosedTerminal | undefined
  // Keeps a terminal the person closed as the newest row of its project.
  readonly keep: (projectId: string, terminal: TerminalMetadata, now: number) => void
  readonly stop: () => void
}

export const createDemoHistory = (now: number, withSamples = true): DemoHistory => {
  const state = createStore<HistoryState>({
    rows: withSamples ? [...rowsOf("storefront", storefront, now)] : [],
  })
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const change = (next: (rows: readonly ClosedTerminal[]) => readonly ClosedTerminal[]): void => {
    state.update((current) => ({ rows: next(current.rows) }))
  }
  // Runs a change the way the runner's stream brings it: a moment after the request.
  const later = (ms: number, run: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, ms)
    timers.add(timer)
  }
  let kept = 0
  const unrestorable = new Set<string>()
  let restorableChanged = (): void => {}
  return {
    history: {
      setRestorable: (terminalId, restorable) => {
        if (restorable) unrestorable.delete(terminalId)
        else unrestorable.add(terminalId)
        restorableChanged()
      },
      isRestorable: (terminalId) => !unrestorable.has(terminalId),
      onRestorable: (listener) => {
        restorableChanged = listener
      },
      state,
      list: (projectId) =>
        Promise.resolve(state.getSnapshot().rows.filter((row) => row.projectId === projectId)),
    },
    restore: (id) => {
      const row = state.getSnapshot().rows.find((each) => each.id === id)
      if (!row) return undefined
      later(restoringMs, () =>
        change((rows) =>
          rows.map((each) =>
            each.id === id ? { ...each, availability: { state: "restoring" } } : each,
          ),
        ),
      )
      later(restoreMs, () => change((rows) => rows.filter((each) => each.id !== id)))
      return row
    },
    keep: (projectId, terminal, at) => {
      const agent = harnesses.find(({ id }) => id === terminal.process)?.id ?? null
      kept += 1
      const row: ClosedTerminal = {
        id: `closed-kept-${kept}`,
        projectId,
        title: terminal.name,
        summary: null,
        handle: terminal.handle ?? null,
        agent,
        program: terminal.process || null,
        cwd: terminal.directory,
        closedAt: at,
        closedBy: null,
        availability: { state: "ready" },
      }
      change((rows) => [row, ...rows])
    },
    stop: () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}

// What a terminal says of closing it, as the runner does: a program runs in the shell (an
// agent counts), or its agent can resume. Both are false once nothing runs.
const closingFacts = (
  terminal: TerminalMetadata,
  restorable: boolean,
): { busy: boolean; restorable: boolean } =>
  terminal.state === "running"
    ? terminal.agent
      ? { busy: true, restorable }
      : { busy: true, restorable: false }
    : { busy: false, restorable: false }

// Nothing was ever run in a plain shell nobody used: it leaves no row, as the runner's.
const wasUsed = (terminal: TerminalMetadata): boolean =>
  terminal.state !== "idle" ||
  terminal.agentRan === true ||
  terminal.name !== "Terminal" ||
  terminal.command !== "zsh"

// A backend whose closed terminals are kept and can be restored, with the demo's samples.
export const withHistory = (backend: Backend, history = createDemoHistory(Date.now())): Backend => {
  let latest: Workspace | undefined
  let sink: BackendSink | undefined
  // Brings every terminal's `busy` and `restorable` in line with what it runs, which the
  // demo's shells and agents change by their status, not by a fact of their own.
  const settle = (): void => {
    if (!latest || !sink) return
    const updates: BackendAction[] = []
    for (const { key, terminal } of terminalsOf(latest)) {
      const facts = closingFacts(terminal, history.history.isRestorable(key.terminalId))
      if (
        (terminal.busy ?? false) === facts.busy &&
        (terminal.restorable ?? false) === facts.restorable
      )
        continue
      updates.push({
        type: "terminal/update",
        target: {
          projectId: key.projectId,
          workspaceSessionId: key.workspaceSessionId,
        },
        terminalId: key.terminalId,
        ...facts,
      })
    }
    if (updates.length) sink.dispatch(updates)
  }
  history.history.onRestorable(() => queueMicrotask(settle))
  return {
    ...backend,
    history: history.history,
    newTerminal: (input) => {
      const { closed, ...rest } = input
      const terminal = backend.newTerminal(rest)
      const row = closed === undefined ? undefined : history.restore(closed)
      return row ? { ...terminal, name: row.title } : terminal
    },
    commit: (workspace, actions) => {
      const before = latest
      latest = workspace
      backend.commit(workspace, actions)
      for (const action of actions) {
        if (action.type !== "terminal/close") continue
        const closed =
          before &&
          terminalsOf(before).find(
            ({ key }) =>
              key.terminalId === action.terminalId &&
              key.projectId === action.target.projectId &&
              key.workspaceSessionId === action.target.workspaceSessionId,
          )
        if (closed && wasUsed(closed.terminal))
          history.keep(action.target.projectId, closed.terminal, Date.now())
      }
      // Not from inside the commit: the store won't take a dispatch there.
      queueMicrotask(settle)
    },
    start: (next) => {
      sink = next
      const stop = backend.start?.(next)
      queueMicrotask(settle)
      return () => {
        stop?.()
        history.stop()
        if (sink === next) sink = undefined
      }
    },
  }
}

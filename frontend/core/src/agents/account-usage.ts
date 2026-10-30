import { harnesses } from "../harnesses"
import type { Workspace } from "../types"
import type { Telemetry } from "./telemetry"

// A window's length as people say it: "5h", "7d", or minutes when neither fits.
const windowName = (minutes: number | null): string => {
  if (minutes === null) return "limit"
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

// The agents whose subscriptions Novadeck hears of, by program name, as people call them.
const agentNames: Readonly<Record<string, string>> = Object.fromEntries(
  harnesses.map(({ id, name }) => [id, name]),
)

// One of a subscription's limit windows: its length as people say it ("5h", "7d"), how
// much of it is used, as a fraction, and when it resets, where its agent says.
export type UsageWindow = {
  // Which of its agent's windows it is, as two of the same length share a name.
  readonly key: string
  readonly name: string
  readonly minutes: number | null
  readonly used: number
  readonly resetsAt: number | null
}

// What one agent's subscription has left. Its kind says how it's limited: by windows of
// time, each used up to a share and reset, as every agent that reports limits does now.
// One paid by credits, with a balance and no windows, would be another kind. A windowed
// one has its windows, shortest first, and the one most used, which says it at a glance.
export type AgentAccount = {
  readonly kind: "windows"
  readonly program: string
  readonly name: string
  readonly windows: readonly UsageWindow[]
  readonly busiest: UsageWindow
}

// A running terminal's place in the telemetry: the session that holds it
// (`${projectId}/${workspaceSessionId}`), its id, and the program it runs.
export type AgentSeat = {
  readonly context: string
  readonly id: string
  readonly program: string
}

// Every running terminal in every session: subscriptions are the account's, whichever
// reports them.
export const runningSeats = (workspace: Workspace): readonly AgentSeat[] =>
  workspace.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals.flatMap((terminal) =>
        terminal.state === "running"
          ? [{ context: `${project.id}/${session.id}`, id: terminal.id, program: terminal.process }]
          : [],
      ),
    ),
  )

export const sameSeats = (a: readonly AgentSeat[], b: readonly AgentSeat[]): boolean =>
  a.length === b.length &&
  a.every(
    (seat, index) =>
      seat.context === b[index]!.context &&
      seat.id === b[index]!.id &&
      seat.program === b[index]!.program,
  )

// Where an agent's subscription stands among the others until the person moves it: in
// this order, then any other agent after them.
const defaultOrder: readonly string[] = harnesses.map(({ id }) => id)

const rank = (program: string, order: readonly string[]): number => {
  const placed = order.indexOf(program)
  if (placed >= 0) return placed
  const known = defaultOrder.indexOf(program)
  return order.length + (known >= 0 ? known : defaultOrder.length)
}

// Each agent's subscription, as its running terminals (`seats`) report it in `telemetry`,
// in the order the person left them (`order`, by program), then the default one; never by
// how much is used, so a subscription stays where it was looked for. A subscription is the
// account's, so every terminal of an agent reports the same windows; of two readings of a
// window the one resetting later is the newer, and of two resetting together the one used
// more. A window whose reset has passed says nothing until its agent reports again.
// Terminals that report no limits, as an API-key account's don't, leave their agent out.
// Two windows of the same length in one reading are two quotas, as Antigravity's weekly
// ones are, so they stay apart, matched across terminals by order.
export const accountUsage = (
  seats: readonly AgentSeat[],
  telemetry: Telemetry,
  now = Date.now(),
  order: readonly string[] = [],
): readonly AgentAccount[] => {
  const byAgent = new Map<string, Map<string, UsageWindow>>()
  for (const { context, id, program } of seats) {
    if (!agentNames[program]) continue
    const seen = new Map<string, number>()
    for (const limit of telemetry[context]?.[id]?.limits ?? []) {
      const name = windowName(limit.minutes)
      const nth = seen.get(name) ?? 0
      seen.set(name, nth + 1)
      if (limit.resetsAt !== null && limit.resetsAt <= now) continue
      const key = `${name}#${nth}`
      const windows = byAgent.get(program) ?? new Map<string, UsageWindow>()
      byAgent.set(program, windows)
      const known = windows.get(key)
      const later = (limit.resetsAt ?? 0) - (known?.resetsAt ?? 0)
      if (!known || later > 0 || (later === 0 && limit.used > known.used))
        windows.set(key, {
          key,
          name,
          minutes: limit.minutes,
          used: limit.used,
          resetsAt: limit.resetsAt,
        })
    }
  }
  return [...byAgent]
    .map(([program, windows]): AgentAccount => {
      const sorted = [...windows.values()].toSorted(
        (a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity),
      )
      return {
        kind: "windows",
        program,
        name: agentNames[program]!,
        windows: sorted,
        busiest: sorted.toSorted((a, b) => b.used - a.used)[0]!,
      }
    })
    .toSorted((a, b) => rank(a.program, order) - rank(b.program, order))
}

// Whether two readings of the accounts say the same, so a report that moves nothing the
// footer shows leaves it as it was.
export const sameAccounts = (a: readonly AgentAccount[], b: readonly AgentAccount[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

// The order after the person moves the subscription shown `from` to `to`: the ones shown,
// as they now stand, then those not shown now, as they were left.
export const movedOrder = (
  accounts: readonly AgentAccount[],
  order: readonly string[],
  from: number,
  to: number,
): readonly string[] => {
  const shown = accounts.map((account) => account.program)
  const [moved] = shown.splice(from, 1)
  if (moved === undefined) return order
  shown.splice(to, 0, moved)
  return [...shown, ...order.filter((program) => !shown.includes(program))]
}

// When the soonest window still to reset does, so a view can drop it then; undefined
// without one.
export const nextAccountReset = (accounts: readonly AgentAccount[]): number | undefined => {
  const times = accounts.flatMap((account) =>
    account.windows.flatMap((window) => (window.resetsAt === null ? [] : [window.resetsAt])),
  )
  return times.length > 0 ? Math.min(...times) : undefined
}

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

// When a window resets, as people say it: how long from now with the time, within a day,
// "in 2h 14m · 16:30"; the weekday and time further off, "Thu 09:00".
export const resetText = (at: number, now = Date.now()): string => {
  const minutes = Math.max(0, Math.ceil((at - now) / 60_000))
  // Six days on, a weekday alone could be today's, so it counts the days instead.
  if (minutes >= 6 * 24 * 60) return `in ${Math.floor(minutes / (24 * 60))}d · ${clock(at)}`
  if (minutes >= 24 * 60)
    return `${new Date(at).toLocaleDateString(undefined, { weekday: "short" })} ${clock(at)}`
  const hours = Math.floor(minutes / 60)
  const left = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  return `in ${left} · ${clock(at)}`
}

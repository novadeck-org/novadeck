import { harnesses } from "../harnesses"
import type { Workspace } from "../types"
import { day, hour, minute } from "../units"
import type { Telemetry } from "./telemetry"

const minutesPerHour = hour / minute
const minutesPerDay = day / minute

// A window's length as people say it: "5h", "7d", or minutes when neither fits.
const windowName = (minutes: number | null): string => {
  if (minutes === null) return "limit"
  if (minutes % minutesPerDay === 0) return `${minutes / minutesPerDay}d`
  if (minutes % minutesPerHour === 0) return `${minutes / minutesPerHour}h`
  return `${minutes}m`
}

// The agents whose subscriptions Novadeck hears of, by program name, as people call them.
const agentNames: Readonly<Record<string, string>> = Object.fromEntries(
  harnesses.map(({ id, name }) => [id, name]),
)

// One of a subscription's limit windows: its length as people say it ("5h", "7d"), the
// models it covers where it doesn't cover them all (`scope`, "Fable"), its `label`, the two
// together ("7d Fable"), which tells it from the account's own window of that length, how
// much of it is used, as a fraction, and when it resets, where its agent says.
export type UsageWindow = {
  // Which of its agent's windows it is, as two of the same length share a name.
  readonly key: string
  readonly name: string
  readonly scope?: string
  readonly label: string
  readonly minutes: number | null
  readonly used: number
  readonly resetsAt: number | null
}

// Shortest first; of one length, the account's own before a scoped one, then by scope.
const windowOrder = (a: UsageWindow, b: UsageWindow): number =>
  (a.minutes ?? Infinity) - (b.minutes ?? Infinity) ||
  Number(a.scope !== undefined) - Number(b.scope !== undefined) ||
  (a.scope ?? "").localeCompare(b.scope ?? "")

// What one agent's subscription has left. Its kind says how it's limited: by windows of
// time, each used up to a share and reset, as every agent that reports limits does now.
// One paid by credits, with a balance and no windows, would be another kind. A windowed
// one has its windows, shortest first, and the one most used of those that limit the work
// under way, which says it at a glance.
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
// A window is matched across terminals by its length and scope; two of the same length and
// scope in one reading are two quotas all the same, so they stay apart, matched by order.
export const accountUsage = (
  seats: readonly AgentSeat[],
  telemetry: Telemetry,
  now = Date.now(),
  order: readonly string[] = [],
): readonly AgentAccount[] => {
  const byAgent = new Map<string, Map<string, UsageWindow>>()
  // The models each agent's terminals run, as their records name them.
  const models = new Map<string, string[]>()
  for (const { context, id, program } of seats) {
    if (!agentNames[program]) continue
    const model = telemetry[context]?.[id]?.model
    if (model) models.set(program, [...(models.get(program) ?? []), model.toLowerCase()])
    const seen = new Map<string, number>()
    for (const limit of telemetry[context]?.[id]?.limits ?? []) {
      const name = windowName(limit.minutes)
      const label = limit.scope === undefined ? name : `${name} ${limit.scope}`
      const nth = seen.get(label) ?? 0
      seen.set(label, nth + 1)
      if (limit.resetsAt !== null && limit.resetsAt <= now) continue
      const key = `${label}#${nth}`
      const windows = byAgent.get(program) ?? new Map<string, UsageWindow>()
      byAgent.set(program, windows)
      const known = windows.get(key)
      const later = (limit.resetsAt ?? 0) - (known?.resetsAt ?? 0)
      if (!known || later > 0 || (later === 0 && limit.used > known.used))
        windows.set(key, {
          key,
          name,
          ...(limit.scope !== undefined && { scope: limit.scope }),
          label,
          minutes: limit.minutes,
          used: limit.used,
          resetsAt: limit.resetsAt,
        })
    }
  }
  return [...byAgent]
    .map(([program, windows]): AgentAccount => {
      const sorted = [...windows.values()].toSorted(windowOrder)
      // At a glance, what limits the work under way: the account's own windows and those of
      // the models its terminals run, not a model's used up that none runs now. Where none is
      // so, as Antigravity's quotas each cover some models, any.
      const running = models.get(program) ?? []
      const limiting = sorted.filter(
        ({ scope }) =>
          scope === undefined || running.some((model) => model.includes(scope.toLowerCase())),
      )
      return {
        kind: "windows",
        program,
        name: agentNames[program]!,
        windows: sorted,
        busiest: (limiting.length > 0 ? limiting : sorted).toSorted((a, b) => b.used - a.used)[0]!,
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
  const minutes = Math.max(0, Math.ceil((at - now) / minute))
  // Six days on, a weekday alone could be today's, so it counts the days instead.
  if (minutes >= 6 * minutesPerDay)
    return `in ${Math.floor(minutes / minutesPerDay)}d · ${clock(at)}`
  if (minutes >= minutesPerDay)
    return `${new Date(at).toLocaleDateString(undefined, { weekday: "short" })} ${clock(at)}`
  const hours = Math.floor(minutes / minutesPerHour)
  const left = hours > 0 ? `${hours}h ${minutes % minutesPerHour}m` : `${minutes}m`
  return `in ${left} · ${clock(at)}`
}

import type { AgentWaiting, TerminalMetadata } from "./types"

const second = 1000
const minute = 60 * second
const hour = 60 * minute

// How long a wake-up that has come and gone is still waited on: its agent's next turn
// starts a moment after it, and a tab must not flicker back to idle in between.
export const wakeGraceMs = 2 * minute

// How far ahead of a wake-up its tab starts to fill, where nothing tells when the agent set
// it.
const wakeHorizonMs = 30 * minute

// Quarters of the way to a wake-up, which its tab's glyph fills by: 0 to 3.
const wakeSteps = 4

const waitingIn = (terminal: TerminalMetadata): AgentWaiting | undefined =>
  terminal.state === "running" ? terminal.agent?.waiting : undefined

// What an agent waits on once its turn is over: the jobs it left running, oldest first,
// each labelled in its own words (its command where it gave none), and its wake-up while it
// has not passed by more than the grace. Undefined when it waits on nothing.
export type Waiting = {
  readonly jobs: readonly {
    readonly id: string
    readonly label: string
    readonly command: string
    readonly since: number
    readonly until: number | null
  }[]
  readonly wake: { readonly at: number; readonly reason: string | null } | null
}

export const waitingOf = (terminal: TerminalMetadata, now = Date.now()): Waiting | undefined => {
  const waiting = waitingIn(terminal)
  if (!waiting) return undefined
  const jobs = waiting.jobs
    .map(({ description, ...job }) => ({
      ...job,
      label: description ?? job.command,
    }))
    .toSorted((a, b) => a.since - b.since)
  const wake = waiting.wake && waiting.wake.at + wakeGraceMs > now ? waiting.wake : null
  return jobs.length > 0 || wake ? { jobs, wake } : undefined
}

// "14:32", the local time of day.
export const clockTime = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

// When the wake-up of an agent that has none left to wait on passed, as the tab's trace of
// it says: "14:32". Undefined while it waits on something or never set one.
export const wakePassed = (terminal: TerminalMetadata, now = Date.now()): string | undefined => {
  const wake = waitingIn(terminal)?.wake
  if (!wake || waitingOf(terminal, now)) return undefined
  return clockTime(wake.at)
}

// How far its wake-up has come, in quarters from 0 to 3, for its glyph to fill by: from
// when its latest turn ended, where its harness tells it, as that is when the agent set
// it.
export const wakeFill = (terminal: TerminalMetadata, now = Date.now()): number => {
  const wake = waitingIn(terminal)?.wake
  if (!wake) return 0
  const ended = terminal.state === "running" ? terminal.agent?.lastTurn?.at : undefined
  const start = ended !== undefined && ended < wake.at ? ended : wake.at - wakeHorizonMs
  const fraction = (now - start) / (wake.at - start)
  return Math.min(wakeSteps - 1, Math.max(0, Math.floor(fraction * wakeSteps)))
}

// How long a job has run, short, for its tab: "<1m", "4m", then "2h".
export const minutesWaited = (since: number, now = Date.now()): string => {
  const elapsed = Math.max(0, now - since)
  if (elapsed < minute) return "<1m"
  return elapsed < hour ? `${Math.floor(elapsed / minute)}m` : `${Math.floor(elapsed / hour)}h`
}

// "8:14", the time left to `at`, for a window's countdown.
export const countdown = (at: number, now = Date.now()): string => {
  const left = Math.max(0, Math.ceil((at - now) / second))
  const seconds = String(left % 60).padStart(2, "0")
  return left >= 3600
    ? `${Math.floor(left / 3600)}:${String(Math.floor((left % 3600) / 60)).padStart(2, "0")}:${seconds}`
    : `${Math.floor(left / 60)}:${seconds}`
}

// What a waiting agent's tab and window say in a line each: the job waited on longest, in
// the agent's words, with how many more there are and how long it has run; or, with no
// job, its wake-up's reason and time. Undefined when it waits on nothing.
export type WaitingLine =
  | {
      readonly kind: "job"
      readonly label: string
      readonly more: number
      readonly since: number
    }
  | { readonly kind: "wake"; readonly label: string; readonly at: number }

export const waitingLine = (
  terminal: TerminalMetadata,
  now = Date.now(),
): WaitingLine | undefined => {
  const waiting = waitingOf(terminal, now)
  if (!waiting) return undefined
  const [job, ...rest] = waiting.jobs
  if (job)
    return {
      kind: "job",
      label: job.label,
      more: rest.length,
      since: job.since,
    }
  return waiting.wake
    ? {
        kind: "wake",
        label: waiting.wake.reason ?? "Wake-up",
        at: waiting.wake.at,
      }
    : undefined
}

const counted = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`

// What a waiting agent waits on, in words for its tab's description and assistive
// technology: "Waiting on Watch CI checks, 4 minutes", or "Waits to wake at 14:32".
// Undefined when it waits on nothing.
export const waitingText = (terminal: TerminalMetadata, now = Date.now()): string | undefined => {
  const line = waitingLine(terminal, now)
  if (!line) return undefined
  if (line.kind === "wake") return `Waits to wake at ${clockTime(line.at)}`
  const minutes = Math.floor(Math.max(0, now - line.since) / minute)
  const what = line.more > 0 ? `${line.label} and ${counted(line.more, "other job")}` : line.label
  return `Waiting on ${what}, ${counted(minutes, "minute")}`
}

// When what a waiting tab shows next changes, so a view can render it again: the minutes
// waited, the quarter its wake-up has come, or the wake-up passing by the grace. Undefined
// when it waits on nothing.
export const nextWaitingChange = (
  terminal: TerminalMetadata,
  now = Date.now(),
): number | undefined => {
  const waiting = waitingOf(terminal, now)
  if (!waiting) return undefined
  const times: number[] = []
  const oldest = waiting.jobs[0]
  if (oldest) {
    const elapsed = Math.max(0, now - oldest.since)
    const unit = elapsed < hour ? minute : hour
    times.push(oldest.since + (Math.floor(elapsed / unit) + 1) * unit)
  }
  const wake = waitingIn(terminal)?.wake
  if (wake && waiting.wake) {
    const ended = terminal.state === "running" ? terminal.agent?.lastTurn?.at : undefined
    const start = ended !== undefined && ended < wake.at ? ended : wake.at - wakeHorizonMs
    const quarter = (wake.at - start) / wakeSteps
    const next = start + (Math.floor((now - start) / quarter) + 1) * quarter
    times.push(next < wake.at ? next : wake.at + wakeGraceMs)
  }
  return Math.min(...times)
}

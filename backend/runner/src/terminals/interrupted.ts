import type { AgentActivity, AgentName } from "@novadeck/protocol"

import { busy } from "./busy.js"
import { failed } from "./failures.js"
import type { Record, Started } from "./record.js"
import type { AgentReport, AgentTurn } from "./saved-terminals.js"

/**
 * What a turn was doing, from the activity clients see (`harnesses/activity.ts`'s
 * `summary`), whichever the harness. "running" is a turn running, subagents and background
 * agents it left included, as a restart of Novadeck stops them too; "waking" is an agent
 * idle but waiting on a wake-up or background command it set, which the restart stopped,
 * so nothing wakes it. Neither when it waits on the person (a permission, question or
 * plan, but for one asked without waiting), is idle, finished, Escaped or ended by an error: a resume of those has nothing cut.
 */
export const turnOf = (activity: AgentActivity | null): AgentTurn | undefined => {
  // A request asked without waiting leaves its turn running all the same.
  if (!activity || activity.attention.pending > (activity.attention.detached ?? 0)) return undefined
  if (activity.state === "working") return "running"
  const { waiting } = activity
  return waiting && (waiting.jobs.length > 0 || waiting.wake) ? "waking" : undefined
}

/**
 * The sessions with `turn` set on `agent`'s and removed from the rest; the same object when
 * nothing changes. A session other than the one bound has no turn of this runner's.
 */
const withTurn = (
  agents: Record["agents"],
  agent: AgentName | null,
  sessionId: string | null,
  turn: AgentTurn | undefined,
): Record["agents"] => {
  let next = agents
  for (const name of Object.keys(agents) as AgentName[]) {
    const report = agents[name]!
    const wanted = name === agent && report.sessionId === sessionId ? turn : undefined
    if (report.turn === wanted) continue
    const { turn: _, ...rest } = report
    const changed: AgentReport = wanted ? { ...rest, turn: wanted } : rest
    next = { ...next, [name]: changed }
  }
  return next
}

/**
 * Keeps what the bound session is doing in the terminal's sessions, to be saved when it
 * changes, so a restart of Novadeck that kills the shell finds what was cut (`restored`).
 * Where no session is bound there is none. Whether it changed.
 */
export const markTurn = (
  record: Pick<Record, "agents" | "bound">,
  activity: AgentActivity | null,
): boolean => {
  const binding = record.bound?.binding
  const next = withTurn(
    record.agents,
    binding?.agent ?? null,
    binding?.sessionId ?? null,
    turnOf(activity),
  )
  if (next === record.agents) return false
  record.agents = next
  return true
}

/**
 * The sessions a restored terminal starts with: the same object where it was not saved or
 * held no turn. A session carries nothing of this run over, so every saved turn is dropped
 * (the terminal then differs from its row, to be saved); what the resumed agent was doing
 * when the runner stopped is kept apart in `started` (`Record.resumeTurn`) for
 * `interruptedFor`. Without a resume there is none to tell.
 */
export const restored = (
  saved: Record["agents"] | undefined,
  resume: AgentName | false | undefined,
  started: Pick<Started, "resumeTurn">,
): Record["agents"] => {
  const agents = saved ?? {}
  started.resumeTurn = resume ? agents[resume]?.turn : undefined
  const next = withTurn(agents, null, null, undefined)
  return next === agents ? (saved ?? agents) : next
}

const notices = {
  running:
    "Novadeck: automatic notice, not from the user: Novadeck restarted (for an update, or " +
    "because it was closed) while your turn was running, and has resumed this session. " +
    "Anything running then, such as commands and subagents, has stopped. Carry on where " +
    "you left off; if that work is already done, say so in a line. This notice needs no " +
    "other reply.",
  waking:
    "Novadeck: automatic notice, not from the user: Novadeck restarted (for an update, or " +
    "because it was closed) while you waited on a background command or a wake-up you set, " +
    "and has resumed this session. It has stopped and will not wake you. Check on that work " +
    "and carry on. This notice needs no other reply.",
} as const satisfies { [turn in AgentTurn]: string }

/**
 * The session an agent showed in a terminal: a bound root's full id, or, where only its
 * prompt shows before any binds (Codex's title), the start of the id it showed, if it did.
 */
export type Seen = { readonly sessionId: string } | { readonly prefix: string | null }

/**
 * The notice a resumed terminal's agent is due, or undefined: only for the first session to
 * show or bind in a terminal that the runner restored with its shell resuming an agent that
 * was mid-turn or waiting on its own work when the previous runner stopped
 * (`Record.resumeTurn`, kept by `markTurn`, read by `restored` and so never set by a
 * person's restart of a shell), only if that session is the one resumed (`resumeClaim`), and
 * only if nothing has started a turn there since (the person's own words carry the agent
 * on). An agent that was idle, waiting on the person, Escaped or errored carries no turn.
 * The terminal is marked (`resumeTold`), so this decides once per resume.
 */
export const interruptedFor = (
  record: Pick<Record, "resumeClaim" | "resumeTold" | "resumeTurn" | "bound">,
  agent: AgentName,
  seen: Seen,
): string | undefined => {
  const { resumeTurn } = record
  record.resumeTurn = undefined
  if (!record.resumeClaim || record.resumeTold) return undefined
  // Once per resume: the first session it follows, whatever it turns out to be.
  record.resumeTold = true
  if (!resumeTurn || !record.resumeClaim.startsWith(`${agent}:`)) return undefined
  const resumed = record.resumeClaim.slice(agent.length + 1)
  if (
    "sessionId" in seen
      ? seen.sessionId !== resumed
      : seen.prefix && !resumed.startsWith(seen.prefix)
  )
    return undefined
  // A turn started meanwhile, as the person typed, goes on by itself.
  if (busy(record.bound?.activity)) return undefined
  return notices[resumeTurn]
}

/**
 * Tells a resumed terminal's agent to carry on if it is due (`interruptedFor`), as any
 * message, so the person never has to visit its terminal. It runs where the resumed agent
 * first shows itself: a session bound (Claude Code's start hook, Antigravity's status line)
 * or its prompt shown before any binds (Codex's title, as it binds with its first prompt).
 */
export const tellInterrupted = (
  record: Pick<Record, "resumeClaim" | "resumeTold" | "resumeTurn" | "bound" | "summary">,
  agent: AgentName,
  seen: Seen,
  messaging: { notice: (terminalId: string, text: string) => boolean },
): void => {
  try {
    const notice = interruptedFor(record, agent, seen)
    if (notice) messaging.notice(record.summary.id, notice)
  } catch (error) {
    failed.interrupted(error)
  }
}

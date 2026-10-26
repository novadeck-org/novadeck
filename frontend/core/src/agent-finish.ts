import { handleText } from "./handle"
import type { Store } from "./store"
import type { AgentTurnEnd, TerminalMetadata, Workspace } from "./types"

// An agent that finished: its turn over on its own, completed or `failed` on an error,
// with nothing it started left that wakes it, as subagents do, and nothing waiting on the
// person. `reply` is the start of its last reply, where its harness tells it.
export type AgentFinish = { readonly failed: boolean; readonly reply?: string }

// The turn end of a terminal's agent Novadeck last took in, by its `at`: null when it
// showed none. Undefined before the terminal was first seen.
export type SeenEnd = number | null

const turnEnd = (terminal: TerminalMetadata): AgentTurnEnd | undefined =>
  terminal.state === "running" ? terminal.agent?.lastTurn : undefined

// Whether an agent is working: its turn, or subagents it left that will wake it.
export const agentWorking = (terminal: TerminalMetadata): boolean =>
  terminal.state === "running" && terminal.agent?.working === true

// What a terminal's status tells of its agent's turn ends, given the one last taken in:
// a finish when it shows an end not seen before, as its agent rests (see `AgentFinish`).
// An end is told apart by its `at`, not by watching the agent go from working to idle, so
// a status that skipped the working one, or several ends in one, still finishes once. The
// first sight of a terminal takes in what it shows, so an end from before a reload or a
// reconnect is never a finish. While the agent works on, an end waits to be taken in; one
// shown while it waits on the person, interrupted by them, or idle with no more said (as
// Antigravity's Escape or refusal) is taken in, and no finish: they were there.
export const sightTurnEnd = (
  seen: SeenEnd | undefined,
  terminal: TerminalMetadata,
): { readonly seen: SeenEnd; readonly finish?: AgentFinish } => {
  const end = turnEnd(terminal)
  if (seen === undefined) return { seen: end?.at ?? null }
  if (!end || end.at === seen || agentWorking(terminal)) return { seen }
  const waiting = terminal.state === "running" && terminal.agent?.attention !== undefined
  if (waiting || (end.outcome !== "completed" && end.outcome !== "failed")) return { seen: end.at }
  const failed = end.outcome === "failed"
  return {
    seen: end.at,
    finish: end.reply === undefined ? { failed } : { failed, reply: end.reply },
  }
}

// How long a completed end waits to be told before it counts as a finish: a harness that
// took the person's Escape just after its reply fires its Stop, then records the
// interruption (Claude Code's transcript, Codex's `Interrupt`) within about half a second
// of the key, a turn the person stopped (docs/harness-coverage.md, "Escape against a reply
// on its way"). The end shown at the time is only a finish if it still stands then.
// Mirrors the runner's constant of the same name, which records the same end after this long;
// a test in runner-adapter keeps the two equal.
export const finishGraceMs = 700

// The finish the completed end at `at` still makes, shown still with the agent resting,
// with its reply as told by then (a Stop may add it after a record ended the turn); none
// once it turned interrupted, was replaced, or the agent works again.
export const standingFinish = (terminal: TerminalMetadata, at: number): AgentFinish | undefined => {
  const end = turnEnd(terminal)
  if (end?.at !== at || end.outcome !== "completed" || agentWorking(terminal)) return undefined
  return end.reply === undefined ? { failed: false } : { failed: false, reply: end.reply }
}

// What a desktop notification says of a finish: who finished, by the terminal's handle
// where it has one, whether it failed, and the start of its reply.
export const finishNotice = (
  terminal: TerminalMetadata,
  { failed, reply }: AgentFinish,
): { readonly title: string; readonly body: string } => {
  const what = failed ? "stopped with an error" : "is done"
  return {
    title: terminal.handle
      ? `${handleText(terminal.handle)} ${what}: ${terminal.name}`
      : `${terminal.name} ${what}`,
    body: reply ?? (failed ? "Its turn failed." : "Finished its turn."),
  }
}

// What a desktop notification says of an agent's `done` report: who is done, as `finishNotice`
// names them, and the report's subject, which the agent wrote to say what it did.
export const doneNotice = (
  terminal: TerminalMetadata,
  { subject }: { readonly subject: string },
): { readonly title: string; readonly body: string } => ({
  title: finishNotice(terminal, { failed: false }).title,
  body: subject,
})

// A finish `followFinishes` tells: the terminal's session context (`${projectId}/${sessionId}`)
// and the terminal as it stands, the finish, and the end's `at`.
export type FollowedFinish = {
  readonly context: string
  readonly terminal: TerminalMetadata
  readonly finish: AgentFinish
  readonly at: number
}

// Follows the workspace's agents finishing (see `sightTurnEnd`) and tells `onFinish` each
// one. What each terminal showed when this started is taken in as seen. A completed end waits
// `graceMs`, in case its harness then says the person's Escape stopped the turn (see
// `finishGraceMs`), and is told only if it still stands then (`standingFinish`); one that
// failed was there, and is told at once. Stops with the returned function.
export const followFinishes = (
  workspace: Store<Workspace>,
  onFinish: (finish: FollowedFinish) => void,
  { graceMs = finishGraceMs }: { graceMs?: number } = {},
): (() => void) => {
  let terminals = new Map<string, { context: string; terminal: TerminalMetadata }>()
  const seen = new Map<string, SeenEnd>()
  const waiting = new Set<ReturnType<typeof setTimeout>>()
  let previous: Workspace | undefined
  const sight = (snapshot: Workspace) => {
    const before = terminals
    terminals = new Map(
      snapshot.projects.flatMap((project) =>
        project.history.flatMap((session) =>
          session.state.roster.terminals.map(
            (terminal) =>
              [
                `${project.id}/${session.id}/${terminal.id}`,
                { context: `${project.id}/${session.id}`, terminal },
              ] as const,
          ),
        ),
      ),
    )
    const finished: {
      key: string
      context: string
      terminal: TerminalMetadata
      finish: AgentFinish
    }[] = []
    for (const [key, { context, terminal }] of terminals) {
      if (before.get(key)?.terminal === terminal) continue
      const { seen: next, finish } = sightTurnEnd(seen.get(key), terminal)
      seen.set(key, next)
      if (finish) finished.push({ key, context, terminal, finish })
    }
    for (const key of seen.keys()) if (!terminals.has(key)) seen.delete(key)
    return finished
  }
  const first = workspace.getSnapshot()
  previous = first
  sight(first)
  const follow = (): void => {
    const snapshot = workspace.getSnapshot()
    if (snapshot.projects === previous?.projects) return
    previous = snapshot
    for (const each of sight(snapshot)) {
      const at = seen.get(each.key)
      if (at === null || at === undefined) continue
      if (each.finish.failed || graceMs <= 0) {
        onFinish({ context: each.context, terminal: each.terminal, finish: each.finish, at })
        continue
      }
      const timer = setTimeout(() => {
        waiting.delete(timer)
        const current = terminals.get(each.key)
        const finish = current ? standingFinish(current.terminal, at) : undefined
        if (current && finish)
          onFinish({ context: current.context, terminal: current.terminal, finish, at })
      }, graceMs)
      waiting.add(timer)
    }
  }
  const stop = workspace.subscribe(follow)
  return () => {
    stop()
    waiting.forEach(clearTimeout)
    waiting.clear()
  }
}

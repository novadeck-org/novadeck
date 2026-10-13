import { isAgentProgram } from "../../model/process"
import type { AgentStatus, AgentTurnEnd, TerminalMetadata } from "../../model/types"
import type { BackendAction, BackendSink, TerminalKey } from "../port"
import { terminalKeyId } from "../registry"
import type { DemoAgentVerbs } from "./agent-link"
import { chatAgent } from "./samples"

// How long a demo agent's turn works before it finishes.
export const demoTurnMs = 1500

// What a demo agent's turn does that its conversation shows: it began, with the prompt
// that started it where one did, ran a tool halfway through, and ended with a reply or
// said nothing; or the agent went back to rest, with no turn behind it.
export type TurnEvent =
  | {
      readonly type: "begin"
      readonly key: TerminalKey
      readonly prompt?: string
    }
  | { readonly type: "tool"; readonly key: TerminalKey }
  | {
      readonly type: "end"
      readonly key: TerminalKey
      readonly outcome: AgentTurnEnd["outcome"]
      readonly reply?: string
    }
  | { readonly type: "rest"; readonly key: TerminalKey }

type Timers = ReturnType<typeof setTimeout>[]

// What a turn ends with, by how it ends, as an agent's harness reports its last reply.
const replies: Record<AgentTurnEnd["outcome"], string | undefined> = {
  completed: "Done. The checkout total now rounds per line, and the tests pass.",
  failed: "I could not finish: the test suite fails to compile.",
  interrupted: "Stopped before the second file.",
  unknown: undefined,
}

// The subagents `work` has an agent run.
const subagents = [
  { id: "sub-1", type: "Explore" },
  { id: "sub-2", type: "code-reviewer" },
  { id: "sub-3", type: null },
]

// What its ended turn left running, which the next status keeps.
const left = (agent: AgentStatus | undefined) =>
  agent?.background ? { background: agent.background } : {}

const statusOf = (terminal: TerminalMetadata | undefined): AgentStatus | undefined =>
  terminal?.state === "running" ? terminal.agent : undefined

// The demo agents' turns, and the one owner of each demo agent: every status they report
// goes through here, so what the chat, the screen and the app's marks show follow from it,
// as they do from a real agent. A prompt to one of them idle at its prompt works for a
// moment, then finishes with the reply it shows, as its hooks would report it, anything it
// left running still running. `prompt` starts a turn and `interrupt` ends one early, as
// Escape does; `resume` takes an agent past what it asked; the verbs `work`, `ask`,
// `finish`, `rest` and `usage` put an agent in a state of the seeds' and the debug panel's choosing
// (see `DemoAgentVerbs`), each cancelling what an earlier one or a turn still had pending;
// `watch` hears every turn's events; and `start` takes the sink the statuses go to.
export const demoTurns = (turnMs = demoTurnMs) => {
  let sink: BackendSink | undefined
  const watchers = new Set<(event: TurnEvent) => void>()
  // The timers of each turn in flight, by terminal.
  const active = new Map<string, Timers>()
  // How many times each terminal's agent was taken some other way: a verb, a prompt, a Stop
  // or a release. What waits to act on it, an answer on its way, checks it hasn't moved.
  const epochs = new Map<string, number>()
  const bump = (id: string): void => void epochs.set(id, (epochs.get(id) ?? 0) + 1)
  // The usage `usage` last set while a turn works, which that turn's later statuses keep
  // in place of the one it began with; gone once the turn ends for good.
  const metered = new Map<string, NonNullable<AgentStatus["usage"]>>()
  // What a status keeps across the turns: its tokens and quotas.
  const kept = (key: TerminalKey, agent: AgentStatus | undefined) => {
    const usage = metered.get(terminalKeyId(key)) ?? agent?.usage
    return usage ? { usage } : {}
  }
  const emit = (event: TurnEvent): void => watchers.forEach((watcher) => watcher(event))
  const cancel = (id: string): void => {
    active.get(id)?.forEach(clearTimeout)
    active.delete(id)
  }
  // Reports the agent's status; `program` first makes the terminal's process one.
  const status = (key: TerminalKey, agent: AgentStatus, program?: string): void => {
    const { projectId, workspaceSessionId, terminalId } = key
    const target = { projectId, workspaceSessionId }
    const actions: BackendAction[] = [
      ...(program
        ? [
            {
              type: "terminal/process" as const,
              target,
              terminalId,
              process: program,
            },
          ]
        : []),
      {
        type: "terminal/status",
        target,
        terminalId,
        status: { state: "running", agent },
      },
    ]
    sink?.dispatch(actions)
  }
  // Works for a moment, running a tool halfway where it `tools`, then ends with the reply.
  const run = (key: TerminalKey, agent: AgentStatus, reply: string, tools: boolean): void => {
    const id = terminalKeyId(key)
    const timers: Timers = [
      ...(tools ? [setTimeout(() => emit({ type: "tool", key }), turnMs / 2)] : []),
      setTimeout(() => {
        active.delete(id)
        status(key, {
          working: false,
          ...left(agent),
          ...kept(key, agent),
          lastTurn: { outcome: "completed", reply, at: Date.now() },
        })
        metered.delete(id)
        emit({ type: "end", key, outcome: "completed", reply })
      }, turnMs),
    ]
    active.set(id, timers)
    // After the engine's own update: a status is a workspace commit of its own.
    queueMicrotask(() => {
      if (active.get(id) === timers) status(key, { working: true, ...kept(key, agent) })
    })
  }
  // Starts the turn of an agent idle at its prompt; whether it started. Nothing for any
  // other terminal.
  const prompt = (text: string, terminal: TerminalMetadata, key: TerminalKey): boolean => {
    const id = terminalKeyId(key)
    const agent = terminal.state === "running" ? (terminal.agent ?? { working: false }) : undefined
    if (!chatAgent(terminal) || !agent || agent.working || agent.attention || active.has(id))
      return false
    bump(id)
    metered.delete(id)
    // An agent Novadeck hears nothing from reports no status, so a turn can't show: its
    // screen takes the person's line and the reply, which moves it past what it showed.
    if (terminal.state === "running" && !terminal.agent) {
      emit({ type: "begin", key, prompt: text.trim() })
      emit({
        type: "end",
        key,
        outcome: "completed",
        reply: `Done: ${text.trim()}. Nothing else changed.`,
      })
      return true
    }
    emit({ type: "begin", key, prompt: text.trim() })
    run(key, agent, `Done: ${text.trim()}. Nothing else changed.`, true)
    return true
  }
  // Takes an agent past what it asked, once the person answered: it waits no more, and
  // goes on to say `reply`, or, with the person's words as a `prompt`, to a turn on them,
  // or, where it `waits`, stops at its prompt for the person's next words.
  const resume = (
    key: TerminalKey,
    terminal: TerminalMetadata,
    next: { readonly reply: string } | { readonly prompt: string } | { readonly waits: true },
  ): void => {
    if (terminal.state !== "running" || active.has(terminalKeyId(key))) return
    const agent = terminal.agent ?? { working: false }
    bump(terminalKeyId(key))
    metered.delete(terminalKeyId(key))
    const resting: AgentStatus = {
      working: false,
      ...left(agent),
      ...kept(key, agent),
    }
    status(key, resting)
    if ("waits" in next) return
    if ("prompt" in next) prompt(next.prompt, { ...terminal, agent: resting }, key)
    else run(key, resting, next.reply, false)
  }

  // What every verb starts with: it cancels what the terminal had pending, and says whether
  // the terminal's process must become an agent, and whether a turn begins.
  const take = (key: TerminalKey, terminal: TerminalMetadata | undefined) => {
    cancel(terminalKeyId(key))
    bump(terminalKeyId(key))
    metered.delete(terminalKeyId(key))
    const agent = statusOf(terminal)
    const program = terminal && isAgentProgram(terminal.process) ? undefined : "claude"
    return { agent, program, began: !agent?.working || program !== undefined }
  }
  const verbs: DemoAgentVerbs = {
    work: (key, terminal, how) => {
      const { agent, program, began } = take(key, terminal)
      if (began) emit({ type: "begin", key })
      status(
        key,
        {
          working: true,
          ...(how?.planning ? { planning: true as const } : {}),
          ...(how?.subagents ? { subagents } : {}),
          ...kept(key, agent),
        },
        program,
      )
    },
    ask: (key, terminal, kind, count, headline) => {
      const { agent, program, began } = take(key, terminal)
      if (began) emit({ type: "begin", key })
      status(
        key,
        {
          working: true,
          ...(kind === "plan" ? { planning: true as const } : {}),
          attention: { kind, count, ...(headline ? { headline } : {}) },
          // What it runs beside the request keeps running.
          ...(agent?.working && agent.subagents ? { subagents: agent.subagents } : {}),
          ...kept(key, agent),
        },
        program,
      )
    },
    finish: (key, terminal, outcome, options) => {
      const { agent, program, began } = take(key, terminal)
      const id = terminalKeyId(key)
      const after = options?.after ?? turnMs
      const { gist, background } = options ?? {}
      const reply = replies[outcome]
      if (began) emit({ type: "begin", key })
      status(key, { working: true, ...kept(key, agent) }, program)
      active.set(id, [
        setTimeout(() => {
          const lastTurn: AgentTurnEnd = {
            outcome,
            ...(reply ? { reply } : {}),
            ...(gist
              ? {
                  gist: gist.text,
                  ...(gist.asks ? { asks: true as const } : {}),
                }
              : {}),
            at: Date.now(),
          }
          // Its subagents keep it working until they finish, as the runner reports it.
          const waiting = background !== undefined && background.agents > 0
          status(key, {
            working: waiting,
            ...(background ? { background } : {}),
            lastTurn,
            ...kept(key, agent),
          })
          emit({ type: "end", key, outcome, ...(reply ? { reply } : {}) })
          if (!waiting) {
            metered.delete(id)
            return void active.delete(id)
          }
          active.set(id, [
            setTimeout(() => {
              active.delete(id)
              status(key, { working: false, lastTurn, ...kept(key, agent) })
              metered.delete(id)
            }, after),
          ])
        }, after),
      ])
    },
    rest: (key, terminal) => {
      const { agent, program } = take(key, terminal)
      status(key, { working: false, ...kept(key, agent) }, program)
      emit({ type: "rest", key })
    },
    usage: (key, terminal, usage) => {
      const agent = statusOf(terminal)
      // An agent Novadeck hears nothing from has no status to set it in.
      if (terminal?.state === "running" && !terminal.agent && isAgentProgram(terminal.process))
        return
      const program = terminal && isAgentProgram(terminal.process) ? undefined : "claude"
      // Only a turn in flight carries the usage on; at rest the status holds it.
      if (active.has(terminalKeyId(key))) metered.set(terminalKeyId(key), usage)
      else metered.delete(terminalKeyId(key))
      status(key, { ...(agent ?? { working: false }), usage }, program)
    },
    release: (key) => {
      cancel(terminalKeyId(key))
      bump(terminalKeyId(key))
      metered.delete(terminalKeyId(key))
    },
  }
  return {
    ...verbs,
    prompt,
    resume,
    // How many times the terminal's agent was taken some other way (see `epochs`).
    epoch: (key: TerminalKey): number => epochs.get(terminalKeyId(key)) ?? 0,
    // Answering one of several requests: the agent waits on one fewer, and all else about
    // it stays as it was.
    lower: (key: TerminalKey, terminal: TerminalMetadata, count: number): void => {
      const agent = statusOf(terminal)
      if (agent?.attention) status(key, { ...agent, attention: { ...agent.attention, count } })
    },
    // Whether a turn started here still runs.
    working: (key: TerminalKey): boolean => active.has(terminalKeyId(key)),
    // Ends the agent's turn as Escape does, refusing whatever it asked: the turn it runs
    // here stops, and any other it shows stops showing. Whether it had one to stop.
    interrupt: (key: TerminalKey, agent: AgentStatus): boolean => {
      const id = terminalKeyId(key)
      if (!active.has(id) && !agent.working && !agent.attention) return false
      cancel(id)
      bump(id)
      status(key, {
        working: false,
        ...left(agent),
        ...kept(key, agent),
        lastTurn: { outcome: "interrupted", at: Date.now() },
      })
      metered.delete(id)
      emit({ type: "end", key, outcome: "interrupted" })
      return true
    },
    watch: (watcher: (event: TurnEvent) => void): (() => void) => {
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },
    // The turns in flight stop with the sink they report to.
    start: (next: BackendSink): (() => void) => {
      sink = next
      return () => {
        if (sink !== next) return
        sink = undefined
        active.forEach((timers) => timers.forEach(clearTimeout))
        active.clear()
        metered.clear()
      }
    },
  }
}

export type DemoTurns = ReturnType<typeof demoTurns>

import type { AgentStatus, TerminalMetadata } from "../../model/types"
import type { BackendSink, TerminalKey } from "../port"
import { terminalKeyId } from "../registry"
import { chatAgent, demoAgent } from "./samples"

// How long a demo agent's turn works before it finishes.
export const demoTurnMs = 1500

// What a demo agent's turn does that its conversation shows: it began with a prompt, ran
// a tool halfway through, and ended with a reply, or was interrupted and said nothing.
export type TurnEvent =
  | {
      readonly type: "begin"
      readonly key: TerminalKey
      readonly prompt: string
    }
  | { readonly type: "tool"; readonly key: TerminalKey }
  | {
      readonly type: "end"
      readonly key: TerminalKey
      readonly outcome: "completed" | "interrupted"
      readonly reply?: string
    }

// What its ended turn left running, which the next status keeps.
const left = (agent: AgentStatus) => (agent.background ? { background: agent.background } : {})

// The demo agents' turns: a prompt to one of its agents idle at its prompt works for a
// moment, then finishes with the reply it shows, as its hooks would report it, anything it left
// running still running. `prompt` starts a turn and `interrupt` ends one early, as Escape
// does; `reply` answers a prompt typed in the terminal for the demo engine; `watch` hears
// every turn's events; and `start` takes the sink the statuses go to.
export const demoTurns = (turnMs = demoTurnMs) => {
  let sink: BackendSink | undefined
  const watchers = new Set<(event: TurnEvent) => void>()
  // The timers of each turn in flight, by terminal.
  const active = new Map<string, ReturnType<typeof setTimeout>[]>()
  const emit = (event: TurnEvent): void => watchers.forEach((watcher) => watcher(event))
  const status = (key: TerminalKey, agent: AgentStatus) => {
    const { projectId, workspaceSessionId, terminalId } = key
    sink?.dispatch([
      {
        type: "terminal/status",
        target: { projectId, workspaceSessionId },
        terminalId,
        status: { state: "running", agent },
      },
    ])
  }
  // Works for a moment, running a tool halfway where it `tools`, then ends with the reply.
  const run = (key: TerminalKey, agent: AgentStatus, reply: string, tools: boolean): void => {
    const id = terminalKeyId(key)
    active.set(id, [
      ...(tools ? [setTimeout(() => emit({ type: "tool", key }), turnMs / 2)] : []),
      setTimeout(() => {
        active.delete(id)
        status(key, {
          working: false,
          ...left(agent),
          lastTurn: { outcome: "completed", reply, at: Date.now() },
        })
        emit({ type: "end", key, outcome: "completed", reply })
      }, turnMs),
    ])
    // After the engine's own update: a status is a workspace commit of its own.
    queueMicrotask(() => {
      if (active.has(id)) status(key, { working: true })
    })
  }
  // Starts the turn of an agent idle at its prompt; nothing for any other terminal.
  const prompt = (
    text: string,
    terminal: TerminalMetadata,
    key: TerminalKey,
  ): string | undefined => {
    const id = terminalKeyId(key)
    const agent = terminal.state === "running" ? (terminal.agent ?? { working: false }) : undefined
    if (!chatAgent(terminal) || !agent || agent.working || agent.attention || active.has(id))
      return undefined
    const reply = `Done: ${text.trim()}. Nothing else changed.`
    emit({ type: "begin", key, prompt: text.trim() })
    run(key, agent, reply, true)
    // What the agent says, which the screen shows as its turn ends.
    return reply
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
    const kept = { ...left(agent), ...(agent.usage ? { usage: agent.usage } : {}) }
    status(key, { working: false, ...kept })
    if ("waits" in next) return
    if ("prompt" in next)
      prompt(next.prompt, { ...terminal, agent: { working: false, ...kept } }, key)
    else run(key, { working: false, ...kept }, next.reply, false)
  }
  return {
    prompt,
    resume,
    reply: (command: string, terminal: TerminalMetadata, key: TerminalKey): string | undefined =>
      demoAgent(terminal) ? prompt(command, terminal, key) : undefined,
    // Whether a turn started here still runs.
    working: (key: TerminalKey): boolean => active.has(terminalKeyId(key)),
    // Ends the agent's turn as Escape does, refusing whatever it asked: the turn it runs
    // here stops, and any other it shows stops showing. Whether it had one to stop.
    interrupt: (key: TerminalKey, agent: AgentStatus): boolean => {
      const id = terminalKeyId(key)
      const timers = active.get(id)
      if (!timers && !agent.working && !agent.attention) return false
      timers?.forEach(clearTimeout)
      active.delete(id)
      status(key, {
        working: false,
        ...left(agent),
        lastTurn: { outcome: "interrupted", at: Date.now() },
      })
      emit({ type: "end", key, outcome: "interrupted" })
      return true
    },
    watch: (watcher: (event: TurnEvent) => void): (() => void) => {
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },
    start: (next: BackendSink): (() => void) => {
      sink = next
      return () => {
        if (sink === next) sink = undefined
      }
    },
  }
}

export type DemoTurns = ReturnType<typeof demoTurns>

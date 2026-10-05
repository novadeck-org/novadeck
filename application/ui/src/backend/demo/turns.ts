import type { AgentStatus, TerminalMetadata } from "../../model/types"
import type { BackendSink, TerminalKey } from "../port"
import { demoAgent } from "./samples"

// How long a demo agent's turn works before it finishes.
export const demoTurnMs = 1500

// The agents demo's turns: a prompt to one of its agents idle at its prompt works for a
// moment, then finishes with the reply it shows, as its hooks would report it, anything it left
// running still running. `reply` answers the prompt for the demo engine, and `start`
// takes the sink the statuses go to.
export const demoTurns = (turnMs = demoTurnMs) => {
  let sink: BackendSink | undefined
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
  return {
    reply: (command: string, terminal: TerminalMetadata, key: TerminalKey): string | undefined => {
      const agent = terminal.state === "running" ? terminal.agent : undefined
      if (!demoAgent(terminal) || !agent || agent.working || agent.attention) return undefined
      const reply = `Done: ${command.trim()}. Nothing else changed.`
      const left = agent.background ? { background: agent.background } : {}
      // After the engine's own update: a status is a workspace commit of its own.
      queueMicrotask(() => status(key, { working: true }))
      setTimeout(
        () =>
          status(key, {
            working: false,
            ...left,
            lastTurn: { outcome: "completed", reply, at: Date.now() },
          }),
        turnMs,
      )
      // What the agent says, which the screen shows as its turn ends.
      return reply
    },
    start: (next: BackendSink): (() => void) => {
      sink = next
      return () => {
        if (sink === next) sink = undefined
      }
    },
  }
}

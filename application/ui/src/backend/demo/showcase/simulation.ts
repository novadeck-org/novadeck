import { notesIn, type CompanionEvent, type Companions } from "../../../model/companion"
import type { SampleAgent } from "./agents"

// The showcase's agents at work: they answer what their terminals are told, revise their
// plans, and show things, on a delay as if thinking. It reports all of it as a backend
// would, so the companion pane can't tell it from a runner.
export type Showcase = Companions & {
  // What the user typed in an agent's terminal.
  readonly told: (terminalId: string, input: string) => void
}

// Where the agent's plan prompt stands. Approval happens in the agent's own terminal;
// NovaDeck can't see it, so only the simulation keeps it.
type Phase = "planning" | "revising" | "working"

type Running = {
  readonly sample: SampleAgent
  phase: Phase
  revision: number
  // The plan file as the user last saved it.
  file: string
  // How many of `artifacts.next` it has shown.
  shown: number
}

export const createShowcase = (
  agents: Readonly<Record<string, SampleAgent>>,
  later: (delay: number, run: () => void) => void = (delay, run) => {
    setTimeout(run, delay)
  },
): Showcase => {
  const listeners = new Set<(event: CompanionEvent) => void>()
  const emit = (event: CompanionEvent): void => listeners.forEach((listener) => listener(event))
  const running = new Map<string, Running>(
    Object.entries(agents).map(([terminalId, sample]) => [
      terminalId,
      { sample, phase: "planning", revision: 0, file: sample.revisions[0]!, shown: 0 },
    ]),
  )

  // The agent writes its next revision; when it read the notes first it applied them.
  const revise = (terminalId: string, readNotes: boolean): void => {
    const agent = running.get(terminalId)!
    const { revisions } = agent.sample
    const revision = Math.min(agent.revision + 1, revisions.length - 1)
    const applies = readNotes && notesIn(agent.file) > 0
    if (agent.phase === "revising") agent.phase = "planning"
    if (revision === agent.revision && !applies) return
    agent.revision = revision
    emit({ type: "plan/revised", terminalId, text: revisions[revision]!, appliedNotes: readNotes })
  }

  return {
    terminals: Object.fromEntries(
      Object.entries(agents).map(([terminalId, sample]) => [
        terminalId,
        { plan: { ...sample.plan, text: sample.revisions[0]! }, shown: sample.artifacts.shown },
      ]),
    ),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    save: (terminalId, text) => {
      const agent = running.get(terminalId)
      if (agent) agent.file = text
    },
    told: (terminalId, input) => {
      const agent = running.get(terminalId)
      if (!agent) return
      const said = input.trim()
      // "show" has the agent show its next thing; "open" plays the user asking for it.
      const showing = /^(show|open)\b/i.exec(said)?.[1]?.toLowerCase()
      if (showing) {
        later(500, () => {
          const artifact = agent.sample.artifacts.next[agent.shown]
          if (!artifact) return
          agent.shown += 1
          emit({ type: "artifact/shown", terminalId, artifact, asked: showing === "open" })
        })
        return
      }
      // Without the skill the agent re-reads the plan only when asked to.
      if (!agent.sample.plan.skill && notesIn(agent.file) && /re-?read/i.test(said)) {
        later(1200, () => revise(terminalId, true))
        return
      }
      if (agent.phase !== "planning") return
      if (/^(y|yes)$/i.test(said)) {
        agent.phase = "working"
        // With the skill it re-reads the plan before starting, and applies any notes.
        if (agent.sample.plan.skill && notesIn(agent.file))
          later(1200, () => revise(terminalId, true))
        return
      }
      agent.phase = "revising"
      later(1800, () => revise(terminalId, agent.sample.plan.skill))
    },
  }
}

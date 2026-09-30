import {
  companionKeyId,
  notesIn,
  type CompanionEvent,
  type CompanionKey,
  type Companions,
  type PlanSnapshot,
} from "../../../model/companion"
import type { SampleAgent } from "./agents"
import { applyEdits, removeNotes } from "./revise"

// The showcase's agents at work: they answer what their terminals are told, revise their
// plans over the file as the user left it, and show things, on a delay as if thinking.
// It reports all of it as a backend would, so the companion pane can't tell it from a
// runner.
export type Showcase = Companions & {
  // What the user typed in an agent's terminal.
  readonly told: (key: CompanionKey, input: string) => void
  // The terminal closed: its agent is gone.
  readonly closed: (key: CompanionKey) => void
}

// Where the agent's plan prompt stands. Approval happens in the agent's own terminal;
// NovaDeck can't see it, so only the simulation keeps it.
type Phase = "planning" | "revising" | "working"

type Running = {
  readonly key: CompanionKey
  readonly sample: SampleAgent
  phase: Phase
  // How many of its revisions it has written.
  revised: number
  // The plan file, and how many times it was written.
  file: string
  writes: number
  // How many of `artifacts.next` it has shown.
  shown: number
}

const write = (agent: Running, text: string): void => {
  agent.file = text
  agent.writes += 1
}

// Each terminal's agent keeps one plan, its root one.
const planRef = "root"

export const createShowcase = (
  agents: readonly { readonly key: CompanionKey; readonly sample: SampleAgent }[],
  later: (delay: number, run: () => void) => void = (delay, run) => {
    setTimeout(run, delay)
  },
): Showcase => {
  const listeners = new Set<(event: CompanionEvent) => void>()
  const emit = (event: CompanionEvent): void => listeners.forEach((listener) => listener(event))
  const running = new Map<string, Running>(
    agents.map(({ key, sample }) => [
      companionKeyId(key),
      { key, sample, phase: "planning", revised: 0, file: sample.text, writes: 1, shown: 0 },
    ]),
  )
  const agentAt = (key: CompanionKey): Running | undefined => running.get(companionKeyId(key))

  const snapshotOf = (agent: Running): PlanSnapshot => ({
    ref: planRef,
    role: "root",
    ...agent.sample.plan,
    writable: true,
    text: agent.file,
    revision: String(agent.writes),
  })

  // The agent reads the plan file and writes over it: its next revision, when it's
  // revising, and, when it read the notes, each applied and removed.
  const revise = (agent: Running, readNotes: boolean, revising = true): void => {
    if (agent.phase === "revising") agent.phase = "planning"
    const edits = revising ? agent.sample.revisions[agent.revised] : undefined
    const edited = edits ? applyEdits(agent.file, edits) : agent.file
    const text = readNotes ? removeNotes(edited) : edited
    if (text === agent.file) return
    if (edits) agent.revised += 1
    write(agent, text)
    emit({ type: "plan/changed", key: agent.key, plan: snapshotOf(agent) })
  }

  return {
    snapshot: () =>
      [...running.values()].map((agent) => ({
        key: agent.key,
        plans: [snapshotOf(agent)],
        shown: agent.sample.artifacts.shown.map((artifact) => artifact.ref),
      })),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: (key, artifactId) => {
      const artifacts = agentAt(key)?.sample.artifacts
      const artifact = [...(artifacts?.shown ?? []), ...(artifacts?.next ?? [])].find(
        ({ ref }) => ref.id === artifactId,
      )
      return artifact
        ? Promise.resolve(artifact.content)
        : Promise.reject(new Error(`No artifact ${artifactId}`))
    },
    save: (key, ref, text, basedOn) => {
      const agent = agentAt(key)
      if (!agent || ref !== planRef) return Promise.reject(new Error(`No plan ${ref}`))
      if (basedOn !== String(agent.writes))
        return Promise.resolve({ saved: false, current: snapshotOf(agent) })
      write(agent, text)
      return Promise.resolve({ saved: true, revision: String(agent.writes) })
    },
    told: (key, input) => {
      const agent = agentAt(key)
      if (!agent) return
      const said = input.trim()
      // "show" has the agent show its next thing; "open" plays the user asking for it.
      const showing = /^(show|open)\b/i.exec(said)?.[1]?.toLowerCase()
      if (showing) {
        later(500, () => {
          const artifact = agent.sample.artifacts.next[agent.shown]
          if (!artifact) return
          agent.shown += 1
          emit({ type: "artifact/shown", key, artifact: artifact.ref, asked: showing === "open" })
        })
        return
      }
      // Without the skill the agent re-reads the plan only when asked to.
      if (!agent.sample.plan.skill && notesIn(agent.file) && /re-?read/i.test(said)) {
        later(1200, () => revise(agent, true))
        return
      }
      if (agent.phase !== "planning") return
      if (/^(y|yes)$/i.test(said)) {
        agent.phase = "working"
        // With the skill it re-reads the plan before starting, and applies any notes.
        if (agent.sample.plan.skill && notesIn(agent.file))
          later(1200, () => revise(agent, true, false))
        return
      }
      agent.phase = "revising"
      later(1800, () => revise(agent, agent.sample.plan.skill))
    },
    closed: (key) => {
      if (running.delete(companionKeyId(key))) emit({ type: "companion/closed", key })
    },
  }
}

import {
  companionKeyId,
  itemIdOf,
  notesIn,
  ownItemWith,
  type CompanionItem,
  type CompanionKey,
  type Companions,
  type ItemContent,
  type ItemId,
  type PlanVersion,
} from "../../../model/companion"
import type { WorkspaceTarget } from "../../../model/types"
import type { BackendAction } from "../../port"
import type { SampleAgent } from "./agents"
import type { SampleArtifact } from "./artifacts"
import { applyEdits, removeNotes } from "./revise"

// The showcase's agents at work: they answer what their terminals are told, revise their
// plans over the file as the person left it, and show things, on a delay as if thinking.
// It reports all of it as a backend would, items through the workspace's actions and
// their content through `follow`, so the companion pane can't tell it from a runner.
export type Showcase = Companions & {
  // What the terminals held before the demo started, for the seed.
  readonly items: readonly CompanionItem[]
  // Reports what the agents do from here on, reading the session's items as they stand
  // through `current`; returns the stop. As it first starts, each agent writes its plan
  // anew and opens what it opens.
  readonly start: (
    report: (actions: readonly BackendAction[]) => void,
    current: () => readonly CompanionItem[],
  ) => () => void
  // What the person typed in an agent's terminal.
  readonly told: (key: CompanionKey, input: string) => void
  // The terminal closed: its agent is gone.
  readonly closed: (key: CompanionKey) => void
}

// A terminal of the showcase's, by the handle its agents know it by.
type Holder = { readonly key: CompanionKey; readonly handle: string }

// Where the agent's plan prompt stands. Approval happens in the agent's own terminal;
// Novadeck can't see it, so only the simulation keeps it.
type Phase = "planning" | "revising" | "working"

type Running = Holder & {
  readonly sample: SampleAgent
  phase: Phase
  // How many of its revisions it has written.
  revised: number
  // The plan file, how many times anyone wrote it, and how many times the agent did.
  file: string
  writes: number
  version: number
  // Its plan's item on its own bar, and every item it ever had for its plan: one moved
  // or undocked away stays the person's, and still shows the plan.
  planId: string
  planIds: Set<string>
  // How many of `artifacts.next` it has shown.
  shown: number
}

const noItems = (): readonly CompanionItem[] => []

const sameSession = (a: WorkspaceTarget, b: WorkspaceTarget): boolean =>
  a.projectId === b.projectId && a.workspaceSessionId === b.workspaceSessionId

// A document's title, as the pane would name it: its first heading, or its file's name.
const titleOf = (path: string, text: string): string =>
  /^# (.+)$/m.exec(text)?.[1]?.trim() ?? path.split("/").at(-1) ?? path

const itemOf = (
  { key, handle }: Holder,
  { item }: SampleArtifact,
  shown: Pick<CompanionItem, "asked" | "shownAt">,
): CompanionItem => ({
  id: itemIdOf(item.id),
  holder: { terminalId: key.terminalId },
  kind: item.kind,
  name: item.name,
  detail: item.detail,
  path: item.path,
  url: item.url,
  lines: item.lines,
  held: item.held,
  by: "agent",
  from: { terminalId: key.terminalId, handle },
  version: 1,
  plan: item.plan ?? null,
  ...shown,
})

const planItemOf = (agent: Running, shownAt: number): CompanionItem => {
  const { path, agent: name } = agent.sample.plan
  return {
    id: itemIdOf(agent.planId),
    holder: { terminalId: agent.key.terminalId },
    kind: "plan",
    name: titleOf(path, agent.file),
    detail: path,
    path,
    url: null,
    lines: null,
    held: false,
    by: "agent",
    from: { terminalId: agent.key.terminalId, handle: agent.handle },
    version: agent.version,
    asked: false,
    shownAt,
    plan: { agent: name, role: "root", source: "file" },
  }
}

const versionOf = (agent: Running): PlanVersion => ({
  stamp: String(agent.writes),
  plan: {
    kind: "plan",
    text: agent.file,
    truncated: false,
    writable: true,
    skill: agent.sample.plan.skill,
  },
})

const contentOf = (agent: Running): ItemContent => {
  const { stamp, plan } = versionOf(agent)
  return { state: "ready", stamp, content: plan }
}

export const createShowcase = (
  {
    agents,
    shown = [],
  }: {
    readonly agents: readonly (Holder & { readonly sample: SampleAgent })[]
    // Terminals without an agent, and what they hold.
    readonly shown?: readonly (Holder & { readonly artifacts: readonly SampleArtifact[] })[]
  },
  later: (delay: number, run: () => void) => void = (delay, run) => {
    setTimeout(run, delay)
  },
  now: () => number = Date.now,
): Showcase => {
  const running = new Map<string, Running>(
    agents.map(({ key, handle, sample }) => [
      companionKeyId(key),
      {
        key,
        handle,
        sample,
        phase: "planning",
        revised: 0,
        file: sample.text,
        writes: 1,
        version: 1,
        planId: sample.plan.id,
        planIds: new Set([sample.plan.id]),
        shown: 0,
      },
    ]),
  )
  const agentAt = (key: CompanionKey): Running | undefined => running.get(companionKeyId(key))
  const planOf = (target: WorkspaceTarget, id: ItemId): Running | undefined =>
    [...running.values()].find((agent) => sameSession(agent.key, target) && agent.planIds.has(id))
  // What every sample item holds, by its id.
  const samples = new Map<string, SampleArtifact>(
    [
      ...agents.flatMap(({ sample }) => [
        ...sample.artifacts.shown,
        ...(sample.artifacts.opened ?? []),
        ...sample.artifacts.next,
      ]),
      ...shown.flatMap((holder) => holder.artifacts),
    ].map((artifact) => [artifact.item.id, artifact]),
  )
  // Who follows each plan, to hear when it's written.
  const following = new Map<ItemId, Set<(content: ItemContent) => void>>()
  let report: ((actions: readonly BackendAction[]) => void) | undefined
  let current: () => readonly CompanionItem[] = noItems
  let started = false

  const written = (agent: Running): void => {
    for (const id of agent.planIds)
      for (const listener of following.get(itemIdOf(id)) ?? []) listener(contentOf(agent))
  }
  const write = (agent: Running, text: string): void => {
    agent.file = text
    agent.writes += 1
    written(agent)
  }
  // The agent wrote its plan: a new version, which its bar marks. As the runner does, it
  // updates the plan on its own bar; one the person moved or undocked stays where it is,
  // and the plan comes to its own bar anew.
  const wrote = (agent: Running, text: string): void => {
    const own = current().find((item) => item.id === agent.planId)
    const away =
      own && !("terminalId" in own.holder && own.holder.terminalId === agent.key.terminalId)
    if (away || (started && !own)) {
      agent.planId = `${agent.sample.plan.id}-${agent.planIds.size + 1}`
      agent.planIds.add(agent.planId)
      agent.version = 0
    }
    agent.version += 1
    write(agent, text)
    report?.([{ type: "item/upsert", target: agent.key, item: planItemOf(agent, now()) }])
  }

  // The agent reads the plan file and writes over it: its next revision, when it's
  // revising, and, when it read the notes, each applied and removed.
  const revise = (agent: Running, readNotes: boolean, revising = true): void => {
    if (agent.phase === "revising") agent.phase = "planning"
    const edits = revising ? agent.sample.revisions[agent.revised] : undefined
    const edited = edits ? applyEdits(agent.file, edits) : agent.file
    const text = readNotes ? removeNotes(edited) : edited
    if (text === agent.file) return
    if (edits) agent.revised += 1
    wrote(agent, text)
  }

  // The agent shows something: on its own bar, updating what's there of the same file or
  // page, or anew.
  const show = (agent: Running, artifact: SampleArtifact, asked: boolean): void => {
    const own = ownItemWith(current(), agent.key.terminalId, artifact.item)
    const item: CompanionItem = own
      ? { ...own, version: own.version + 1, asked, shownAt: now() }
      : itemOf(agent, artifact, { asked, shownAt: now() })
    report?.([{ type: "item/upsert", target: agent.key, item }])
  }

  const items: readonly CompanionItem[] = [
    ...[...running.values()].flatMap((agent, index) => [
      planItemOf(agent, index),
      ...agent.sample.artifacts.shown.map((artifact, shownAt) =>
        itemOf(agent, artifact, { asked: false, shownAt: index + shownAt + 1 }),
      ),
    ]),
    ...shown.flatMap((holder) =>
      holder.artifacts.map((artifact, shownAt) =>
        itemOf(holder, artifact, { asked: false, shownAt }),
      ),
    ),
  ]

  return {
    items,
    start: (next, read) => {
      report = next
      current = read
      if (!started) {
        started = true
        for (const agent of running.values()) {
          // Each agent has just written its plan, and opens what it opens.
          wrote(agent, agent.file)
          for (const artifact of agent.sample.artifacts.opened ?? []) show(agent, artifact, true)
        }
      }
      return () => {
        if (report === next) report = undefined
      }
    },
    follow: (target, id, { reveal }, on) => {
      const agent = planOf(target, id)
      if (agent) {
        const listeners = following.get(id) ?? new Set()
        following.set(id, listeners)
        listeners.add(on)
        on(contentOf(agent))
        return () => listeners.delete(on)
      }
      const sample = samples.get(id)
      on(
        !sample
          ? { state: "unavailable", reason: "gone", size: null }
          : sample.item.held && !reveal
            ? { state: "unavailable", reason: "held", size: null }
            : sample.content,
      )
      return () => {}
    },
    save: (target, id, text, basedOn) => {
      const agent = planOf(target, id)
      if (!agent) return Promise.reject(new Error(`No plan ${id}`))
      if (basedOn !== String(agent.writes))
        return Promise.resolve({ saved: false, current: versionOf(agent) })
      write(agent, text)
      return Promise.resolve({ saved: true, stamp: String(agent.writes) })
    },
    told: (key, input) => {
      const agent = agentAt(key)
      if (!agent) return
      const said = input.trim()
      // "show" has the agent show its next thing; "open" plays the person asking for it.
      const showing = /^(show|open)\b/i.exec(said)?.[1]?.toLowerCase()
      if (showing) {
        later(500, () => {
          const artifact = agent.sample.artifacts.next[agent.shown]
          if (!artifact) return
          agent.shown += 1
          show(agent, artifact, showing === "open")
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
      running.delete(companionKeyId(key))
    },
  }
}

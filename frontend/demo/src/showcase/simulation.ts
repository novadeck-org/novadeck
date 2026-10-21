import {
  companionKeyId,
  itemIdOf,
  notesIn,
  PlanUnwritableError,
  ownItemWith,
  shownItemWith,
  type CompanionItem,
  type CompanionKey,
  type Companions,
  type ItemContent,
  type ItemId,
  type PlanVersion,
} from "@novadeck/core/companion"
import type { BackendAction } from "@novadeck/core/port"
import type { WorkspaceTarget } from "@novadeck/core/types"

import type { SampleAgent } from "./agents"
import type { SampleArtifact } from "./artifacts"
import { attachedArtifact } from "./attached"
import { applyEdits, removeNotes } from "./revise"

// The showcase's agents at work: they answer what their terminals are told, revise their
// plans over the file as the person left it, and show things, on a delay as if thinking.
// It reports all of it as a backend would, items through the workspace's actions and
// their content through `follow`, so the companion pane can't tell it from a runner.
// What can go wrong with an agent's plan for the person's edits, for the debug panel and
// specs to reach: it lives in the agent's messages (`transcript`), its file is deleted
// (`gone`), its folder can't be written (`folder`), it is too large to write
// (`too-large`), or saves fail for a while without saying why (`failing`).
export type PlanFault = "transcript" | "gone" | "folder" | "too-large" | "failing"

export const planFaults: readonly PlanFault[] = [
  "transcript",
  "gone",
  "folder",
  "too-large",
  "failing",
]

export type Showcase = Companions & {
  // Whether any agent here has a plan, which can go wrong.
  readonly plans: boolean
  // What the terminals held before the demo started, for the seed.
  readonly items: readonly CompanionItem[]
  // Reports what the agents do from here on, reading the session's items as they stand
  // through `current`; returns the stop. As it first starts, each agent writes its plan
  // anew and opens what it opens.
  readonly start: (
    report: (actions: readonly BackendAction[]) => void,
    current: () => readonly CompanionItem[],
  ) => () => void
  // What the person typed in an agent's terminal. Where it has the agent revise its plan,
  // `revised` is called once the revision is written.
  readonly told: (key: CompanionKey, input: string, revised?: () => void) => void
  // The terminal closed: its agent is gone.
  readonly closed: (key: CompanionKey) => void
  // Puts the plan of the agent in this terminal in a fault, or back to normal; false where
  // the terminal has no agent with a plan.
  readonly fault: (key: CompanionKey, fault: PlanFault | undefined) => boolean
}

// Whether a backend's companions are the showcase's, which the debug panel can fault.
export const isShowcase = (companions: Companions): companions is Showcase =>
  "fault" in companions && "told" in companions

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
  // Its plan's item, on its own bar or wherever the person moved it, and every item it
  // ever had for its plan: each still shows the plan.
  planId: string
  planIds: Set<string>
  // How many of `artifacts.next` it has shown.
  shown: number
  fault?: PlanFault | undefined
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
    writable: agent.fault !== "transcript",
    skill: agent.sample.plan.skill,
  },
})

const contentOf = (agent: Running): ItemContent => {
  if (agent.fault === "gone") return { state: "unavailable", reason: "gone", size: null }
  const { stamp, plan } = versionOf(agent)
  return { state: "ready", stamp, content: plan }
}

export const createShowcase = (
  {
    agents,
    shown = [],
    directory,
  }: {
    readonly agents: readonly (Holder & { readonly sample: SampleAgent })[]
    // Terminals without an agent, and what they hold.
    readonly shown?: readonly (Holder & { readonly artifacts: readonly SampleArtifact[] })[]
    // The folder of the project a terminal is in, which a file the person attaches is named from.
    readonly directory?: (key: CompanionKey) => string | undefined
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
  let attachedCount = 0
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
  // updates the plan where it is, on its own bar or where the person moved it; one the
  // person closed comes to its own bar anew.
  const wrote = (agent: Running, text: string): void => {
    const own = current().find((item) => item.id === agent.planId)
    if (started && !own) {
      agent.planId = `${agent.sample.plan.id}-${agent.planIds.size + 1}`
      agent.planIds.add(agent.planId)
      agent.version = 0
    }
    agent.version += 1
    write(agent, text)
    const item = planItemOf(agent, now())
    report?.([
      {
        type: "item/upsert",
        target: agent.key,
        item: own ? { ...item, holder: own.holder } : item,
      },
    ])
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

  // The agent shows something: on its own bar, updating what it showed of the same file
  // or page, there or wherever the person moved it, or anew.
  const show = (agent: Running, artifact: SampleArtifact, asked: boolean): void => {
    const own = shownItemWith(current(), agent.key.terminalId, artifact.item)
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
    plans: agents.length > 0,
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
    // As the runner's `keep` does: what the person picked lands on the terminal's bar, asked
    // for. An item that bar holds for the same file, whoever showed it and whatever lines it
    // points at, is updated to the whole file and shown again; with none, a new item is added.
    attach: (key, path) => {
      // The same file as an agent showed it holds the same content, all of it.
      const sample = [...samples.values()].find((each) => each.item.path === path)
      const made = attachedArtifact(path, directory?.(key))
      const shownContent = sample?.content
      const content: ItemContent =
        shownContent?.state === "ready" && shownContent.content.kind === "file"
          ? {
              ...shownContent,
              content: {
                ...shownContent.content,
                from: shownContent.content.firstLine,
                to: shownContent.content.firstLine + shownContent.content.lines.length - 1,
              },
            }
          : (sample?.content ?? made.content)
      const own = ownItemWith(current(), key.terminalId, made.item)
      const handle =
        [...agents, ...shown].find((each) => companionKeyId(each.key) === companionKeyId(key))
          ?.handle ?? key.terminalId
      const id = own?.id ?? `attached-${(attachedCount += 1)}`
      samples.set(id, { item: { ...made.item, id }, content })
      const { kind, name, detail, url, lines, held } = made.item
      const item: CompanionItem = own
        ? {
            ...own,
            kind,
            name,
            detail,
            path,
            url,
            lines,
            held,
            version: own.version + 1,
            asked: true,
            shownAt: now(),
          }
        : {
            ...itemOf(
              { key, handle },
              { item: { ...made.item, id }, content },
              {
                asked: true,
                shownAt: now(),
              },
            ),
            by: "person",
          }
      report?.([{ type: "item/upsert", target: key, item }])
      return Promise.resolve()
    },
    save: (target, id, text, basedOn) => {
      const agent = planOf(target, id)
      if (!agent) return Promise.reject(new Error(`No plan ${id}`))
      if (agent.fault === "failing") return Promise.reject(new Error("The save didn't go through"))
      if (agent.fault) return Promise.reject(new PlanUnwritableError(agent.fault))
      if (basedOn !== String(agent.writes))
        return Promise.resolve({ saved: false, current: versionOf(agent) })
      write(agent, text)
      return Promise.resolve({ saved: true, stamp: String(agent.writes) })
    },
    told: (key, input, revised) => {
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
        // A decline that asked it comes back to its plan once the turn its words began ends.
        if (revised) later(1800, revised)
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
      later(1800, () => {
        revise(agent, agent.sample.plan.skill)
        revised?.()
      })
    },
    closed: (key) => {
      running.delete(companionKeyId(key))
    },
    fault: (key, fault) => {
      const agent = agentAt(key)
      if (!agent) return false
      agent.fault = fault
      written(agent)
      return true
    },
  }
}

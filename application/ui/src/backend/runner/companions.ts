import type {
  AgentDetail,
  AgentName,
  AgentShown,
  ArtifactContent,
  PlanContent,
} from "@novadeck/protocol"

import {
  companionKeyId,
  type CompanionEvent,
  type CompanionKey,
  type CompanionSnapshot,
  type Companions,
  type PlanSnapshot,
} from "../../model/companion"

// The runner's companions: the plans its agents keep, as `agents.detail` lists them and
// `agents.plan` streams them, and what they showed through NovaDeck's MCP server, as
// `agents.shown` lists it. Plans are read-only for now: the runner can't write one yet.

export type PlanStreams = {
  readonly detail: (terminalId: string) => AsyncIterableIterator<AgentDetail, undefined>
  readonly plan: (terminalId: string, plan: string) => AsyncIterableIterator<PlanContent, undefined>
  readonly shown: (terminalId: string) => AsyncIterableIterator<AgentShown, undefined>
  readonly artifact: (terminalId: string, artifact: string) => Promise<ArtifactContent>
}

export type RunnerCompanions = Companions & {
  // The runner has the terminal: follow its agent's plans. Call again after a fresh
  // shell starts; following that ended starts over, and following that runs goes on.
  readonly follow: (key: CompanionKey) => void
  // The terminal is gone: stop following it.
  readonly unfollow: (key: CompanionKey) => void
  // Stops following every terminal; listeners stay, for a later `follow`.
  readonly stop: () => void
}

const agentNames: Record<AgentName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
}

// A plan's revision: its text, hashed (FNV-1a), since the runner names none.
export const revisionOf = (text: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(36)}:${text.length}`
}

type Followed = {
  readonly key: CompanionKey
  readonly detail: AsyncIterableIterator<AgentDetail, undefined>
  // What its agents showed: the stream, and the version of each thing last reported.
  readonly shown: AsyncIterableIterator<AgentShown, undefined> | undefined
  readonly versions: Map<string, number>
  // What the latest detail says of each plan it lists: its role, name and agent.
  readonly described: Map<string, Omit<PlanSnapshot, "text" | "revision">>
  // Each plan it lists, while it lists it: its stream, and its latest text once known.
  readonly plans: Map<
    string,
    { readonly stream: AsyncIterableIterator<PlanContent, undefined>; snapshot?: PlanSnapshot }
  >
}

// `livePages` when the host can load pages in the pane, as the desktop app can.
export const createRunnerCompanions = (
  streams: PlanStreams,
  { livePages = false }: { readonly livePages?: boolean } = {},
): RunnerCompanions => {
  const listeners = new Set<(event: CompanionEvent) => void>()
  const emit = (event: CompanionEvent): void => listeners.forEach((listener) => listener(event))
  const followed = new Map<string, Followed>()

  const dropPlan = (terminal: Followed, ref: string): void => {
    const plan = terminal.plans.get(ref)
    if (!plan) return
    terminal.plans.delete(ref)
    void plan.stream.return?.()
    if (plan.snapshot) emit({ type: "plan/removed", key: terminal.key, ref })
  }

  const followPlan = (terminal: Followed, ref: string): void => {
    let stream: AsyncIterableIterator<PlanContent, undefined>
    try {
      stream = streams.plan(terminal.key.terminalId, ref)
    } catch {
      return
    }
    const plan: { stream: typeof stream; snapshot?: PlanSnapshot } = { stream }
    terminal.plans.set(ref, plan)
    void (async () => {
      try {
        for await (const content of stream) {
          if (terminal.plans.get(ref) !== plan) return
          const described = terminal.described.get(ref)
          if (!described) continue
          plan.snapshot = {
            ...described,
            text: content.text,
            revision: revisionOf(content.text),
            // Past 256 KiB the runner sends the plan cut short.
            ...(content.truncated ? { truncated: true } : {}),
          }
          emit({ type: "plan/changed", key: terminal.key, plan: plan.snapshot })
        }
      } catch {
        // The plan stream failed; its terminal's next detail follows it again.
      }
      // Another plan replaced it, or the agent left: it's gone until listed again.
      if (terminal.plans.get(ref) === plan) dropPlan(terminal, ref)
    })()
  }

  // Everything the terminal's agents showed, reported as it's shown: something new, or
  // something shown again with new content. Nothing is withdrawn: the user dismisses.
  const followShown = (
    terminal: Followed,
    stream: AsyncIterableIterator<AgentShown, undefined>,
  ): void => {
    void (async () => {
      try {
        // What the first snapshot lists was shown before this follow, as before a
        // reload: it's listed as already seen, and opens nothing.
        let first = true
        for await (const snapshot of stream) {
          if (followed.get(companionKeyId(terminal.key)) !== terminal) return
          for (const { asked, held, ...shown } of snapshot.shown) {
            if ((terminal.versions.get(shown.id) ?? 0) >= shown.version) continue
            terminal.versions.set(shown.id, shown.version)
            emit({
              type: "artifact/shown",
              key: terminal.key,
              artifact: { ...shown, ...(held && { held: true }) },
              // A held one never opens by itself, whatever the runner says.
              asked: asked && !held,
              ...(first && { seen: true }),
            })
          }
          first = false
        }
      } catch {
        // The runner closed or lost the terminal; its detail's end starts it over.
      }
    })()
  }

  const follow = (key: CompanionKey): void => {
    const id = companionKeyId(key)
    if (followed.has(id)) return
    let details: AsyncIterableIterator<AgentDetail, undefined>
    try {
      details = streams.detail(key.terminalId)
    } catch {
      // Plans are extra: a runner that can't follow them leaves the terminal as it is.
      return
    }
    // What its agents show is extra too; a runner without it shows nothing.
    let shown: AsyncIterableIterator<AgentShown, undefined> | undefined
    try {
      shown = streams.shown(key.terminalId)
    } catch {
      shown = undefined
    }
    const terminal: Followed = {
      key,
      detail: details,
      shown,
      versions: new Map(),
      described: new Map(),
      plans: new Map(),
    }
    followed.set(id, terminal)
    if (shown) followShown(terminal, shown)
    void (async () => {
      try {
        for await (const detail of terminal.detail) {
          if (followed.get(id) !== terminal) return
          const agent = detail.agent ? agentNames[detail.agent] : "The agent"
          const roles = new Map(detail.actors.map((actor) => [actor.ref, actor.role]))
          const listed = new Set(detail.plans.map((plan) => plan.ref))
          for (const ref of terminal.plans.keys()) if (!listed.has(ref)) dropPlan(terminal, ref)
          for (const plan of detail.plans) {
            terminal.described.set(plan.ref, {
              ref: plan.ref,
              role: roles.get(plan.actor) === "root" ? "root" : "subagent",
              path: plan.name ?? `${agent} plan`,
              agent,
              // NovaDeck can't tell yet whether its skill is installed.
              skill: false,
              writable: false,
            })
            if (!terminal.plans.has(plan.ref)) followPlan(terminal, plan.ref)
          }
        }
      } catch {
        // The runner closed or lost the terminal.
      }
      // Following ended while the terminal is still held, as when the runner lost it or
      // a fresh shell hasn't started yet: its plans go, and a later `follow` starts over.
      if (followed.get(id) !== terminal) return
      followed.delete(id)
      void terminal.shown?.return?.()
      for (const ref of terminal.plans.keys()) dropPlan(terminal, ref)
    })()
  }

  const unfollow = (key: CompanionKey): void => {
    const id = companionKeyId(key)
    const terminal = followed.get(id)
    if (!terminal) return
    followed.delete(id)
    void terminal.detail.return?.()
    void terminal.shown?.return?.()
    const streamsLeft = [...terminal.plans.values()]
    // Emptied first, so the ending streams report nothing about a closed terminal.
    terminal.plans.clear()
    for (const { stream } of streamsLeft) void stream.return?.()
    emit({ type: "companion/closed", key })
  }

  return {
    snapshot: () =>
      [...followed.values()].map((terminal): CompanionSnapshot => ({
        key: terminal.key,
        plans: [...terminal.plans.values()].flatMap(({ snapshot }) => (snapshot ? [snapshot] : [])),
        shown: [],
      })),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: async (key, artifactId) => {
      const content = await streams.artifact(key.terminalId, artifactId)
      return content.kind === "page" ? { ...content, live: livePages } : content
    },
    save: () => Promise.reject(new Error("The runner can't write plans yet")),
    follow,
    unfollow,
    stop: () => {
      for (const terminal of followed.values()) unfollow(terminal.key)
    },
  }
}

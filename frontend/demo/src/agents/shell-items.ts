import { shellCounts } from "@novadeck/core/agents/shells"
import { agentName } from "@novadeck/core/conversation/turns"
import {
  emptyCompanions,
  itemIdOf,
  type Item,
  type ItemContent,
  type ItemId,
} from "@novadeck/core/items"
import type { Backend, BackendAction, BackendSink } from "@novadeck/core/port"
import type { AgentShell, Workspace } from "@novadeck/core/types"

import { itemsOf, terminalsOf } from "../workspace"
import { demoShellOutput, printEveryMs } from "./shell-output"

// The shells item the runner makes for a terminal's agent once its first background shell
// starts: one per terminal, on its bar and not opened by itself, whose content is each shell
// of the agent's status with its output. The demo makes it the same way, from the statuses its
// agents report, and keeps the content of running shells going (see `shell-output.ts`). As the
// runner does, it takes the item away when the agent lists no shells; but a status that lists
// them as an empty list (a state of the debug panel) keeps it, to see what its pane says then.

const prefix = "demo-shells-"

const detailOf = (shells: readonly AgentShell[]): string => {
  const { running, failed } = shellCounts(shells)
  return (
    [running > 0 && `${running} running`, failed > 0 && `${failed} failed`]
      .filter(Boolean)
      .join(" · ") || "ended"
  )
}

const contentOf = (
  terminalName: string,
  shells: readonly AgentShell[],
  now: number,
): ItemContent => ({
  state: "ready",
  stamp: `${now}`,
  content: {
    kind: "shells",
    agent: terminalName,
    shells: shells.map((shell) => ({
      id: shell.id,
      command: shell.command,
      since: shell.since,
      exit: shell.exit,
      output: demoShellOutput(shell, now),
    })),
  },
})

// Where a status's shells are, by terminal: the agent's own name and its shells, once it lists any.
const shellsOf = (workspace: Workspace) =>
  terminalsOf(workspace).flatMap(({ key, terminal }) =>
    terminal.state === "running" && terminal.agent?.shells
      ? [
          {
            key,
            handle: terminal.handle ?? terminal.id,
            name: agentName(terminal.process),
            shells: terminal.agent.shells,
          },
        ]
      : [],
  )

// The shells items the workspace holds that no agent's status makes now, with where they are.
const gone = (workspace: Workspace, live: ReadonlySet<string>) =>
  workspace.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.items
        .filter((item) => item.id.startsWith(prefix) && !live.has(item.id))
        .map((item) => ({
          itemId: item.id,
          target: { projectId: project.id, workspaceSessionId: session.id },
        })),
    ),
  )

export const withShellItems = (backend: Backend): Backend => {
  const companions = backend.companions ?? emptyCompanions()
  let latest: Workspace | undefined
  let sink: BackendSink | undefined
  let scheduled = false
  // The shells each terminal's item has had, so a new one shows it again.
  const known = new Map<string, Set<string>>()
  const followers = new Map<ItemId, Set<(content: ItemContent) => void>>()

  const current = (id: ItemId) =>
    latest && shellsOf(latest).find(({ key }) => itemIdOf(`${prefix}${key.terminalId}`) === id)
  const tell = (id: ItemId): void => {
    const now = Date.now()
    const found = current(id)
    for (const on of followers.get(id) ?? [])
      on(
        found
          ? contentOf(found.name, found.shells, now)
          : { state: "unavailable", reason: "gone", size: null },
      )
  }

  // Makes or updates the item of each terminal whose agent has shells.
  const sync = (): void => {
    scheduled = false
    if (!latest || !sink) return
    const held = itemsOf(latest)
    const actions: BackendAction[] = []
    const made = shellsOf(latest)
    for (const { itemId, target } of gone(
      latest,
      new Set(made.map(({ key }) => `${prefix}${key.terminalId}`)),
    )) {
      known.delete(itemId)
      actions.push({ type: "item/remove", target, itemId })
    }
    for (const { key, handle, shells } of made) {
      const id = itemIdOf(`${prefix}${key.terminalId}`)
      const seen = known.get(id) ?? new Set<string>()
      const arrived = shells.some((shell) => !seen.has(shell.id))
      known.set(id, new Set(shells.map((shell) => shell.id)))
      const item = held.find((each) => each.id === id)
      const detail = detailOf(shells)
      if (item && !arrived && item.detail === detail) continue
      actions.push({
        type: "item/upsert",
        target: { projectId: key.projectId, workspaceSessionId: key.workspaceSessionId },
        item: {
          id,
          holder: { terminalId: key.terminalId },
          kind: "shells",
          name: "Shells",
          detail,
          path: null,
          url: null,
          lines: null,
          secret: false,
          by: "agent",
          from: { terminalId: key.terminalId, handle },
          version: (item?.version ?? 0) + (arrived || !item ? 1 : 0),
          openAsked: false,
          shownAt: Date.now(),
          plan: null,
        } satisfies Item,
      })
    }
    if (actions.length > 0) sink.dispatch(actions)
    for (const id of followers.keys()) tell(id)
  }
  // Within a workspace commit no transaction may start, so the item follows right after.
  const soon = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(sync)
  }

  return {
    ...backend,
    companions: {
      ...companions,
      follow: (target, itemId, options, on) => {
        if (!itemId.startsWith(prefix)) return companions.follow(target, itemId, options, on)
        const each = followers.get(itemId) ?? new Set()
        each.add(on)
        followers.set(itemId, each)
        tell(itemId)
        // What runs prints on, a line every few seconds.
        const timer = setInterval(() => tell(itemId), printEveryMs)
        return () => {
          clearInterval(timer)
          each.delete(on)
        }
      },
    },
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
      soon()
    },
    start: (to) => {
      sink = to
      const stop = backend.start?.(to)
      return () => {
        sink = undefined
        stop?.()
      }
    },
  }
}

import type { TerminalKey } from "@novadeck/core/port"
import type { WorkspaceAction } from "@novadeck/core/state"
import { createTerminalRegistry, terminalKeyId } from "@novadeck/core/terminals/registry"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

import { demoAgent, mockReply, type DemoAgent } from "../samples"
import { emptyLine, type Line } from "../screen/line-editor"

export type Entry = {
  readonly id: string
  readonly command: string
  readonly reply: string
}

// What an agent's terminal opened with, taken once and kept: its transcript is history, so
// a later change of plan mode, or another view showing the terminal, leaves it as it was.
export type Opening = {
  readonly agent: DemoAgent | undefined
  readonly planned: boolean
  // Codex at work and asking nothing: its review is still under way.
  readonly reviewing: boolean
  // Claude Code in plan mode still reading, asking nothing yet: the plan comes a moment
  // later, which its screen plays out from `at`, when the terminal opened.
  readonly reading: boolean
  readonly at: number
}

const openingOf = (terminal: TerminalMetadata): Opening => ({
  agent: demoAgent(terminal),
  planned: terminal.state === "running" && terminal.agent?.planning === true,
  reviewing:
    demoAgent(terminal) === "codex" &&
    terminal.state === "running" &&
    terminal.agent?.working === true &&
    terminal.agent.attention === undefined,
  reading:
    demoAgent(terminal) === "claude" &&
    terminal.state === "running" &&
    terminal.agent?.planning === true &&
    terminal.agent.working &&
    terminal.agent.attention === undefined,
  at: Date.now(),
})

export type DemoTerminalSnapshot = {
  readonly opening: Opening
  // The command line, as its line editor keeps it: the draft, the cursor and the history.
  readonly line: Line
  readonly entries: readonly Entry[]
  readonly cleared: boolean
}

export type DemoEngine = {
  readonly reconcile: (workspace: Workspace, actions: readonly WorkspaceAction[]) => void
  // Whether the engine keeps a simulated process for the terminal.
  readonly has: (key: TerminalKey) => boolean
  // The terminal as the workspace last had it, and the name of its project.
  readonly terminal: (key: TerminalKey) => TerminalMetadata | undefined
  readonly projectName: (key: TerminalKey) => string
  readonly getSnapshot: (key: TerminalKey) => DemoTerminalSnapshot
  // Calls `listener` when the terminal's snapshot or metadata changes, or it closes.
  readonly subscribe: (key: TerminalKey, listener: () => void) => () => void
  readonly setLine: (key: TerminalKey, line: Line) => void
  readonly run: (key: TerminalKey, command: string) => void
}

const empty: DemoTerminalSnapshot = {
  opening: { agent: undefined, planned: false, reviewing: false, reading: false, at: 0 },
  line: emptyLine(),
  entries: [],
  cleared: false,
}

// Command lines and transcripts for the demo's simulated terminals.
export const createDemoEngine = (): DemoEngine => {
  const listeners = new Map<string, Set<() => void>>()
  const projects = new Map<string, string>()
  const publish = (key: TerminalKey): void =>
    listeners.get(terminalKeyId(key))?.forEach((listener) => listener())
  const registry = createTerminalRegistry<{ snapshot: DemoTerminalSnapshot }>({
    // Created terminals start blank instead of showing the sample transcript, but one an agent
    // opened (with its agent started in it) shows its own opening.
    open: (_key, terminal, created) => ({
      snapshot: { ...empty, opening: openingOf(terminal), cleared: created && !terminal.openedBy },
    }),
    close: (_entry, key) => publish(key),
  })
  const update = (
    key: TerminalKey,
    change: (previous: DemoTerminalSnapshot) => DemoTerminalSnapshot,
  ): void => {
    // A callback retained by a closed presentation must not recreate a process.
    const entry = registry.get(key)?.entry
    if (!entry) return
    const next = change(entry.snapshot)
    if (next === entry.snapshot) return
    entry.snapshot = next
    publish(key)
  }
  return {
    reconcile: (workspace, actions) => {
      const before = new Map<string, TerminalMetadata>()
      for (const project of workspace.projects) projects.set(project.id, project.name)
      for (const project of workspace.projects)
        for (const session of project.history)
          for (const terminal of session.state.roster.terminals) {
            const key = {
              projectId: project.id,
              workspaceSessionId: session.id,
              terminalId: terminal.id,
            }
            const known = registry.get(key)?.terminal
            if (known) before.set(terminalKeyId(key), known)
          }
      registry.reconcile(workspace, actions)
      for (const project of workspace.projects)
        for (const session of project.history)
          for (const terminal of session.state.roster.terminals) {
            const key = {
              projectId: project.id,
              workspaceSessionId: session.id,
              terminalId: terminal.id,
            }
            // A terminal whose program changed in place opens afresh for its new agent.
            const entry = registry.get(key)?.entry
            if (entry && entry.snapshot.opening.agent !== demoAgent(terminal))
              entry.snapshot = { ...entry.snapshot, opening: openingOf(terminal) }
            const was = before.get(terminalKeyId(key))
            if (was && was !== terminal) publish(key)
          }
    },
    has: (key) => registry.get(key) !== undefined,
    terminal: (key) => registry.get(key)?.terminal,
    projectName: (key) => projects.get(key.projectId) ?? key.projectId,
    getSnapshot: (key) => registry.get(key)?.entry.snapshot ?? empty,
    subscribe: (key, listener) => {
      const id = terminalKeyId(key)
      const subscribers = listeners.get(id) ?? new Set<() => void>()
      subscribers.add(listener)
      listeners.set(id, subscribers)
      return () => {
        subscribers.delete(listener)
        if (!subscribers.size) listeners.delete(id)
      }
    },
    setLine: (key, line) =>
      update(key, (previous) => (previous.line === line ? previous : { ...previous, line })),
    run: (key, command) => {
      const terminal = registry.get(key)?.terminal
      if (!terminal || !command.trim()) return
      update(key, (previous) =>
        command.trim() === "clear"
          ? { ...previous, cleared: true, entries: [] }
          : {
              ...previous,
              entries: [
                ...previous.entries,
                {
                  id: crypto.randomUUID(),
                  command,
                  reply: mockReply(command, terminal),
                },
              ],
            },
      )
    },
  }
}

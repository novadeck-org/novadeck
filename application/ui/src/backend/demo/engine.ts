import type { WorkspaceAction } from "../../model/state"
import type { TerminalMetadata, Workspace } from "../../model/types"
import type { TerminalKey } from "../port"
import { createTerminalRegistry, terminalKeyId } from "../registry"
import { demoAgent, mockReply, type DemoAgent } from "./samples"

export type Entry = {
  readonly id: string
  readonly command: string
  readonly reply: string
}

// What an agent's terminal opened with, taken once and kept: its transcript is history, so
// a later change of plan mode, or a remount of the surface, leaves it as it was.
export type Opening = {
  readonly agent: DemoAgent | undefined
  readonly planned: boolean
  // Codex at work and asking nothing: its review is still under way.
  readonly reviewing: boolean
}

const openingOf = (terminal: TerminalMetadata): Opening => ({
  agent: demoAgent(terminal),
  planned: terminal.state === "running" && terminal.agent?.planning === true,
  reviewing:
    demoAgent(terminal) === "codex" &&
    terminal.state === "running" &&
    terminal.agent?.working === true &&
    terminal.agent.attention === undefined,
})

export type DemoTerminalSnapshot = {
  readonly opening: Opening
  readonly draft: string
  // Where the output was scrolled to: "end" while it sat at the bottom, so a remount, whose
  // layout may differ, keeps it there instead of at a pixel offset.
  readonly scrollOffset: number | "end" | undefined
  readonly entries: readonly Entry[]
  readonly cleared: boolean
}

export type DemoEngine = {
  readonly reconcile: (workspace: Workspace, actions: readonly WorkspaceAction[]) => void
  // Whether the engine keeps a simulated process for the terminal.
  readonly has: (key: TerminalKey) => boolean
  readonly getSnapshot: (key: TerminalKey) => DemoTerminalSnapshot
  readonly subscribe: (key: TerminalKey, listener: () => void) => () => void
  readonly setDraft: (key: TerminalKey, draft: string) => void
  readonly setScrollOffset: (key: TerminalKey, scrollOffset: number | "end") => void
  readonly run: (key: TerminalKey, command: string) => void
}

const empty: DemoTerminalSnapshot = {
  opening: { agent: undefined, planned: false, reviewing: false },
  draft: "",
  scrollOffset: undefined,
  entries: [],
  cleared: false,
}

// Drafts, transcript and scroll offsets for the demo's simulated terminals.
export const createDemoEngine = (): DemoEngine => {
  const listeners = new Map<string, Set<() => void>>()
  const publish = (key: TerminalKey): void =>
    listeners.get(terminalKeyId(key))?.forEach((listener) => listener())
  const registry = createTerminalRegistry<{ snapshot: DemoTerminalSnapshot }>({
    // Created terminals start blank instead of showing the sample transcript.
    open: (_key, terminal, created) => ({
      snapshot: { ...empty, opening: openingOf(terminal), cleared: created },
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
      registry.reconcile(workspace, actions)
      // A terminal whose program changed in place opens afresh for its new agent.
      for (const project of workspace.projects)
        for (const session of project.history)
          for (const terminal of session.state.roster.terminals)
            update(
              { projectId: project.id, workspaceSessionId: session.id, terminalId: terminal.id },
              (previous) =>
                previous.opening.agent === demoAgent(terminal)
                  ? previous
                  : { ...previous, opening: openingOf(terminal) },
            )
    },
    has: (key) => registry.get(key) !== undefined,
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
    setDraft: (key, draft) =>
      update(key, (previous) => (previous.draft === draft ? previous : { ...previous, draft })),
    setScrollOffset: (key, scrollOffset) =>
      update(key, (previous) =>
        previous.scrollOffset === scrollOffset ? previous : { ...previous, scrollOffset },
      ),
    run: (key, command) => {
      const terminal = registry.get(key)?.terminal
      if (!terminal || !command.trim()) return
      update(key, (previous) =>
        command.trim() === "clear"
          ? { ...previous, draft: "", cleared: true, entries: [] }
          : {
              ...previous,
              draft: "",
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

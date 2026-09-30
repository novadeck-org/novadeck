import type { WorkspaceAction } from "../../model/state"
import type { TerminalMetadata, Workspace } from "../../model/types"
import type { TerminalKey } from "../port"
import { createTerminalRegistry, terminalKeyId } from "../registry"
import { mockReply } from "./samples"

export type Entry = { readonly id: string; readonly command: string; readonly reply: string }

export type DemoTerminalSnapshot = {
  readonly draft: string
  readonly scrollOffset: number | undefined
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
  readonly setScrollOffset: (key: TerminalKey, scrollOffset: number) => void
  readonly run: (key: TerminalKey, command: string) => void
}

const empty: DemoTerminalSnapshot = {
  draft: "",
  scrollOffset: undefined,
  entries: [],
  cleared: false,
}

// Drafts, transcript and scroll offsets for the demo's simulated terminals. `reply`
// answers a terminal's command instead of the sample shell, when it has an answer.
export const createDemoEngine = (
  reply?: (command: string, terminal: TerminalMetadata, key: TerminalKey) => string | undefined,
): DemoEngine => {
  const listeners = new Map<string, Set<() => void>>()
  const publish = (key: TerminalKey): void =>
    listeners.get(terminalKeyId(key))?.forEach((listener) => listener())
  const registry = createTerminalRegistry<{ snapshot: DemoTerminalSnapshot }>({
    // Created terminals start blank instead of showing the sample transcript.
    open: (_key, _terminal, created) => ({ snapshot: { ...empty, cleared: created } }),
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
    reconcile: registry.reconcile,
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
                  reply: reply?.(command, terminal, key) ?? mockReply(command, terminal),
                },
              ],
            },
      )
    },
  }
}

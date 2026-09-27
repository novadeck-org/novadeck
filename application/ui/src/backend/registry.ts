import type { WorkspaceAction } from "../model/state"
import type { TerminalMetadata, Workspace } from "../model/types"
import type { TerminalKey } from "./port"

// Both hooks run inside Backend.commit and follow its rules: always synchronous;
// `open` for the initial workspace must not start I/O, while later `open` and
// `close` calls may start fire-and-forget I/O that is safe to repeat per terminal.
export type TerminalLifecycle<Entry> = {
  // `created` is true only for a terminal added by the committed actions,
  // not for one that already existed when the backend first saw the workspace.
  readonly open: (key: TerminalKey, terminal: TerminalMetadata, created: boolean) => Entry
  readonly close: (entry: Entry, key: TerminalKey) => void
}

export type RegisteredTerminal<Entry> = {
  readonly terminal: TerminalMetadata
  readonly entry: Entry
}

export type TerminalRegistry<Entry> = {
  readonly reconcile: (workspace: Workspace, actions: readonly WorkspaceAction[]) => void
  readonly get: (key: TerminalKey) => RegisteredTerminal<Entry> | undefined
}

export const terminalKeyId = (key: TerminalKey): string =>
  JSON.stringify([key.projectId, key.workspaceSessionId, key.terminalId])

const createdKeys = (actions: readonly WorkspaceAction[]): Set<string> =>
  new Set(
    actions.flatMap((action) =>
      action.type === "terminal/add"
        ? [terminalKeyId({ ...action.target, terminalId: action.terminal.id })]
        : [],
    ),
  )

// Keeps one entry per terminal in the workspace, independent of which view shows it.
export const createTerminalRegistry = <Entry>(
  lifecycle: TerminalLifecycle<Entry>,
): TerminalRegistry<Entry> => {
  const registered = new Map<string, RegisteredTerminal<Entry> & { readonly key: TerminalKey }>()
  const reconcile = (workspace: Workspace, actions: readonly WorkspaceAction[]): void => {
    const created = createdKeys(actions)
    const remaining = new Set<string>()
    for (const project of workspace.projects)
      for (const session of project.history)
        for (const terminal of session.state.roster.terminals) {
          const key = {
            projectId: project.id,
            workspaceSessionId: session.id,
            terminalId: terminal.id,
          }
          const id = terminalKeyId(key)
          remaining.add(id)
          const previous = registered.get(id)
          if (previous?.terminal === terminal) continue
          registered.set(id, {
            key,
            terminal,
            entry: previous ? previous.entry : lifecycle.open(key, terminal, created.has(id)),
          })
        }
    for (const [id, item] of registered) {
      if (remaining.has(id)) continue
      // Forget the terminal first so the close hook and late callbacks see it as gone.
      registered.delete(id)
      lifecycle.close(item.entry, item.key)
    }
  }
  return { reconcile, get: (key) => registered.get(terminalKeyId(key)) }
}

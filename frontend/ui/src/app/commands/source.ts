import { hasTerminal } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"

import { currentState, currentTarget } from "../selectors"
import type { CommandContext } from "./context"

export type SourceCommands = {
  // Puts a file of the active project, by its path from the project's root, on the bar of the
  // focused terminal, which opens it there. Nothing happens where no terminal is focused or
  // the backend can't attach. Rejects when the backend can't put the file there.
  readonly openSourceFile: (path: string) => Promise<void>
}

// The path of a file from a project's directory, in the separator the directory is written in.
export const absolutePath = (directory: string, path: string): string => {
  const windows = directory.includes("\\") && !directory.includes("/")
  const base = directory.replace(/[\\/]+$/, "")
  return windows ? `${base}\\${path.replaceAll("/", "\\")}` : `${base}/${path}`
}

export const createSourceCommands = ({
  workspace,
  companions,
}: Pick<CommandContext, "workspace" | "companions">): SourceCommands => ({
  openSourceFile: async (path) => {
    const attach = companions?.attach
    if (!attach) return
    const snapshot = workspace.getSnapshot()
    const { roster, items, selected } = currentState(snapshot)
    // A terminal, or the terminal an undocked window of its companion came from.
    const window = roster.windows.find((each) => each.id === selected)
    const terminalId = hasTerminal(roster, selected)
      ? selected
      : items.find((item) => item.id === window?.itemId)?.from.terminalId
    if (terminalId === undefined || !hasTerminal(roster, terminalId)) return
    await attach(
      { ...currentTarget(snapshot), terminalId },
      absolutePath(activeProject(snapshot)!.directory, path),
    )
  },
})

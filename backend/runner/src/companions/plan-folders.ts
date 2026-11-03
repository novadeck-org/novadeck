import { dirname } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import type { TerminalPlace } from "./items.js"
import type { ItemRecord } from "./records.js"

export type PlanFolderSources = {
  /** The folder of a session's project. */
  readonly projectFolder: (sessionId: string) => string | undefined
  /** Where a terminal is, as items need it. */
  readonly place: (terminalId: string) => TerminalPlace | undefined
  /** The folders an agent keeps its plan files in by default (see `Harness.planFolders`). */
  readonly planFolders: (agent: AgentName) => Promise<readonly string[]>
}

/**
 * The folders a plan file may be saved under: its session's project, the folder its
 * terminal works in (a sibling worktree, or one an agent was opened in), the agent's own
 * plans folders, and those its session reported by its transcript, as a second account's
 * home. A filesystem root is no folder to allow.
 */
export const planSaveFolders = async (
  item: Pick<ItemRecord, "sessionId" | "terminalId" | "from" | "plan">,
  sources: PlanFolderSources,
): Promise<readonly string[]> => {
  const terminal = item.from?.terminalId ?? item.terminalId
  const place = terminal === null ? undefined : sources.place(terminal)
  const agent = item.plan?.agent
  const folders = [
    sources.projectFolder(item.sessionId),
    place?.cwd,
    ...(agent ? await sources.planFolders(agent) : []),
    ...(agent && place?.transcript
      ? (harnesses[agent].planFoldersOf?.(place.transcript) ?? [])
      : []),
  ]
  return folders.filter(
    (folder): folder is string => folder !== undefined && dirname(folder) !== folder,
  )
}

import type { AgentName } from "@novadeck/core/harnesses"
import type { Backend } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import { agentLabels } from "../preferences/agent-switches"
import {
  connectInstalled,
  stepInstall,
  type InstallTerminal,
  type PendingInstall,
} from "../preferences/installs"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"

// What each of the terminals asked for looks like in the workspace, by id; absent for one
// closed, or in no session.
const terminalsOf = (
  workspace: Workspace,
  ids: readonly string[],
): ReadonlyMap<string, InstallTerminal> => {
  const found = new Map<string, InstallTerminal>()
  if (ids.length === 0) return found
  for (const project of workspace.projects)
    for (const session of project.history)
      for (const terminal of session.state.roster.terminals)
        if (ids.includes(terminal.id))
          found.set(terminal.id, { busy: terminal.busy === true, directory: terminal.directory })
  return found
}

const sameTerminals = (
  a: ReadonlyMap<string, InstallTerminal>,
  b: ReadonlyMap<string, InstallTerminal>,
): boolean =>
  a.size === b.size &&
  [...a].every(([id, terminal]) => {
    const other = b.get(id)
    return other?.busy === terminal.busy && other.directory === terminal.directory
  })

/**
 * Installs an agent that isn't here: opens a terminal running its installer, and once that
 * ends, connects the agent where it is installed now, and starts it in a terminal of its own,
 * for the person to sign in. An installer that failed leaves its terminal as it is, for the
 * person to read, and nothing else changes; a connection that failed shows on the agent's
 * switch, as any does.
 *
 * The agent starts in a new terminal, not the installer's: that shell began before the
 * install and the connection, so it has neither the agent's folder on its PATH nor Novadeck's
 * shim for it (both are fixed as a shell starts), and an agent started there would run
 * without the status line, or Codex's reports, Novadeck follows it by.
 */
export const useInstalls = (
  agents: Backend["agents"],
): ((agent: AgentName, command: string) => void) => {
  const { commands } = useWorkspaceServices()
  // The installs under way: a store of their own, which an effect may change as it follows them.
  const [installs] = useState(() => createStore<readonly PendingInstall[]>([]))
  const pending = useSyncExternalStore(installs.subscribe, installs.getSnapshot)
  const ids = pending.map((install) => install.terminalId)
  const terminals = useWorkspaceState((state) => terminalsOf(state, ids), sameTerminals)
  // Installs whose end is being dealt with, so a later render does not deal with one twice.
  const ending = useRef(new Set<string>())

  const start = useCallback(
    (agent: AgentName, command: string) => {
      const terminalId = commands.add({ title: `Install ${agentLabels[agent]}`, command })
      installs.update((current) => [...current, { agent, terminalId, ran: false }])
    },
    [commands, installs],
  )

  useEffect(() => {
    if (pending.length === 0) return
    const next: PendingInstall[] = []
    let changed = false
    for (const install of pending) {
      const terminal = terminals.get(install.terminalId)
      const result = stepInstall(install, terminal)
      if (result.step === "running") {
        next.push(result.install)
        changed ||= result.install !== install
        continue
      }
      changed = true
      if (result.step === "gone" || !terminal || !agents || ending.current.has(install.terminalId))
        continue
      ending.current.add(install.terminalId)
      void connectInstalled(agents, install.agent)
        .then((outcome) => {
          if (outcome !== "ready") return
          // Beside the installer's terminal, in its folder, which the shell may have left.
          commands.openRequested({
            from: install.terminalId,
            directory: terminal.directory,
            command: install.agent,
            focus: true,
            answer: () => {},
          })
        })
        .finally(() => ending.current.delete(install.terminalId))
    }
    if (changed) installs.update(() => next)
  }, [pending, terminals, agents, commands, installs])

  return start
}

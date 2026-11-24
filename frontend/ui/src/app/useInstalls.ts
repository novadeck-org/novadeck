import type { AgentName } from "@novadeck/core/harnesses"
import type { Backend } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { agentLabels } from "../preferences/agent-switches"
import {
  connectInstalled,
  readInstalls,
  startInstalled,
  writeInstalls,
  stepInstall,
  type InstallTerminal,
  type PendingInstall,
} from "../preferences/installs"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"

// What each of the terminals asked for looks like in the workspace, by id; absent for one
// closed, or in no session.
export const terminalsOf = (
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

export const sameTerminals = (
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
): {
  // `quiet`: once installed and connected, don't start the agent for the person to sign in.
  readonly install: (
    agent: AgentName,
    command: string,
    options?: { readonly quiet?: boolean },
  ) => void
  // The agents whose installer runs now, until each one's end has been dealt with.
  readonly installing: ReadonlySet<AgentName>
  // Why the last install of an agent didn't end with it installed and connected, in words, until
  // it is installed again.
  readonly failures: ReadonlyMap<AgentName, string>
} => {
  const { commands } = useWorkspaceServices()
  // The installs under way: a store of their own, which an effect may change as it follows them.
  // Kept in session storage, so a reload while one runs follows it again: one whose terminal
  // is gone then ends as any does, unfinished.
  const [installs] = useState(() => {
    const store = createStore(readInstalls())
    store.subscribe(() => writeInstalls(store.getSnapshot()))
    return store
  })
  const pending = useSyncExternalStore(installs.subscribe, installs.getSnapshot)
  const ids = pending.map((install) => install.terminalId)
  const terminals = useWorkspaceState((state) => terminalsOf(state, ids), sameTerminals)
  // Installs whose end is being dealt with, so a later render does not deal with one twice.
  const ending = useRef(new Set<string>())
  // The agents of those, which still read as installing until they are connected: their
  // installer is done, but the look that finds them may take a while.
  const [connecting] = useState(() => createStore<ReadonlySet<AgentName>>(new Set()))
  const settling = useSyncExternalStore(connecting.subscribe, connecting.getSnapshot)
  // What the installs that ended without a ready agent said of it.
  const [failed] = useState(() => createStore<ReadonlyMap<AgentName, string>>(new Map()))
  const failures = useSyncExternalStore(failed.subscribe, failed.getSnapshot)
  const fail = useCallback(
    (agent: AgentName, why: string | undefined) =>
      failed.update((now) => {
        const next = new Map(now)
        if (why === undefined) next.delete(agent)
        else next.set(agent, why)
        return next
      }),
    [failed],
  )

  const start = useCallback(
    (agent: AgentName, command: string, options?: { readonly quiet?: boolean }) => {
      const terminalId = commands.add({ title: `Install ${agentLabels[agent]}`, command })
      fail(agent, undefined)
      installs.update((current) => [
        ...current,
        { agent, terminalId, ran: false, ...(options?.quiet && { quiet: true as const }) },
      ])
    },
    [commands, installs, fail],
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
      connecting.update((agentsNow) => new Set(agentsNow).add(install.agent))
      void connectInstalled(agents, install.agent)
        .then((outcome) => {
          if (outcome === "missing")
            fail(
              install.agent,
              `The installer ended, but ${agentLabels[install.agent]} isn't on this computer. Its terminal shows why.`,
            )
          if (outcome !== "ready" || install.quiet) return
          startInstalled(commands, install, terminal.directory)
        })
        .finally(() => {
          ending.current.delete(install.terminalId)
          connecting.update((agentsNow) => {
            const left = new Set(agentsNow)
            left.delete(install.agent)
            return left
          })
        })
    }
    if (changed) installs.update(() => next)
  }, [pending, terminals, agents, commands, installs, connecting, fail])

  const installing = useMemo(
    () => new Set([...pending.map((install) => install.agent), ...settling]),
    [pending, settling],
  )
  return useMemo(() => ({ install: start, installing, failures }), [start, installing, failures])
}

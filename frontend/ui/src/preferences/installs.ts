import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import type { Backend, TerminalRequest } from "@novadeck/core/port"

// An agent's installer running in a terminal of its own: the terminal, and whether it was seen
// working, which is what tells its end from its start (a new terminal reads idle until its
// startup command is under way).
export type PendingInstall = {
  readonly agent: AgentName
  readonly terminalId: string
  readonly ran: boolean
}

// What a pending install's terminal is, as the workspace shows it; undefined once it is gone.
export type InstallTerminal = { readonly busy: boolean; readonly directory: string }

// Where a pending install stands: still under way (`install` as it is now), ended with its
// program done (`finished`), or ended because its terminal closed first (`gone`).
export type InstallStep<T extends { readonly ran: boolean } = PendingInstall> =
  | { readonly step: "running"; readonly install: T }
  | { readonly step: "finished" | "gone" }

// The installer ends when its terminal stops being busy after having been; one closed
// meanwhile ends it unfinished, with nothing to look for.
// (Forge installs and sign-ins follow their terminals the same way.)
export const stepInstall = <T extends { readonly ran: boolean }>(
  install: T,
  terminal: InstallTerminal | undefined,
): InstallStep<T> => {
  if (!terminal) return { step: "gone" }
  if (terminal.busy)
    return { step: "running", install: install.ran ? install : { ...install, ran: true } }
  return install.ran ? { step: "finished" } : { step: "running", install }
}

// How an install that ended turned out for the agent: it is not installed after all (its
// installer failed, which its terminal shows), or installed but not connected (the switch
// shows why), or installed and connected, ready to start.
export type InstallResult = "ready" | "missing" | "unconnected"

type Agents = NonNullable<Backend["agents"]>

// Looks again at the agents, and where `agent` is installed now connects Novadeck's plugin
// into it, as its switch would, waiting for the backend's answer to each.
export const connectInstalled = async (
  agents: Agents,
  agent: AgentName,
): Promise<InstallResult> => {
  const entry = () => agents.state.getSnapshot().find((each) => each.agent === agent)
  await agents.refresh({ fresh: true })
  if (!entry()?.available) return "missing"
  if (!entry()?.connected) {
    agents.set(agent, true)
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (entry()?.busy) return
        unsubscribe()
        resolve()
      }
      const unsubscribe = agents.state.subscribe(check)
      check()
    })
  }
  return entry()?.connected ? "ready" : "unconnected"
}

// Where the installs under way are kept, in this window's session storage: a reload or a
// remount while an installer runs finds them again, as its terminal survives it.
const storageKey = "novadeck.installs"

const isPending = (value: unknown): value is PendingInstall => {
  if (typeof value !== "object" || value === null) return false
  const { agent, terminalId, ran } = value as Record<string, unknown>
  return (
    typeof agent === "string" &&
    harnesses.some(({ id }) => id === agent) &&
    typeof terminalId === "string" &&
    typeof ran === "boolean"
  )
}

export const readInstalls = (): readonly PendingInstall[] => {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]")
    return Array.isArray(stored) ? stored.filter(isPending) : []
  } catch {
    return []
  }
}

export const writeInstalls = (installs: readonly PendingInstall[]): void => {
  try {
    if (installs.length === 0) sessionStorage.removeItem(storageKey)
    else sessionStorage.setItem(storageKey, JSON.stringify(installs))
  } catch {
    // Without storage, an install under way is not found again after a reload.
  }
}

type Starting = {
  readonly openRequested: (request: TerminalRequest) => void
  readonly add: (options?: { readonly command?: string }) => string
}

// Starts the agent for the person to sign in: beside the installer's terminal, in its folder.
// Where that terminal closed meanwhile, in a terminal of the project on screen instead.
export const startInstalled = (
  commands: Starting,
  install: PendingInstall,
  directory: string,
): void => {
  commands.openRequested({
    from: install.terminalId,
    directory,
    command: install.agent,
    focus: true,
    answer: (result) => {
      if ("reason" in result) commands.add({ command: install.agent })
    },
  })
}

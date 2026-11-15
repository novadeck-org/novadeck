import type { AgentName } from "@novadeck/core/harnesses"
import type { Backend } from "@novadeck/core/port"

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
export type InstallStep =
  | { readonly step: "running"; readonly install: PendingInstall }
  | { readonly step: "finished" | "gone" }

// The installer ends when its terminal stops being busy after having been; one closed
// meanwhile ends it unfinished, with nothing to look for.
export const stepInstall = (
  install: PendingInstall,
  terminal: InstallTerminal | undefined,
): InstallStep => {
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

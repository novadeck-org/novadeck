import { harnesses, type AgentName } from "@novadeck/core/harnesses"

// An agent the person can connect, as its switch shows it.
export type AgentSwitch = {
  readonly agent: AgentName
  readonly available: boolean
  readonly connected: boolean
  readonly busy: boolean
  readonly error?: string
  readonly limited?: "own-status-line" | undefined
}

export const agentLabels = Object.fromEntries(
  harnesses.map(({ id, name }) => [id, name]),
) as Record<AgentName, string>

// Only a state worth knowing gets a note; the switch already shows on or off.
export const agentNote = ({
  available,
  connected,
  busy,
  error,
}: AgentSwitch): string | undefined => {
  if (busy) return connected ? "Disconnecting…" : "Connecting…"
  if (error) return error
  if (!available) return "Not installed"
  return undefined
}

// What a connected agent's limit means for messaging with it, under its name; nothing
// where none, or while it changes.
const limitNotes: Readonly<Record<NonNullable<AgentSwitch["limited"]>, string>> = {
  "own-status-line":
    "It runs your own status line, which keeps Novadeck's out on Windows, so messages can't wake it until you've sent it a prompt. Removing your status line from its settings lifts this.",
}

export const agentLimit = ({ connected, busy, limited }: AgentSwitch): string | undefined =>
  !connected || busy || limited === undefined ? undefined : limitNotes[limited]

// What connecting means, shown above the switches.
export const agentsExplanation =
  "Unlock Novadeck features inside your coding agents, like resuming sessions after a restart. Connecting adds a small plugin; switching it off removes it."

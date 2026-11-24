import { harnesses, type AgentName } from "@novadeck/core/harnesses"

// An agent the person can connect, as its switch shows it.
export type AgentSwitch = {
  readonly agent: AgentName
  readonly available: boolean
  readonly connected: boolean
  readonly busy: boolean
  readonly error?: string
  readonly limited?: "own-status-line" | "outdated" | "unsupported" | undefined
  // The command that installs it, while it is not `available`.
  readonly installer?: string | undefined
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

type Limit = NonNullable<AgentSwitch["limited"]>

// What a connected agent's limit means for messaging with it, under its name; nothing
// where none, or while it changes. The words of a reason, which any agent may have.
const limitNotes: Readonly<Record<Limit, string>> = {
  "own-status-line":
    "It runs your own status line, which keeps Novadeck's out on Windows, so messages can't wake it until you've sent it a prompt. Removing your status line from its settings lifts this.",
  outdated:
    "This version is too old for Novadeck, so it runs without sessions resuming, messages or the chat. Updating it turns them on.",
  unsupported:
    "This version is newer than Novadeck knows, so it runs without sessions resuming, messages or the chat. Installing the release Novadeck works with instead turns them on.",
}

// The words of one agent for a reason, where the agent's own command or versions say more: they
// stand in place of the reason's.
const agentLimitNotes: Readonly<Partial<Record<AgentName, Partial<Record<Limit, string>>>>> = {
  opencode: {
    outdated:
      "This version is too old for Novadeck, so it runs without sessions resuming, messages or the chat. Update it (opencode upgrade) to turn them on.",
    unsupported:
      "Novadeck works with opencode 1 so far, so opencode 2 runs without sessions resuming, messages or the chat. Installing opencode 1 (1.18 or later) instead turns them on.",
  },
  pi: {
    outdated:
      "This version is too old for Novadeck, so it runs without sessions resuming, messages or the chat. Update it (pi update) to turn them on.",
    unsupported:
      "Novadeck works with pi 1 so far, so pi 2 runs without sessions resuming, messages or the chat. Installing pi 1 (1.1 or later) instead turns them on.",
  },
}

export const agentLimit = ({ agent, connected, busy, limited }: AgentSwitch): string | undefined =>
  !connected || busy || limited === undefined
    ? undefined
    : (agentLimitNotes[agent]?.[limited] ?? limitNotes[limited])

// What connecting means, shown above the switches.
export const agentsExplanation =
  "Unlock Novadeck features inside your coding agents, like resuming sessions after a restart. Connecting adds a small plugin; switching it off removes it."

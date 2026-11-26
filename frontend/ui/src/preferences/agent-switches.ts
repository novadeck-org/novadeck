import { harnesses, type AgentName } from "@novadeck/core/harnesses"

// An agent the person can connect, as its switch shows it.
export type AgentSwitch = {
  readonly agent: AgentName
  readonly available: boolean
  readonly connected: boolean
  readonly busy: boolean
  readonly error?: string
  readonly limited?: "own-status-line" | "outdated" | "unsupported" | undefined
  // Disconnected outside Novadeck, or not connected while agents of it sleep.
  readonly lost?: true | undefined
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

// What a lost agent costs, under its name: it is off, so what needs it waits. Nothing while it
// is on, or while the person changes it.
export const agentLost = ({ connected, busy, lost }: AgentSwitch): string | undefined =>
  lost && !connected && !busy
    ? "Disconnected outside Novadeck. Until you connect it again, its sleeping agents can't wake, messages to them wait, and its sessions can't resume."
    : undefined

type Limit = NonNullable<AgentSwitch["limited"]>

// What a connected agent's limit means for messaging with it, under its name; nothing
// where none, or while it changes. The words of a reason, which any agent may have.
const limitNotes: Readonly<Record<Limit, string>> = {
  "own-status-line":
    "It runs your own status line, which keeps Novadeck's out on Windows. Messages can't wake it until you've sent it a prompt. Remove your status line from its settings to fix this.",
  outdated:
    "Too old for Novadeck. It runs, but without resumed sessions, messages or the chat. Update it to turn them on.",
  unsupported:
    "Newer than Novadeck knows. It runs, but without resumed sessions, messages or the chat. Install the release Novadeck works with to turn them on.",
}

// The words of one agent for a reason, where the agent's own command or versions say more: they
// stand in place of the reason's.
const agentLimitNotes: Readonly<Partial<Record<AgentName, Partial<Record<Limit, string>>>>> = {
  opencode: {
    outdated:
      "Too old for Novadeck. It runs, but without resumed sessions, messages or the chat. Update it (opencode upgrade) to turn them on.",
    unsupported:
      "Novadeck works with OpenCode 1 so far. OpenCode 2 runs, but without resumed sessions, messages or the chat. Install OpenCode 1 (1.18 or later) to turn them on.",
  },
  pi: {
    outdated:
      "Too old for Novadeck. It runs, but without resumed sessions, messages or the chat. Update it (pi update) to turn them on.",
    unsupported:
      "Novadeck works with Pi 1 so far. Pi 2 runs, but without resumed sessions, messages or the chat. Install Pi 1 (1.0 or later) to turn them on.",
  },
}

export const agentLimit = ({ agent, connected, busy, limited }: AgentSwitch): string | undefined =>
  !connected || busy || limited === undefined
    ? undefined
    : (agentLimitNotes[agent]?.[limited] ?? limitNotes[limited])

// What connecting means, shown above the switches.
export const agentsExplanation =
  "A connected agent resumes its sessions after a restart, wakes for messages, and shows in the chat. Connecting adds a small plugin. Switch it off and the plugin goes."

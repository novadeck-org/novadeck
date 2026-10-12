import { harnesses, type AgentName } from "../model/harnesses"
import { Switch } from "../ui-toolkit/Switch"
import { settingRowClasses, settingsCardClasses } from "./settings"

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

// One switch per agent: on installs Novadeck's plugin into it, off removes it. An agent
// that is not installed, or one mid-change, cannot be switched.
export const AgentSwitches = ({
  agents,
  onChange,
}: {
  readonly agents: readonly AgentSwitch[]
  readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
}): React.JSX.Element => (
  <ul className={`m-0 p-0 ${settingsCardClasses}`} aria-label="Agents">
    {agents.map((item) => {
      const label = agentLabels[item.agent]
      const note = agentNote(item)
      const limit = agentLimit(item)
      return (
        <li key={item.agent} className={settingRowClasses}>
          <div className="flex min-w-0 flex-col gap-1">
            <span id={`agent-${item.agent}`}>{label}</span>
            {limit && (
              <span
                id={`agent-${item.agent}-limit`}
                className="settings-note text-control leading-relaxed"
                data-tone="warning"
              >
                {limit}
              </span>
            )}
            {note && item.error && (
              <span
                id={`agent-${item.agent}-note`}
                className="settings-note text-control leading-relaxed"
                data-tone="danger"
                role="alert"
              >
                {note}
              </span>
            )}
          </div>
          {/* A short state sits beside the switch, so the row keeps its height. */}
          <div className="flex shrink-0 items-center gap-3">
            {note && !item.error && (
              <span id={`agent-${item.agent}-note`} className="settings-note text-control">
                {note}
              </span>
            )}
            <Switch
              checked={item.connected}
              onChange={(connected) => onChange(item.agent, connected)}
              labelledBy={`agent-${item.agent}`}
              {...(note || limit
                ? {
                    describedBy: [
                      note && `agent-${item.agent}-note`,
                      limit && `agent-${item.agent}-limit`,
                    ]
                      .filter(Boolean)
                      .join(" "),
                  }
                : {})}
              disabled={!item.available || item.busy}
              busy={item.busy}
            />
          </div>
        </li>
      )
    })}
  </ul>
)

// What connecting means, shown above the switches.
export const agentsExplanation =
  "Unlock Novadeck features inside your coding agents, like resuming sessions after a restart. Connecting adds a small plugin; switching it off removes it."

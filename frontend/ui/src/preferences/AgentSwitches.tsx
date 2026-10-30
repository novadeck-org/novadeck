import { Switch } from "@novadeck/toolkit/Switch"

import { agentLabels, agentLimit, agentNote, type AgentSwitch } from "./agent-switches"
import { settingRowClasses, settingsCardClasses } from "./settings"

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
    {agents.map((toggle) => {
      const label = agentLabels[toggle.agent]
      const note = agentNote(toggle)
      const limit = agentLimit(toggle)
      return (
        <li key={toggle.agent} className={settingRowClasses}>
          <div className="flex min-w-0 flex-col gap-1">
            <span id={`agent-${toggle.agent}`}>{label}</span>
            {limit && (
              <span
                id={`agent-${toggle.agent}-limit`}
                className="settings-note text-control leading-5"
                data-tone="warning"
              >
                {limit}
              </span>
            )}
            {note && toggle.error && (
              <span
                id={`agent-${toggle.agent}-note`}
                className="settings-note text-control leading-5"
                data-tone="danger"
                role="alert"
              >
                {note}
              </span>
            )}
          </div>
          {/* A short state sits beside the switch, so the row keeps its height. */}
          <div className="flex shrink-0 items-center gap-3">
            {note && !toggle.error && (
              <span id={`agent-${toggle.agent}-note`} className="settings-note text-control">
                {note}
              </span>
            )}
            <Switch
              checked={toggle.connected}
              onChange={(connected) => onChange(toggle.agent, connected)}
              labelledBy={`agent-${toggle.agent}`}
              {...(note || limit
                ? {
                    describedBy: [
                      note && `agent-${toggle.agent}-note`,
                      limit && `agent-${toggle.agent}-limit`,
                    ]
                      .filter(Boolean)
                      .join(" "),
                  }
                : {})}
              disabled={!toggle.available || toggle.busy}
              busy={toggle.busy}
            />
          </div>
        </li>
      )
    })}
  </ul>
)

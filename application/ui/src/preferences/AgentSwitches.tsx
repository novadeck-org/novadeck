import { Switch } from "../ui-toolkit/Switch"
import { settingRowClasses, settingsCardClasses } from "./settings"

// An agent the person can connect, as its switch shows it.
export type AgentSwitch = {
  readonly agent: "claude" | "codex" | "agy"
  readonly available: boolean
  readonly connected: boolean
  readonly busy: boolean
  readonly error?: string
}

export const agentLabels: Record<AgentSwitch["agent"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
}

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

// One switch per agent: on installs NovaDeck's plugin into it, off removes it. An agent
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
      return (
        <li key={item.agent} className={settingRowClasses}>
          <div className="flex min-w-0 flex-col gap-1">
            <span id={`agent-${item.agent}`}>{label}</span>
            {note && item.error && (
              <span
                id={`agent-${item.agent}-note`}
                className="settings-note text-[11px] leading-relaxed"
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
              <span id={`agent-${item.agent}-note`} className="settings-note text-[11px]">
                {note}
              </span>
            )}
            <Switch
              checked={item.connected}
              onChange={(connected) => onChange(item.agent, connected)}
              labelledBy={`agent-${item.agent}`}
              {...(note ? { describedBy: `agent-${item.agent}-note` } : {})}
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
  "Unlock NovaDeck features inside your coding agents, like resuming sessions after a restart. Connecting adds a small plugin; switching it off removes it."

import type { AgentName } from "@novadeck/core/harnesses"
import { AntigravityIcon } from "@novadeck/toolkit/icons/AntigravityIcon"
import { ClaudeIcon } from "@novadeck/toolkit/icons/ClaudeIcon"
import { CodexIcon } from "@novadeck/toolkit/icons/CodexIcon"
import { OpencodeIcon } from "@novadeck/toolkit/icons/OpencodeIcon"
import { PiIcon } from "@novadeck/toolkit/icons/PiIcon"
import { Switch } from "@novadeck/toolkit/Switch"
import type { ComponentType } from "react"

import { agentLabels, agentLimit, agentLost, agentNote, type AgentSwitch } from "./agent-switches"
import { settingRowClasses, settingsStackClasses } from "./settings"

// Each agent's mark, as the welcome dialog's cards show it.
const icons: Readonly<Record<AgentName, ComponentType<{ size?: number; strokeWidth?: number }>>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  agy: AntigravityIcon,
  opencode: OpencodeIcon,
  pi: PiIcon,
}

// The agent's mark in a tile, as on the welcome dialog's cards; an outline where it isn't
// installed.
const Tile = ({
  agent,
  missing = false,
}: {
  readonly agent: AgentName
  readonly missing?: boolean
}): React.JSX.Element => {
  const Icon = icons[agent]
  return (
    <span
      className="choice-card-tile settings-agent-tile flex size-[38px] flex-none items-center justify-center"
      data-missing={missing || undefined}
      aria-hidden="true"
    >
      <Icon size={20} strokeWidth={1.4} />
    </span>
  )
}

// The command that installs an agent that isn't here, where the backend knows one.
const installerOf = ({ available, installer }: AgentSwitch): string | undefined =>
  available ? undefined : installer

// One switch per agent: on installs Novadeck's plugin into it, off removes it. An agent
// that is not installed, or one mid-change, cannot be switched. One not installed whose
// installer is known offers Install in place of its switch, where `onInstall` is given,
// and reads as installing while its installer runs.
export const AgentSwitches = ({
  agents,
  onChange,
  onInstall,
  installing,
}: {
  readonly agents: readonly AgentSwitch[]
  readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
  readonly onInstall?: ((agent: AgentName, command: string) => void) | undefined
  // The agents whose installer runs now.
  readonly installing?: ReadonlySet<AgentName> | undefined
}): React.JSX.Element => (
  <ul className={settingsStackClasses} aria-label="Agents">
    {agents.map((toggle) => {
      const label = agentLabels[toggle.agent]
      const installer = onInstall ? installerOf(toggle) : undefined
      if (installer)
        return (
          <InstallRow
            key={toggle.agent}
            agent={toggle.agent}
            label={label}
            command={installer}
            running={installing?.has(toggle.agent) === true}
            onInstall={() => onInstall?.(toggle.agent, installer)}
          />
        )
      const note = agentNote(toggle)
      const limit = agentLimit(toggle)
      const lost = agentLost(toggle)
      return (
        <li key={toggle.agent} className={settingRowClasses}>
          <div className="flex min-w-0 items-center gap-3">
            <Tile agent={toggle.agent} missing={!toggle.available} />
            <div className="flex min-w-0 flex-col gap-1">
              <span id={`agent-${toggle.agent}`} className="settings-label">
                {label}
              </span>
              {limit && (
                <span
                  id={`agent-${toggle.agent}-limit`}
                  className="settings-note text-control leading-5"
                  data-tone="warning"
                >
                  {limit}
                </span>
              )}
              {lost && (
                <span
                  id={`agent-${toggle.agent}-lost`}
                  className="settings-note text-control leading-5"
                  data-tone="warning"
                >
                  {lost}
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
              {...(note || limit || lost
                ? {
                    describedBy: [
                      note && `agent-${toggle.agent}-note`,
                      limit && `agent-${toggle.agent}-limit`,
                      lost && `agent-${toggle.agent}-lost`,
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

// An agent that isn't here: the command its installer runs, whole under its name so nothing
// it will do is hidden, and Install, which runs it in a terminal of the workspace.
const InstallRow = ({
  agent,
  label,
  command,
  running,
  onInstall,
}: {
  readonly agent: AgentName
  readonly label: string
  readonly command: string
  readonly running: boolean
  readonly onInstall: () => void
}): React.JSX.Element => (
  <li className={settingRowClasses}>
    {/* It takes the row's width, so the command shows as much as fits. */}
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Tile agent={agent} missing />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={`agent-${agent}`} className="settings-label">
          {label}
        </span>
        <span id={`agent-${agent}-note`} className="settings-note text-control leading-5">
          {running ? "Installing in a terminal of its own." : "Not installed. Install runs"}
          {/* Whole, wrapping where it must, so nothing it will do is hidden. */}
          {!running && (
            <code className="settings-installer mt-0.5 block [overflow-wrap:anywhere]">
              {command}
            </code>
          )}
        </span>
      </div>
    </div>
    <button
      type="button"
      className="button min-h-8 shrink-0 px-3 text-control"
      aria-label={running ? `Installing ${label}` : `Install ${label}`}
      aria-describedby={`agent-${agent}-note`}
      // Focused from a row that needs this agent, as a switch is.
      data-agent-install
      // Still focusable while its installer runs, as a pending switch is, and announced so.
      aria-disabled={running || undefined}
      aria-busy={running || undefined}
      onClick={() => {
        if (!running) onInstall()
      }}
    >
      {running ? "Installing…" : "Install"}
    </button>
  </li>
)

import type { AgentMode } from "@novadeck/core/port"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import { useState, type ReactNode } from "react"

import { agentModeChoice, agentModeChoices } from "./agent-mode-choices"
import { AgentModeMap } from "./AgentModeMap"
import { settingRowClasses, settingsCardClasses } from "./settings"

const items = agentModeChoices.map(({ mode, label }) => ({ value: mode, label }))

// "Agents work as": the modes by name in a switch, as Appearance's Mode is, and under it the
// picked mode's map beside what it's for, what agents then do and what it costs. Once the
// person changes it, a line says when running agents follow it.
// `badge` stands beside its name, as Experimental's mark does while the picker is one.
export const AgentModePicker = ({
  mode,
  onChange,
  badge,
}: {
  readonly mode: AgentMode
  readonly onChange: (mode: AgentMode) => void
  readonly badge?: ReactNode
}): React.JSX.Element => {
  const [first] = useState(mode)
  const choice = agentModeChoice(mode)
  return (
    <>
      <div className={`agent-mode-preferences @container ${settingsCardClasses}`}>
        <fieldset
          className={`preference-row ${settingRowClasses} m-0 min-w-0 max-[480px]:flex-col max-[480px]:items-stretch max-[480px]:gap-2.5`}
          aria-labelledby="agent-mode-label"
        >
          <span className="flex items-center gap-2">
            <span id="agent-mode-label">Agents work as</span>
            {badge}
          </span>
          <SegmentGroup
            label="Agents work as"
            items={items}
            value={mode}
            onValueChange={(next) => {
              const picked = agentModeChoices.find((item) => item.mode === next)?.mode
              if (picked) onChange(picked)
            }}
            className="flex shrink-0 gap-1"
            itemClassName="flex h-7 min-w-18 items-center justify-center px-2.5 text-control max-[480px]:flex-1"
            indicatorClassName="absolute"
          />
        </fieldset>
        {/* The map stacks over its words where the card is too narrow for both side by side, as
            beside a menu in a small window; search passes it by (data-search-skip): it is no
            setting of its own. */}
        <div
          className="settings-row @container/agent-mode-map grid grid-cols-[272px_minmax(0,1fr)] items-center gap-5 px-4 py-3.5 @max-[560px]:grid-cols-1 @max-[560px]:justify-items-center"
          data-search-skip=""
        >
          <AgentModeMap mode={choice.mode} label={choice.map} />
          <div
            className="flex min-w-0 flex-col gap-2 text-body @max-[560px]:justify-self-stretch"
            aria-live="polite"
          >
            <p className="m-0">{choice.lead}</p>
            <ul className="agent-mode-facts settings-description m-0 flex flex-col gap-1 pl-4 text-control leading-5">
              {choice.facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
            {choice.cost && (
              <p className="settings-note m-0 text-control leading-5" data-tone="warning">
                {choice.cost}
              </p>
            )}
          </div>
        </div>
      </div>
      {mode !== first && (
        <p className="settings-description m-0 px-0.5 text-control leading-5" role="status">
          Agents already running follow it fully from their next session.
        </p>
      )}
    </>
  )
}

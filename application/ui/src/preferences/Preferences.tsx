import { LayoutGrid, Moon, PanelLeft, SquareDashedMousePointer, Sun, X } from "lucide-react"
import { useRef, useState } from "react"

import { shortcutGroups } from "../interaction/keymap"
import { currentPlatform } from "../interaction/shortcuts"
import { viewModes } from "../model/state"
import type { PreferencesValue } from "../model/types"
import { Dialog } from "../ui-toolkit/Dialog"
import { Select } from "../ui-toolkit/Select"
import { Switch } from "../ui-toolkit/Switch"
import { Tabs, TabList, Tab, TabPanel } from "../ui-toolkit/Tabs"
import { AgentSwitches, agentsExplanation, type AgentSwitch } from "./AgentSwitches"

import motion from "../ui-toolkit/ModalMotion.module.css"

const themes = [{ label: "Monochrome", value: "monochrome" }]
const fontSizes = [12, 13, 15].map((size) => ({ label: `${size}px`, value: String(size) }))

export const Preferences = ({
  open,
  value,
  onChange,
  onClose,
  onExitComplete,
  tab,
  onTabChange,
  transcripts,
  agents,
}: {
  open: boolean
  tab: "general" | "shortcuts"
  onTabChange: (tab: "general" | "shortcuts") => void
  value: PreferencesValue
  onChange: (value: PreferencesValue) => void
  onClose: () => void
  onExitComplete?: () => void
  // Whether terminals' screens are kept to show again when they restore; absent where
  // the backend keeps none.
  transcripts?: { readonly enabled: boolean; readonly onChange: (enabled: boolean) => void }
  // Agents whose sessions resume once connected; absent where the backend has none.
  agents?: {
    readonly list: readonly AgentSwitch[]
    readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
  }
}): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const panels = useRef<HTMLDivElement>(null)
  const [openSelect, setOpenSelect] = useState<string | null>(null)
  const changeTab = (next: string): void => {
    if (next !== "general" && next !== "shortcuts") return
    onTabChange(next)
    setOpenSelect(null)
    if (panels.current) panels.current.scrollTop = 0
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(expanded) => {
        if (!expanded) {
          setOpenSelect(null)
          onClose()
        }
      }}
      onExitComplete={() => {
        setOpenSelect(null)
        onExitComplete?.()
      }}
      contentRef={dialog}
      label="Preferences"
      backdropClassName={`${motion.backdrop} fixed inset-0 z-50 bg-scrim backdrop-blur-[3px]`}
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center"
      className={`${motion.dialog} flex h-[75dvh] w-[min(480px,calc(100vw-32px))] flex-col overflow-visible rounded-popover border border-line-strong bg-paper p-5 text-ink shadow-modal max-[360px]:w-[calc(100vw-24px)] max-[360px]:p-4`}
    >
      <div className="preferences-heading flex shrink-0 min-h-[30px] items-center justify-between gap-4">
        <h2 id="preferences-title" className="m-0 text-[14px] font-medium tracking-[-0.2px]">
          Preferences
        </h2>
        <button className="icon-button size-8" aria-label="Close preferences" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <Tabs value={tab} onValueChange={changeTab} className="flex min-h-0 flex-1 flex-col">
        <TabList
          className="preferences-tabs mt-4.5 flex shrink-0 gap-4 border-b border-line"
          label="Preference sections"
        >
          {(["general", "shortcuts"] as const).map((id) => (
            <Tab
              key={id}
              value={id}
              className="relative min-h-[31px] px-0.5 text-left text-[11px] text-muted data-selected:text-ink data-selected:after:absolute data-selected:after:right-0 data-selected:after:bottom-[-1px] data-selected:after:left-0 data-selected:after:h-px data-selected:after:bg-strong data-selected:after:content-['']"
            >
              {id === "general" ? "General" : "Shortcuts"}
            </Tab>
          ))}
        </TabList>
        <div ref={panels} className="preferences-panels grid min-h-0 overflow-y-auto">
          <TabPanel
            value="general"
            className="preferences-panel col-start-1 row-start-1 outline-none transition-opacity duration-(--motion-feedback) ease-interface focus-visible:outline-1 focus-visible:outline-line-strong focus-visible:outline-offset-[-1px] data-[state=open]:visible data-[state=open]:opacity-100 data-[state=closed]:invisible data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0"
          >
            <Select
              className="preference-row min-h-[62px] border-b border-line"
              label="Theme"
              items={themes}
              value="monochrome"
              open={open && tab === "general" && openSelect === "theme"}
              onOpenChange={(expanded) => setOpenSelect(expanded ? "theme" : null)}
              portalContainer={dialog}
            />
            <div className="preference-row flex min-h-[62px] items-center justify-between gap-4 border-b border-line text-[12px] text-ink">
              <div className="flex flex-col gap-1">
                <span>Appearance</span>
                <span id="theme-mode-description" className="text-[10px] text-muted">
                  Light mode only
                </span>
              </div>
              <div className="flex items-center gap-2" title="Unavailable">
                <Sun size={14} strokeWidth={1.5} aria-hidden="true" className="text-muted" />
                <button
                  type="button"
                  role="switch"
                  aria-label="Dark mode"
                  aria-checked={false}
                  aria-describedby="theme-mode-description"
                  disabled
                  className="relative h-5 w-9 cursor-not-allowed rounded-control border border-line bg-soft opacity-50"
                >
                  <span className="absolute top-0.5 left-0.5 size-3.5 rounded-control border border-line-strong bg-paper" />
                </button>
                <Moon
                  size={14}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className="text-muted opacity-40"
                />
              </div>
            </div>
            <Select
              className="preference-row min-h-[62px] border-b border-line"
              label="Terminal text size"
              items={fontSizes}
              value={String(value.fontSize)}
              onValueChange={(size) => onChange({ ...value, fontSize: Number(size) })}
              open={open && tab === "general" && openSelect === "font-size"}
              onOpenChange={(expanded) => setOpenSelect(expanded ? "font-size" : null)}
              portalContainer={dialog}
            />
            {transcripts && (
              <div className="preference-row flex min-h-[62px] items-center justify-between gap-4 border-b border-line py-3 text-[12px] text-ink">
                <div className="flex flex-col gap-1">
                  <span id="transcripts-label">Terminal transcripts</span>
                  <span
                    id="transcripts-description"
                    className="text-[10px] leading-relaxed text-muted"
                  >
                    Keeps each terminal's recent output on this computer and shows it again after a
                    restart. It can include secrets that were typed or printed.
                  </span>
                </div>
                <Switch
                  checked={transcripts.enabled}
                  onChange={transcripts.onChange}
                  labelledBy="transcripts-label"
                  describedBy="transcripts-description"
                />
              </div>
            )}
            {agents && (
              <section className="mt-4" aria-labelledby="agents-heading">
                <h3 id="agents-heading" className="m-0 text-[12px] font-normal">
                  Resume agents
                </h3>
                <p className="mt-1 mb-1 text-[10px] leading-relaxed text-muted">
                  {agentsExplanation}
                </p>
                <AgentSwitches agents={agents.list} onChange={agents.onChange} />
              </section>
            )}
            <fieldset className="view-preferences m-0 mt-4 min-w-0 border-0 p-0">
              <legend className="mb-2.5 p-0 text-[12px]">View modes</legend>
              <div className="view-preference-options grid grid-cols-3 gap-1.5">
                {viewModes.map((mode) => {
                  const checked = value.enabledViews.includes(mode)
                  const Icon =
                    mode === "focus"
                      ? PanelLeft
                      : mode === "grid"
                        ? LayoutGrid
                        : SquareDashedMousePointer
                  return (
                    <label
                      key={mode}
                      className={`relative flex min-h-[66px] min-w-0 flex-col justify-between gap-2 rounded-control border p-[9px] text-[12px] ${checked ? "border-line-strong bg-shell text-ink shadow-control" : "border-line bg-paper text-muted hover:bg-shell hover:text-ink"} ${checked && value.enabledViews.length === 1 ? "cursor-not-allowed" : "cursor-pointer"} has-focus-visible:outline-1 has-focus-visible:outline-line-strong has-focus-visible:outline-offset-3 max-[360px]:min-h-[60px] max-[360px]:p-[7px] max-[360px]:text-[10px]`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={checked && value.enabledViews.length === 1}
                        className="absolute top-2.5 right-2.5 m-0 size-3 accent-strong"
                        onChange={() =>
                          onChange({
                            ...value,
                            enabledViews: viewModes.filter((item) =>
                              item === mode ? !checked : value.enabledViews.includes(item),
                            ),
                          })
                        }
                      />
                      <Icon
                        aria-hidden="true"
                        className={`shrink-0 ${checked && value.enabledViews.length === 1 ? "opacity-45" : ""}`}
                        size={15}
                        strokeWidth={1.5}
                      />
                      <span>
                        {mode === "focus" ? "Focus" : mode === "grid" ? "Grid" : "Canvas"}
                      </span>
                    </label>
                  )
                })}
              </div>
              <p className="m-0 mt-[9px] text-[10px] text-muted">Keep at least one view enabled.</p>
            </fieldset>
          </TabPanel>
          <TabPanel
            value="shortcuts"
            className="preferences-panel col-start-1 row-start-1 outline-none transition-opacity duration-(--motion-feedback) ease-interface focus-visible:outline-1 focus-visible:outline-line-strong focus-visible:outline-offset-[-1px] data-[state=open]:visible data-[state=open]:opacity-100 data-[state=closed]:invisible data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0"
          >
            {shortcutGroups(currentPlatform()).map(({ title, description, items }) => (
              <section key={title} className="mt-5" aria-label={`${title} shortcuts`}>
                <h3 className="m-0 text-xs font-medium">{title}</h3>
                <p className="mt-1 mb-2 text-[10px] leading-relaxed text-muted">{description}</p>
                <dl className="shortcut-list m-0 grid gap-0">
                  {items.map(({ label, display }) => (
                    <div
                      key={label}
                      className="flex min-h-[46px] items-center justify-between gap-4 border-b border-line text-[12px]"
                    >
                      <dt className="m-0">{label}</dt>
                      <dd className="m-0 flex shrink-0 gap-1">
                        {display.map((key) => (
                          <kbd key={key} className="text-muted">
                            {key}
                          </kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </TabPanel>
        </div>
      </Tabs>
    </Dialog>
  )
}

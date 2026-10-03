import { LayoutGrid, PanelLeft, SquareDashedMousePointer, X } from "lucide-react"
import { useRef, useState, type ReactNode } from "react"

import { shortcutGroups } from "../interaction/keymap"
import { currentPlatform } from "../interaction/shortcuts"
import { viewModes } from "../model/state"
import type { PreferencesValue } from "../model/types"
import { themes, type ThemeEntry, type ThemeId } from "../theme/themes"
import { Checkbox } from "../ui-toolkit/Checkbox"
import { Dialog } from "../ui-toolkit/Dialog"
import { SegmentGroup } from "../ui-toolkit/SegmentGroup"
import { Select } from "../ui-toolkit/Select"
import { Switch } from "../ui-toolkit/Switch"
import { Tabs, TabList, Tab, TabPanel } from "../ui-toolkit/Tabs"
import { AgentSwitches, agentsExplanation, type AgentSwitch } from "./AgentSwitches"
import { settingRowClasses, settingsCardClasses } from "./settings"

const themeItems = themes.map(({ id, name }) => ({ label: name, value: id }))
const schemeItems = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] as const
const fontSizes = [12, 13, 15].map((size) => ({ label: `${size}px`, value: String(size) }))
const viewLabels = { focus: "Focus", grid: "Grid", canvas: "Canvas" } as const
const viewIcons = { focus: PanelLeft, grid: LayoutGrid, canvas: SquareDashedMousePointer } as const

// Section titles match the sidebar's panel titles.
const sectionTitleClasses = "section-label m-0 text-[9px] font-medium"
const sectionDescriptionClasses = "settings-description m-0 mt-1.5 text-[11px] leading-relaxed"
const panelClasses =
  "preferences-panel col-start-1 row-start-1 flex flex-col gap-6 px-6 py-5 data-[state=open]:visible data-[state=open]:opacity-100 data-[state=closed]:invisible data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 max-[480px]:px-4"

// A titled group of settings; the title names the region unless a label is given.
const Section = ({
  title,
  description,
  label,
  children,
}: {
  title: string
  description?: ReactNode
  label?: string
  children: ReactNode
}): React.JSX.Element => {
  const id = `preferences-${title.toLowerCase().replaceAll(" ", "-")}`
  return (
    <section
      className="flex flex-col gap-2.5"
      {...(label ? { "aria-label": label } : { "aria-labelledby": id })}
    >
      <header className="px-0.5">
        <h3 id={id} className={sectionTitleClasses}>
          {title}
        </h3>
        {description && <p className={sectionDescriptionClasses}>{description}</p>}
      </header>
      {children}
    </section>
  )
}

// A setting's name and what it does, beside its control.
const SettingText = ({
  id,
  label,
  description,
  descriptionId,
}: {
  id: string
  label: string
  description: string
  descriptionId: string
}): React.JSX.Element => (
  <span className="flex min-w-0 flex-col gap-1">
    <span id={id}>{label}</span>
    <span id={descriptionId} className="settings-description text-[11px] leading-relaxed">
      {description}
    </span>
  </span>
)

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
  const lastView = value.enabledViews.length === 1
  const { appearance } = value
  const theme: ThemeEntry<ThemeId> =
    themes.find((entry) => entry.id === appearance.theme) ?? themes[0]
  // A theme drawn in one scheme leaves nothing to choose.
  const onlyScheme = theme.schemes.length === 1 ? theme.schemes[0] : undefined
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
      backdropClassName="overlay fixed inset-0 z-50"
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center"
      className="modal flex h-[min(640px,calc(100dvh-48px))] w-[min(540px,calc(100vw-32px))] flex-col overflow-hidden max-[480px]:w-[calc(100vw-24px)]"
    >
      <Tabs value={tab} onValueChange={changeTab} className="flex min-h-0 flex-1 flex-col">
        <div className="modal-header preferences-heading shrink-0 px-6 pt-5 max-[480px]:px-4">
          <div className="flex items-center justify-between gap-4">
            <h2 id="preferences-title" className="modal-title m-0 text-[15px] font-medium">
              Preferences
            </h2>
            <button
              className="icon-button -mr-2 size-8"
              aria-label="Close preferences"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
          <TabList
            className="preferences-tabs mt-3 flex gap-5"
            label="Preference sections"
            indicatorClassName="bottom-[-1px] h-0.5"
          >
            {(["general", "shortcuts"] as const).map((id) => (
              <Tab key={id} value={id} className="relative min-h-9 px-0.5 text-left text-[12px]">
                {id === "general" ? "General" : "Shortcuts"}
              </Tab>
            ))}
          </TabList>
        </div>
        <div ref={panels} className="preferences-panels grid min-h-0 flex-1 overflow-y-auto">
          <TabPanel value="general" className={panelClasses}>
            <Section title="Appearance">
              <div className={settingsCardClasses}>
                <Select
                  className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-36`}
                  label="Theme"
                  items={themeItems}
                  value={theme.id}
                  onValueChange={(id) => {
                    const chosen = themes.find((entry) => entry.id === id)
                    if (chosen)
                      onChange({ ...value, appearance: { ...appearance, theme: chosen.id } })
                  }}
                  open={open && tab === "general" && openSelect === "theme"}
                  onOpenChange={(expanded) => setOpenSelect(expanded ? "theme" : null)}
                  portalContainer={dialog}
                />
                {/* A disabled fieldset disables the segment group inside it. */}
                <fieldset
                  className={`preference-row ${settingRowClasses} m-0 min-w-0`}
                  aria-labelledby="theme-scheme-label"
                  aria-describedby="theme-scheme-description"
                  disabled={onlyScheme !== undefined}
                >
                  <SettingText
                    id="theme-scheme-label"
                    label="Mode"
                    description={
                      onlyScheme
                        ? `${theme.name} comes only in ${onlyScheme}.`
                        : "Follow the system, or stay light or dark."
                    }
                    descriptionId="theme-scheme-description"
                  />
                  <SegmentGroup
                    label="Mode"
                    items={[...schemeItems]}
                    value={onlyScheme ?? appearance.scheme}
                    onValueChange={(next) => {
                      const scheme = schemeItems.find((item) => item.value === next)?.value
                      if (scheme) onChange({ ...value, appearance: { ...appearance, scheme } })
                    }}
                    className="flex shrink-0 gap-1"
                    itemClassName="flex h-7 min-w-14 items-center justify-center px-2.5 text-[11px] data-disabled:cursor-not-allowed"
                    indicatorClassName="absolute"
                  />
                </fieldset>
              </div>
            </Section>
            <fieldset
              className="view-preferences settings-fieldset m-0 min-w-0 p-0"
              aria-describedby="view-modes-description"
            >
              <legend className="float-left mb-1.5 w-full p-0 px-0.5">
                <span className={`block ${sectionTitleClasses}`}>View modes</span>
              </legend>
              <p
                id="view-modes-description"
                className={`clear-both px-0.5 ${sectionDescriptionClasses}`}
              >
                Layouts shown in the header. At least one stays on.
              </p>
              <div className="view-preference-options mt-2.5 grid grid-cols-3 gap-2 max-[360px]:gap-1.5">
                {viewModes.map((mode) => {
                  const checked = value.enabledViews.includes(mode)
                  const locked = checked && lastView
                  const Icon = viewIcons[mode]
                  return (
                    <label
                      key={mode}
                      className={`choice-card relative flex min-h-[76px] min-w-0 flex-col justify-between gap-3 p-3 text-[12px] ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}
                      data-state={checked ? "checked" : "unchecked"}
                      data-disabled={locked || undefined}
                    >
                      <Icon aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.5} />
                      <span>{viewLabels[mode]}</span>
                      <Checkbox
                        className="absolute top-2.5 right-2.5"
                        checked={checked}
                        disabled={locked}
                        onChange={() =>
                          onChange({
                            ...value,
                            enabledViews: viewModes.filter((item) =>
                              item === mode ? !checked : value.enabledViews.includes(item),
                            ),
                          })
                        }
                      />
                    </label>
                  )
                })}
              </div>
            </fieldset>
            <Section title="Terminals">
              <div className={settingsCardClasses}>
                <Select
                  className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-36`}
                  label="Text size"
                  items={fontSizes}
                  value={String(value.fontSize)}
                  onValueChange={(size) => onChange({ ...value, fontSize: Number(size) })}
                  open={open && tab === "general" && openSelect === "font-size"}
                  onOpenChange={(expanded) => setOpenSelect(expanded ? "font-size" : null)}
                  portalContainer={dialog}
                />
                {transcripts && (
                  <div className={`preference-row ${settingRowClasses}`}>
                    <SettingText
                      id="transcripts-label"
                      label="Transcripts"
                      description="Show recent output again after a restart. Saved on this computer, so it can include secrets."
                      descriptionId="transcripts-description"
                    />
                    <Switch
                      checked={transcripts.enabled}
                      onChange={transcripts.onChange}
                      labelledBy="transcripts-label"
                      describedBy="transcripts-description"
                    />
                  </div>
                )}
              </div>
            </Section>
            {agents && (
              <Section title="Agents" description={agentsExplanation}>
                <AgentSwitches agents={agents.list} onChange={agents.onChange} />
              </Section>
            )}
          </TabPanel>
          <TabPanel value="shortcuts" className={panelClasses}>
            {shortcutGroups(currentPlatform()).map(({ title, description, items }) => (
              <Section
                key={title}
                title={title}
                description={description}
                label={`${title} shortcuts`}
              >
                <dl className={`shortcut-list m-0 ${settingsCardClasses}`}>
                  {items.map(({ label, display }) => (
                    <div
                      key={label}
                      className="settings-row flex min-h-10.5 items-center justify-between gap-4 px-4 py-2 text-[12px]"
                    >
                      <dt className="m-0 min-w-0">{label}</dt>
                      <dd className="m-0 flex shrink-0 gap-1">
                        {display.map((key) => (
                          <kbd
                            key={key}
                            className="h-5.5 min-w-5.5 pt-0.5 text-[10px] leading-none"
                          >
                            {key}
                          </kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Section>
            ))}
          </TabPanel>
        </div>
      </Tabs>
    </Dialog>
  )
}

import { MURMUR_NAME } from "@novadeck/core/murmur"
import { viewModes } from "@novadeck/core/state"
import type { PreferencesValue } from "@novadeck/core/types"
import { Checkbox } from "@novadeck/toolkit/Checkbox"
import { Dialog } from "@novadeck/toolkit/Dialog"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import { Select } from "@novadeck/toolkit/Select"
import { Switch } from "@novadeck/toolkit/Switch"
import { Tabs, TabList, Tab, TabPanel } from "@novadeck/toolkit/Tabs"
import { views } from "@novadeck/toolkit/views"
import { X } from "lucide-react"
import { useRef, useState, type ReactNode } from "react"

import { shortcutGroups } from "../interaction/keymap"
import { currentPlatform } from "../interaction/shortcuts"
import { themes, type ThemeEntry, type ThemeId } from "../theme/themes"
import { AddonRow } from "./addon-parts"
import { AgentSwitches, agentsExplanation, type AgentSwitch } from "./AgentSwitches"
import { murmurDescription } from "./murmur-addon"
import { MurmurAddon, type MurmurAddonValue } from "./MurmurAddon"
import {
  preferencesTabs,
  settingRowClasses,
  settingsCardClasses,
  versionText,
  type PreferencesTab,
} from "./settings"
import { UninstallApp, type UninstallValue } from "./UninstallApp"
import { VoiceInput, type VoiceAddon } from "./VoiceInput"

const themeItems = themes.map(({ id, name }) => ({ label: name, value: id }))
const schemeItems = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] as const
const fontSizes = [12, 13, 15].map((size) => ({ label: `${size}px`, value: String(size) }))

// Section titles match the sidebar's panel titles.
const sectionTitleClasses = "section-label m-0 text-label font-medium"
const sectionDescriptionClasses = "settings-description m-0 mt-1.5 text-control leading-5"
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
    <span id={descriptionId} className="settings-description text-control leading-5">
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
  voice,
  murmur,
  experimental,
  version,
  logs,
  uninstall,
  notices = false,
  hostSounds = false,
  hearSound,
  chat = false,
}: {
  open: boolean
  tab: PreferencesTab
  onTabChange: (tab: PreferencesTab) => void
  value: PreferencesValue
  onChange: (value: PreferencesValue) => void
  onClose: () => void
  onExitComplete?: () => void
  // Whether terminals' screens are kept to show again when they restore; absent where
  // the backend keeps none.
  transcripts?: {
    readonly enabled: boolean
    // False where nothing can keep them encrypted: the switch shows off and cannot change.
    readonly available: boolean
    readonly onChange: (enabled: boolean) => void
  }
  // Whether the page can show desktop notifications, as the desktop app can.
  notices?: boolean
  // Whether the system's notifications play the sound themselves, at the system's alert
  // volume, as on macOS.
  hostSounds?: boolean
  // Plays the notification sound at a volume, for the person to hear what they set.
  hearSound?: (volume: number) => void
  // Whether the backend reads agents' conversations, which the chat view shows.
  chat?: boolean
  // Agents whose sessions resume once connected; absent where the backend has none.
  agents?: {
    readonly list: readonly AgentSwitch[]
    readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
  }
  // Voice input, as the backend has it; absent where it has none.
  voice?: VoiceAddon
  // Murmur, as the backend has it; absent where it has none.
  murmur?: MurmurAddonValue
  // Whether the desktop app follows early builds, which also shows the Experimental tab;
  // absent where it doesn't offer the choice. `on` is undefined until the app has said.
  experimental?: {
    readonly on: boolean | undefined
    readonly onChange: (on: boolean) => void
  }
  // The desktop app's version; absent where the backend has none to give.
  version?: string
  // Opens the desktop app's logs folder; absent where the backend keeps no logs.
  logs?: () => void
  // Removing the desktop app; absent where the backend offers none, as for a portable copy.
  uninstall?: UninstallValue
}): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const panels = useRef<HTMLDivElement>(null)
  const [openSelect, setOpenSelect] = useState<string | null>(null)
  const changeTab = (next: string): void => {
    const chosen = preferencesTabs.find(({ id }) => id === next)
    if (!chosen) return
    onTabChange(chosen.id)
    setOpenSelect(null)
    if (panels.current) panels.current.scrollTop = 0
  }
  // The Addons are voice input and murmur; a backend with neither, as the website's demo,
  // has no tab for them, though a URL can still name the section.
  const hasAddons = voice !== undefined || murmur !== undefined
  // About is the app itself: its version, updates, logs and removal; a backend with none of
  // them has no tab for it.
  const hasAbout = version !== undefined || experimental !== undefined || !!logs || !!uninstall
  // The Experimental tab, with the chat view, is there only while its switch is on.
  const hasExperimental = experimental?.on === true
  const hidden = (id: PreferencesTab): boolean =>
    (id === "addons" && !hasAddons) ||
    (id === "about" && !hasAbout) ||
    (id === "experimental" && !hasExperimental)
  const shown = hidden(tab) ? "general" : tab
  // The Experimental tab's switches, one row each.
  const experimentalToggles = [
    {
      id: "chat-view",
      label: "Chat view",
      description: chat
        ? "Read and reply to agents in a chat instead of their terminal. When the chat can't handle something, answer in the terminal."
        : "Not available here.",
      checked: value.chatView,
      onToggle: (chatView: boolean) => onChange({ ...value, chatView }),
      disabled: !chat,
    },
  ]
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
      <Tabs value={shown} onValueChange={changeTab} className="flex min-h-0 flex-1 flex-col">
        <div className="modal-header preferences-heading shrink-0 px-6 pt-5 max-[480px]:px-4">
          <div className="flex items-center justify-between gap-4">
            <h2 id="preferences-title" className="modal-title m-0 text-title font-medium">
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
            {preferencesTabs
              .filter(({ id }) => !hidden(id))
              .map(({ id, label }) => (
                <Tab key={id} value={id} className="relative min-h-9 px-0.5 text-left text-body">
                  {label}
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
                  // A saved theme the app doesn't have shows as the one drawn, Graphite,
                  // without being chosen, so picking Graphite saves it.
                  value={theme.id === appearance.theme ? theme.id : ""}
                  placeholder={theme.name}
                  onValueChange={(id) => {
                    const chosen = themes.find((entry) => entry.id === id)
                    if (chosen)
                      onChange({ ...value, appearance: { ...appearance, theme: chosen.id } })
                  }}
                  open={open && shown === "general" && openSelect === "theme"}
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
                  {/* Remounted when the theme's schemes change, so it shows the forced mode,
                      and the saved one again, as its checked inputs would not follow. */}
                  <SegmentGroup
                    key={onlyScheme ?? "free"}
                    label="Mode"
                    items={[...schemeItems]}
                    value={onlyScheme ?? appearance.scheme}
                    onValueChange={(next) => {
                      const scheme = schemeItems.find((item) => item.value === next)?.value
                      if (scheme) onChange({ ...value, appearance: { ...appearance, scheme } })
                    }}
                    className="flex shrink-0 gap-1"
                    itemClassName="flex h-7 min-w-14 items-center justify-center px-2.5 text-control data-disabled:cursor-not-allowed"
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
                Layouts shown in the header. At least one stays on; with one, the header has no
                switch.
              </p>
              <div className="view-preference-options mt-2.5 grid grid-cols-3 gap-2 max-[360px]:gap-1.5">
                {viewModes.map((mode) => {
                  const { label, icon: Icon } = views[mode]
                  const checked = value.enabledViews.includes(mode)
                  const locked = checked && lastView
                  return (
                    <label
                      key={mode}
                      className={`choice-card relative flex min-h-[76px] min-w-0 flex-col justify-between gap-3 p-3 text-body ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}
                      data-state={checked ? "checked" : "unchecked"}
                      data-disabled={locked || undefined}
                    >
                      <Icon aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.5} />
                      <span>{label}</span>
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
                  open={open && shown === "general" && openSelect === "font-size"}
                  onOpenChange={(expanded) => setOpenSelect(expanded ? "font-size" : null)}
                  portalContainer={dialog}
                />
                <div className={`preference-row ${settingRowClasses}`}>
                  <SettingText
                    id="ligatures-label"
                    label="Ligatures"
                    description="Join pairs such as => and != into one symbol in terminals and code."
                    descriptionId="ligatures-description"
                  />
                  <Switch
                    checked={value.ligatures}
                    onChange={(ligatures) => onChange({ ...value, ligatures })}
                    labelledBy="ligatures-label"
                    describedBy="ligatures-description"
                  />
                </div>
                {transcripts && (
                  <div className={`preference-row ${settingRowClasses}`}>
                    <SettingText
                      id="transcripts-label"
                      label="Transcripts"
                      description={
                        transcripts.available
                          ? "Show recent output again after a restart. Saved encrypted on this computer."
                          : "Not available on this computer: recent output is saved only encrypted, and Novadeck can't keep a key safe here."
                      }
                      descriptionId="transcripts-description"
                    />
                    <Switch
                      checked={transcripts.available && transcripts.enabled}
                      onChange={transcripts.onChange}
                      labelledBy="transcripts-label"
                      describedBy="transcripts-description"
                      disabled={!transcripts.available}
                    />
                  </div>
                )}
                <div className={`preference-row ${settingRowClasses}`}>
                  <SettingText
                    id="notify-needs-label"
                    label="Notify when an agent needs you"
                    description={
                      notices
                        ? "A toast in the corner while you're in Novadeck, or a desktop notification while it's in the background, for a question, an approval or trouble that stopped an agent. Clicking either opens the Inbox."
                        : "A toast in the corner for a question, an approval or trouble that stopped an agent. Clicking it opens the Inbox."
                    }
                    descriptionId="notify-needs-description"
                  />
                  <Switch
                    checked={value.notifyNeeds}
                    onChange={(notifyNeeds) => onChange({ ...value, notifyNeeds })}
                    labelledBy="notify-needs-label"
                    describedBy="notify-needs-description"
                  />
                </div>
                <div className={`preference-row ${settingRowClasses}`}>
                  <SettingText
                    id="notify-finished-label"
                    label="Notify when an agent finishes"
                    description={
                      notices
                        ? "A desktop notification when an agent reports its task done (its subject) or a turn fails, while Novadeck is in the background."
                        : "Only in the desktop app."
                    }
                    descriptionId="notify-finished-description"
                  />
                  <Switch
                    checked={value.notifyFinished}
                    onChange={(notifyFinished) => onChange({ ...value, notifyFinished })}
                    labelledBy="notify-finished-label"
                    describedBy="notify-finished-description"
                    disabled={!notices}
                  />
                </div>
                {/* Only where Novadeck rings through desktop notifications. */}
                {notices && (
                  <>
                    <div className={`preference-row ${settingRowClasses}`}>
                      <SettingText
                        id="sound-label"
                        label="Play a sound"
                        description="Novadeck's own sound when an agent needs you or finishes, the same on every system. Holds off during Do Not Disturb where the system says so."
                        descriptionId="sound-description"
                      />
                      <Switch
                        checked={value.sound}
                        onChange={(sound) => onChange({ ...value, sound })}
                        labelledBy="sound-label"
                        describedBy="sound-description"
                      />
                    </div>
                    <div className={`preference-row ${settingRowClasses}`}>
                      {hostSounds ? (
                        <SettingText
                          id="sound-volume-label"
                          label="Volume"
                          description="For the sound inside Novadeck. Desktop notifications play at the system's alert volume."
                          descriptionId="sound-volume-description"
                        />
                      ) : (
                        <span id="sound-volume-label">Volume</span>
                      )}
                      <span className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={value.soundVolume}
                          onChange={(event) =>
                            onChange({ ...value, soundVolume: Number(event.target.value) })
                          }
                          aria-labelledby="sound-volume-label"
                          aria-valuetext={`${Math.round(value.soundVolume * 100)}%`}
                          {...(hostSounds
                            ? { "aria-describedby": "sound-volume-description" }
                            : {})}
                          disabled={!value.sound}
                          className="settings-range w-32 cursor-pointer disabled:cursor-not-allowed"
                        />
                        <button
                          type="button"
                          className="button min-h-8 shrink-0 px-3 text-control"
                          // Stays enabled with the sound off: hear it before turning it on.
                          onClick={() => hearSound?.(value.soundVolume)}
                        >
                          Hear it
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </div>
            </Section>
            {agents && (
              <Section title="Agents" description={agentsExplanation}>
                <AgentSwitches agents={agents.list} onChange={agents.onChange} />
              </Section>
            )}
          </TabPanel>
          {hasAddons && (
            <TabPanel value="addons" className={panelClasses}>
              <Section
                title="Voice input"
                description="Speak prompts into agent terminals. Speech is transcribed on this computer and never leaves it."
              >
                <VoiceInput
                  voice={voice}
                  open={open && tab === "addons"}
                  portalContainer={dialog}
                />
              </Section>
              <Section title={MURMUR_NAME} description={murmurDescription}>
                <MurmurAddon murmur={murmur} />
              </Section>
            </TabPanel>
          )}
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
                      className="settings-row flex min-h-10.5 items-center justify-between gap-4 px-4 py-2 text-body"
                    >
                      <dt className="m-0 min-w-0">{label}</dt>
                      <dd className="m-0 flex shrink-0 gap-1">
                        {display.map((key) => (
                          <kbd
                            key={key}
                            className="h-5.5 min-w-5.5 pt-0.5 text-caption leading-none"
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
          {hasAbout && (
            <TabPanel value="about" className={panelClasses}>
              {version && (
                <dl className={`${settingsCardClasses} m-0`}>
                  <div className={`preference-row ${settingRowClasses}`}>
                    <dt className="m-0">Version</dt>
                    <dd className="m-0 select-text">{versionText(version)}</dd>
                  </div>
                </dl>
              )}
              {experimental && (
                <Section title="Updates">
                  <div className={settingsCardClasses}>
                    <div className={`preference-row ${settingRowClasses}`}>
                      <SettingText
                        id="experimental-label"
                        label="Experimental"
                        description="Get new releases as soon as they're published, before they're promoted to stable, and try features that are still being built in the Experimental tab. Turning this off doesn't go back to an older version."
                        descriptionId="experimental-description"
                      />
                      <Switch
                        checked={experimental.on === true}
                        onChange={experimental.onChange}
                        labelledBy="experimental-label"
                        describedBy="experimental-description"
                        disabled={experimental.on === undefined}
                      />
                    </div>
                  </div>
                </Section>
              )}
              {(logs || uninstall) && (
                <div className="flex flex-col gap-2.5">
                  {logs && (
                    <div className={settingsCardClasses}>
                      <AddonRow
                        scope="about"
                        id="logs"
                        label="Logs"
                        description="What Novadeck recorded of its recent runs, without anything your terminals showed. Attach them to a bug report."
                      >
                        <button
                          type="button"
                          className="button min-h-8 shrink-0 px-3 text-control"
                          aria-describedby="about-logs-description"
                          onClick={logs}
                        >
                          Open logs folder
                        </button>
                      </AddonRow>
                    </div>
                  )}
                  {uninstall && <UninstallApp uninstall={uninstall} />}
                </div>
              )}
            </TabPanel>
          )}
          {hasExperimental && (
            <TabPanel value="experimental" className={panelClasses}>
              <div className={settingsCardClasses}>
                {experimentalToggles.map(
                  ({ id, label, description, checked, onToggle, disabled }) => (
                    <div key={id} className={`preference-row ${settingRowClasses}`}>
                      <SettingText
                        id={`${id}-label`}
                        label={label}
                        description={description}
                        descriptionId={`${id}-description`}
                      />
                      <Switch
                        checked={checked}
                        onChange={onToggle}
                        labelledBy={`${id}-label`}
                        describedBy={`${id}-description`}
                        disabled={disabled}
                      />
                    </div>
                  ),
                )}
              </div>
            </TabPanel>
          )}
        </div>
      </Tabs>
    </Dialog>
  )
}

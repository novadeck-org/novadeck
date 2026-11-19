import { MURMUR_NAME } from "@novadeck/core/addons/murmur"
import type { ForgeName } from "@novadeck/core/forges"
import type { AgentName } from "@novadeck/core/harnesses"
import type { NoticeSound } from "@novadeck/core/sounds"
import { viewModes } from "@novadeck/core/state"
import { screenReaderPreferences, type PreferencesValue } from "@novadeck/core/types"
import { Checkbox } from "@novadeck/toolkit/Checkbox"
import { Dialog } from "@novadeck/toolkit/Dialog"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import { Select } from "@novadeck/toolkit/Select"
import { Switch } from "@novadeck/toolkit/Switch"
import { Tabs, TabList, Tab, TabPanel } from "@novadeck/toolkit/Tabs"
import { views } from "@novadeck/toolkit/views"
import { MessagesSquare, SquareTerminal, X } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"

import { shortcutGroups } from "../interaction/keymap"
import { currentPlatform } from "../interaction/shortcuts"
import { soundChoiceOf, soundInEffect, soundName, sounds } from "../sounds"
import { themes, type ThemeEntry, type ThemeId } from "../theme/themes"
import { AddonRow } from "./addon-parts"
import { agentsExplanation, type AgentSwitch } from "./agent-switches"
import { AgentSwitches } from "./AgentSwitches"
import { forgesExplanation, type ForgeSwitch } from "./forge-switches"
import { ForgeSwitches } from "./ForgeSwitches"
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
// How long an idle agent runs before it is stopped, in minutes; null for never.
const idleChoices = [
  { label: "Off", value: "off" },
  { label: "15 minutes", value: "15" },
  { label: "30 minutes", value: "30" },
  { label: "1 hour", value: "60" },
  { label: "4 hours", value: "240" },
]

// How agents show: in the chat, or as the terminal.
const agentPresentations = [
  { chatView: true, label: "Chat", icon: MessagesSquare },
  { chatView: false, label: "Terminal", icon: SquareTerminal },
] as const

const fontSizes = [12, 13, 15].map((size) => ({ label: `${size}px`, value: String(size) }))

// Screen reader support's choices: Automatic only where the app can tell when one runs.
const screenReaderChoices = (known: boolean) => [
  ...(known
    ? [
        {
          label: "Automatic",
          value: "auto",
          description: "On while the system reports a screen reader",
        },
      ]
    : []),
  { label: "On", value: "on", description: "Terminals always keep text a reader can read" },
  { label: "Off", value: "off", description: "Terminals keep no text for a reader" },
]

// Section titles match the sidebar's panel titles.
const sectionTitleClasses = "section-label m-0 text-label font-medium"
// A group inside a section, as Layout's two sets of choices.
const groupTitleClasses = "text-body font-medium"
const sectionDescriptionClasses = "settings-description m-0 mt-1.5 text-control leading-5"
const panelClasses =
  "preferences-panel col-start-1 row-start-1 flex flex-col gap-6 px-6 py-5 data-[state=open]:visible data-[state=open]:opacity-100 data-[state=closed]:invisible data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 max-[480px]:px-4"

// The switch of an agent in the Agents section, or its Install where it isn't installed, where
// the page has it.
const agentSwitch = (agent: AgentName): HTMLElement | null =>
  document
    .getElementById(`agent-${agent}`)
    ?.closest("li")
    ?.querySelector<HTMLElement>("[role=switch], [data-agent-install]") ?? null

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

// Brings the open tab into view once the dialog's content is there, and when the tab changes:
// on a phone the list scrolls, and the tab a URL names may be out of sight. The dialog mounts
// its content only once it opens, so this stands inside it, not in the dialog's own component.
const TabInView = ({
  tab,
  within,
}: {
  tab: string
  within: RefObject<HTMLDivElement | null>
}): null => {
  useEffect(() => {
    within.current
      ?.querySelector<HTMLElement>(`[role="tab"][id$="-${tab}"]`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [tab, within])
  return null
}

// The list's value for a wait; none for one the list lacks.
const idleChoice = (minutes: number | null): string => {
  const value = minutes === null ? "off" : String(minutes)
  return idleChoices.some((choice) => choice.value === value) ? value : ""
}

export const Preferences = ({
  open,
  value,
  onChange,
  onClose,
  onExitComplete,
  tab,
  onTabChange,
  focusAgent = null,
  onFocusedAgent,
  transcripts,
  hibernation,
  tour = false,
  worktrees,
  forges,
  agents,
  voice,
  murmur,
  experimental,
  version,
  logs,
  uninstall,
  notices = false,
  screenReaderKnown = false,
  systemSounds = false,
  hearSound,
  chat = false,
}: {
  open: boolean
  // The tab to show; null for none named, which opens Agents where the backend has it, else General.
  tab: PreferencesTab | null
  onTabChange: (tab: PreferencesTab) => void
  // An agent whose switch to bring into view and focus once the dialog is open, where the
  // person came from a row that needs it connected; `onFocusedAgent` says it was done.
  focusAgent?: AgentName | null
  onFocusedAgent?: () => void
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
  // After how many idle minutes an agent is stopped, null for never; absent where the
  // backend stops none.
  hibernation?: {
    readonly minutes: number | null
    readonly onChange: (minutes: number | null) => void
  }
  // Whether the backend has a tour, which the Onboarding tour switch offers from the footer.
  tour?: boolean
  // Whether agents get git worktrees, an Experimental feature the backend keeps; absent
  // where the backend has none.
  worktrees?: {
    readonly enabled: boolean
    readonly onChange: (enabled: boolean) => void
  }
  // The forges whose pull requests the Worktrees panel shows, an Experimental feature the backend keeps;
  // absent where the backend has none.
  forges?: {
    readonly list: readonly ForgeSwitch[]
    readonly onChange: (forge: ForgeName, enabled: boolean) => void
    // Runs the installer of a forge's tool that isn't here; absent where none can run.
    readonly onInstall?: ((forge: ForgeName, command: string) => void) | undefined
    // The forges whose installer runs now.
    readonly installing?: ReadonlySet<ForgeName> | undefined
    // Runs a signed-out host's sign-in command in a terminal.
    readonly onSignIn?: ((forge: ForgeName, host: string, command: string) => void) | undefined
    // The hosts whose sign-in runs now, as `${forge}/${host}`.
    readonly signingIn?: ReadonlySet<string> | undefined
  }
  // Whether the page can show desktop notifications, as the desktop app can.
  notices?: boolean
  // Whether the app can tell when a screen reader runs, as the desktop app can: it offers
  // Automatic, which follows it, where a browser offers On and Off alone.
  screenReaderKnown?: boolean
  // Whether the system's notifications play the sound themselves, at the system's alert
  // volume, as on macOS.
  systemSounds?: boolean
  // Plays the notice sound at a volume, for the person to hear what they set.
  hearSound?: (volume: number, sound?: NoticeSound) => void
  // Whether the backend reads agents' conversations, which the chat view shows.
  chat?: boolean
  // Agents whose sessions resume once connected; absent where the backend has none.
  agents?: {
    readonly list: readonly AgentSwitch[]
    readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
    // Runs the installer of an agent that isn't here; absent where none can run.
    readonly onInstall?: ((agent: AgentSwitch["agent"], command: string) => void) | undefined
    // The agents whose installer runs now.
    readonly installing?: ReadonlySet<AgentSwitch["agent"]> | undefined
  }
  // Voice input, as the backend has it; absent where it has none.
  voice?: VoiceAddon
  // Murmur, as the backend has it; absent where it has none.
  murmur?: MurmurAddonValue
  // Whether the desktop app follows experimental builds, which also shows the Experimental tab;
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
  const hasAgents = agents !== undefined
  const focused = useRef(onFocusedAgent)
  useEffect(() => {
    focused.current = onFocusedAgent
  }, [onFocusedAgent])
  useEffect(() => {
    if (!open || !focusAgent) return undefined
    if (!hasAgents) {
      focused.current?.()
      return undefined
    }
    // The dialog's content mounts, and the dialog takes focus for itself, a moment after it
    // opens: take it from there once the switch is on the page, and again while it settles.
    let frame = 0
    let tries = 0
    let held = 0
    const focusSwitch = (): void => {
      const found = agentSwitch(focusAgent)
      if (!found) {
        if (++tries < 30) frame = requestAnimationFrame(focusSwitch)
        else focused.current?.()
        return
      }
      if (document.activeElement !== found) {
        found.scrollIntoView?.({ block: "center" })
        found.focus()
        held = 0
      } else held += 1
      if (held < 3) frame = requestAnimationFrame(focusSwitch)
      else focused.current?.()
    }
    frame = requestAnimationFrame(focusSwitch)
    return () => cancelAnimationFrame(frame)
  }, [open, focusAgent, hasAgents])
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
  // The Experimental tab is there only while its switch is on.
  const hasExperimental = experimental?.on === true
  // Agents holds the agents and when to stop the idle ones; a backend with neither, as the
  // website's demo, has no tab for them.
  const hasAgentsTab = hasAgents || hibernation !== undefined
  const hidden = (id: PreferencesTab): boolean =>
    (id === "agents" && !hasAgentsTab) ||
    (id === "addons" && !hasAddons) ||
    (id === "about" && !hasAbout) ||
    (id === "experimental" && !hasExperimental)
  // Where no tab is named, Agents opens where there is one, else General.
  const shown = tab === null ? (hasAgentsTab ? "agents" : "general") : hidden(tab) ? "general" : tab
  // The Experimental tab's switches, one row each.
  const experimentalToggles = [
    {
      id: "agent-avatars",
      label: "Agent avatars",
      description:
        "Show each terminal's critter from Messages in its tab and window header. On a zoomed-out Canvas, it grows so you can still tell windows apart.",
      checked: value.agentAvatars,
      onToggle: (agentAvatars: boolean) => onChange({ ...value, agentAvatars }),
      disabled: false,
    },
    {
      id: "fold-long-replies",
      label: "Fold long replies",
      description:
        "In Agent Chat, an agent's older long replies show their opening lines and a key for the rest. Its latest reply always shows in full.",
      checked: value.foldLongReplies,
      onToggle: (foldLongReplies: boolean) => onChange({ ...value, foldLongReplies }),
      disabled: false,
    },
    {
      id: "onboarding-tour",
      label: "Onboarding tour",
      description: tour
        ? "Add a Help menu to the footer that offers a short tour: your own agent, on its cheapest model, in a sandbox folder."
        : "Not available here.",
      checked: tour && value.onboardingTour,
      onToggle: (onboardingTour: boolean) => onChange({ ...value, onboardingTour }),
      disabled: !tour,
    },
    {
      id: "agent-worktrees",
      label: "Agent worktrees",
      description: worktrees
        ? "Agents work in their own git worktrees, and the sidebar gets a Worktrees panel that lists each one with what it changed since main. Novadeck cleans a worktree up once it's merged or its terminal is closed."
        : "Not available here.",
      checked: worktrees?.enabled ?? false,
      onToggle: (enabled: boolean) => worktrees?.onChange(enabled),
      disabled: !worktrees,
    },
  ]
  const lastView = value.enabledViews.length === 1
  const { appearance } = value
  const theme: ThemeEntry<ThemeId> =
    themes.find((entry) => entry.id === appearance.theme) ?? themes[0]
  // A theme drawn in one scheme leaves nothing to choose.
  const onlyScheme = theme.schemes.length === 1 ? theme.schemes[0] : undefined
  // The first sound is the theme's own, which the choice follows; the rest override it.
  const soundItems = [
    { label: `Theme's bell (${soundName(theme.sound)})`, value: "theme" },
    ...sounds.map(({ id, name }) => ({ label: name, value: id })),
  ]
  const { soundChoice } = value
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
      className="modal flex h-[min(640px,calc(100dvh-48px))] w-[min(640px,calc(100vw-32px))] flex-col overflow-clip max-[480px]:w-[calc(100vw-24px)]"
    >
      <Tabs value={shown} onValueChange={changeTab} className="flex min-h-0 flex-1 flex-col">
        <TabInView tab={shown} within={dialog} />
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
            // Whenever the tabs are wider than the dialog (a phone, a larger text size, another
            // tab), the list scrolls on its own, never the dialog. Scrolling clips what the
            // indicator's glow draws outside the list, so the list pads out by the glow and takes
            // the padding back in its margin (the top too, for the focus ring), and the indicator
            // keeps its place.
            className="preferences-tabs mt-1.5 -mx-2 -mb-2 flex gap-5 overflow-x-auto px-2 pt-1.5 pb-2 [scrollbar-width:none]"
            label="Preference sections"
            indicatorClassName="bottom-[calc(0.5rem-1px)] h-0.5"
          >
            {preferencesTabs
              .filter(({ id }) => !hidden(id))
              .map(({ id, label }) => (
                <Tab
                  key={id}
                  value={id}
                  className="relative min-h-9 shrink-0 px-0.5 text-left text-body"
                >
                  {label}
                </Tab>
              ))}
          </TabList>
        </div>
        <div ref={panels} className="preferences-panels grid min-h-0 flex-1 overflow-y-auto">
          <TabPanel value="agents" className={panelClasses}>
            {(agents || hibernation) && (
              <Section title="Agents" {...(agents ? { description: agentsExplanation } : {})}>
                {agents && (
                  <AgentSwitches
                    agents={agents.list}
                    onChange={agents.onChange}
                    onInstall={agents.onInstall}
                    installing={agents.installing}
                  />
                )}
                {hibernation && (
                  <div className={settingsCardClasses}>
                    <Select
                      className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-36`}
                      label="Stop idle agents after"
                      items={idleChoices}
                      // A saved wait the list doesn't have shows as it is, without being chosen.
                      value={idleChoice(hibernation.minutes)}
                      placeholder={`${hibernation.minutes} minutes`}
                      onValueChange={(choice) =>
                        hibernation.onChange(choice === "off" ? null : Number(choice))
                      }
                      open={open && shown === "agents" && openSelect === "idle-agents"}
                      onOpenChange={(expanded) => setOpenSelect(expanded ? "idle-agents" : null)}
                      portalContainer={dialog}
                    />
                  </div>
                )}
              </Section>
            )}
          </TabPanel>
          <TabPanel value="appearance" className={panelClasses}>
            <Section title="Theme">
              <div className={settingsCardClasses}>
                <Select
                  className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-52`}
                  label="Theme"
                  items={themeItems}
                  // A saved theme the app doesn't have shows as the one drawn, Coolant,
                  // without being chosen, so picking Coolant saves it.
                  value={theme.id === appearance.theme ? theme.id : ""}
                  placeholder={theme.name}
                  onValueChange={(id) => {
                    const chosen = themes.find((entry) => entry.id === id)
                    if (chosen)
                      onChange({ ...value, appearance: { ...appearance, theme: chosen.id } })
                  }}
                  open={open && shown === "appearance" && openSelect === "theme"}
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
            <Section title="Layout">
              <fieldset
                className="view-preferences settings-fieldset m-0 min-w-0 p-0"
                aria-describedby="view-modes-description"
              >
                <legend className="float-left mb-1.5 w-full p-0 px-0.5">
                  <span className={`block ${groupTitleClasses}`}>View modes</span>
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
              {/* Only where the backend reads agents' conversations. */}
              {chat && (
                <fieldset
                  className="agent-chat-preferences settings-fieldset m-0 mt-2.5 min-w-0 p-0"
                  aria-describedby="agent-chat-description"
                >
                  <legend className="float-left mb-1.5 w-full p-0 px-0.5">
                    <span className={`block ${groupTitleClasses}`}>Show agents as</span>
                  </legend>
                  <p
                    id="agent-chat-description"
                    className={`clear-both px-0.5 ${sectionDescriptionClasses}`}
                  >
                    Agent Chat: read and reply to agents in a chat instead of their terminal. When
                    the chat can't handle something, answer in the terminal.
                  </p>
                  <div className="mt-2.5 grid grid-cols-3 gap-2 max-[360px]:gap-1.5">
                    {agentPresentations.map(({ chatView, label, icon: Icon }) => {
                      const checked = value.chatView === chatView
                      return (
                        <label
                          key={label}
                          className="choice-card solid relative flex min-h-[76px] min-w-0 cursor-pointer flex-col justify-between gap-3 p-3 text-body"
                          data-state={checked ? "checked" : "unchecked"}
                        >
                          <Icon
                            aria-hidden="true"
                            className="shrink-0"
                            size={16}
                            strokeWidth={1.5}
                          />
                          <span>{label}</span>
                          {/* The checkbox's box, round (the toggle recipe), with a dot in place of its check. */}
                          <span className="checkbox absolute top-2.5 right-2.5 flex size-4 shrink-0 items-center justify-center">
                            <input
                              type="radio"
                              name="agent-presentation"
                              className="checkbox-input absolute inset-0 m-0 size-full cursor-pointer"
                              checked={checked}
                              onChange={() => onChange({ ...value, chatView })}
                            />
                            <span
                              aria-hidden="true"
                              className="checkbox-dot pointer-events-none relative"
                            />
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </fieldset>
              )}
            </Section>
            <Section title="Text">
              <div className={settingsCardClasses}>
                <Select
                  className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-36`}
                  label="Text size"
                  items={fontSizes}
                  value={String(value.fontSize)}
                  onValueChange={(size) => onChange({ ...value, fontSize: Number(size) })}
                  open={open && shown === "appearance" && openSelect === "font-size"}
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
                <Select
                  className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-36`}
                  label="Screen reader support"
                  items={screenReaderChoices(screenReaderKnown)}
                  // Where nothing can tell, Automatic keeps the text, as On does.
                  value={
                    value.screenReader === "auto" && !screenReaderKnown ? "on" : value.screenReader
                  }
                  onValueChange={(choice) =>
                    onChange({
                      ...value,
                      screenReader:
                        screenReaderPreferences.find((each) => each === choice) ??
                        value.screenReader,
                    })
                  }
                  open={open && shown === "appearance" && openSelect === "screen-reader"}
                  onOpenChange={(expanded) => setOpenSelect(expanded ? "screen-reader" : null)}
                  portalContainer={dialog}
                />
              </div>
            </Section>
          </TabPanel>
          <TabPanel value="general" className={panelClasses}>
            <Section title="Notifications">
              <div className={settingsCardClasses}>
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
              </div>
            </Section>
            {/* Only where Novadeck rings through desktop notifications. */}
            {notices && (
              <Section title="Bell">
                <div className={settingsCardClasses}>
                  <div className={`preference-row ${settingRowClasses}`}>
                    <SettingText
                      id="sound-label"
                      label="Ring the bell"
                      description="Novadeck rings when an agent needs you or finishes. Holds off during Do Not Disturb where the system says so."
                      descriptionId="sound-description"
                    />
                    <Switch
                      checked={value.sound}
                      onChange={(sound) => onChange({ ...value, sound })}
                      labelledBy="sound-label"
                      describedBy="sound-description"
                    />
                  </div>
                  {/* What it rings with and how loud matter only while it rings. */}
                  {value.sound && (
                    <>
                      <Select
                        className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-52`}
                        label="Sound"
                        items={soundItems}
                        value={soundChoice}
                        onValueChange={(next) => {
                          const chosen = { ...value, soundChoice: soundChoiceOf(next) }
                          onChange(chosen)
                          // Picking a sound plays it, as the system's own sound settings do.
                          hearSound?.(value.soundVolume, soundInEffect(chosen))
                        }}
                        open={open && shown === "general" && openSelect === "sound"}
                        onOpenChange={(expanded) => setOpenSelect(expanded ? "sound" : null)}
                        portalContainer={dialog}
                      />
                      <div className={`preference-row ${settingRowClasses}`}>
                        {systemSounds ? (
                          <SettingText
                            id="sound-volume-label"
                            label="Volume"
                            description="For the bell inside Novadeck. Desktop notifications play at the system's alert volume."
                            descriptionId="sound-volume-description"
                          />
                        ) : (
                          <span id="sound-volume-label">Volume</span>
                        )}
                        <span className="flex shrink-0 items-center gap-3">
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
                            {...(systemSounds
                              ? { "aria-describedby": "sound-volume-description" }
                              : {})}
                            className="settings-range w-32 cursor-pointer"
                          />
                          <button
                            type="button"
                            className="button min-h-8 shrink-0 px-3 text-control"
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
            )}
            {transcripts && (
              <Section title="Storage">
                <div className={settingsCardClasses}>
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
                </div>
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
              {forges && (
                <Section title="Forge integrations" description={forgesExplanation}>
                  <ForgeSwitches
                    forges={forges.list}
                    onChange={forges.onChange}
                    onInstall={forges.onInstall}
                    installing={forges.installing}
                    onSignIn={forges.onSignIn}
                    signingIn={forges.signingIn}
                  />
                </Section>
              )}
            </TabPanel>
          )}
        </div>
      </Tabs>
    </Dialog>
  )
}

import { MURMUR_NAME } from "@novadeck/core/addons/murmur"
import type { ForgeName } from "@novadeck/core/forges"
import type { AgentName } from "@novadeck/core/harnesses"
import type { AgentMode, BundledPiFetchState } from "@novadeck/core/port"
import type { NoticeSound } from "@novadeck/core/sounds"
import { viewModes } from "@novadeck/core/state"
import { appScales, screenReaderPreferences, type PreferencesValue } from "@novadeck/core/types"
import { Checkbox } from "@novadeck/toolkit/Checkbox"
import { Dialog } from "@novadeck/toolkit/Dialog"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import { Select } from "@novadeck/toolkit/Select"
import { Switch } from "@novadeck/toolkit/Switch"
import { Tabs, TabList, Tab, TabPanel } from "@novadeck/toolkit/Tabs"
import { views } from "@novadeck/toolkit/views"
import {
  Mic,
  MessagesSquare,
  Monitor,
  Moon,
  Search,
  SquareTerminal,
  Sun,
  Tag,
  X,
} from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react"

import { shortcutGroups } from "../interaction/keymap"
import { currentPlatform } from "../interaction/shortcuts"
import { soundChoiceOf, soundInEffect, soundName, sounds } from "../sounds"
import { themes, type ThemeEntry, type ThemeId } from "../theme/themes"
import { AddonRow } from "./addon-parts"
import { agentsExplanation, type AgentSwitch } from "./agent-switches"
import { AgentModePicker } from "./AgentModePicker"
import { AgentSwitches } from "./AgentSwitches"
import {
  bundledPiDescription,
  bundledPiLabel,
  bundledPiNote,
  type BundledPiNote,
} from "./bundled-pi"
import { builtInFont, fontChoices, isBundled } from "./font-choices"
import { forgesExplanation, type ForgeRow } from "./forge-rows"
import { ForgeRows } from "./ForgeRows"
import { murmurDescription } from "./murmur-addon"
import { MurmurAddon, type MurmurAddonValue } from "./MurmurAddon"
import { matchRows, rowsOf, type PreferenceRow } from "./preferences-search"
import {
  fallbackTab,
  fontSizeRange,
  preferencesTabs,
  settingRowClasses,
  settingsCardClasses,
  versionText,
  type PreferencesTab,
} from "./settings"
import { NoticePreview, TerminalSample } from "./SettingsSamples"
import { useThemeMonoFamily } from "./theme-font"
import { UninstallApp, type UninstallValue } from "./UninstallApp"
import { useInstalledFonts } from "./useInstalledFonts"
import { VoiceInput, type VoiceAddon } from "./VoiceInput"

const themeItems = themes.map(({ id, name }) => ({ label: name, value: id }))
// As the welcome dialog offers them.
const schemeItems = [
  { label: "System", value: "system", icon: <Monitor size={13} aria-hidden="true" /> },
  { label: "Light", value: "light", icon: <Sun size={13} aria-hidden="true" /> },
  { label: "Dark", value: "dark", icon: <Moon size={13} aria-hidden="true" /> },
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

const scaleItems = appScales.map((scale) => ({ label: `${scale}%`, value: String(scale) }))

// Screen reader support's choices: Automatic only where the app can tell when one runs. Plain
// words, as the menu is as wide as its button; the row's description says what they do.
const screenReaderChoices = (known: boolean) => [
  ...(known ? [{ label: "Automatic", value: "auto" }] : []),
  { label: "On", value: "on" },
  { label: "Off", value: "off" },
]

const screenReaderExplanation = (known: boolean): string =>
  "Lets a screen reader read the terminal you're in. Terminals draw a little slower." +
  (known ? " Automatic follows your system." : "")

// Section titles match the sidebar's panel titles.
const sectionTitleClasses = "section-label m-0 text-label font-medium"
// A group inside a section, as Layout's two sets of choices.
const groupTitleClasses = "text-body font-medium"
const sectionDescriptionClasses = "settings-description m-0 mt-1.5 text-control leading-5"
const panelClasses =
  "preferences-panel col-start-1 row-start-1 flex flex-col gap-7 px-8 py-6 data-[state=open]:visible data-[state=open]:opacity-100 data-[state=closed]:invisible data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 max-[640px]:px-4 max-[640px]:py-5"

// A page's name in the menu, by its id.
const pageLabel = (id: string): string | undefined =>
  preferencesTabs.find((page) => page.id === id)?.label

// A setting search found: its row, on its page.
type Found = PreferenceRow<{ readonly page: string; readonly row: HTMLElement }>
// What takes focus in a row search jumps to: its control.
const rowControls = '[role="switch"], [role="combobox"], [role="radio"], input, button'
// Where a key types: `/` searches anywhere else.
const typingFields =
  'input:not([type="range"]):not([type="radio"]):not([type="checkbox"]):not([type="button"]), textarea, select, [contenteditable="true"]'
// How long a row search jumped to stays tinted, in milliseconds (settings.css's animation).
const foundFor = 1600

// One Experimental switch: the page its feature is on, and whether the switch stands on that
// page too (`onPage`), or only the feature it turns on does.
type ExperimentalToggle = {
  readonly id: string
  readonly page: PreferencesTab
  readonly onPage: boolean
  readonly label: string
  readonly description: string
  readonly checked: boolean
  readonly onToggle: (on: boolean) => void
  readonly disabled: boolean
  readonly hidden?: boolean
  readonly note?: BundledPiNote | undefined
  readonly retry?: () => void
}

// The window width at which the menu turns from a column into a row above the page (the
// `max-[640px]` classes below), where its arrow keys turn with it.
const narrowQuery = "(max-width: 640px)"
const subscribeNarrow = (changed: () => void): (() => void) => {
  if (typeof matchMedia !== "function") return () => {}
  const query = matchMedia(narrowQuery)
  query.addEventListener("change", changed)
  return () => query.removeEventListener("change", changed)
}
const isNarrow = (): boolean => typeof matchMedia === "function" && matchMedia(narrowQuery).matches
const useNarrow = (): boolean => useSyncExternalStore(subscribeNarrow, isNarrow, () => false)

// The tint each row search jumped to fades on, so a second jump to it starts afresh.
const fading = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()
const tint = (row: HTMLElement): void => {
  clearTimeout(fading.get(row))
  delete row.dataset.found
  // A reflow between, so the animation plays again on a row that still had it.
  void row.offsetWidth
  row.dataset.found = ""
  fading.set(
    row,
    setTimeout(() => delete row.dataset.found, foundFor),
  )
}

// Every page shows, where nothing says otherwise.
const everyPage = (): boolean => true

// Marks what is still being built, beside its name or its section's title.
const ExperimentalBadge = (): React.JSX.Element => (
  <span className="badge settings-badge shrink-0 px-1.5 text-[10px] leading-4 font-normal">
    Experimental
  </span>
)

// Experimental switches, a row each, in a card of their own or, `bare`, in the card a page
// gives them. On their own page each is badged; on the Experimental page (`onGoTo`) each says
// the page it is on, and goes there. `scope` keeps the two pages' ids apart. Search finds a
// switch on its own page where it stands there too, and on the Experimental page where not.
const ExperimentalRows = ({
  toggles,
  scope = "",
  bare = false,
  onGoTo,
  shows = everyPage,
}: {
  readonly toggles: readonly ExperimentalToggle[]
  readonly scope?: string
  readonly bare?: boolean
  // Goes to a toggle's page, where `shows` says Preferences has it.
  readonly onGoTo?: ((page: PreferencesTab, id: string) => void) | undefined
  readonly shows?: (page: PreferencesTab) => boolean
}): React.JSX.Element | null => {
  if (toggles.length === 0) return null
  const rows = toggles.map(
    ({ id: name, page, onPage, label, description, checked, onToggle, disabled, note, retry }) => {
      // Only a switch that stands on two pages needs its ids kept apart.
      const id = onGoTo && !onPage ? name : `${scope}${name}`
      const twice = onGoTo !== undefined && onPage && shows(page)
      return (
        <div
          key={id}
          className={`preference-row ${settingRowClasses}`}
          {...(twice ? { "data-search-skip": "" } : {})}
        >
          <span className="flex min-w-0 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span id={`${id}-label`}>{label}</span>
              {!onGoTo && <ExperimentalBadge />}
            </span>
            <span id={`${id}-description`} className="settings-description text-control leading-5">
              {description}
            </span>
            {note && (
              <span
                className="settings-note flex flex-wrap items-center gap-x-2 gap-y-1 text-control leading-5"
                data-experimental-note={name}
                // A failure is said at once; progress as the person pauses.
                {...(note.error ? { "data-tone": "danger", role: "alert" } : { role: "status" })}
              >
                <span id={`${id}-note`}>{note.text}</span>
                {note.error && (
                  <button
                    type="button"
                    className="button min-h-7 px-2.5 text-control"
                    aria-label={`Try again: ${label}`}
                    onClick={retry}
                  >
                    Try again
                  </button>
                )}
              </span>
            )}
            {onGoTo && shows(page) && (
              <button
                type="button"
                className="button link addon-action w-fit text-control"
                onClick={() => onGoTo(page, onPage ? name : "")}
              >
                On {pageLabel(page)}
              </button>
            )}
          </span>
          <Switch
            checked={checked}
            onChange={onToggle}
            labelledBy={`${id}-label`}
            describedBy={note ? `${id}-description ${id}-note` : `${id}-description`}
            disabled={disabled}
          />
        </div>
      )
    },
  )
  return bare ? <>{rows}</> : <div className={settingsCardClasses}>{rows}</div>
}

// The switch of an agent in the Agents section, or its Install where it isn't installed, where
// the page has it.
const agentSwitch = (agent: AgentName): HTMLElement | null =>
  document
    .getElementById(`agent-${agent}`)
    ?.closest("li")
    ?.querySelector<HTMLElement>("[role=switch], [data-agent-install]") ?? null

// A group of settings, titled where `title` is given; the title names the region unless a
// label is given, which a group the page's own title already names has in place of one.
const Section = ({
  title,
  badge,
  description,
  label,
  icon,
  children,
}: {
  title?: string
  badge?: ReactNode
  description?: ReactNode
  label?: string
  // A mark in a tile beside the title, as an addon's.
  icon?: ReactNode
  children: ReactNode
}): React.JSX.Element => {
  const id = title && `preferences-${title.toLowerCase().replaceAll(" ", "-")}`
  return (
    <section
      className="flex flex-col gap-2.5"
      {...(label || !id ? { "aria-label": label } : { "aria-labelledby": id })}
    >
      {(title || description) && (
        <header className="flex items-center gap-3 px-0.5">
          {icon && (
            <span
              className="choice-card-tile flex size-9 flex-none items-center justify-center"
              aria-hidden="true"
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            {title && (
              // The badge stands beside the title, out of the name it gives the section.
              <div className="flex items-center gap-2">
                <h3 id={id} className={sectionTitleClasses}>
                  {title}
                </h3>
                {badge}
              </div>
            )}
            {description && <p className={sectionDescriptionClasses}>{description}</p>}
          </div>
        </header>
      )}
      {children}
    </section>
  )
}

// A setting's description, under its name.
const descriptionClasses = "settings-description text-control leading-5"

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

// How many taps on the version show the Experimental switch while it's off, as Android's build
// number does for its developer options, and from how many left the row counts them down.
const revealTaps = 10
const revealCountdown = 5

// The About page's version. Where `onReveal` is given, the Experimental switch is hidden: tapping
// the version ten times shows it, counting the last taps down beside the label. The count starts
// over each time the tab opens.
const VersionRow = ({
  version,
  onReveal,
}: {
  version: string
  onReveal: (() => void) | undefined
}): React.JSX.Element => {
  const [taps, setTaps] = useState(0)
  const left = revealTaps - taps
  const tap = (): void => {
    if (!onReveal) return
    if (left <= 1) {
      setTaps(0)
      onReveal()
    } else setTaps(taps + 1)
  }
  return (
    // The row itself is the list, so the card's hairline runs between it and the row after.
    <dl className={`preference-row ${settingRowClasses} m-0`}>
      <dt className="m-0 flex min-w-0 flex-col">
        <span>Version</span>
        <span role="status" className="settings-description text-control leading-5 not-empty:mt-1">
          {onReveal && left <= revealCountdown
            ? `Tap ${left === 1 ? "once more" : `${left} more times`} to show Experimental`
            : ""}
        </span>
      </dt>
      {/* A hidden gesture, as Android's: the switch it shows is no secret, only out of the
            way, so the version stays plain, selectable text. */}
      <dd className="m-0 select-text" onClick={tap}>
        {versionText(version)}
      </dd>
    </dl>
  )
}

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
  agentModes,
  agentMode,
  shippingGate,
  bundledPi,
  murmurSwitch,
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
  scalable = false,
  systemSounds = false,
  hearSound,
  chat = false,
  askToast,
}: {
  open: boolean
  // The page to show; null for none named, which opens Agents where the backend has it, else
  // Appearance.
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
  // Whether Solo and Swarm may be picked, an Experimental feature the backend keeps; absent
  // where it has none. The picker below shows only while it is on.
  agentModes?: {
    readonly enabled: boolean
    readonly onChange: (enabled: boolean) => void
  }
  // How agents work with each other; absent where the backend has no such setting.
  agentMode?: {
    readonly mode: AgentMode
    readonly onChange: (mode: AgentMode) => void
  }
  // Whether the shipping gate is on, an Experimental feature the backend keeps; absent where it
  // has none.
  shippingGate?: {
    readonly enabled: boolean
    readonly onChange: (enabled: boolean) => void
  }
  // Whether Novadeck's own pi is on, an Experimental feature the backend keeps, and where its
  // download stands; absent where it has none, as a runner from before it.
  bundledPi?: {
    readonly enabled: boolean
    readonly fetch: BundledPiFetchState
    readonly onChange: (enabled: boolean) => void
  }
  // Whether Murmur shows and may run, an Experimental feature the backend keeps; absent where it
  // has no Murmur or no switch for it, as a runner from before it.
  murmurSwitch?: {
    readonly enabled: boolean
    readonly onChange: (enabled: boolean) => void
  }
  // Whether the backend has a tour, which the Onboarding tour switch offers from the footer.
  tour?: boolean
  // Whether agents get git worktrees, on unless the person turns it off; absent where the
  // backend has none.
  worktrees?: {
    readonly enabled: boolean
    readonly onChange: (enabled: boolean) => void
  }
  // The forges whose pull requests the Worktrees panel shows, every one on; absent where the
  // backend has none.
  forges?: {
    readonly list: readonly ForgeRow[]
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
  // Whether the app can scale its windows, as the desktop app can; a browser has its own zoom.
  scalable?: boolean
  // Whether the system's notifications play the sound themselves, at the system's alert
  // volume, as on macOS.
  systemSounds?: boolean
  // Plays the notice sound at a volume, for the person to hear what they set.
  hearSound?: (volume: number, sound?: NoticeSound) => void
  // Whether the backend reads agents' conversations, which the chat view shows.
  chat?: boolean
  // The Inbox's toast for an agent's ask, which Notifications shows above its switches.
  askToast?: ReactNode
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
  // absent where it doesn't offer the choice. `on` is undefined until the app has said. While
  // off, the switch shows only once `revealed`, which tapping the version ten times asks for.
  experimental?: {
    readonly on: boolean | undefined
    readonly onChange: (on: boolean) => void
    readonly revealed: boolean
    readonly onReveal: () => void
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
  const narrow = useNarrow()
  const searchField = useRef<HTMLInputElement>(null)
  const [openSelect, setOpenSelect] = useState<string | null>(null)
  // What the person searches for, and the rows that match it, read from the pages as typed.
  const [query, setQuery] = useState("")
  const [found, setFound] = useState<readonly Found[]>([])
  const changeTab = (next: string): void => {
    const chosen = preferencesTabs.find(({ id }) => id === next)
    if (!chosen) return
    onTabChange(chosen.id)
    setOpenSelect(null)
    if (panels.current) panels.current.scrollTop = 0
  }
  const search = (text: string): void => {
    setQuery(text)
    setFound(panels.current ? matchRows(text, rowsOf(panels.current, pageLabel)) : [])
  }
  // Opens the page a match is on and brings its row into view, tinted a moment, with its
  // control focused where it has one.
  const jump = ({ target }: Found): void => {
    // Focus waits in the field while the results go, so it never falls out of the dialog.
    searchField.current?.focus({ preventScroll: true })
    search("")
    changeTab(target.page)
    requestAnimationFrame(() => {
      const { row } = target
      row.scrollIntoView?.({ block: "center" })
      // A row with no control, as a shortcut's, leaves focus on its page.
      const control =
        row.querySelector<HTMLElement>(rowControls) ?? row.closest<HTMLElement>('[role="tabpanel"]')
      control?.focus({ preventScroll: true })
      tint(row)
    })
  }
  // Goes from the Experimental page to a switch's own page, focused on the switch where it stands
  // there (`id`), else on the page, so focus never stays on the page left behind.
  const goTo = (page: PreferencesTab, id: string): void => {
    // The page's tab holds focus while the pages turn.
    panels.current
      ?.closest('[role="dialog"]')
      ?.querySelector<HTMLElement>(`[role="tab"][data-value="${page}"]`)
      ?.focus({ preventScroll: true })
    changeTab(page)
    requestAnimationFrame(() => {
      const panel = panels.current?.querySelector<HTMLElement>(
        `[role="tabpanel"][id$="content-${page}"]`,
      )
      const row = id
        ? document.getElementById(`${id}-label`)?.closest<HTMLElement>(".settings-row")
        : null
      row?.scrollIntoView?.({ block: "center" })
      const control = row?.querySelector<HTMLElement>(rowControls) ?? panel
      control?.focus({ preventScroll: true })
      if (row) tint(row)
    })
  }
  // `/` searches, as in the app's lists, unless the person is typing. Escape takes a search away
  // first, before it closes Preferences (the dialog's onEscapeKeyDown).
  const searching = query.trim() !== ""
  const searchingNow = useRef(searching)
  useEffect(() => {
    searchingNow.current = searching
  }, [searching])
  // A setting changed while the results show can add or take away rows (Ring the bell's off
  // takes Volume away), so the results are read again as the pages change.
  useEffect(() => {
    const root = panels.current
    if (!searching || !root) return undefined
    const observer = new MutationObserver(() => {
      setFound(matchRows(query, rowsOf(root, pageLabel)))
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [searching, query])
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest(typingFields)) return
      event.preventDefault()
      searchField.current?.focus()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])
  // The Addons are voice input and murmur; a backend with neither, as the website's demo,
  // has no page for them, though a URL can still name it.
  const hasAddons = voice !== undefined || murmur !== undefined
  // About is the app itself: its version, updates, logs and removal; a backend with none of
  // them has no page for it.
  const hasAbout = version !== undefined || experimental !== undefined || !!logs || !!uninstall
  // The Experimental page, and every Experimental row on the other pages, are there only while
  // its switch is on.
  const hasExperimental = experimental?.on === true
  // The switch itself shows while on, and while off once revealed in this run.
  const showExperimentalSwitch =
    experimental !== undefined && (hasExperimental || experimental.revealed)
  // The mode picker is an Experimental feature: it shows only with its switch on, and only where
  // the Experimental page is there to turn it off.
  const showAgentMode = agentMode !== undefined && agentModes?.enabled === true && hasExperimental
  // Agents holds the agents, how they run, their pull requests and their Experimental features;
  // a backend with none of them, as the website's demo, has no page for it. Shipping gate stands
  // there whenever Experimental is on, offered or not, as it always stood in the Experimental list.
  const hasAgentExperiments = hasExperimental
  // The forges' rows say how the Worktrees panel reads pull requests, so they go with it.
  const showForges = forges !== undefined && worktrees?.enabled !== false
  const hasAgentsTab =
    hasAgents ||
    hibernation !== undefined ||
    worktrees !== undefined ||
    showForges ||
    showAgentMode ||
    hasAgentExperiments
  const hidden = (id: PreferencesTab): boolean =>
    (id === "agents" && !hasAgentsTab) ||
    (id === "addons" && !hasAddons) ||
    (id === "about" && !hasAbout) ||
    (id === "experimental" && !hasExperimental)
  // Where no page is named, Agents opens where there is one, else Appearance.
  const shown =
    tab === null ? (hasAgentsTab ? "agents" : fallbackTab) : hidden(tab) ? fallbackTab : tab
  const { fonts: installed } = useInstalledFonts(open && shown === "terminal")
  const themeFamily = useThemeMonoFamily()
  const terminalFonts = fontChoices(installed, value.fontFamily ?? "", themeFamily)
  // Terminals join ligatures only in the bundled font, which they draw where it is the default
  // (the standard themes) or the choice.
  const terminalFamily =
    terminalFonts.value === builtInFont ? themeFamily || "JetBrains Mono" : terminalFonts.value
  const terminalLigatures = isBundled(terminalFamily)
  // Every Experimental switch, each with the page its feature is on. `onPage` rows also stand on
  // that page, badged; the others' page shows what they turn on (the mode picker, Murmur), and
  // the Experimental page lists them all.
  const experimentalToggles: readonly ExperimentalToggle[] = [
    {
      id: "agent-avatars",
      page: "appearance",
      onPage: true,
      label: "Agent avatars",
      description:
        "Show each terminal's critter from Messages in its tab and window header. On a zoomed-out Canvas, it grows so you can still tell windows apart.",
      checked: value.agentAvatars,
      onToggle: (agentAvatars: boolean) => onChange({ ...value, agentAvatars }),
      disabled: false,
    },
    {
      id: "onboarding-tour",
      page: "about",
      onPage: true,
      label: "Onboarding tour",
      description: tour
        ? "A Help menu in the footer that offers a short tour: three Pi agents in a sandbox repo, on a model Novadeck pays for."
        : "Not available here.",
      checked: tour && value.onboardingTour,
      onToggle: (onboardingTour: boolean) => onChange({ ...value, onboardingTour }),
      disabled: !tour,
    },
    {
      id: "agent-modes",
      page: "agents",
      onPage: false,
      label: "Agent modes",
      description: agentModes
        ? "Pick how agents work together, on the Agents page: Solo for one or two agents you steer yourself, Herd for several side by side, Swarm for a big goal split across agents. While this is off, agents work as Herd."
        : "Not available here.",
      checked: agentModes?.enabled ?? false,
      onToggle: (enabled: boolean) => agentModes?.onChange(enabled),
      disabled: !agentModes,
    },
    {
      id: "shipping-gate",
      page: "agents",
      onPage: true,
      label: "Shipping gate",
      description: shippingGate
        ? "Claude Code, Codex, Antigravity, OpenCode and Pi need your OK to push to a branch that isn't theirs, land into another branch, open a PR or merge: your own words in their terminal, or Allow on the card in the chat or the Inbox. Without it they're stopped and told to ask. Applies to agents started after you turn it on. Antigravity and OpenCode skip it when told to skip all permissions, and Antigravity in Windows' cmd asks you as before."
        : "Not available here.",
      checked: shippingGate?.enabled ?? false,
      onToggle: (enabled: boolean) => shippingGate?.onChange(enabled),
      disabled: !shippingGate,
    },
    {
      id: "bundled-pi",
      page: "agents",
      onPage: true,
      label: bundledPiLabel,
      description: bundledPiDescription,
      checked: bundledPi?.enabled ?? false,
      onToggle: (enabled: boolean) => bundledPi?.onChange(enabled),
      disabled: !bundledPi,
      // Only where the runner has it: one from before it (revision 16) never offers the row.
      hidden: !bundledPi,
      note: bundledPi && bundledPiNote(bundledPi.enabled, bundledPi.fetch),
      // Switched on again, a failed download is tried again.
      retry: () => bundledPi?.onChange(true),
    },
    {
      id: "murmur",
      page: "addons",
      onPage: false,
      label: MURMUR_NAME,
      description: `Name terminals with a small model that runs on this computer's graphics, over the agents' own titles. Adds ${MURMUR_NAME} to the Addons page, to install from there. While off, nothing is named or downloaded, and an install stays on disk.`,
      checked: murmurSwitch?.enabled ?? false,
      onToggle: (enabled: boolean) => murmurSwitch?.onChange(enabled),
      disabled: !murmurSwitch,
      // Only where the backend has Murmur and a runner with its switch (revision 20).
      hidden: !murmurSwitch,
    },
  ]
  const toggles = experimentalToggles.filter((toggle) => !toggle.hidden)
  // A page's own Experimental rows, while Experimental is on.
  const pageToggles = (page: PreferencesTab, ids?: readonly string[]): ExperimentalToggle[] =>
    hasExperimental
      ? toggles.filter(
          (toggle) => toggle.page === page && toggle.onPage && (!ids || ids.includes(toggle.id)),
        )
      : []
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
  // The shipping gate goes with the worktrees and pull requests it guards.
  const gitToggles = pageToggles("agents", ["shipping-gate"])
  const agentsRunning = hibernation !== undefined || showAgentMode
  const agentsGit = worktrees !== undefined || showForges || gitToggles.length > 0
  const pageTitle = pageLabel(shown) ?? ""
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
        setQuery("")
        setFound([])
        onExitComplete?.()
      }}
      contentRef={dialog}
      label="Preferences"
      // It opens on the open page's tab, where the arrow keys move between pages and `/` searches.
      initialFocusEl={() =>
        dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null
      }
      onEscapeKeyDown={(event) => {
        if (!searchingNow.current) return
        event.preventDefault()
        search("")
      }}
      backdropClassName="overlay fixed inset-0 z-50"
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center"
      className="modal flex h-[min(800px,calc(100dvh-64px))] w-[min(1080px,calc(100vw-64px))] flex-col overflow-clip max-[640px]:h-[calc(100dvh-24px)] max-[640px]:w-[calc(100vw-24px)]"
    >
      <Tabs
        value={shown}
        onValueChange={changeTab}
        orientation={narrow ? "horizontal" : "vertical"}
        className="grid min-h-0 flex-1 grid-cols-[232px_minmax(0,1fr)] max-[640px]:flex max-[640px]:flex-col"
      >
        <TabInView tab={shown} within={dialog} />
        <div className="preferences-nav flex min-h-0 flex-col gap-3 pt-5 max-[640px]:gap-2 max-[640px]:pt-4">
          <h2
            id="preferences-title"
            className="modal-title m-0 px-5 text-title font-medium max-[640px]:px-4"
          >
            Preferences
          </h2>
          <label className="field preferences-search mx-3 flex min-h-8 items-center gap-2 px-2.5 text-control">
            <Search aria-hidden="true" size={14} className="settings-description shrink-0" />
            <input
              ref={searchField}
              type="search"
              className="min-w-0 flex-1"
              placeholder="Search"
              aria-label="Search preferences"
              value={query}
              onChange={(event) => search(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && found[0]) {
                  event.preventDefault()
                  jump(found[0])
                }
              }}
            />
            {!query && (
              <kbd aria-hidden="true" className="h-5 min-w-5 pt-0.5 text-caption leading-none">
                /
              </kbd>
            )}
          </label>
          {query.trim() && (
            <div
              className="preferences-results flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3"
              role="group"
              aria-label="Search results"
            >
              {found.length === 0 ? (
                <p
                  className="settings-description m-0 px-2 py-1.5 text-control leading-5"
                  role="status"
                >
                  Nothing matches “{query.trim()}”.
                </p>
              ) : (
                found.map((match) => (
                  <button
                    key={`${match.target.page}\n${match.section}\n${match.label}`}
                    type="button"
                    className="tab preferences-result flex min-h-11 flex-col items-start justify-center px-2 py-1 text-left text-body"
                    onClick={() => jump(match)}
                  >
                    <span>{match.label}</span>
                    <span className="settings-description text-caption leading-4">
                      {match.section && match.section !== match.label
                        ? `${match.page} · ${match.section}`
                        : match.page}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          <div
            className="flex min-h-0 flex-1 flex-col max-[640px]:flex-none"
            hidden={query.trim() !== ""}
          >
            <TabList
              // A menu down the dialog's side: the open page's mark stands on the divider, as the
              // tab bar's line stood under it. On a phone it turns into a row that scrolls.
              // It pads out by the focus ring, which its scrolling would clip.
              className="preferences-tabs flex min-h-0 flex-1 flex-col overflow-y-auto pt-1 pr-1 pb-3 pl-3 [scrollbar-width:none] max-[640px]:flex-row max-[640px]:gap-4 max-[640px]:overflow-x-auto max-[640px]:px-4 max-[640px]:pb-2"
              label="Preference sections"
              indicatorClassName="right-0 h-(--height) w-0.5 max-[640px]:right-auto max-[640px]:bottom-0 max-[640px]:h-0.5 max-[640px]:w-(--width)"
            >
              {preferencesTabs
                .filter(({ id }) => !hidden(id))
                .map(({ id, label }) => (
                  <Tab
                    key={id}
                    value={id}
                    className={`relative flex min-h-9 shrink-0 items-center px-2 text-left text-body ${id === "about" ? "mt-auto max-[640px]:mt-0" : ""}`}
                  >
                    {label}
                  </Tab>
                ))}
            </TabList>
          </div>
        </div>
        <div className="preferences-main flex min-h-0 min-w-0 flex-col max-[640px]:flex-1">
          <div className="modal-header preferences-heading flex shrink-0 items-start justify-between gap-4 px-8 pt-5 pb-4 max-[640px]:px-4">
            <div className="min-w-0">
              <h2 className="m-0 text-title font-medium">{pageTitle}</h2>
              {shown === "experimental" && (
                <p className={sectionDescriptionClasses}>
                  Features still being built, each with the page where you'll find it.
                </p>
              )}
            </div>
            <button
              className="icon-button -mt-1 -mr-2 size-8 shrink-0"
              aria-label="Close preferences"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
          <div ref={panels} className="preferences-panels grid min-h-0 flex-1 overflow-y-auto">
            <TabPanel value="agents" className={panelClasses}>
              {(agents || pageToggles("agents", ["bundled-pi"]).length > 0) && (
                <Section
                  title="Connected agents"
                  {...(agents ? { description: agentsExplanation } : {})}
                >
                  {agents && (
                    <AgentSwitches
                      agents={agents.list}
                      onChange={agents.onChange}
                      onInstall={agents.onInstall}
                      installing={agents.installing}
                    />
                  )}
                  <ExperimentalRows toggles={pageToggles("agents", ["bundled-pi"])} />
                </Section>
              )}
              {agentsRunning && (
                <Section title="Running">
                  {showAgentMode && (
                    <AgentModePicker
                      mode={agentMode.mode}
                      onChange={agentMode.onChange}
                      badge={<ExperimentalBadge />}
                    />
                  )}
                  {hibernation && (
                    <div className={settingsCardClasses}>
                      <Select
                        className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-36`}
                        label="Stop idle agents after"
                        description="An agent with nothing to do stops after this long. A message wakes it again."
                        descriptionClassName={descriptionClasses}
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
              {agentsGit && (
                // Where agents' work goes: their worktrees, what they may push, and the pull
                // requests the Worktrees panel reads.
                <Section title="Worktrees and pull requests">
                  {(worktrees || gitToggles.length > 0) && (
                    <div className={settingsCardClasses}>
                      {/* On for everyone: a way out for whoever keeps worktrees with a tool of
                          their own. */}
                      {worktrees && (
                        <div className={`preference-row ${settingRowClasses}`}>
                          <SettingText
                            id="agent-worktrees-label"
                            label="Agent worktrees"
                            description="Each agent works in a git worktree of its own, shown in the Worktrees panel and cleaned up once merged. Turn off only if another tool manages your worktrees: agents then work in your checkout."
                            descriptionId="agent-worktrees-description"
                          />
                          <Switch
                            checked={worktrees.enabled}
                            onChange={worktrees.onChange}
                            labelledBy="agent-worktrees-label"
                            describedBy="agent-worktrees-description"
                          />
                        </div>
                      )}
                      <ExperimentalRows toggles={gitToggles} bare />
                    </div>
                  )}
                  {showForges && (
                    <>
                      <p className={`px-0.5 ${sectionDescriptionClasses}`}>{forgesExplanation}</p>
                      <ForgeRows
                        forges={forges.list}
                        onInstall={forges.onInstall}
                        installing={forges.installing}
                        onSignIn={forges.onSignIn}
                        signingIn={forges.signingIn}
                      />
                    </>
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
                      itemClassName="flex h-7 min-w-14 items-center justify-center gap-1.5 px-2.5 text-control data-disabled:cursor-not-allowed"
                      indicatorClassName="absolute"
                    />
                  </fieldset>
                </div>
              </Section>
              <Section title="Layout">
                <fieldset
                  className="view-preferences settings-fieldset m-0 flex min-w-0 flex-col p-0"
                  aria-describedby="view-modes-description"
                >
                  <legend className="w-full p-0 px-0.5">
                    <span className={`block ${groupTitleClasses}`}>View modes</span>
                  </legend>
                  <p
                    id="view-modes-description"
                    className={`mt-1.5 px-0.5 ${sectionDescriptionClasses}`}
                  >
                    The layouts you switch between in the header. Keep at least one; with one, the
                    header has no switch.
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
                          <Icon
                            aria-hidden="true"
                            className="shrink-0"
                            size={16}
                            strokeWidth={1.5}
                          />
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
                    className="agent-chat-preferences settings-fieldset m-0 mt-2.5 flex min-w-0 flex-col p-0"
                    aria-describedby="agent-chat-description"
                  >
                    <legend className="w-full p-0 px-0.5">
                      <span className={`block ${groupTitleClasses}`}>Show agents as</span>
                    </legend>
                    <p
                      id="agent-chat-description"
                      className={`mt-1.5 px-0.5 ${sectionDescriptionClasses}`}
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
                {pageToggles("appearance").length > 0 && (
                  <div className="mt-2.5">
                    <ExperimentalRows toggles={pageToggles("appearance")} />
                  </div>
                )}
              </Section>
              {scalable && (
                <Section title="Size">
                  <div className={settingsCardClasses}>
                    <Select
                      className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-36`}
                      label="Scale"
                      description="Makes all of Novadeck bigger or smaller. Terminal text has its own size, on the Terminal page."
                      descriptionClassName={descriptionClasses}
                      items={scaleItems}
                      value={String(value.appScale)}
                      onValueChange={(next) => {
                        const appScale = appScales.find((scale) => String(scale) === next)
                        if (appScale) onChange({ ...value, appScale })
                      }}
                      open={open && shown === "appearance" && openSelect === "scale"}
                      onOpenChange={(expanded) => setOpenSelect(expanded ? "scale" : null)}
                      portalContainer={dialog}
                    />
                  </div>
                </Section>
              )}
            </TabPanel>
            <TabPanel value="terminal" className={panelClasses}>
              <Section title="Text">
                <div className={settingsCardClasses}>
                  {/* What the rows under it change, as they change it. */}
                  <TerminalSample
                    family={terminalFamily}
                    size={value.fontSize}
                    ligatures={value.ligatures && terminalLigatures}
                  />
                  <div className={`preference-row ${settingRowClasses}`}>
                    <span id="font-size-label">Text size</span>
                    <span className="flex shrink-0 items-center gap-3">
                      <input
                        type="range"
                        min={fontSizeRange.min}
                        max={fontSizeRange.max}
                        step={1}
                        value={value.fontSize}
                        onChange={(event) =>
                          onChange({ ...value, fontSize: Number(event.target.value) })
                        }
                        aria-labelledby="font-size-label"
                        aria-valuetext={`${value.fontSize}px`}
                        className="settings-range w-40 cursor-pointer"
                      />
                      <span aria-hidden="true" className="w-10 text-right tabular-nums">
                        {value.fontSize}px
                      </span>
                    </span>
                  </div>
                  <Select
                    className={`preference-row ${settingRowClasses} [&_[data-part=trigger]]:w-52`}
                    label="Terminal font"
                    items={terminalFonts.items}
                    value={terminalFonts.value}
                    onValueChange={(choice) =>
                      onChange({ ...value, fontFamily: choice === builtInFont ? "" : choice })
                    }
                    open={open && shown === "terminal" && openSelect === "terminal-font"}
                    onOpenChange={(expanded) => setOpenSelect(expanded ? "terminal-font" : null)}
                    portalContainer={dialog}
                  />
                  <div className={`preference-row ${settingRowClasses}`}>
                    <SettingText
                      id="ligatures-label"
                      label="Ligatures"
                      description={
                        terminalLigatures
                          ? "Draw pairs such as => and != as one symbol, in terminals and code."
                          : "Draw pairs such as => and != as one symbol in code. Terminals join them only in the built-in JetBrains Mono."
                      }
                      descriptionId="ligatures-description"
                    />
                    <Switch
                      checked={value.ligatures}
                      onChange={(ligatures) => onChange({ ...value, ligatures })}
                      labelledBy="ligatures-label"
                      describedBy="ligatures-description"
                    />
                  </div>
                </div>
              </Section>
              <Section title="Accessibility">
                <div className={settingsCardClasses}>
                  <div className={`preference-row ${settingRowClasses}`}>
                    <SettingText
                      id="screen-reader-label"
                      label="Screen reader support"
                      description={screenReaderExplanation(screenReaderKnown)}
                      descriptionId="screen-reader-description"
                    />
                    <Select
                      className="shrink-0 [&_[data-part=label]]:sr-only [&_[data-part=trigger]]:w-36"
                      label="Screen reader support"
                      items={screenReaderChoices(screenReaderKnown)}
                      // Where nothing can tell, Automatic keeps the text, as On does.
                      value={
                        value.screenReader === "auto" && !screenReaderKnown
                          ? "on"
                          : value.screenReader
                      }
                      onValueChange={(choice) =>
                        onChange({
                          ...value,
                          screenReader:
                            screenReaderPreferences.find((each) => each === choice) ??
                            value.screenReader,
                        })
                      }
                      open={open && shown === "terminal" && openSelect === "screen-reader"}
                      onOpenChange={(expanded) => setOpenSelect(expanded ? "screen-reader" : null)}
                      portalContainer={dialog}
                    />
                  </div>
                </div>
              </Section>
              {transcripts && (
                <Section title="After a restart">
                  <div className={settingsCardClasses}>
                    <div className={`preference-row ${settingRowClasses}`}>
                      <SettingText
                        id="transcripts-label"
                        label="Keep recent output"
                        description={
                          transcripts.available
                            ? "Shows each terminal's recent output again after Novadeck restarts. Saved encrypted on this computer."
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
            <TabPanel value="notifications" className={panelClasses}>
              <Section title="Notify me">
                <div className={settingsCardClasses}>
                  <NoticePreview
                    toast={askToast}
                    needs={value.notifyNeeds}
                    done={notices && value.notifyFinished}
                    desktop={notices}
                  />
                  <div className={`preference-row ${settingRowClasses}`}>
                    <SettingText
                      id="notify-needs-label"
                      label="When an agent needs you"
                      description={
                        notices
                          ? "A question, an approval, or trouble that stopped it. A toast while you're in Novadeck, or a desktop notification while it's in the background. Either opens the Inbox."
                          : "A question, an approval, or trouble that stopped it. A toast in the corner, which opens the Inbox."
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
                      label="When an agent is done"
                      description={
                        notices
                          ? "It reported its task done, or a turn failed. A desktop notification while Novadeck is in the background."
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
              {notices && (
                <Section title="Sound">
                  <div className={settingsCardClasses}>
                    <div className={`preference-row ${settingRowClasses}`}>
                      <SettingText
                        id="sound-label"
                        label="Ring the bell"
                        description="When an agent needs you or is done. Quiet during Do Not Disturb, where the system tells Novadeck."
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
                          label="Bell"
                          items={soundItems}
                          value={soundChoice}
                          onValueChange={(next) => {
                            const chosen = { ...value, soundChoice: soundChoiceOf(next) }
                            onChange(chosen)
                            // Picking a sound plays it, as the system's own sound settings do.
                            hearSound?.(value.soundVolume, soundInEffect(chosen))
                          }}
                          open={open && shown === "notifications" && openSelect === "sound"}
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
            </TabPanel>
            {hasAddons && (
              <TabPanel value="addons" className={panelClasses}>
                <Section
                  title="Voice input"
                  icon={<Mic size={16} strokeWidth={1.5} />}
                  description="Speak prompts into a terminal. Speech is turned into text on this computer and never leaves it."
                >
                  <VoiceInput
                    voice={voice}
                    open={open && tab === "addons"}
                    portalContainer={dialog}
                  />
                </Section>
                {/* Not while Murmur's Experimental switch is off, nor where the backend has none. */}
                {murmur && (
                  <Section
                    title={MURMUR_NAME}
                    icon={<Tag size={16} strokeWidth={1.5} />}
                    {...(hasExperimental ? { badge: <ExperimentalBadge /> } : {})}
                    description={murmurDescription}
                  >
                    <MurmurAddon murmur={murmur} />
                  </Section>
                )}
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
                {(version || (experimental && showExperimentalSwitch)) && (
                  // The app itself: its version, and the builds it follows.
                  <Section title="Version and updates">
                    <div className={settingsCardClasses}>
                      {version && (
                        <VersionRow
                          version={version}
                          onReveal={showExperimentalSwitch ? undefined : experimental?.onReveal}
                        />
                      )}
                      {experimental && showExperimentalSwitch && (
                        <div className={`preference-row ${settingRowClasses}`}>
                          <SettingText
                            id="experimental-label"
                            label="Experimental builds"
                            description="Get each release as soon as it's out, before it's promoted to stable, and try features still being built on the Experimental page. Turning this off keeps the version you have until the next stable one."
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
                      )}
                    </div>
                  </Section>
                )}
                {(logs || pageToggles("about").length > 0) && (
                  <Section title="Help">
                    <div className={settingsCardClasses}>
                      <ExperimentalRows toggles={pageToggles("about")} bare />
                      {logs && (
                        <AddonRow
                          scope="about"
                          id="logs"
                          label="Logs"
                          description="What Novadeck recorded of its recent runs, never what your terminals showed. Attach them to a bug report."
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
                      )}
                    </div>
                  </Section>
                )}
                {uninstall && (
                  <Section title="Remove">
                    <UninstallApp uninstall={uninstall} />
                  </Section>
                )}
              </TabPanel>
            )}
            {hasExperimental && (
              <TabPanel value="experimental" className={panelClasses}>
                <ExperimentalRows
                  toggles={toggles}
                  scope="index-"
                  onGoTo={goTo}
                  shows={(page) => !hidden(page)}
                />
              </TabPanel>
            )}
          </div>
        </div>
      </Tabs>
    </Dialog>
  )
}

import { harnesses } from "@novadeck/core/harnesses"
import type { SchemePreference } from "@novadeck/core/types"
import { Checkbox } from "@novadeck/toolkit/Checkbox"
import { Dialog, DialogDescription, DialogTitle } from "@novadeck/toolkit/Dialog"
import { AntigravityIcon } from "@novadeck/toolkit/icons/AntigravityIcon"
import { ClaudeIcon } from "@novadeck/toolkit/icons/ClaudeIcon"
import { CodexIcon } from "@novadeck/toolkit/icons/CodexIcon"
import { brandName, NovaMark, NovaPattern, Wordmark } from "@novadeck/toolkit/NovaLogo"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import {
  ArrowRight,
  Download,
  MessagesSquare,
  Monitor,
  Moon,
  Play,
  ScrollText,
  Sun,
  type LucideIcon,
} from "lucide-react"
import {
  Fragment,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type RefObject,
} from "react"

import { agentLabels, agentNote, type AgentSwitch } from "./agent-switches"
import { WelcomePreview } from "./WelcomePreview"

type Choices = Record<AgentSwitch["agent"], boolean>

// Every agent found on this computer starts chosen; the person opts out, not in.
const installed = (agents: readonly AgentSwitch[], id: AgentSwitch["agent"]): boolean =>
  agents.find(({ agent }) => agent === id)?.available ?? false
const choicesFrom = (agents: readonly AgentSwitch[]): Choices =>
  Object.fromEntries(harnesses.map(({ id }) => [id, installed(agents, id)])) as Choices

type TranscriptsSetting = {
  readonly enabled: boolean
  // False where nothing can keep them encrypted; the choice is left out.
  readonly available: boolean
  readonly onChange: (enabled: boolean) => void
}

// The chat view, offered where the backend reads agents' conversations.
type ChatViewSetting = {
  readonly enabled: boolean
  readonly onChange: (enabled: boolean) => void
}

// The page's scheme, which the dialog changes at once, as Preferences does: the person sees
// what they pick, and it stays however the dialog closes.
type SchemeSetting = {
  readonly value: SchemePreference
  readonly onChange: (scheme: SchemePreference) => void
}

const schemeItems = [
  { label: "System", value: "system", icon: <Monitor size={13} aria-hidden="true" /> },
  { label: "Light", value: "light", icon: <Sun size={13} aria-hidden="true" /> },
  { label: "Dark", value: "dark", icon: <Moon size={13} aria-hidden="true" /> },
] as const

const icons = { claude: ClaudeIcon, codex: CodexIcon, agy: AntigravityIcon }

// Staggers an entrance: `at` ms after the dialog opens.
const at = (ms: number): CSSProperties => ({ "--_at": `${ms}ms` }) as CSSProperties

const listed = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

// What starting will install, so nothing about it is a surprise.
const pluginNote = (names: readonly string[]): string =>
  names.length === 0
    ? "You can connect agents later in Preferences."
    : `Adds a small plugin to ${listed(names)}. Remove it anytime in Preferences.`

const headline = "Room to build."

// The command that installs an agent that isn't here, where the backend knows one.
const installerOf = ({ available, installer }: AgentSwitch): string | undefined =>
  available ? undefined : installer

// What an agent that is not installed offers in place of a choice: the command that installs it,
// shown on asking and read out whole with the button that runs it.
type Installable = {
  readonly command: string
  readonly onInstall: () => void
}

type CardIcon = LucideIcon | ComponentType<{ size?: number; strokeWidth?: number }>

const Tile = ({ icon: Icon }: { readonly icon: CardIcon }): React.JSX.Element => (
  <span
    className="choice-card-tile relative flex size-[38px] flex-none items-center justify-center"
    aria-hidden="true"
  >
    <Icon size={20} strokeWidth={1.4} />
  </span>
)

// One choice as a card: the icon tile takes the brand tile once chosen.
const ChoiceCard = ({
  icon,
  label,
  note,
  noteId,
  error = false,
  name,
  value,
  checked,
  disabled = false,
  onChange,
  onLook,
}: {
  readonly icon: CardIcon
  readonly label: string
  readonly note?: string | undefined
  readonly noteId: string
  readonly error?: boolean
  readonly name: string
  readonly value: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (checked: boolean) => void
  // Told whether the pointer is over the card, or focus in it: the card is looked at while either is.
  readonly onLook?: ((how: "pointer" | "focus", looking: boolean) => void) | undefined
}): React.JSX.Element => (
  <label
    {...(onLook
      ? {
          onPointerEnter: () => onLook("pointer", true),
          onPointerLeave: () => onLook("pointer", false),
          onFocus: () => onLook("focus", true),
          onBlur: () => onLook("focus", false),
        }
      : {})}
    className={`choice-card solid flex min-h-[60px] min-w-0 items-start gap-3 px-3 py-2.5 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
    data-state={checked ? "checked" : "unchecked"}
    data-disabled={disabled || undefined}
  >
    <Tile icon={icon} />
    {/* As tall as the tile at least, so one line sits level with its middle and more start
        at its top. */}
    <span className="flex min-h-[38px] min-w-0 flex-1 flex-col justify-center gap-0.5">
      <span className="text-body font-medium">{label}</span>
      {note && (
        <span
          id={noteId}
          className="settings-note text-caption leading-4.5"
          data-tone={error ? "danger" : undefined}
          role={error ? "alert" : undefined}
        >
          {note}
        </span>
      )}
    </span>
    <span className="flex h-[38px] shrink-0 items-center">
      <Checkbox
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={note ? noteId : undefined}
        onChange={onChange}
      />
    </span>
  </label>
)

// A command as it wraps: after a space, or a slash that ends a run of them (so `https://` stays
// whole), before anywhere else.
const wrappable = (command: string): React.JSX.Element[] =>
  command.split(/(?<= )|(?<=\/)(?!\/)/).map((part, index) => (
    // The parts never reorder.
    // oxlint-disable-next-line react/no-array-index-key
    <Fragment key={index}>
      {part}
      <wbr />
    </Fragment>
  ))

// An agent that isn't here, as an empty seat to fill: a dashed card that offers to add it,
// with the command Install runs a click away, across the card under its name, and read out
// whole with the button.
const InstallCard = ({
  icon,
  label,
  noteId,
  disabled,
  command,
  onInstall,
}: {
  readonly icon: CardIcon
  readonly label: string
  readonly noteId: string
  readonly disabled: boolean
  readonly onInstall: () => void
} & Installable): React.JSX.Element => {
  const [shown, setShown] = useState(false)
  const commandId = `${noteId}-command`
  return (
    <div
      className="choice-card solid welcome-install flex min-h-[60px] min-w-0 flex-col px-3 py-2.5"
      data-state="unchecked"
      data-disabled={disabled || undefined}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Tile icon={icon} />
        <span className="flex min-h-[38px] min-w-0 flex-1 flex-col items-start justify-center">
          <span className="text-body font-medium">Add {label}</span>
          {/* "Add" and Install say it isn't here; the line keeps to the command, so it fits one. */}
          <button
            type="button"
            className="button link addon-action !mt-0 text-left text-caption leading-4"
            aria-expanded={shown}
            aria-controls={commandId}
            onClick={() => setShown((open) => !open)}
          >
            {shown ? "Hide install command" : "Show install command"}
          </button>
          {/* What the button reads out: the whole command, shown or not. */}
          <span id={noteId} className="sr-only">
            Not installed. Install runs {command}
          </span>
        </span>
        <span className="flex h-[38px] shrink-0 items-center">
          <button
            type="button"
            className="button primary min-h-8 shrink-0 gap-1.5 px-3 text-control"
            aria-label={`Install ${label}`}
            aria-describedby={noteId}
            disabled={disabled}
            onClick={onInstall}
          >
            <Download size={13} aria-hidden="true" className="max-[420px]:hidden" />
            Install
          </button>
        </span>
      </div>
      {shown && (
        // Under the name, as wide as the card leaves it.
        <code id={commandId} className="welcome-install-command mt-2 ml-[50px] block px-2 py-1.5">
          {wrappable(command)}
        </code>
      )}
    </div>
  )
}

const WelcomeForm = ({
  agents,
  onChange,
  onInstall,
  onTour,
  transcripts,
  chatView,
  scheme,
  onDone,
  heading,
}: {
  readonly agents: readonly AgentSwitch[]
  readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
  readonly onInstall?: ((agent: AgentSwitch["agent"], command: string) => void) | undefined
  readonly onTour?: ((agent: AgentSwitch["agent"]) => void) | undefined
  readonly transcripts?: TranscriptsSetting | undefined
  readonly chatView?: ChatViewSetting | undefined
  readonly scheme?: SchemeSetting | undefined
  readonly onDone: () => void
  readonly heading: RefObject<HTMLHeadingElement | null>
}): React.JSX.Element => {
  const [choices, setChoices] = useState<Choices>(() => choicesFrom(agents))
  // Transcripts start on; the person opts out.
  const [keepTranscripts, setKeepTranscripts] = useState(true)
  const offerTranscripts = transcripts?.available === true
  // The chat view starts on too.
  const [showChat, setShowChat] = useState(true)
  // While the person looks at that choice, the preview marks what it changes.
  const [lookingAtChat, setLookingAtChat] = useState({ pointer: false, focus: false })
  const offerSettings = offerTranscripts || chatView !== undefined

  // As "Let’s build something" applies the choices; `install` then also starts installing
  // an agent that isn't here, whose terminal opens as the dialog closes.
  const submit = (install?: { agent: AgentSwitch["agent"]; command: string }): void => {
    for (const toggle of agents) {
      const connected = choices[toggle.agent]
      if (toggle.available && !toggle.busy && connected !== toggle.connected) {
        onChange(toggle.agent, connected)
      }
    }
    if (transcripts?.available && keepTranscripts !== transcripts.enabled)
      transcripts.onChange(keepTranscripts)
    if (chatView && showChat !== chatView.enabled) chatView.onChange(showChat)
    onDone()
    if (install) onInstall?.(install.agent, install.command)
  }
  // The tour runs the first agent chosen here, once the choices are applied.
  const touring = agents.find((toggle) => toggle.available && choices[toggle.agent])?.agent

  return (
    <form
      // The preview takes the room a wide window gives; the choices keep enough for a command.
      className="grid min-h-0 min-[820px]:grid-cols-[minmax(0,1.5fr)_minmax(380px,1fr)]"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {/* Beside the choices, the preview takes whatever height they leave it. */}
      <div className="welcome-intro relative isolate min-w-0 overflow-hidden px-8 pt-8 pb-6 min-[820px]:flex min-[820px]:flex-col min-[820px]:px-10 min-[820px]:pt-10 max-[420px]:px-5">
        <NovaPattern className="welcome-pattern pointer-events-none absolute top-0 right-0 -z-10 h-[230px] w-[72%]" />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex items-center gap-2.5 text-[23px]" role="img" aria-label={brandName}>
            <NovaMark size={35} animated />
            {/* With no descenders the letters ride high in their line; this centres their
                capitals and baseline on the mark. */}
            <Wordmark animated className="translate-y-[0.07em]" />
          </div>
          {scheme && (
            <div className="welcome-enter" style={at(1100)}>
              <SegmentGroup
                label="Appearance"
                items={schemeItems}
                value={scheme.value}
                onValueChange={(next) => {
                  const chosen = schemeItems.find((item) => item.value === next)?.value
                  if (chosen) scheme.onChange(chosen)
                }}
                className="flex shrink-0 gap-1"
                itemClassName="flex h-7 items-center justify-center gap-1.5 px-2.5 text-control"
                indicatorClassName="absolute"
              />
            </div>
          )}
        </div>
        <div className="mt-10 max-[819px]:mt-6">
          <DialogTitle
            ref={heading}
            tabIndex={-1}
            className="welcome-headline m-0 text-[46px] leading-[1.06] font-medium max-[819px]:text-[38px] max-[420px]:text-[34px]"
          >
            {/* Read whole at once; the typed copy is for the eyes only. */}
            <span className="sr-only">Big ideas. {headline}</span>
            <span aria-hidden="true">
              <span className="welcome-rise" style={at(420)}>
                Big ideas.
              </span>
              <br />
              {[...headline].map((letter, index) => (
                <span
                  // The letters never reorder.
                  // oxlint-disable-next-line react/no-array-index-key
                  key={index}
                  className="welcome-letter"
                  style={{ "--_i": index } as CSSProperties}
                >
                  {letter}
                </span>
              ))}
              <span className="welcome-caret ml-[0.08em] inline-block h-[0.8em] w-[0.14em] align-[-0.04em]" />
            </span>
          </DialogTitle>
          <DialogDescription
            className="modal-description welcome-enter mt-4 mb-0 max-w-[350px] text-lead leading-[1.7]"
            style={at(1300)}
          >
            Terminals, agents, and projects in one workspace.
          </DialogDescription>
        </div>
        <div className="welcome-enter flex min-h-0 flex-1 flex-col" style={at(500)}>
          <WelcomePreview
            connected={choices}
            chat={chatView !== undefined && showChat}
            spotlight={chatView !== undefined && (lookingAtChat.pointer || lookingAtChat.focus)}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-col px-8 pt-10 max-[819px]:pt-7 max-[420px]:px-5">
        <div className="my-auto">
          <div className="welcome-enter mb-6" style={at(600)}>
            <h3 className="welcome-heading m-0 text-[25px] leading-[1.2] font-medium">
              Connect your agents
            </h3>
            <p className="modal-description mt-2 mb-0 text-body leading-[1.7]">
              Unlock Novadeck features inside your coding agents.
            </p>
          </div>

          <fieldset className="settings-fieldset welcome-enter m-0 min-w-0 p-0" style={at(750)}>
            <legend className="sr-only">Agents</legend>
            {/* One column, which a shown command wraps to. */}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
              {agents.map((toggle) => {
                const note = agentNote(toggle)
                const command = installerOf(toggle)
                return command && onInstall ? (
                  <InstallCard
                    key={toggle.agent}
                    icon={icons[toggle.agent]}
                    label={agentLabels[toggle.agent]}
                    noteId={`welcome-${toggle.agent}-description`}
                    disabled={toggle.busy}
                    command={command}
                    onInstall={() => submit({ agent: toggle.agent, command })}
                  />
                ) : (
                  <ChoiceCard
                    key={toggle.agent}
                    icon={icons[toggle.agent]}
                    label={agentLabels[toggle.agent]}
                    note={note}
                    noteId={`welcome-${toggle.agent}-description`}
                    error={Boolean(toggle.error)}
                    name="agents"
                    value={toggle.agent}
                    checked={choices[toggle.agent]}
                    disabled={toggle.busy || !toggle.available}
                    onChange={(checked) =>
                      setChoices((current) => ({ ...current, [toggle.agent]: checked }))
                    }
                  />
                )
              })}
            </div>
          </fieldset>

          <p
            className={`modal-description welcome-enter mt-3 min-h-[2lh] text-caption leading-[1.65] ${offerSettings ? "mb-5" : "mb-8"}`}
            style={at(850)}
          >
            {pluginNote(
              agents
                .filter((toggle) => toggle.available && choices[toggle.agent])
                .map((toggle) => agentLabels[toggle.agent]),
            )}
          </p>

          {offerSettings && (
            <fieldset
              className="settings-fieldset welcome-enter m-0 mb-8 min-w-0 p-0"
              style={at(900)}
            >
              <legend className="sr-only">Settings</legend>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
                {chatView && (
                  <ChoiceCard
                    icon={MessagesSquare}
                    label="Agent Chat"
                    note="Chat with agents instead of a terminal."
                    noteId="welcome-chat-view-description"
                    name="chat-view"
                    value="on"
                    checked={showChat}
                    onChange={setShowChat}
                    onLook={(how, looking) =>
                      setLookingAtChat((current) => ({ ...current, [how]: looking }))
                    }
                  />
                )}
                {offerTranscripts && (
                  <ChoiceCard
                    icon={ScrollText}
                    label="Transcripts"
                    note="Keep output after restarts, encrypted."
                    noteId="welcome-transcripts-description"
                    name="transcripts"
                    value="on"
                    checked={keepTranscripts}
                    onChange={setKeepTranscripts}
                  />
                )}
              </div>
            </fieldset>
          )}
        </div>
        {/* Stays in view at the column's foot while a short window scrolls the dialog. */}
        <div
          className="welcome-enter welcome-actions -mx-8 px-8 pb-7 max-[420px]:-mx-5 max-[420px]:px-5"
          style={at(1000)}
        >
          <button
            type="submit"
            className="button primary welcome-start relative min-h-11 w-full justify-between gap-3 overflow-hidden px-4 py-3 text-body font-medium"
          >
            Let’s build something
            <ArrowRight size={16} className="welcome-arrow" aria-hidden="true" />
          </button>
          {onTour && touring && (
            <button
              type="button"
              className="button welcome-tour mt-2 min-h-9 w-full gap-2 px-3 py-2 text-control"
              onClick={() => {
                submit()
                onTour(touring)
              }}
            >
              <Play size={14} aria-hidden="true" />
              Take the tour
            </button>
          )}
          <button
            type="button"
            className="button ghost welcome-skip mt-2 min-h-9 w-full px-3 py-2 text-control"
            onClick={onDone}
          >
            Skip for now
          </button>
        </div>
      </div>
    </form>
  )
}

// Choices stay local until submission. Dismissing changes no agent, chat view or transcript
// setting; Preferences keeps its immediate switches. The scheme alone applies at once.
export const WelcomeDialog = ({
  open,
  agents,
  onChange,
  onInstall,
  onTour,
  transcripts,
  chatView,
  scheme,
  onDone,
}: {
  readonly open: boolean
  readonly agents: readonly AgentSwitch[]
  readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
  readonly onInstall?: ((agent: AgentSwitch["agent"], command: string) => void) | undefined
  // Applies the choices, as starting does, and offers the tour with the agent first chosen.
  readonly onTour?: ((agent: AgentSwitch["agent"]) => void) | undefined
  readonly transcripts?: TranscriptsSetting | undefined
  // Given, the person chooses here whether agents show as a chat, as starting applies.
  readonly chatView?: ChatViewSetting | undefined
  // Given, the person picks the page's scheme here, at once; left out where the theme has one.
  readonly scheme?: SchemeSetting | undefined
  readonly onDone: () => void
}): React.JSX.Element => {
  const heading = useRef<HTMLHeadingElement>(null)
  return (
    <Dialog
      open={open}
      closeOnInteractOutside
      onOpenChange={(expanded) => {
        if (!expanded) onDone()
      }}
      label="Welcome to Novadeck"
      initialFocusEl={() => heading.current}
      backdropClassName="overlay welcome-overlay fixed inset-0 z-50"
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center p-4"
      className="modal max-h-[calc(100dvh-32px)] w-[min(1080px,calc(100vw-32px))] overflow-y-auto"
    >
      <WelcomeForm
        agents={agents}
        onChange={onChange}
        onInstall={onInstall}
        onTour={onTour}
        transcripts={transcripts}
        chatView={chatView}
        scheme={scheme}
        onDone={onDone}
        heading={heading}
      />
    </Dialog>
  )
}

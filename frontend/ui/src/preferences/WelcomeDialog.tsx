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
  MessagesSquare,
  Monitor,
  Moon,
  Play,
  ScrollText,
  Sun,
  type LucideIcon,
} from "lucide-react"
import { useRef, useState, type ComponentType, type CSSProperties, type RefObject } from "react"

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
// shown whole beside its name, and the button that runs it.
type Installable = {
  readonly command: string
  readonly onInstall: () => void
}

// One choice as a card: the icon tile takes the brand tile once chosen.
const ChoiceCard = ({
  icon: Icon,
  label,
  note,
  noteId,
  error = false,
  name,
  value,
  checked,
  disabled = false,
  installable,
  onChange,
  onLook,
}: {
  readonly icon: LucideIcon | ComponentType<{ size?: number; strokeWidth?: number }>
  readonly label: string
  readonly note?: string | undefined
  readonly noteId: string
  readonly error?: boolean
  readonly name: string
  readonly value: string
  readonly checked: boolean
  readonly disabled?: boolean
  // Given, the card offers installing instead of choosing, and `note` is left out.
  readonly installable?: Installable | undefined
  readonly onChange: (checked: boolean) => void
  // Told when the pointer or focus comes to the card and leaves it.
  readonly onLook?: ((looking: boolean) => void) | undefined
}): React.JSX.Element => {
  const Card = installable ? "div" : "label"
  return (
    <Card
      {...(onLook
        ? {
            onPointerEnter: () => onLook(true),
            onPointerLeave: () => onLook(false),
            onFocus: () => onLook(true),
            onBlur: () => onLook(false),
          }
        : {})}
      className={`choice-card solid flex min-h-[60px] min-w-0 items-center gap-3 px-3 py-2.5 ${disabled ? "cursor-not-allowed" : installable ? "" : "cursor-pointer"}`}
      data-state={checked ? "checked" : "unchecked"}
      data-disabled={disabled || undefined}
    >
      <span
        className="choice-card-tile relative flex size-[38px] flex-none items-center justify-center"
        aria-hidden="true"
      >
        <Icon size={20} strokeWidth={1.4} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium">{label}</span>
        {installable ? (
          <span id={noteId} className="settings-note text-caption leading-4.5">
            Not installed. Install runs
            {/* Whole, so nothing it will do is hidden; a long one is cut to the card, and
              the title and the description reading it out hold all of it. */}
            <code className="settings-installer mt-0.5 block truncate" title={installable.command}>
              {installable.command}
            </code>
          </span>
        ) : (
          note && (
            <span
              id={noteId}
              className="settings-note text-caption leading-4.5"
              data-tone={error ? "danger" : undefined}
              role={error ? "alert" : undefined}
            >
              {note}
            </span>
          )
        )}
      </span>
      {installable ? (
        <button
          type="button"
          className="button min-h-8 shrink-0 px-3 text-control"
          aria-label={`Install ${label}`}
          aria-describedby={noteId}
          disabled={disabled}
          onClick={installable.onInstall}
        >
          Install
        </button>
      ) : (
        <Checkbox
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          aria-label={label}
          aria-describedby={note ? noteId : undefined}
          onChange={onChange}
        />
      )}
    </Card>
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
  const [lookingAtChat, setLookingAtChat] = useState(false)
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
      className="grid min-h-0 min-[820px]:grid-cols-[1.3fr_1fr]"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="welcome-intro relative isolate min-w-0 overflow-hidden px-8 pt-8 pb-6 min-[820px]:px-10 min-[820px]:pt-10 max-[420px]:px-5">
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
        <div className="welcome-enter" style={at(500)}>
          <WelcomePreview
            connected={choices}
            chat={chatView !== undefined && showChat}
            spotlight={chatView !== undefined && lookingAtChat}
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
            {/* One column that may be narrower than a command, which is cut to it. */}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
              {agents.map((toggle) => {
                const note = agentNote(toggle)
                return (
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
                    disabled={
                      toggle.busy || (!toggle.available && !(installerOf(toggle) && onInstall))
                    }
                    installable={
                      installerOf(toggle) && onInstall
                        ? {
                            command: installerOf(toggle)!,
                            onInstall: () =>
                              submit({ agent: toggle.agent, command: installerOf(toggle)! }),
                          }
                        : undefined
                    }
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
                    label="Chat view"
                    note="Read and reply to agents in a chat instead of their terminal."
                    noteId="welcome-chat-view-description"
                    name="chat-view"
                    value="on"
                    checked={showChat}
                    onChange={setShowChat}
                    onLook={setLookingAtChat}
                  />
                )}
                {offerTranscripts && (
                  <ChoiceCard
                    icon={ScrollText}
                    label="Transcripts"
                    note="Show recent output again after a restart. Saved encrypted on this computer."
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
      className="modal max-h-[calc(100dvh-32px)] w-[min(980px,calc(100vw-32px))] overflow-y-auto"
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

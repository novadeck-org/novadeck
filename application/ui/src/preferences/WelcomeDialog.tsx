import { ArrowRight, ScrollText, Sparkles, type LucideIcon } from "lucide-react"
import { useRef, useState, type ComponentType, type CSSProperties, type RefObject } from "react"

import { Checkbox } from "../ui-toolkit/Checkbox"
import { deckName, DeckMark, DeckPattern, DeckWordmark } from "../ui-toolkit/DeckLogo"
import { Dialog, DialogDescription, DialogTitle } from "../ui-toolkit/Dialog"
import { ClaudeIcon } from "../ui-toolkit/icons/ClaudeIcon"
import { CodexIcon } from "../ui-toolkit/icons/CodexIcon"
import { agentLabels, agentNote, type AgentSwitch } from "./AgentSwitches"
import { WelcomePreview } from "./WelcomePreview"

type Choices = Record<AgentSwitch["agent"], boolean>

// Every agent found on this computer starts chosen; the person opts out, not in.
const installed = (agents: readonly AgentSwitch[], id: AgentSwitch["agent"]): boolean =>
  agents.find(({ agent }) => agent === id)?.available ?? false
const choicesFrom = (agents: readonly AgentSwitch[]): Choices => ({
  claude: installed(agents, "claude"),
  codex: installed(agents, "codex"),
  agy: installed(agents, "agy"),
})

export type TranscriptsSetting = {
  readonly enabled: boolean
  readonly onChange: (enabled: boolean) => void
}

const icons = { claude: ClaudeIcon, codex: CodexIcon, agy: Sparkles }

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

// One choice as a card: the icon tile takes the Deck mark's face once chosen.
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
  onChange,
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
  readonly onChange: (checked: boolean) => void
}): React.JSX.Element => (
  <label
    className={`choice-card solid flex min-h-[60px] items-center gap-3 px-3 py-2.5 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
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
      <span className="text-[12px] font-medium">{label}</span>
      {note && (
        <span
          id={noteId}
          className="settings-note text-[10px] leading-relaxed"
          data-tone={error ? "danger" : undefined}
          role={error ? "alert" : undefined}
        >
          {note}
        </span>
      )}
    </span>
    <Checkbox
      name={name}
      value={value}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      aria-describedby={note ? noteId : undefined}
      onChange={onChange}
    />
  </label>
)

const WelcomeForm = ({
  agents,
  onChange,
  transcripts,
  onDone,
  heading,
}: {
  readonly agents: readonly AgentSwitch[]
  readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
  readonly transcripts?: TranscriptsSetting | undefined
  readonly onDone: () => void
  readonly heading: RefObject<HTMLHeadingElement | null>
}): React.JSX.Element => {
  const [choices, setChoices] = useState<Choices>(() => choicesFrom(agents))
  // Transcripts start on; the person opts out.
  const [keepTranscripts, setKeepTranscripts] = useState(true)

  const submit = (): void => {
    for (const item of agents) {
      const connected = choices[item.agent]
      if (item.available && !item.busy && connected !== item.connected) {
        onChange(item.agent, connected)
      }
    }
    if (transcripts && keepTranscripts !== transcripts.enabled)
      transcripts.onChange(keepTranscripts)
    onDone()
  }

  return (
    <form
      className="grid min-h-0 min-[820px]:grid-cols-[1.3fr_1fr]"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="welcome-intro relative isolate min-w-0 overflow-hidden px-8 pt-8 pb-6 min-[820px]:px-10 min-[820px]:pt-10 max-[420px]:px-5">
        <DeckPattern className="welcome-pattern pointer-events-none absolute top-0 right-0 -z-10 h-[230px] w-[72%]" />
        <div
          className="welcome-brand flex items-center gap-2.5 text-[23px] font-semibold"
          role="img"
          aria-label={deckName}
        >
          <DeckMark size={35} animated />
          <DeckWordmark animated />
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
            className="modal-description welcome-enter mt-4 mb-0 max-w-[350px] text-[13px] leading-[1.7]"
            style={at(1300)}
          >
            Terminals, agents, and projects in one workspace.
          </DialogDescription>
        </div>
        <div className="welcome-enter" style={at(500)}>
          <WelcomePreview connected={choices} />
        </div>
      </div>

      <div className="flex min-w-0 flex-col px-8 pt-10 pb-7 max-[819px]:pt-7 max-[420px]:px-5">
        <div className="my-auto">
          <div className="welcome-enter mb-6" style={at(600)}>
            <h3 className="welcome-heading m-0 text-[25px] leading-[1.2] font-medium">
              Connect your agents
            </h3>
            <p className="modal-description mt-2 mb-0 text-[12px] leading-[1.7]">
              Unlock NovaDeck features inside your coding agents.
            </p>
          </div>

          <fieldset className="settings-fieldset welcome-enter m-0 min-w-0 p-0" style={at(750)}>
            <legend className="sr-only">Agents</legend>
            <div className="grid gap-2">
              {agents.map((item) => {
                const note = agentNote(item)
                return (
                  <ChoiceCard
                    key={item.agent}
                    icon={icons[item.agent]}
                    label={agentLabels[item.agent]}
                    note={note}
                    noteId={`welcome-${item.agent}-description`}
                    error={Boolean(item.error)}
                    name="agents"
                    value={item.agent}
                    checked={choices[item.agent]}
                    disabled={!item.available || item.busy}
                    onChange={(checked) =>
                      setChoices((current) => ({ ...current, [item.agent]: checked }))
                    }
                  />
                )
              })}
            </div>
          </fieldset>

          <p
            className={`modal-description welcome-enter mt-3 min-h-[2lh] text-[10px] leading-[1.65] ${transcripts ? "mb-5" : "mb-8"}`}
            style={at(850)}
          >
            {pluginNote(
              agents
                .filter((item) => item.available && choices[item.agent])
                .map((item) => agentLabels[item.agent]),
            )}
          </p>

          {transcripts && (
            <fieldset
              className="settings-fieldset welcome-enter m-0 mb-8 min-w-0 p-0"
              style={at(900)}
            >
              <legend className="sr-only">Terminals</legend>
              <ChoiceCard
                icon={ScrollText}
                label="Transcripts"
                note="Show recent output again after a restart. Saved on this computer, so it can include secrets."
                noteId="welcome-transcripts-description"
                name="transcripts"
                value="on"
                checked={keepTranscripts}
                onChange={setKeepTranscripts}
              />
            </fieldset>
          )}
        </div>
        <div className="welcome-enter" style={at(1000)}>
          <button
            type="submit"
            className="button primary welcome-start relative min-h-11 w-full justify-between gap-3 overflow-hidden px-4 py-3 text-[12px] font-medium"
          >
            Let’s build something
            <ArrowRight size={16} className="welcome-arrow" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="button ghost welcome-skip mt-2 min-h-9 w-full px-3 py-2 text-[11px]"
            onClick={onDone}
          >
            Skip for now
          </button>
        </div>
      </div>
    </form>
  )
}

// Choices stay local until submission. Dismissing changes no agent or transcript
// setting; Preferences keeps its immediate switches.
export const WelcomeDialog = ({
  open,
  agents,
  onChange,
  transcripts,
  onDone,
}: {
  readonly open: boolean
  readonly agents: readonly AgentSwitch[]
  readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
  readonly transcripts?: TranscriptsSetting | undefined
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
      label="Welcome to NovaDeck"
      initialFocusEl={() => heading.current}
      backdropClassName="overlay welcome-overlay fixed inset-0 z-50"
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center p-4"
      className="modal max-h-[calc(100dvh-32px)] w-[min(980px,calc(100vw-32px))] overflow-y-auto"
    >
      <WelcomeForm
        agents={agents}
        onChange={onChange}
        transcripts={transcripts}
        onDone={onDone}
        heading={heading}
      />
    </Dialog>
  )
}

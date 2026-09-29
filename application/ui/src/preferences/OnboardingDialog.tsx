import { ArrowRight, Check, Sparkles } from "lucide-react"
import { useRef, useState, type CSSProperties, type RefObject } from "react"

import { deckName, DeckMark, DeckPattern, DeckWordmark } from "../ui-toolkit/DeckLogo"
import { Dialog, DialogDescription, DialogTitle } from "../ui-toolkit/Dialog"
import { ClaudeIcon } from "../ui-toolkit/icons/ClaudeIcon"
import { CodexIcon } from "../ui-toolkit/icons/CodexIcon"
import { agentLabels, type AgentSwitch } from "./AgentSwitches"
import { OnboardingPreview } from "./OnboardingPreview"

import motion from "../ui-toolkit/ModalMotion.module.css"
import styles from "./OnboardingDialog.module.css"

type Choices = Record<AgentSwitch["agent"], boolean>

const choicesFrom = (agents: readonly AgentSwitch[]): Choices => ({
  claude: agents.find(({ agent }) => agent === "claude")?.connected ?? false,
  codex: agents.find(({ agent }) => agent === "codex")?.connected ?? false,
  agy: agents.find(({ agent }) => agent === "agy")?.connected ?? false,
})

const icons = { claude: ClaudeIcon, codex: CodexIcon, agy: Sparkles }

// Staggers an entrance: `at` ms after the dialog opens.
const at = (ms: number): CSSProperties => ({ "--at": `${ms}ms` }) as CSSProperties

const listed = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

// What starting will install, so nothing about it is a surprise.
const pluginNote = (names: readonly string[]): string =>
  names.length === 0
    ? "You can connect agents later in Preferences."
    : `Adds a small plugin to ${listed(names)}. Remove it anytime in Preferences.`

const headline = "Room to build."

// Only a state worth knowing gets a note; an agent ready to connect needs none.
const choiceNote = (item: AgentSwitch): string | undefined => {
  if (item.busy) return item.connected ? "Disconnecting…" : "Connecting…"
  if (item.error) return item.error
  if (!item.available) return "Not installed"
  return undefined
}

const OnboardingForm = ({
  agents,
  onChange,
  onDone,
  heading,
}: {
  readonly agents: readonly AgentSwitch[]
  readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
  readonly onDone: () => void
  readonly heading: RefObject<HTMLHeadingElement | null>
}): React.JSX.Element => {
  const [choices, setChoices] = useState<Choices>(() => choicesFrom(agents))

  const submit = (): void => {
    for (const item of agents) {
      const connected = choices[item.agent]
      if (item.available && !item.busy && connected !== item.connected) {
        onChange(item.agent, connected)
      }
    }
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
      <div className="relative isolate min-w-0 overflow-hidden border-b border-line bg-shell px-8 pt-8 pb-6 min-[820px]:border-r min-[820px]:border-b-0 min-[820px]:px-10 min-[820px]:pt-10 max-[420px]:px-5">
        <DeckPattern className={`${styles.pattern} -z-10`} />
        <div
          className="flex items-center gap-2.5 text-[23px] font-semibold tracking-[-0.8px]"
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
            className="m-0 text-[46px] leading-[1.06] font-medium tracking-[-2.2px] focus-visible:outline-none max-[819px]:text-[38px] max-[420px]:text-[34px]"
          >
            {/* Read whole at once; the typed copy is for the eyes only. */}
            <span className="sr-only">Big ideas. {headline}</span>
            <span aria-hidden="true">
              <span className={styles.rise} style={at(420)}>
                Big ideas.
              </span>
              <br />
              {[...headline].map((letter, index) => (
                <span
                  // The letters never reorder.
                  // oxlint-disable-next-line react/no-array-index-key
                  key={index}
                  className={styles.letter}
                  style={{ "--i": index } as CSSProperties}
                >
                  {letter}
                </span>
              ))}
              <span className={styles.caret} />
            </span>
          </DialogTitle>
          <DialogDescription
            className={`${styles.enter} mt-4 mb-0 max-w-[350px] text-[13px] leading-[1.7] text-muted`}
            style={at(1300)}
          >
            Terminals, agents, and projects in one workspace.
          </DialogDescription>
        </div>
        <div className={styles.enter} style={at(500)}>
          <OnboardingPreview connected={choices} />
        </div>
      </div>

      <div className="flex min-w-0 flex-col px-8 pt-10 pb-7 max-[819px]:pt-7 max-[420px]:px-5">
        <div className="my-auto">
          <div className={`${styles.enter} mb-6`} style={at(600)}>
            <h3 className="m-0 text-[25px] leading-[1.2] font-medium tracking-[-0.9px]">
              Connect your agents
            </h3>
            <p className="mt-2 mb-0 text-[12px] leading-[1.7] text-muted">
              Unlock NovaDeck features inside your coding agents.
            </p>
          </div>

          <fieldset className={`${styles.enter} m-0 min-w-0 border-0 p-0`} style={at(750)}>
            <legend className="sr-only">Agents</legend>
            <div className="grid gap-2">
              {agents.map((item) => {
                const selected = choices[item.agent]
                const disabled = !item.available || item.busy
                const note = choiceNote(item)
                const description = note ? `onboarding-${item.agent}-description` : undefined
                const Icon = icons[item.agent]
                return (
                  <label
                    key={item.agent}
                    className={`group flex min-h-[60px] items-center gap-3 rounded-panel border px-3 py-2.5 transition-[background-color,border-color,box-shadow] duration-(--motion-state) has-focus-visible:outline-2 has-focus-visible:outline-strong has-focus-visible:outline-offset-2 ${selected ? "border-line-strong bg-shell shadow-panel" : "border-line bg-paper"} ${disabled ? "cursor-not-allowed" : "cursor-pointer hover:border-line-strong hover:bg-shell"}`}
                  >
                    <span
                      className={styles.tile}
                      data-selected={selected || undefined}
                      data-disabled={disabled || undefined}
                      aria-hidden="true"
                    >
                      <Icon size={20} strokeWidth={1.4} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={`text-[12px] font-medium ${disabled ? "text-muted" : "text-ink"}`}
                      >
                        {agentLabels[item.agent]}
                      </span>
                      {note && (
                        <span
                          id={description}
                          className={`text-[10px] leading-relaxed ${item.error ? "text-danger-fg" : "text-muted"}`}
                          role={item.error ? "alert" : undefined}
                        >
                          {note}
                        </span>
                      )}
                    </span>
                    <span className="relative flex size-4 shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        name="agents"
                        value={item.agent}
                        checked={selected}
                        disabled={disabled}
                        aria-label={agentLabels[item.agent]}
                        aria-describedby={description}
                        className="peer absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-[2px] border border-line-strong bg-paper checked:border-strong checked:bg-strong disabled:cursor-not-allowed disabled:bg-shell focus-visible:outline-none"
                        onChange={(event) =>
                          setChoices((current) => ({
                            ...current,
                            [item.agent]: event.target.checked,
                          }))
                        }
                      />
                      <Check
                        size={12}
                        strokeWidth={2.5}
                        className={`${styles.check} pointer-events-none relative text-white`}
                        aria-hidden="true"
                      />
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <p
            className={`${styles.enter} mt-3 mb-8 min-h-[2lh] text-[10px] leading-[1.65] text-muted`}
            style={at(850)}
          >
            {pluginNote(
              agents
                .filter((item) => item.available && choices[item.agent])
                .map((item) => agentLabels[item.agent]),
            )}
          </p>
        </div>
        <div className={styles.enter} style={at(1000)}>
          <button
            type="submit"
            className={`${styles.start} flex min-h-11 w-full items-center justify-between gap-3 rounded-control border border-strong bg-strong px-4 py-3 text-[12px] font-medium text-white shadow-control hover:bg-ink focus-visible:outline-2 focus-visible:outline-strong focus-visible:outline-offset-2`}
          >
            Let’s build something
            <ArrowRight size={16} className={styles.arrow} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="mt-2 min-h-9 w-full rounded-control px-3 py-2 text-[11px] text-muted hover:bg-shell hover:text-ink"
            onClick={onDone}
          >
            Skip for now
          </button>
        </div>
      </div>
    </form>
  )
}

// Choices stay local until submission. Dismissing makes no connection changes;
// Preferences keeps its immediate switches.
export const OnboardingDialog = ({
  open,
  agents,
  onChange,
  onDone,
}: {
  readonly open: boolean
  readonly agents: readonly AgentSwitch[]
  readonly onChange: (agent: AgentSwitch["agent"], connected: boolean) => void
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
      backdropClassName={`${motion.backdrop} fixed inset-0 z-50 bg-scrim backdrop-blur-[5px]`}
      positionerClassName="fixed inset-0 z-50 flex items-center justify-center p-4"
      className={`${motion.dialog} max-h-[calc(100dvh-32px)] w-[min(980px,calc(100vw-32px))] overflow-y-auto rounded-popover border border-line-strong bg-paper text-ink shadow-modal`}
    >
      <OnboardingForm agents={agents} onChange={onChange} onDone={onDone} heading={heading} />
    </Dialog>
  )
}

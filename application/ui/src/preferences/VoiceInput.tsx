import { useState, type RefObject } from "react"

import { currentPlatform, shortcutBindings, type Shortcut } from "../interaction/shortcuts"
import type { Voice, VoiceModel, VoiceState } from "../model/voice"
import { ConfirmDialog } from "../ui-toolkit/ConfirmDialog"
import { Progress } from "../ui-toolkit/Progress"
import { SegmentGroup } from "../ui-toolkit/SegmentGroup"
import { Select } from "../ui-toolkit/Select"
import { Switch } from "../ui-toolkit/Switch"
import { settingRowClasses, settingsCardClasses } from "./settings"
import {
  checkText,
  formatSize,
  installedSize,
  installSize,
  languages,
  modelNames,
  modelSummaries,
  recommendation,
  stepLabels,
} from "./voice-addon"

export type VoiceAddon = {
  readonly state: VoiceState
  readonly actions: Pick<Voice, "install" | "cancel" | "uninstall" | "set">
}

const models: readonly VoiceModel[] = ["turbo", "small"]
const rowClasses = `preference-row ${settingRowClasses}`
const noteClasses = "settings-description text-control leading-relaxed"

// What the person holds to dictate, when the shortcut list names it.
const dictationKeys = (): string | undefined => {
  const bindings: Partial<Record<string, Shortcut>> = shortcutBindings(currentPlatform())
  return bindings["voice"]?.display.join(" + ")
}

const Row = ({
  id,
  label,
  description,
  children,
}: {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly children?: React.ReactNode
}): React.JSX.Element => (
  <div className={rowClasses}>
    <span className="flex min-w-0 flex-col gap-1">
      <span id={`voice-${id}`}>{label}</span>
      {description && (
        <span id={`voice-${id}-description`} className={noteClasses}>
          {description}
        </span>
      )}
    </span>
    {children}
  </div>
)

// The model chooser, with what the chosen one is like.
const ModelChoice = ({
  label,
  choices,
  value,
  onChange,
  detail,
  disabled = false,
}: {
  readonly label: string
  readonly choices: readonly VoiceModel[]
  readonly value: VoiceModel
  readonly onChange: (model: VoiceModel) => void
  readonly detail: (model: VoiceModel) => string
  readonly disabled?: boolean
}): React.JSX.Element => (
  <Row id="model" label={label} description={`${modelSummaries[value]} ${detail(value)}`.trim()}>
    {choices.length === 1 ? (
      // One installed model leaves nothing to choose: it is shown as the value.
      <span className="shrink-0">{modelNames[value]}</span>
    ) : (
      <SegmentGroup
        label={label}
        items={choices.map((model) => ({ label: modelNames[model], value: model }))}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          const model = choices.find((item) => item === next)
          if (model) onChange(model)
        }}
        className="flex shrink-0 gap-1"
        itemClassName="flex h-7 min-w-14 items-center justify-center px-2.5 text-control"
        indicatorClassName="absolute"
      />
    )}
  </Row>
)

const Installing = ({
  installing,
  onCancel,
}: {
  readonly installing: NonNullable<VoiceState["installing"]>
  readonly onCancel: () => void
}): React.JSX.Element => {
  const { step, received, total, model } = installing
  const label = stepLabels[step]
  return (
    <div
      className={`${rowClasses} flex-col items-stretch gap-2.5`}
      role="group"
      aria-label="Installing"
    >
      <div className="flex items-center justify-between gap-6">
        <span className="flex min-w-0 flex-col gap-1">
          <span>{`${label}${step === "check" ? "" : `: ${step === "model" ? modelNames[model] : "speech engine"}`}`}</span>
          {step !== "check" && (
            <span className={noteClasses}>{`${formatSize(received)} of ${formatSize(total)}`}</span>
          )}
        </span>
        <button
          type="button"
          className="button min-h-8 shrink-0 px-3 text-control"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      <Progress label={label} value={step === "check" ? 0 : received} max={total} />
    </div>
  )
}

// Voice input's card in Preferences' Addons tab: install it, choose how it listens, take
// it away. `voice` is absent where the backend has none.
export const VoiceInput = ({
  voice,
  open,
  portalContainer,
}: {
  readonly voice: VoiceAddon | undefined
  // Whether the card is on screen, which its select needs to know to close with the tab.
  readonly open: boolean
  readonly portalContainer: RefObject<HTMLElement | null>
}): React.JSX.Element => {
  const [choice, setChoice] = useState<VoiceModel>("turbo")
  const [selecting, setSelecting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Set once the person confirms an uninstall, holding the failure then showing: the state
  // has no field for a removal under way, so the card waits for the engine to be gone or a
  // new failure to turn up.
  const [removing, setRemoving] = useState<{ readonly failure: string | null } | null>(null)
  // The model the person last asked to install, which Try again installs again, until that
  // install is seen through: once it has run, an end without a failure forgets it.
  const [asked, setAsked] = useState<{ readonly model: VoiceModel; readonly ran: boolean } | null>(
    null,
  )
  if (
    removing &&
    voice &&
    (!voice.state.installed.length || voice.state.failure !== removing.failure)
  )
    setRemoving(null)
  if (!voice)
    return (
      <div className={settingsCardClasses}>
        <p className={`${rowClasses} m-0 ${noteClasses}`}>Voice input isn't available here.</p>
      </div>
    )
  const { state, actions } = voice
  if (asked && !asked.ran && state.installing) setAsked({ ...asked, ran: true })
  if (asked?.ran && !state.installing && !state.failure) setAsked(null)
  const { failure, installing, installed } = state
  const failed = failure && (
    <p
      className="settings-note m-0 px-4 py-3 text-control leading-relaxed"
      data-tone="danger"
      role="alert"
    >
      {failure}
    </p>
  )
  const install = (model: VoiceModel): void => {
    setAsked({ model, ran: false })
    actions.install(model)
  }
  // What an installed card can still do about a failure: install again, the model asked
  // for if there was one, or the one in use, which fetches an engine that is missing or out
  // of date, runs the check, and skips models on disk. It leaves voice input off if it was.
  const retry = (): void =>
    install(asked?.model ?? (installed.includes(state.model) ? state.model : installed[0]!))
  if (!state.available)
    return (
      <div className={settingsCardClasses}>
        <p className={`${rowClasses} m-0 ${noteClasses}`}>
          This build has no voice engine for this platform.
        </p>
      </div>
    )
  if (installing)
    return (
      <div className={settingsCardClasses}>
        <Installing installing={installing} onCancel={actions.cancel} />
      </div>
    )
  if (!installed.length)
    return (
      <div className={settingsCardClasses}>
        <ModelChoice
          label="Model"
          choices={models}
          value={choice}
          onChange={setChoice}
          detail={(model) => `Downloads ${formatSize(installSize(state, model))}, with the engine.`}
        />
        <div className={rowClasses}>
          <span className={noteClasses}>Downloads once, then works offline.</span>
          <button
            type="button"
            className="button primary min-h-8 shrink-0 px-3 text-control"
            onClick={() => install(choice)}
          >
            Install
          </button>
        </div>
        {failed}
      </div>
    )
  const busy = removing !== null
  const other = models.find((model) => !installed.includes(model))
  const keys = dictationKeys()
  const hint = recommendation(state)
  return (
    <>
      <div className={settingsCardClasses}>
        <div className={rowClasses}>
          <span className="flex min-w-0 flex-col gap-1">
            <span id="voice-enabled">Enabled</span>
            <span id="voice-enabled-description" className={noteClasses}>
              {keys
                ? `Hold ${keys} in a terminal, or click its microphone, to speak.`
                : "Hold the dictation shortcut in a terminal, or click its microphone, to speak."}
            </span>
          </span>
          <Switch
            checked={state.enabled}
            onChange={(enabled) => actions.set({ enabled })}
            disabled={busy}
            labelledBy="voice-enabled"
            describedBy="voice-enabled-description"
          />
        </div>
        <ModelChoice
          label="Model"
          choices={installed}
          value={installed.includes(state.model) ? state.model : installed[0]!}
          onChange={(model) => actions.set({ model })}
          detail={() => ""}
          disabled={busy}
        />
        {other && (
          <div className={rowClasses}>
            <span className="flex min-w-0 flex-col gap-1">
              <span>{`Also install ${modelNames[other]}`}</span>
              <span className={noteClasses}>{modelSummaries[other]}</span>
            </span>
            <button
              type="button"
              className="button min-h-8 shrink-0 px-3 text-control"
              disabled={busy}
              onClick={() => install(other)}
            >
              {`Install · ${formatSize(installSize(state, other))}`}
            </button>
          </div>
        )}
        <Select
          className={`${rowClasses} [&_[data-part=trigger]]:w-36`}
          label="Language"
          items={languages}
          value={state.language}
          onValueChange={(language) => actions.set({ language })}
          disabled={busy}
          open={open && selecting}
          onOpenChange={setSelecting}
          portalContainer={portalContainer}
        />
        {state.check && (
          <div className={rowClasses}>
            <span className="flex min-w-0 flex-col gap-1">
              <span className={noteClasses}>{checkText(state.check)}</span>
              {hint && <span className={noteClasses}>{hint}</span>}
            </span>
          </div>
        )}
        <div className={rowClasses}>
          <span className="flex min-w-0 flex-col gap-1">
            <span>Uninstall</span>
            <span className={noteClasses}>{`Frees ${formatSize(installedSize(state))}.`}</span>
          </span>
          <button
            type="button"
            className="button min-h-8 shrink-0 px-3 text-control"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {busy ? "Removing…" : "Uninstall"}
          </button>
        </div>
        {failure && (
          <div className="flex items-center justify-between gap-6">
            {failed}
            <button
              type="button"
              className="button mr-4 min-h-8 shrink-0 px-3 text-control"
              disabled={busy}
              onClick={retry}
            >
              Try again
            </button>
          </div>
        )}
      </div>
      <ConfirmDialog
        subject={confirming ? state : null}
        title={() => "Uninstall voice input?"}
        description={(shown) =>
          `The speech engine and its models are removed from this computer, freeing ${formatSize(installedSize(shown))}. You can install them again.`
        }
        confirmLabel="Uninstall"
        cancelLabel="Cancel"
        onConfirm={() => {
          setConfirming(false)
          setRemoving({ failure })
          actions.uninstall()
        }}
        onCancel={() => setConfirming(false)}
        widthClassName="w-[min(380px,calc(100vw-32px))]"
      />
    </>
  )
}

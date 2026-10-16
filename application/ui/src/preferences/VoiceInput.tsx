import { useState, type RefObject } from "react"

import { dictationKeys } from "../interaction/shortcuts"
import { refusalText } from "../model/addon"
import { formatSize, stepLabel } from "../model/addon-format"
import { installSize, type Voice, type VoiceState } from "../model/voice"
import { Chord } from "../ui-toolkit/Chord"
import { ConfirmDialog } from "../ui-toolkit/ConfirmDialog"
import { Select } from "../ui-toolkit/Select"
import { Switch } from "../ui-toolkit/Switch"
import { AddonFailure, addonNoteClasses, addonRowClasses, InstallProgress } from "./addon-parts"
import { settingsCardClasses } from "./settings"
import { checkText, installedSize, languages, voiceOnDisk, voiceSetUp } from "./voice-addon"

export type VoiceAddon = {
  readonly state: VoiceState
  readonly actions: Pick<Voice, "install" | "cancel" | "uninstall" | "set">
}

// What the card says went wrong: the runner's failure, or the backend's refusal of any call.
const told = (state: VoiceState): string | null =>
  state.failure ?? (state.refused ? refusalText(state.refused, "voice input") : null)

const rowClasses = addonRowClasses
const noteClasses = addonNoteClasses

const Installing = ({
  installing,
  onCancel,
}: {
  readonly installing: NonNullable<VoiceState["installing"]>
  readonly onCancel: () => void
}): React.JSX.Element => {
  const { step, received, total } = installing
  const label = stepLabel(step)
  return (
    <InstallProgress
      title={`${label}${step === "check" ? "" : `: ${step === "model" ? "speech model" : "speech engine"}`}`}
      {...(step !== "check" && { detail: `${formatSize(received)} of ${formatSize(total)}` })}
      label={label}
      received={step === "check" ? 0 : received}
      total={total}
      indeterminate={step === "check"}
      onCancel={onCancel}
    />
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
  const [selecting, setSelecting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Set once the person confirms an uninstall, holding the failure then showing: the state
  // has no field for a removal under way, so the card waits for the engine to be gone or a
  // new failure to turn up.
  const [removing, setRemoving] = useState<{ readonly failure: string | null } | null>(null)
  if (removing && voice && (!voiceOnDisk(voice.state) || told(voice.state) !== removing.failure))
    setRemoving(null)
  if (!voice)
    return (
      <div className={settingsCardClasses}>
        <p className={`${rowClasses} m-0 ${noteClasses}`}>Voice input isn't available here.</p>
      </div>
    )
  const { state, actions } = voice
  const { installing } = state
  const failure = told(state)
  const failed = failure && <AddonFailure>{failure}</AddonFailure>
  // What an installed card can still do about a failure: install again, which fetches an
  // engine that is missing or out of date, runs the check, and skips models on disk. It
  // leaves voice input off if it was.
  const retry = actions.install
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
  const busy = removing !== null
  const keys = dictationKeys()
  // What an uninstall frees, offered whenever anything of voice input is on disk, whatever its
  // check said: a model a cancel left behind, or an engine that never started, is reclaimed here.
  const uninstallRow = voiceOnDisk(state) && (
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
  )
  const confirmDialog = (
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
  )
  if (!voiceSetUp(state))
    return (
      <>
        <div className={settingsCardClasses}>
          {/* Wanted until turned off or declined: the app shows a microphone in agent terminals
            that offers the install, and holds the shortcut. Off, both go until it is on again. */}
          <div className={rowClasses}>
            <span className="flex min-w-0 flex-col gap-1">
              <span id="voice-enabled">Enabled</span>
              <span id="voice-enabled-description" className={noteClasses}>
                Shows a microphone in agent terminals. It offers to install voice input when used.
              </span>
            </span>
            <Switch
              checked={state.wanted}
              onChange={(enabled) => actions.set({ enabled })}
              disabled={busy}
              labelledBy="voice-enabled"
              describedBy="voice-enabled-description"
            />
          </div>
          <div className={rowClasses}>
            <span className={noteClasses}>
              {installSize(state) > 0
                ? `Downloads ${formatSize(installSize(state))} once, then works offline.`
                : "Finish setting up voice input."}
            </span>
            <button
              type="button"
              className="button primary min-h-8 shrink-0 px-3 text-control"
              disabled={busy}
              onClick={actions.install}
            >
              Install
            </button>
          </div>
          {uninstallRow}
          {failed}
        </div>
        {confirmDialog}
      </>
    )
  return (
    <>
      <div className={settingsCardClasses}>
        <div className={rowClasses}>
          <span className="flex min-w-0 flex-col gap-1">
            <span id="voice-enabled">Enabled</span>
            <span id="voice-enabled-description" className={noteClasses}>
              Hold <Chord keys={keys} /> in a terminal, or click its microphone, to speak.
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
            </span>
          </div>
        )}
        {uninstallRow}
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
      {confirmDialog}
    </>
  )
}

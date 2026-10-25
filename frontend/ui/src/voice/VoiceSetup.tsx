import { formatSize, stepLabel } from "@novadeck/core/addon-format"
import { installFailure, installSize } from "@novadeck/core/voice"
import { Chord } from "@novadeck/toolkit/Chord"
import { Progress } from "@novadeck/toolkit/Progress"
import { Check, Mic, TriangleAlert } from "lucide-react"
import { useState, useSyncExternalStore } from "react"

import type { DictationController, VoiceSetup } from "./dictation"

const failurePrefix = "Voice input didn't install:"
const offerText = "Talk to your agents. Voice input runs on this computer"
const preferencesNote = "You can install it later in Preferences → Addons."

// A button of the strip or the overlay: it takes the pointer but never focus, so typing
// stays in the terminal.
const Action = ({
  primary = false,
  title,
  onPress,
  children,
}: {
  readonly primary?: boolean
  readonly title?: string
  readonly onPress: () => void
  readonly children: React.ReactNode
}): React.JSX.Element => (
  <button
    type="button"
    className={primary ? "button primary dictation-button" : "dictation-link"}
    {...(title && { title })}
    onMouseDown={(event) => event.preventDefault()}
    // Its own click, not its window's, which Canvas would also select.
    onClick={(event) => {
      event.stopPropagation()
      onPress()
    }}
  >
    {children}
  </button>
)

// What voice input's setup says: the offer, the install's progress, that it is ready, or why
// it failed. Both the strip of a terminal and the overlay at the app's foot show it. The
// progress numbers stay out of the live region, which reads a stable summary instead.
export const VoiceSetupContent = ({
  controller,
  setup,
  keys,
}: {
  readonly controller: DictationController
  readonly setup: VoiceSetup
  // The dictation shortcut's keys, said once voice input is ready.
  readonly keys: readonly string[]
}): React.JSX.Element => {
  const state = useSyncExternalStore(controller.voice.subscribe, controller.voice.getSnapshot)
  // The last reason an install went wrong, kept for when the snapshot that clears a refusal
  // comes before the strip is gone, so it never says "didn't install:" and nothing more.
  const [reason, setReason] = useState("")
  const now = installFailure(state)
  if (now !== null && now !== reason) setReason(now)
  const { turnOn, noThanks, cancel } = controller.setupActions
  if (setup.kind === "offer")
    return (
      <>
        <Mic size={14} className="dictation-icon" aria-hidden />
        <span className="dictation-text" title={`${offerText}. ${preferencesNote}`}>
          <span className="dictation-long">{offerText}</span>
          <span className="dictation-short">Voice input</span>
        </span>
        {/* Nothing to download, as after a cancel at the check, has no size to say. */}
        {installSize(state) > 0 && (
          <span className="dictation-muted dictation-fixed">
            · {formatSize(installSize(state))} once
          </span>
        )}
        <Action title={preferencesNote} onPress={noThanks}>
          No thanks
        </Action>
        <Action primary onPress={turnOn}>
          Turn on
        </Action>
      </>
    )
  if (setup.kind === "installing") {
    const { installing } = state
    const indeterminate = installing === null || installing.step === "check"
    return (
      <>
        <Mic size={14} className="dictation-icon" aria-hidden />
        <span className="dictation-text">
          <span className="dictation-long">Setting up voice input</span>
          <span className="dictation-short">Voice input</span>
        </span>
        <span className="dictation-muted dictation-fixed" aria-hidden>
          {"· "}
          {installing === null ? (
            "Starting…"
          ) : installing.step === "check" ? (
            "Checking…"
          ) : (
            <>
              <span className="dictation-long">{stepLabel(installing.step)} </span>
              {formatSize(installing.received)} of {formatSize(installing.total)}
            </>
          )}
        </span>
        <span className="dictation-progress" aria-hidden>
          <Progress
            label="Voice input setup"
            value={indeterminate ? null : (installing?.received ?? 0)}
            max={installing?.total ?? 1}
          />
        </span>
        <Action onPress={cancel}>Cancel</Action>
      </>
    )
  }
  if (setup.kind === "ready") {
    return (
      <>
        <Check size={14} className="dictation-icon" aria-hidden />
        <span className="dictation-text">
          Voice input is ready. Hold <Chord keys={keys} /> to talk.
        </span>
      </>
    )
  }
  // The backend's own words often name voice input already.
  const told = now ?? reason
  const said = /voice input/i.test(told) ? told : `${failurePrefix} ${told}`
  return (
    <>
      <TriangleAlert size={14} className="dictation-icon" aria-hidden />
      <span className="dictation-text dictation-clamp" title={said}>
        {said}
      </span>
      <Action primary onPress={turnOn}>
        Try again
      </Action>
    </>
  )
}

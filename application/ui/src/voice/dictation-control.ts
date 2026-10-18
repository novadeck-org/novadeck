import type { TerminalKey } from "#core/types"

// What keys and buttons ask of dictation. `dictation.ts` implements it.
export type Dictation = {
  // A clip is being recorded now, held or hands-free.
  readonly recording: () => boolean
  // A clip is recording or being transcribed, so Esc still has something to cancel.
  readonly active: () => boolean
  // Whether the shortcut is dictation's: not while voice input is off by the person's
  // choice (or this build has none), when a terminal gets the chord as any other key. A
  // recording under way keeps it.
  readonly claims: () => boolean
  // The shortcut's key went down, with the target it would dictate into, if there is one.
  // `code` names the physical key, which `release` matches.
  readonly press: (target: TerminalKey | undefined, code: string) => void
  readonly release: (code: string) => void
  // The window lost focus.
  readonly blur: () => void
  // Drops the recording without transcribing it, or the transcription still under way.
  readonly cancel: () => void
  // The mic button: starts a hands-free recording, or ends the one running.
  readonly toggle: (target: TerminalKey) => void
}

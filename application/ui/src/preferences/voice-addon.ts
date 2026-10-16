import type { VoiceState } from "../model/voice"

// What the voice input card says, as plain functions of the addon's state.

export const languages = [
  { label: "Auto-detect", value: "auto" },
  { label: "English", value: "en" },
  { label: "Polish", value: "pl" },
  { label: "German", value: "de" },
  { label: "French", value: "fr" },
  { label: "Spanish", value: "es" },
  { label: "Italian", value: "it" },
  { label: "Portuguese", value: "pt" },
  { label: "Dutch", value: "nl" },
  { label: "Ukrainian", value: "uk" },
  { label: "Russian", value: "ru" },
  { label: "Czech", value: "cs" },
  { label: "Swedish", value: "sv" },
  { label: "Turkish", value: "tr" },
  { label: "Japanese", value: "ja" },
  { label: "Chinese", value: "zh" },
  { label: "Korean", value: "ko" },
  { label: "Hindi", value: "hi" },
  { label: "Arabic", value: "ar" },
]

// Whether voice input is set up: its model is installed and passed its check. Otherwise
// Addons offers the install, whatever is on disk.
export const voiceSetUp = (state: VoiceState): boolean =>
  state.installed.includes(state.model) && state.check !== null

// What an uninstall frees: the engine, where it is on disk, and every model there (each
// size with the speech-detection model, which a second model counts once more).
export const installedSize = (state: VoiceState): number =>
  (state.engineInstalled ? state.sizes.engine : 0) +
  state.installed.reduce((sum, model) => sum + state.sizes[model], 0)

// Whether anything of voice input is on disk, which an uninstall frees whatever its check said.
export const voiceOnDisk = (state: VoiceState): boolean =>
  state.engineInstalled || state.installed.length > 0

export const checkText = ({ milliseconds }: NonNullable<VoiceState["check"]>): string =>
  `Checked: a test clip took ${(milliseconds / 1000).toFixed(1)} s.`

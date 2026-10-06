import type { VoiceModel, VoiceState } from "../model/voice"

// What the voice input card says, as plain functions of the addon's state.

export const modelNames: Record<VoiceModel, string> = { turbo: "Turbo", small: "Small" }
export const modelSummaries: Record<VoiceModel, string> = {
  turbo: "Most accurate, 99 languages; best with a GPU.",
  small: "Faster without a GPU, less accurate.",
}

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

const megabyte = 1024 * 1024
const gigabyte = 1024 * megabyte

// A download size in whole megabytes, or gigabytes with a decimal from one up. Anything
// received reads as at least a megabyte; only nothing at all reads as none.
export const formatSize = (bytes: number): string =>
  bytes >= gigabyte
    ? `${(bytes / gigabyte).toFixed(1)} GB`
    : `${bytes <= 0 ? 0 : Math.max(1, Math.round(bytes / megabyte))} MB`

// What installing `model` downloads: its own file, and the engine too until one is there.
// A model's size includes the speech-detection model every install shares, which the state
// doesn't give apart, so a second install is shown at most a megabyte over.
export const installSize = (state: VoiceState, model: VoiceModel): number =>
  state.sizes[model] + (state.installed.length ? 0 : state.sizes.engine)

// What an uninstall frees: the engine and every model on disk, with the shared
// speech-detection model counted once per model for the same reason.
export const installedSize = (state: VoiceState): number =>
  state.sizes.engine + state.installed.reduce((sum, model) => sum + state.sizes[model], 0)

export const stepLabels = {
  engine: "Downloading engine",
  model: "Downloading model",
  check: "Checking",
} as const

export const checkText = ({ milliseconds, gpu }: NonNullable<VoiceState["check"]>): string =>
  `Checked: a test clip took ${(milliseconds / 1000).toFixed(1)} s on the ${gpu ? "GPU" : "CPU"}.`

// Said when the model this computer suits is not the one in use.
export const recommendation = (state: VoiceState): string | undefined => {
  const { check, model, installed } = state
  if (!check || check.recommended === model) return undefined
  const name = modelNames[check.recommended]
  return installed.includes(check.recommended)
    ? `This computer suits ${name} better; you can switch to it above.`
    : `This computer suits ${name} better; you can install it below.`
}

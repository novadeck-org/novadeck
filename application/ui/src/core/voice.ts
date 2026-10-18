import type { Refusal } from "./addon"
import type { Store } from "./store"

// Voice input, as a backend offers it: speech recorded here, transcribed on the backend's
// machine by an engine and a model the person installs when they reach for it (or from
// Preferences), and typed into a terminal as if pasted, for the person to read and send.

// The longest clip a backend takes, in seconds. The core can't import the protocol's wire contracts,
// so backend/runner/voice.test.ts checks this against its `maxVoiceSeconds`.
export const maxClipSeconds = 120

// `turbo` is accurate in many languages but wants a GPU; `small` is quicker on a CPU. The
// install picks the one that suits the computer; the person never does.
export type VoiceModel = "turbo" | "small"

export type VoiceState = {
  // Whether the backend has an engine for its platform; without one nothing installs.
  readonly available: boolean
  // The models on disk beside the engine; empty until an install finishes.
  readonly installed: readonly VoiceModel[]
  // Whether the person turned voice input on; it needs `model` installed.
  readonly enabled: boolean
  // Whether the person wants voice input, installed or not: until they turn it off or say
  // no thanks to its offer, the app shows a microphone that offers its install, and holds
  // its shortcut.
  readonly wanted: boolean
  readonly model: VoiceModel
  // Whether the engine is on disk, with or without a model.
  readonly engineInstalled: boolean
  // The model an install fetches first; small where the computer is known not to suit turbo.
  readonly aim: VoiceModel
  // `auto`, or a language code such as "en" or "pl".
  readonly language: string
  // Download sizes in bytes.
  readonly sizes: { readonly engine: number; readonly turbo: number; readonly small: number }
  // What an install is doing, with the bytes received of the step's total.
  readonly installing: {
    // Whether the person asked, or the app's update brought a new engine to fetch alone.
    readonly origin: "person" | "update"
    readonly model: VoiceModel
    readonly step: "engine" | "model" | "check"
    readonly received: number
    readonly total: number
  } | null
  // How the engine did on a test clip after an install: the model checked and how long it took.
  readonly check: { readonly model: VoiceModel; readonly milliseconds: number } | null
  // Why the last install, or the engine's update, failed, as the runner says. A clip that
  // fails to transcribe rejects to its caller instead.
  readonly failure: string | null
  // A call the person made that the backend refused, until its next snapshot; apart from
  // `failure`, which is the runner's word on an install it ran.
  readonly refused: Refusal | null
}

// What shows of an install that went wrong, whoever says so: the runner's failure of one it
// ran, or the backend's refusal of the call to start it. A refused setting or removal is not.
export const installFailure = (state: VoiceState): string | null =>
  state.failure ?? (state.refused?.call === "install" ? state.refused.message : null)

export type VoiceSettings = {
  readonly enabled: boolean
  readonly model: VoiceModel
  readonly language: string
}

// What the person changes of them: the model is the install's choice.
export type VoiceChange = Partial<Omit<VoiceSettings, "model">>

export type VoiceTranscript = {
  readonly text: string
  // The language the engine heard, such as "en".
  readonly language: string
}

// A clip being recorded. Audio goes to the backend as it arrives, so transcribing only
// waits for the engine once the person stops speaking.
export type VoiceClip = {
  // Adds 16 kHz mono 16-bit samples.
  readonly append: (samples: Int16Array) => void
  // Ends the clip and transcribes it; `terminalId` names the terminal it is dictated
  // into, whose words help spell what is said. Rejects with an Error whose message says
  // why, for the person.
  readonly finish: (options?: { readonly terminalId?: string }) => Promise<VoiceTranscript>
  // Ends the clip without transcribing it.
  readonly discard: () => void
}

export type Voice = {
  readonly state: Store<VoiceState>
  // Each of these starts the change; `state` shows it as it goes, and its end or failure.
  // Answers once the call is through, refused or not (a refusal shows in `refused`).
  readonly install: () => Promise<void>
  readonly cancel: () => void
  readonly uninstall: () => void
  readonly set: (settings: VoiceChange) => void
  // Starts a clip.
  readonly record: () => VoiceClip
}

// What an install downloads: the model it aims for (turbo, or small where the computer is
// known not to suit turbo) unless it is on disk already, and the engine unless that is. A turbo that later turns
// out too slow for this computer costs small's download after, which isn't counted.
export const installSize = (state: VoiceState): number =>
  (state.installed.includes(state.aim) ? 0 : state.sizes[state.aim]) +
  (state.engineInstalled ? 0 : state.sizes.engine)

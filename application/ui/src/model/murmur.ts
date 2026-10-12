import type { Store } from "./store"

// Murmur, as a backend offers it: a small model that runs on the backend's machine, on
// its GPU, and names the terminals from what they are doing. The person
// installs it from Preferences; it has no model or language to choose.

// What the person is told it is called. The name isn't final, so every text that says it
// reads it from here.
export const MURMUR_NAME = "Murmur"

export type MurmurState = {
  // Whether the backend has an engine for its platform; without one nothing installs.
  readonly available: boolean
  // Whether the engine and the model are on disk.
  readonly installed: boolean
  // Whether the person turned murmur on; it needs to be installed.
  readonly enabled: boolean
  // Whether the person wants murmur, installed or not: until they turn it off, an install
  // turns it on.
  readonly wanted: boolean
  // Download sizes in bytes.
  readonly sizes: { readonly engine: number; readonly model: number }
  // What an install is doing, with the bytes received of the step's total.
  readonly installing: {
    readonly step: "engine" | "model" | "check"
    readonly received: number
    readonly total: number
  } | null
  // The GPU that passed the check after an install. Null until one does: on a computer
  // with no working GPU it stays null, and `failure` says so.
  readonly check: {
    readonly device: string
    readonly integrated: boolean
    readonly milliseconds: number
  } | null
  // Why the last install, or its check, failed. A backend may also show here why a change
  // was refused, until its next snapshot.
  readonly failure: string | null
}

export type MurmurSettings = {
  readonly enabled: boolean
}

export type Murmur = {
  readonly state: Store<MurmurState>
  // Each of these starts the change; `state` shows it as it goes, and its end or failure.
  readonly install: () => void
  readonly cancel: () => void
  // Settles when the removal ended, whether it worked or failed (`state` shows which).
  readonly uninstall: () => Promise<void>
  readonly set: (settings: Partial<MurmurSettings>) => void
}

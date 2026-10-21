import type { Refusal } from "./addon"
import type { Store } from "./store"

// Murmur, as a backend offers it: a small model that runs on the backend's machine, on its
// graphics, and names the terminals from what they are doing. The person turns it on from
// the one-time offer or from Preferences; it has no model or language to choose. Nothing
// downloads without that click.

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
  // What an install is doing, with the bytes received of the step's total, and who started
  // it: the person, or the app's update, which fetches a new engine alone.
  readonly installing: {
    readonly step: "engine" | "model" | "check"
    readonly received: number
    readonly total: number
    readonly origin: "person" | "update"
  } | null
  // The device that passed the check after an install; null until one does.
  readonly check: {
    readonly device: string
    readonly integrated: boolean
    readonly milliseconds: number
  } | null
  // Why murmur is not working, as the runner says it: an install that failed for a reason
  // that may pass (network, disk), a device that went away, an engine that keeps failing.
  readonly failure: string | null
  // The part of `failure` that is murmur stopping while installed (its engine failing job
  // after job, or its worker not starting), until a job succeeds. Its jobs retry by
  // themselves, so it is news, not something to retry; null for the rest of `failure`.
  readonly stopped: string | null
  // Why this computer can't run murmur, technical, for a details view: the host's word
  // ("host", nothing downloads and an install is refused), or a check's, which an install runs
  // again and which is kept until another passes. Not a failure to retry, and no offer.
  readonly unsupported: { readonly reason: string; readonly source: "host" | "check" } | null
  // In how many sessions of the app the one-time offer was shown; it stops after three.
  readonly offers: number
  // A call the person made that the backend refused, until the next snapshot. Apart from
  // `failure`, which is only what the runner says.
  readonly refused: Refusal | null
}

// Installed, with no check passed and no install running: a check that was cancelled, or
// dropped because its device went away. Not a failure in itself: installing again runs just
// the check.
export const unchecked = (state: MurmurState): boolean =>
  state.installed && state.check === null && state.installing === null && state.unsupported === null

// What murmur's check is called in the steps of an install.
export const murmurChecking = "Checking this computer"

export type MurmurSettings = {
  readonly enabled: boolean
}

export type Murmur = {
  readonly state: Store<MurmurState>
  // Starts an install; `state` shows it as it goes, and its end or failure. Settles once the
  // call has returned, whether the backend took it or refused it (`state.refused` says which).
  readonly install: () => Promise<void>
  readonly cancel: () => void
  // Settles when the removal ended, whether it worked or failed (`state` shows which).
  readonly uninstall: () => Promise<void>
  readonly set: (settings: Partial<MurmurSettings>) => void
  // Counts a session of the app the one-time offer was shown in. Fire and forget.
  readonly noteOffered: () => void
  // A backend may ask the app to offer murmur now, on the selected terminal, where the demo's
  // debug panel does: each bump is a request.
  readonly offer?: Store<number>
  // Asks for the gist of the reply that ended the terminal's turn at `at`, which the person
  // hasn't seen; it arrives with the terminal's agent status. Fire and forget.
  readonly gist?: (terminalId: string, at: number) => void
}

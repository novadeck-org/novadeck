import type { Refusal } from "@novadeck/core/addon"
import type { Murmur, MurmurState } from "@novadeck/core/murmur"
import { createStore } from "@novadeck/core/store"
import type { MurmurState as WireMurmurState } from "@novadeck/protocol"
import type { Runner } from "@novadeck/runner-client"

// The runner's murmur addon: its state as `murmur.watch` streams it, and installs and
// settings as calls whose refusals show in that state until the next snapshot.

export type MurmurCalls = Runner["murmur"]

export type RunnerMurmur = {
  readonly murmur: Murmur
  // Follows the addon's state; once started it goes on across reconnections.
  readonly follow: () => void
  readonly stop: () => void
}

// Before the runner's first snapshot nothing is installed. The addon counts as available:
// a runner without an engine says so in its first snapshot, and a call that fails says why.
export const noMurmur: MurmurState = {
  available: true,
  installed: false,
  enabled: false,
  // Nothing is offered until the runner says it is wanted.
  wanted: false,
  sizes: { engine: 0, model: 0 },
  installing: null,
  check: null,
  kept: false,
  unsupported: null,
  offers: 0,
  refused: null,
  failure: null,
  stopped: null,
}

const reason = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

export const createRunnerMurmur = (
  calls: MurmurCalls,
  // Keeps a call the backend waits for before it stops, as its other calls are.
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerMurmur => {
  const state = createStore<MurmurState>(noMurmur)
  let stream: AsyncIterableIterator<WireMurmurState, undefined> | undefined

  const follow = (): void => {
    if (stream) return
    let next: AsyncIterableIterator<WireMurmurState, undefined>
    try {
      next = calls.watch()
    } catch {
      // Murmur is extra: a runner that can't follow it leaves the addon as it was.
      return
    }
    stream = next
    void (async () => {
      try {
        for await (const snapshot of next) {
          if (stream !== next) return
          state.update(() => ({ ...snapshot, refused: null }))
        }
      } catch {
        // The runner closed, or has no murmur.
      }
      if (stream === next) stream = undefined
    })()
  }

  // Runs a call that changes the addon; the next snapshot shows its effect, and a
  // rejection shows meanwhile as the refusal of that call. Settles once the call has, either way.
  const change = (which: Refusal["call"], call: () => Promise<void>): Promise<void> =>
    track(call()).catch((error: unknown) => {
      state.update((current) => ({
        ...current,
        refused: { call: which, message: reason(error) },
      }))
    })

  return {
    murmur: {
      state,
      install: () => change("install", () => calls.install()),
      cancel: () => void change("cancel", () => calls.cancel()),
      uninstall: () => change("uninstall", () => calls.uninstall()),
      set: (settings) => void change("set", () => calls.set(settings)),
      // Only counted: a count that is not kept is no refusal to show.
      noteOffered: () => void track(calls.noteOffered()).catch(() => {}),
      // Murmur is extra: a gist that can't be asked for leaves the reply as it was.
      gist: (terminalId, at) => void track(calls.gist(terminalId, at)).catch(() => {}),
    },
    follow,
    stop: () => {
      const current = stream
      stream = undefined
      void current?.return?.()
    },
  }
}

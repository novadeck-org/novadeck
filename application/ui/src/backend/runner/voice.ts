import {
  maxVoiceSeconds,
  voiceSampleRate,
  voiceUnavailable,
  type VoiceState as WireVoiceState,
  type VoiceUnavailable,
} from "@novadeck/protocol"
import { hasCode, type Runner } from "@novadeck/protocol/client"

import { createStore } from "../../model/store"
import type { Voice, VoiceClip, VoiceModel, VoiceState } from "../../model/voice"

// The runner's voice input addon: its state as `voice.watch` streams it, installs and
// settings as calls whose failures show in that state until the next snapshot, and clips
// whose audio goes up while the person still speaks, so stopping only waits for the engine.

export type VoiceCalls = Runner["voice"]

export type RunnerVoice = {
  readonly voice: Voice
  // Follows the addon's state; once started it goes on across reconnections.
  readonly follow: () => void
  readonly stop: () => void
}

// Before the runner's first snapshot nothing is installed. The addon counts as available:
// a runner without an engine says so in its first snapshot, and a call that fails says why.
export const noVoice: VoiceState = {
  available: true,
  installed: [],
  enabled: false,
  model: "turbo",
  language: "auto",
  sizes: { engine: 0, turbo: 0, small: 0 },
  installing: null,
  check: null,
  failure: null,
}

// How often a clip's audio goes up while it records: often enough that the end of a
// sentence has little left to send, rarely enough to stay a handful of calls.
export const flushMs = 300

const reason = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

// What each reason voice input is unavailable means for the person, with what to do next.
const unavailable: Record<VoiceUnavailable["reason"], string> = {
  unavailable: "This version of Novadeck has no voice input for this computer.",
  off: "Voice input isn't installed or is turned off. See Preferences, Addons.",
  removing: "Voice input is being removed. Install it again in Preferences, Addons.",
  updating: "The voice engine is updating. Try dictating again in a moment.",
  missing: "The voice engine is missing. Install voice input again in Preferences, Addons.",
}

// What a failed clip call means for the person.
export const clipFailure = (error: unknown): Error => {
  if (hasCode(error, "UPLOAD_TOO_LARGE"))
    return new Error(`That was too long to transcribe. Dictate up to ${maxVoiceSeconds} seconds.`)
  if (hasCode(error, "VOICE_UNAVAILABLE")) {
    // A runner that sends no reason, or one this client doesn't know, still says why in
    // words; a bare code says nothing.
    const why = voiceUnavailable.safeParse(error.data)
    // A missing engine's own message says more, such as that the disk is full.
    if (why.success)
      return new Error(
        why.data.reason === "missing" && reason(error) !== "VOICE_UNAVAILABLE"
          ? reason(error)
          : unavailable[why.data.reason],
      )
    return new Error(reason(error) !== "VOICE_UNAVAILABLE" ? reason(error) : unavailable.off)
  }
  if (hasCode(error, "VOICE_FAILED")) return new Error(`The speech engine failed: ${reason(error)}`)
  if (hasCode(error, "NOT_FOUND"))
    return new Error("The runner lost the recording. Try dictating again.")
  if (hasCode(error, "DISCONNECTED") || hasCode(error, "CLOSED"))
    return new Error("The runner isn't reachable, so nothing was transcribed.")
  return new Error(`Couldn't transcribe: ${reason(error)}`, { cause: error })
}

// 16-bit samples as the little-endian bytes the runner takes, whatever this machine's order.
const littleEndian = (chunks: readonly Int16Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(total * 2)
  const view = new DataView(bytes.buffer)
  let at = 0
  for (const chunk of chunks)
    for (const sample of chunk) {
      view.setInt16(at, sample, true)
      at += 2
    }
  return bytes
}

export const createRunnerVoice = (
  calls: VoiceCalls,
  // Keeps a call the backend waits for before it stops, as its other calls are.
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerVoice => {
  const state = createStore<VoiceState>(noVoice)
  let stream: AsyncIterableIterator<WireVoiceState, undefined> | undefined

  const follow = (): void => {
    if (stream) return
    let next: AsyncIterableIterator<WireVoiceState, undefined>
    try {
      next = calls.watch()
    } catch {
      // Voice is extra: a runner that can't follow it leaves the addon as it was.
      return
    }
    stream = next
    void (async () => {
      try {
        for await (const snapshot of next) {
          if (stream !== next) return
          state.update(() => snapshot)
        }
      } catch {
        // The runner closed, or has no voice input.
      }
      if (stream === next) stream = undefined
    })()
  }

  // Runs a call that changes the addon; the next snapshot shows its effect, and a
  // rejection shows meanwhile as the failure.
  const change = (what: string, call: () => Promise<void>): void => {
    track(call()).catch((error: unknown) =>
      state.update((current) => ({ ...current, failure: `Couldn't ${what}: ${reason(error)}` })),
    )
  }

  const record = (): VoiceClip => {
    const clipId = crypto.randomUUID()
    let pending: Int16Array[] = []
    let offset = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    // Uploads go one at a time, in order: the runner places each by its offset.
    let flights: Promise<void> = Promise.resolve()
    let failed: Error | undefined
    let ended = false
    // Samples still to take before the runner's limit: a stop that comes late, as from a
    // timer slowed in a hidden window, keeps the first two minutes instead of losing all.
    let room = maxVoiceSeconds * voiceSampleRate

    const send = async (): Promise<void> => {
      if (failed || !pending.length) return
      const bytes = littleEndian(pending)
      pending = []
      try {
        await calls.record(clipId, offset, bytes)
        offset += bytes.length
      } catch (error) {
        failed = clipFailure(error)
      }
    }
    const flush = (): Promise<void> => {
      clearTimeout(timer)
      timer = undefined
      flights = flights.then(send)
      return flights
    }

    return {
      append: (samples) => {
        if (ended || failed || room <= 0) return
        const kept = samples.length > room ? samples.subarray(0, room) : samples
        room -= kept.length
        pending.push(kept)
        timer ??= setTimeout(() => void flush(), flushMs)
      },
      finish: async (options) => {
        ended = true
        await flush()
        if (failed) throw failed
        if (!offset) throw new Error("Nothing was recorded.")
        try {
          return await calls.transcribe(clipId, options)
        } catch (error) {
          // The runner keeps a clip after a failed transcription for a retry, which
          // dictation never makes: let it go rather than leave the audio there.
          void calls.discard(clipId).catch(() => {})
          throw clipFailure(error)
        }
      },
      discard: () => {
        ended = true
        clearTimeout(timer)
        timer = undefined
        pending = []
        // After the upload under way, so the runner never sees audio for a forgotten clip.
        flights = flights.then(() => calls.discard(clipId).catch(() => {}))
      },
    }
  }

  return {
    voice: {
      state,
      install: (model: VoiceModel) => change("install voice input", () => calls.install(model)),
      cancel: () => change("cancel the install", () => calls.cancel()),
      uninstall: () => change("uninstall voice input", () => calls.uninstall()),
      set: (settings) => change("change voice input", () => calls.set(settings)),
      record,
    },
    follow,
    stop: () => {
      const current = stream
      stream = undefined
      void current?.return?.()
    },
  }
}

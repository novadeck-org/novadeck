import { maxVoiceSeconds, voiceSampleRate, type VoiceState } from "@novadeck/protocol"
import { RunnerError } from "@novadeck/protocol/client"
import { vi } from "vitest"

import { maxClipSeconds } from "../../model/voice"
import { context, describe, expect, it } from "../../test"
import { createRunnerVoice, flushMs, noVoice, type VoiceCalls } from "./voice"

const installed: VoiceState = { ...noVoice, installed: ["small" as const], model: "small" as const }

// The runner's voice calls, with the snapshots the test pushes streamed by `watch`.
const runner = (overrides: Partial<VoiceCalls> = {}) => {
  const queued: VoiceState[] = []
  let wake: (() => void) | undefined
  const mocks = {
    watch: vi.fn<VoiceCalls["watch"]>(() => {
      const iterator: AsyncIterableIterator<VoiceState, undefined> = {
        [Symbol.asyncIterator]: () => iterator,
        next: async () => {
          // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed snapshot.
          while (!queued.length) await new Promise<void>((resolve) => (wake = resolve))
          return { value: queued.shift()!, done: false }
        },
        return: async () => ({ value: undefined, done: true }),
      }
      return iterator
    }),
    install: vi.fn<VoiceCalls["install"]>(async () => {}),
    cancel: vi.fn<VoiceCalls["cancel"]>(async () => {}),
    uninstall: vi.fn<VoiceCalls["uninstall"]>(async () => {}),
    set: vi.fn<VoiceCalls["set"]>(async () => {}),
    record: vi.fn<VoiceCalls["record"]>(async () => {}),
    transcribe: vi.fn<VoiceCalls["transcribe"]>(async () => ({ text: "hello", language: "en" })),
    discard: vi.fn<VoiceCalls["discard"]>(async () => {}),
  }
  const calls = { ...mocks, ...overrides }
  const push = (state: VoiceState) => {
    queued.push(state)
    wake?.()
  }
  return { calls: mocks, push, ...createRunnerVoice(calls) }
}

describe("the runner's voice input", () => {
  it("shows nothing installed until the runner's first snapshot, then each one", async () => {
    const { voice, follow, push } = runner()
    expect(voice.state.getSnapshot()).toEqual(noVoice)
    follow()
    push(installed)
    await vi.waitFor(() => expect(voice.state.getSnapshot()).toEqual(installed))
  })

  context("when a call is refused", () => {
    it("shows why, until the next snapshot", async () => {
      const { voice, follow, push } = runner({
        install: async () => {
          throw new RunnerError("CONFLICT", "Already installing.")
        },
      })
      follow()
      voice.install("turbo")
      await vi.waitFor(() =>
        expect(voice.state.getSnapshot().failure).toBe(
          "Couldn't install voice input: Already installing.",
        ),
      )
      push(installed)
      await vi.waitFor(() => expect(voice.state.getSnapshot().failure).toBeNull())
    })
  })

  it("passes installs, settings, cancels and uninstalls to the runner", () => {
    const { voice, calls } = runner()
    voice.install("small")
    voice.set({ language: "pl" })
    voice.cancel()
    voice.uninstall()
    expect(calls.install).toHaveBeenCalledWith("small")
    expect(calls.set).toHaveBeenCalledWith({ language: "pl" })
    expect(calls.cancel).toHaveBeenCalled()
    expect(calls.uninstall).toHaveBeenCalled()
  })

  describe("a clip", () => {
    it("goes up as little-endian bytes in batches, each at the offset after the last", async () => {
      vi.useFakeTimers()
      try {
        const { voice, calls } = runner()
        const clip = voice.record()
        clip.append(Int16Array.of(1, -2))
        clip.append(Int16Array.of(0x0102))
        await vi.advanceTimersByTimeAsync(flushMs)
        clip.append(Int16Array.of(3))
        const finished = clip.finish({ prompt: "main.ts" })
        await vi.advanceTimersByTimeAsync(0)
        await expect(finished).resolves.toEqual({ text: "hello", language: "en" })
        const [first, second] = calls.record.mock.calls
        expect(first![1]).toBe(0)
        expect([...first![2]]).toEqual([1, 0, 0xfe, 0xff, 2, 1])
        expect(second![1]).toBe(6)
        expect([...second![2]]).toEqual([3, 0])
        expect(calls.transcribe).toHaveBeenCalledWith(first![0], { prompt: "main.ts" })
      } finally {
        vi.useRealTimers()
      }
    })

    it("keeps the first two minutes of a clip that runs over, instead of failing it", async () => {
      vi.useFakeTimers()
      try {
        const { voice, calls } = runner()
        const clip = voice.record()
        const limit = maxVoiceSeconds * voiceSampleRate
        clip.append(new Int16Array(limit - 10))
        clip.append(new Int16Array(100))
        clip.append(new Int16Array(100))
        const finished = clip.finish()
        await vi.advanceTimersByTimeAsync(0)
        await expect(finished).resolves.toMatchObject({ text: "hello" })
        const sent = calls.record.mock.calls.reduce((sum, call) => sum + call[2].length, 0)
        expect(sent).toBe(limit * 2)
      } finally {
        vi.useRealTimers()
      }
    })

    it("sends one batch at a time", async () => {
      let running = 0
      let most = 0
      const { voice, calls } = runner({
        record: async () => {
          running += 1
          most = Math.max(most, running)
          await new Promise((resolve) => setTimeout(resolve, 5))
          running -= 1
        },
      })
      const clip = voice.record()
      clip.append(Int16Array.of(1))
      await clip.finish()
      expect(most).toBe(1)
      expect(calls.transcribe).toHaveBeenCalledOnce()
    })

    it("says so when nothing was recorded, without asking the runner", async () => {
      const { voice, calls } = runner()
      await expect(voice.record().finish()).rejects.toThrow("Nothing was recorded.")
      expect(calls.transcribe).not.toHaveBeenCalled()
    })

    it("fails in words for the person when the clip is too long, or voice is off", async () => {
      const long = runner({
        record: async () => {
          throw new RunnerError("UPLOAD_TOO_LARGE", "too big")
        },
      })
      const clip = long.voice.record()
      clip.append(Int16Array.of(1))
      await expect(clip.finish()).rejects.toThrow(/too long to transcribe/)
      expect(long.calls.transcribe).not.toHaveBeenCalled()

      const off = runner({
        transcribe: async () => {
          throw new RunnerError("VOICE_UNAVAILABLE")
        },
      })
      const next = off.voice.record()
      next.append(Int16Array.of(1))
      await expect(next.finish()).rejects.toThrow(/Preferences/)

      // The runner's own reason, as while its engine updates, says more than the code.
      const updating = runner({
        record: async () => {
          throw new RunnerError(
            "VOICE_UNAVAILABLE",
            "Updating the voice engine. Try again when it is done.",
          )
        },
      })
      const later = updating.voice.record()
      later.append(Int16Array.of(1))
      await expect(later.finish()).rejects.toThrow("Updating the voice engine")
    })

    it("lets the runner forget a clip whose transcription failed", async () => {
      const { voice, calls } = runner({
        transcribe: async () => {
          throw new RunnerError("VOICE_FAILED", "engine crashed")
        },
      })
      const clip = voice.record()
      clip.append(Int16Array.of(1))
      await expect(clip.finish()).rejects.toThrow(/engine failed/)
      await vi.waitFor(() => expect(calls.discard).toHaveBeenCalledOnce())
    })

    it("is forgotten by the runner once discarded, after the upload under way", async () => {
      const { voice, calls } = runner()
      const clip = voice.record()
      clip.append(Int16Array.of(1))
      clip.discard()
      clip.append(Int16Array.of(2))
      await vi.waitFor(() => expect(calls.discard).toHaveBeenCalledOnce())
      expect(calls.record).not.toHaveBeenCalled()
      expect(calls.transcribe).not.toHaveBeenCalled()
    })
  })
})

describe("the longest dictation", () => {
  it("is what the protocol takes of a clip", () => {
    expect(maxClipSeconds).toBe(maxVoiceSeconds)
  })
})

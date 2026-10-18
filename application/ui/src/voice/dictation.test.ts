import { vi } from "vitest"

import { createStore, type MutableStore } from "#core/store"
import type { TerminalKey } from "#core/types"
import {
  maxClipSeconds,
  type Voice,
  type VoiceClip,
  type VoiceState,
  type VoiceTranscript,
} from "#core/voice"

import { context, describe, expect, it } from "../test"
import type { Capture, CaptureHandlers } from "./capture"
import {
  createDictation,
  failureMilliseconds,
  offerMilliseconds,
  readyMilliseconds,
  voiceReady,
  type DictationController,
} from "./dictation"

const target: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t1" }

const installed: VoiceState = {
  available: true,
  installed: ["turbo"],
  enabled: true,
  wanted: true,
  model: "turbo",
  aim: "turbo",
  engineInstalled: false,
  language: "auto",
  sizes: { engine: 1, turbo: 2, small: 1 },
  installing: null,
  check: null,
  failure: null,
  refused: null,
}

type FakeClip = VoiceClip & {
  readonly appended: number[]
  readonly terminals: (string | undefined)[]
  discarded: boolean
  resolve: (transcript: VoiceTranscript) => void
  reject: (failure: Error) => void
}

// A backend voice and microphone that record what they were asked, with a clock and
// timers the test turns by hand.
const setup = (state: VoiceState = installed) => {
  const clips: FakeClip[] = []
  const calls: string[] = []
  // What the install call answers with, where a test holds it.
  const gate: { pending: Promise<void> | undefined } = { pending: undefined }
  const voice: Voice = {
    state: createStore(state),
    install: () => {
      calls.push("install")
      return gate.pending ?? Promise.resolve()
    },
    cancel: () => void calls.push("cancel"),
    uninstall: () => {},
    set: (change) => void calls.push(`set ${JSON.stringify(change)}`),
    record: () => {
      const clip: FakeClip = {
        appended: [],
        terminals: [],
        discarded: false,
        append: (samples) => void clip.appended.push(samples.length),
        finish: (options) => {
          clip.terminals.push(options?.terminalId)
          return new Promise((resolve, reject) => {
            clip.resolve = resolve
            clip.reject = reject
          })
        },
        discard: () => void (clip.discarded = true),
        resolve: () => {},
        reject: () => {},
      }
      clips.push(clip)
      return clip
    },
  }
  const typed: { key: TerminalKey; text: string }[] = []
  // Whether the target terminal is still there to take text.
  const terminal = { open: true }
  const microphone: {
    handlers: CaptureHandlers[]
    stops: number
    // Whether a drain waits, as the real one does, until `land` lets the last words in.
    hold: boolean
    land: (() => void)[]
    settle: ((capture: Capture) => void)[]
    fail: ((failure: Error) => void)[]
  } = { handlers: [], stops: 0, hold: false, land: [], settle: [], fail: [] }
  let now = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let timerIds = 0
  const offers: string[] = []
  const controller: DictationController = createDictation({
    voice,
    offered: () => void offers.push("offer"),
    typeInto: (key, text) => {
      if (terminal.open) typed.push({ key, text })
      return terminal.open
    },
    startCapture: (handlers) =>
      new Promise((resolve, reject) => {
        microphone.handlers.push(handlers)
        microphone.settle.push(resolve)
        microphone.fail.push(reject)
      }),
    now: () => now,
    after: (milliseconds, run) => {
      const id = ++timerIds
      timers.set(id, { at: now + milliseconds, run })
      return () => void timers.delete(id)
    },
  })
  controller.start()
  const advance = (milliseconds: number): void => {
    now += milliseconds
    for (const [id, timer] of timers)
      if (timer.at <= now) {
        timers.delete(id)
        timer.run()
      }
  }
  // The microphone starts and delivers `seconds` of speech.
  const capture = (): Capture => ({
    stop: () => void microphone.stops++,
    drain: () => {
      microphone.stops++
      return microphone.hold
        ? new Promise((resolve) => void microphone.land.push(resolve))
        : Promise.resolve()
    },
  })
  const speak = async (seconds: number): Promise<void> => {
    microphone.settle.at(-1)!(capture())
    await Promise.resolve()
    microphone.handlers.at(-1)!.onSamples(new Int16Array(Math.round(seconds * 16_000)))
  }
  return {
    controller,
    clips,
    typed,
    terminal,
    microphone,
    capture,
    advance,
    speak,
    voice,
    offers,
    calls,
    gate,
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("voiceReady", () => {
  it("needs voice on and the chosen model on disk", () => {
    expect(voiceReady(installed)).toBe(true)
    expect(voiceReady({ ...installed, enabled: false })).toBe(false)
    expect(voiceReady({ ...installed, installed: ["small"] })).toBe(false)
    expect(voiceReady({ ...installed, installed: [] })).toBe(false)
  })
})

describe("dictation", () => {
  context("when held to speak", () => {
    it("starts a clip at once and pastes the transcript into the terminal on release", async () => {
      const app = setup()
      const { dictation, view } = app.controller
      dictation.press(target, "KeyM")
      expect(app.clips).toHaveLength(1)
      expect(view.getSnapshot()).toMatchObject({ phase: "recording", mode: "hold", target })
      await app.speak(2)
      app.advance(2000)
      dictation.release("KeyM")
      expect(view.getSnapshot().phase).toBe("transcribing")
      expect(app.microphone.stops).toBe(1)
      await flush()
      expect(app.clips[0]!.terminals).toEqual(["t1"])
      app.clips[0]!.resolve({ text: "  run the tests \n", language: "en" })
      await flush()
      expect(app.typed).toEqual([{ key: target, text: "run the tests" }])
      expect(view.getSnapshot()).toMatchObject({ phase: "idle", target: null })
      // It says the words went in, in the terminal they went to.
      expect(view.getSnapshot().notice).toEqual({ text: "Typed 3 words", tone: "done", target })
    })

    it("streams audio into the clip as it arrives", async () => {
      const app = setup()
      app.controller.dictation.press(target, "KeyM")
      await app.speak(1)
      expect(app.clips[0]!.appended).toEqual([16_000])
    })

    it("pastes nothing when the engine hears nothing, and says so", async () => {
      const app = setup()
      app.controller.dictation.press(target, "KeyM")
      await app.speak(1)
      app.advance(1000)
      app.controller.dictation.release("KeyM")
      await flush()
      app.clips[0]!.resolve({ text: "  ", language: "en" })
      await flush()
      expect(app.typed).toEqual([])
      expect(app.controller.view.getSnapshot().notice).toMatchObject({ tone: "hint", target })
    })

    it("transcribes when the window loses focus", async () => {
      const app = setup()
      app.controller.dictation.press(target, "KeyM")
      await app.speak(1)
      app.advance(1000)
      app.controller.dictation.blur()
      expect(app.controller.view.getSnapshot().phase).toBe("transcribing")
    })
  })

  context("when tapped for hands-free recording", () => {
    it("keeps recording after a quick release and stops on the next press", async () => {
      const app = setup()
      const { dictation, view } = app.controller
      dictation.press(target, "KeyM")
      app.advance(120)
      dictation.release("KeyM")
      expect(view.getSnapshot()).toMatchObject({ phase: "recording", mode: "toggle" })
      await app.speak(3)
      app.advance(3000)
      dictation.press(target, "KeyM")
      dictation.release("KeyM")
      expect(view.getSnapshot().phase).toBe("transcribing")
    })
  })

  context("when the mic button is clicked", () => {
    it("records until clicked again", async () => {
      const app = setup()
      const { dictation, view } = app.controller
      dictation.toggle(target)
      await app.speak(1)
      app.advance(1000)
      expect(dictation.recording()).toBe(true)
      dictation.toggle(target)
      expect(view.getSnapshot().phase).toBe("transcribing")
    })
  })

  context("when the clip is a slip of the key", () => {
    it("drops under 300 ms of audio without a word", async () => {
      const app = setup()
      const { dictation, view } = app.controller
      dictation.toggle(target)
      await app.speak(0.2)
      dictation.toggle(target)
      await flush()
      expect(app.clips[0]!.discarded).toBe(true)
      expect(app.microphone.stops).toBe(1)
      expect(view.getSnapshot()).toMatchObject({ phase: "idle", notice: null })
    })
  })

  context("when cancelled", () => {
    it("discards the clip, releases the microphone and pastes nothing", async () => {
      const app = setup()
      app.controller.dictation.press(target, "KeyM")
      await app.speak(2)
      app.controller.dictation.cancel()
      expect(app.clips[0]!.discarded).toBe(true)
      expect(app.microphone.stops).toBe(1)
      expect(app.controller.view.getSnapshot().phase).toBe("idle")
      app.controller.dictation.release("KeyM")
      await flush()
      expect(app.typed).toEqual([])
    })

    it("lets the microphone go if it was still asking when cancelled", async () => {
      const app = setup()
      app.controller.dictation.press(target, "KeyM")
      app.controller.dictation.cancel()
      app.microphone.settle[0]!(app.capture())
      await flush()
      expect(app.microphone.stops).toBe(1)
    })

    it("ignores audio that arrives late", async () => {
      const app = setup()
      app.controller.dictation.press(target, "KeyM")
      const [handlers] = app.microphone.handlers
      app.controller.dictation.cancel()
      handlers!.onSamples(new Int16Array(100))
      expect(app.clips[0]!.appended).toEqual([])
    })
  })

  context("when the microphone is still taking in the last words", () => {
    it("counts and sends what lands before the drain ends", async () => {
      const app = setup()
      app.microphone.hold = true
      app.controller.dictation.toggle(target)
      await app.speak(1)
      app.controller.dictation.toggle(target)
      await flush()
      expect(app.clips[0]!.terminals).toEqual([])
      app.microphone.handlers[0]!.onSamples(new Int16Array(1600))
      app.microphone.land[0]!()
      await flush()
      expect(app.clips[0]!.appended).toEqual([16_000, 1600])
      expect(app.clips[0]!.terminals).toHaveLength(1)
    })

    it("lets a cancel discard at once and release the microphone", async () => {
      const app = setup()
      app.microphone.hold = true
      app.controller.dictation.toggle(target)
      await app.speak(1)
      app.controller.dictation.toggle(target)
      const stops = app.microphone.stops
      app.controller.dictation.cancel()
      expect(app.microphone.stops).toBe(stops + 1)
      expect(app.clips[0]!.discarded).toBe(true)
      app.microphone.handlers[0]!.onSamples(new Int16Array(1600))
      app.microphone.land[0]!()
      await flush()
      expect(app.clips[0]!.appended).toEqual([16_000])
      expect(app.clips[0]!.terminals).toEqual([])
      expect(app.controller.view.getSnapshot().phase).toBe("idle")
    })
  })

  context("when the recording reaches the backend's limit", () => {
    it("stops and transcribes by itself", async () => {
      const app = setup()
      app.controller.dictation.toggle(target)
      await app.speak(5)
      app.advance(maxClipSeconds * 1000 - 1)
      expect(app.controller.dictation.recording()).toBe(true)
      app.advance(1)
      expect(app.controller.view.getSnapshot().phase).toBe("transcribing")
    })
  })

  it("records while an update replaces the engine, which the runner keeps serving", () => {
    const app = setup({
      ...installed,
      installing: { origin: "person", model: "turbo", step: "engine", received: 1, total: 2 },
    })
    app.controller.dictation.press(target, "KeyM")
    expect(app.clips).toHaveLength(1)
  })

  context("when dictation is not set up", () => {
    const busy: VoiceState = {
      ...installed,
      enabled: false,
      installing: { origin: "person", model: "turbo", step: "model", received: 1, total: 2 },
    }
    it("starts nothing and says voice input is still installing", () => {
      const app = setup(busy)
      app.controller.dictation.press(target, "KeyM")
      expect(app.clips).toHaveLength(0)
      expect(app.controller.view.getSnapshot().notice?.text).toContain("still installing")
    })

    it("asks for a terminal when there is none to type into", () => {
      const app = setup()
      app.controller.dictation.press(undefined, "KeyM")
      expect(app.clips).toHaveLength(0)
      expect(app.controller.view.getSnapshot().notice?.text).toContain("Select a terminal")
    })

    it("lets the hint fade after a few seconds", () => {
      const app = setup(busy)
      app.controller.dictation.press(target, "KeyM")
      app.advance(4000)
      expect(app.controller.view.getSnapshot().notice).toBeNull()
    })
  })

  context("when voice input is not installed", () => {
    const notInstalled = { ...installed, installed: [], enabled: false }

    it("offers to install it when the shortcut is pressed, saying nothing else", () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      expect(app.offers).toEqual(["offer"])
      expect(app.clips).toHaveLength(0)
      expect(app.controller.view.getSnapshot().notice).toBeNull()
    })

    it("offers it when the mic is clicked, and again the next time", () => {
      const app = setup(notInstalled)
      app.controller.dictation.toggle(target)
      app.controller.setupActions.dismiss()
      app.controller.dictation.toggle(target)
      expect(app.offers).toEqual(["offer", "offer"])
    })

    it("offers it again after an install that failed", () => {
      const app = setup({ ...notInstalled, installed: ["small"], failure: "Out of disk space." })
      app.controller.dictation.press(target, "KeyM")
      expect(app.offers).toEqual(["offer"])
    })

    it("offers it again after a cancel that left a model on disk, never checked", () => {
      const app = setup({ ...notInstalled, installed: ["small"], model: "small", check: null })
      app.controller.dictation.press(target, "KeyM")
      expect(app.offers).toEqual(["offer"])
      expect(app.clips).toHaveLength(0)
    })

    it("does not offer it while it installs, and says so", () => {
      const app = setup({
        ...notInstalled,
        installing: { origin: "person", model: "turbo", step: "model", received: 1, total: 2 },
      })
      app.controller.dictation.press(target, "KeyM")
      expect(app.offers).toEqual([])
      expect(app.controller.view.getSnapshot().notice?.text).toContain("still installing")
    })

    it("does not offer it once the person said no thanks", () => {
      const app = setup({ ...notInstalled, wanted: false })
      app.controller.dictation.press(target, "KeyM")
      expect(app.offers).toEqual([])
    })
  })

  context("voice input's setup in the strip", () => {
    const notInstalled = { ...installed, installed: [], enabled: false }
    const update = (app: ReturnType<typeof setup>, change: Partial<VoiceState>): void => {
      ;(app.voice.state as MutableStore<VoiceState>).update((state) => ({ ...state, ...change }))
    }
    const kind = (app: ReturnType<typeof setup>) => app.controller.setup.getSnapshot()?.kind

    it("offers on the terminal reached from, and notes that it was offered", () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      expect(app.controller.setup.getSnapshot()).toEqual({ kind: "offer", target })
      expect(app.offers).toEqual(["offer"])
    })

    it("offers on no terminal where none was chosen", () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(undefined, "KeyM")
      expect(app.controller.setup.getSnapshot()).toEqual({ kind: "offer", target: null })
    })

    it("turns voice input on when the shortcut is pressed again, never recording", () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.controller.dictation.press(target, "KeyM")
      expect(app.calls).toEqual(["install"])
      expect(kind(app)).toBe("installing")
      expect(app.clips).toHaveLength(0)
    })

    it("ignores the offer after a while, which is not an answer", () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.advance(offerMilliseconds)
      expect(kind(app)).toBeUndefined()
      expect(app.calls).toEqual([])
      app.controller.dictation.press(target, "KeyM")
      expect(kind(app)).toBe("offer")
    })

    it("dismisses the offer without installing or declining anything", () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.controller.setupActions.dismiss()
      expect(kind(app)).toBeUndefined()
      expect(app.calls).toEqual([])
    })

    it("declines on No thanks, by turning voice input off", () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.controller.setupActions.noThanks()
      expect(app.calls).toEqual(['set {"enabled":false}'])
      expect(kind(app)).toBeUndefined()
    })

    it("follows the install to the ready note, which goes by itself", async () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.controller.setupActions.turnOn()
      await flush()
      update(app, {
        installing: { origin: "person", model: "turbo", step: "model", received: 1, total: 2 },
      })
      expect(kind(app)).toBe("installing")
      update(app, { ...installed, installing: null })
      expect(kind(app)).toBe("ready")
      app.advance(readyMilliseconds)
      expect(kind(app)).toBeUndefined()
    })

    it("shows an install's failure, not as a decline, and drops it after a while", async () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.controller.setupActions.turnOn()
      await flush()
      update(app, {
        installing: { origin: "person", model: "turbo", step: "model", received: 1, total: 2 },
      })
      update(app, { installing: null, failure: "Out of disk space." })
      expect(kind(app)).toBe("failed")
      app.advance(failureMilliseconds)
      expect(kind(app)).toBeUndefined()
      expect(app.voice.state.getSnapshot().wanted).toBe(true)
    })

    it("turns on when the mic is clicked while the offer shows", () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.controller.dictation.toggle(target)
      expect(app.calls).toEqual(["install"])
      expect(kind(app)).toBe("installing")
    })

    it("offers on another terminal when its mic is clicked, and only turns on for the offer's own", () => {
      const app = setup(notInstalled)
      const other = { ...target, terminalId: "t2" }
      app.controller.dictation.press(target, "KeyM")

      app.controller.dictation.toggle(other)

      expect(app.calls).toEqual([])
      expect(app.controller.setup.getSnapshot()).toEqual({ kind: "offer", target: other })
      app.controller.dictation.toggle(other)
      expect(app.calls).toEqual(["install"])
    })

    it("clears the ready note and a failure as a clip starts, so its own result shows", async () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.controller.setupActions.turnOn()
      await flush()
      update(app, {
        installing: { origin: "person", model: "turbo", step: "model", received: 1, total: 2 },
      })
      update(app, { ...installed, installing: null })
      expect(kind(app)).toBe("ready")

      app.controller.dictation.press(target, "KeyM")

      expect(kind(app)).toBeUndefined()
      expect(app.clips).toHaveLength(1)
    })

    it("ignores a snapshot from before the install call is through", async () => {
      const app = setup(notInstalled)
      let through = (): void => {}
      app.gate.pending = new Promise<void>((resolve) => {
        through = resolve
      })
      app.controller.dictation.press(target, "KeyM")
      app.controller.setupActions.turnOn()

      // A stale snapshot: no install, and a failure from long ago.
      update(app, { installing: null, failure: "Old failure." })
      expect(kind(app)).toBe("installing")

      update(app, {
        installing: { origin: "person", model: "turbo", step: "model", received: 1, total: 2 },
      })
      through()
      await flush()
      expect(kind(app)).toBe("installing")
    })

    it("shows the backend's refusal of the install call as a failure, not that of a setting", async () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.controller.setupActions.turnOn()
      await flush()
      update(app, { refused: { call: "install", message: "Voice input is already installing." } })
      expect(kind(app)).toBe("failed")
    })

    it("shows nothing after a cancel, and nothing for a refused setting", async () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      app.controller.setupActions.turnOn()
      await flush()
      update(app, {
        installing: { origin: "person", model: "turbo", step: "model", received: 1, total: 2 },
      })
      update(app, { installing: null })
      expect(kind(app)).toBeUndefined()

      app.controller.dictation.press(target, "KeyM")
      app.controller.setupActions.turnOn()
      await flush()
      update(app, {
        installing: { origin: "person", model: "turbo", step: "model", received: 1, total: 2 },
      })
      update(app, { refused: { call: "set", message: "No." } })
      expect(kind(app)).toBe("installing")
      // The install ends with only that refusal on record: not a failure of the install.
      update(app, { installing: null })
      expect(kind(app)).toBeUndefined()
    })

    it("drops the setup once voice input is declined elsewhere", () => {
      const app = setup(notInstalled)
      app.controller.dictation.press(target, "KeyM")
      update(app, { wanted: false })
      expect(kind(app)).toBeUndefined()
    })
  })

  context("whose shortcut is it", () => {
    it("is dictation's while voice input is wanted, installed or not", () => {
      expect(setup().controller.dictation.claims()).toBe(true)
      expect(
        setup({ ...installed, installed: [], enabled: false }).controller.dictation.claims(),
      ).toBe(true)
    })

    it("is the terminal's once voice input is off or declined, or where there is none", () => {
      expect(setup({ ...installed, wanted: false }).controller.dictation.claims()).toBe(false)
      expect(setup({ ...installed, available: false }).controller.dictation.claims()).toBe(false)
    })

    it("stays dictation's while a clip is recorded", () => {
      const app = setup()
      app.controller.dictation.press(target, "KeyM")
      ;(app.voice.state as MutableStore<VoiceState>).update((state) => ({
        ...state,
        wanted: false,
      }))
      expect(app.controller.dictation.claims()).toBe(true)
    })
  })

  context("when the microphone can't start", () => {
    it("says why, releases the clip and goes idle", async () => {
      const app = setup()
      app.controller.dictation.press(target, "KeyM")
      app.microphone.fail[0]!(new Error("No microphone found."))
      await flush()
      expect(app.clips[0]!.discarded).toBe(true)
      expect(app.controller.view.getSnapshot()).toMatchObject({
        phase: "idle",
        notice: { text: "No microphone found.", tone: "error" },
      })
    })
  })

  context("when the transcription fails", () => {
    it("shows the backend's reason and pastes nothing", async () => {
      const app = setup()
      app.controller.dictation.toggle(target)
      await app.speak(1)
      app.controller.dictation.toggle(target)
      await flush()
      app.clips[0]!.reject(new Error("The speech engine isn't running."))
      await flush()
      expect(app.typed).toEqual([])
      expect(app.controller.view.getSnapshot()).toMatchObject({
        phase: "idle",
        notice: { text: "The speech engine isn't running.", tone: "error" },
      })
    })
  })

  context("when the terminal wasn't taking input as the text arrived", () => {
    const dictate = async (app: ReturnType<typeof setup>): Promise<void> => {
      app.controller.dictation.toggle(target)
      await app.speak(1)
      app.controller.dictation.toggle(target)
      app.terminal.open = false
      await flush()
      app.clips[0]!.resolve({ text: "run the tests", language: "en" })
      await flush()
    }

    it("copies the text to the clipboard and says so", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
      vi.stubGlobal("navigator", { clipboard: { writeText } })
      try {
        const app = setup()
        await dictate(app)
        expect(writeText).toHaveBeenCalledWith("run the tests")
        expect(app.controller.view.getSnapshot().notice).toEqual({
          text: "The terminal wasn't taking input when the text arrived. The text is on your clipboard.",
          tone: "error",
          target,
        })
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it("shows the text itself where the clipboard can't take it", async () => {
      vi.stubGlobal("navigator", {})
      try {
        const app = setup()
        await dictate(app)
        expect(app.controller.view.getSnapshot().notice).toEqual({
          text: "The terminal wasn't taking input when the text arrived: run the tests",
          tone: "error",
          target,
        })
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  context("when cancelled while transcribing", () => {
    it("goes idle at once and throws the transcript away", async () => {
      const app = setup()
      app.controller.dictation.toggle(target)
      await app.speak(1)
      app.controller.dictation.toggle(target)
      expect(app.controller.dictation.active()).toBe(true)
      app.controller.dictation.cancel()
      expect(app.controller.view.getSnapshot().phase).toBe("idle")
      app.clips[0]!.resolve({ text: "run the tests", language: "en" })
      await flush()
      expect(app.typed).toEqual([])
      expect(app.controller.view.getSnapshot().notice).toBeNull()
    })

    it("lets a new recording start without the old one ending it", async () => {
      const app = setup()
      app.controller.dictation.toggle(target)
      await app.speak(1)
      app.controller.dictation.toggle(target)
      app.controller.dictation.cancel()
      app.controller.dictation.toggle(target)
      app.clips[0]!.resolve({ text: "stale", language: "en" })
      await flush()
      expect(app.controller.view.getSnapshot().phase).toBe("recording")
      expect(app.typed).toEqual([])
    })
  })

  context("while a transcription runs", () => {
    it("takes no second clip", async () => {
      const app = setup()
      app.controller.dictation.toggle(target)
      await app.speak(1)
      app.controller.dictation.toggle(target)
      app.controller.dictation.press(target, "KeyM")
      expect(app.clips).toHaveLength(1)
    })
  })

  it("shares the microphone's level through a store of its own", async () => {
    const app = setup()
    app.controller.dictation.toggle(target)
    app.microphone.handlers[0]!.onLevel(0.6)
    expect(app.controller.level.getSnapshot()).toBe(0.6)
    app.controller.dictation.cancel()
    expect(app.controller.level.getSnapshot()).toBe(0)
  })
})

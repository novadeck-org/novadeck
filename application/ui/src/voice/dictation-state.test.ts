import type { TerminalKey } from "../model/types"
import { context, describe, expect, it } from "../test"
import {
  idle,
  stepDictation,
  tapMilliseconds,
  type Dictating,
  type DictationEvent,
  type Readiness,
  type Step,
} from "./dictation-state"

const target: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t1" }
const ready: Readiness = { ready: true }
const off: Readiness = { ready: false, hint: "Set it up in Preferences → Addons." }

const press = (now: number, extra: Partial<Extract<DictationEvent, { type: "press" }>> = {}) =>
  ({ type: "press", code: "KeyM", target, now, readiness: ready, ...extra }) as const
const release = (now: number, code = "KeyM") => ({ type: "release", code, now }) as const

// Plays events in order, returning every step's effects and the state at the end.
const play = (...events: DictationEvent[]): { state: Dictating; effects: Step["effects"][] } =>
  events.reduce<{ state: Dictating; effects: Step["effects"][] }>(
    ({ state, effects }, event) => {
      const step = stepDictation(state, event)
      return { state: step.state, effects: [...effects, step.effects] }
    },
    { state: idle, effects: [] },
  )

describe("dictation state", () => {
  context("when the shortcut is held", () => {
    it("records from the press and transcribes on release", () => {
      const { state, effects } = play(press(1000), release(1000 + tapMilliseconds + 1))
      expect(effects).toEqual([[{ kind: "start", target }], [{ kind: "stop", target }]])
      expect(state).toEqual({ kind: "transcribing", target })
    })

    it("follows the main key by code, whatever modifiers come up first", () => {
      const { state } = play(press(0), release(900, "ControlLeft"), release(950, "ShiftLeft"))
      expect(state).toMatchObject({ kind: "recording", mode: "hold" })
      expect(play(press(0), release(900, "KeyM")).state.kind).toBe("transcribing")
    })

    it("transcribes when the window loses focus mid-hold", () => {
      const { state, effects } = play(press(0), { type: "blur" })
      expect(state.kind).toBe("transcribing")
      expect(effects.at(-1)).toEqual([{ kind: "stop", target }])
    })

    it("ignores a second key pressed during the hold", () => {
      const { state } = play(press(0), press(500, { code: "KeyK" }))
      expect(state).toMatchObject({ kind: "recording", mode: "hold", code: "KeyM" })
    })
  })

  context("when the shortcut is only tapped", () => {
    it("leaves a hands-free recording running after the quick release", () => {
      const { state, effects } = play(press(0), release(tapMilliseconds - 1))
      expect(state).toMatchObject({ kind: "recording", mode: "toggle", code: null })
      expect(effects.at(-1)).toEqual([])
    })

    it("stops on the next press, and its release does nothing", () => {
      const { state, effects } = play(press(0), release(100), press(5000), release(5100))
      expect(state).toEqual({ kind: "transcribing", target })
      expect(effects.flat()).toEqual([
        { kind: "start", target },
        { kind: "stop", target },
      ])
    })

    it("carries on when the window loses focus", () => {
      expect(play(press(0), release(100), { type: "blur" }).state.kind).toBe("recording")
    })
  })

  context("when the mic button is clicked", () => {
    const click = (now: number) => ({ type: "toggle", target, now, readiness: ready }) as const

    it("starts a hands-free recording and stops it on the next click", () => {
      expect(play(click(0)).state).toMatchObject({ kind: "recording", mode: "toggle" })
      expect(play(click(0), click(2000)).effects.at(-1)).toEqual([{ kind: "stop", target }])
    })

    it("ends a recording the shortcut began hands-free", () => {
      expect(play(press(0), release(50), click(3000)).state.kind).toBe("transcribing")
    })

    it("ends a hold too, whose release then does nothing", () => {
      const { state } = play(press(0), click(500), release(900))
      expect(state.kind).toBe("transcribing")
    })
  })

  context("when recording is cancelled", () => {
    it("drops the clip without transcribing", () => {
      const { state, effects } = play(press(0), { type: "cancel" })
      expect(state).toEqual(idle)
      expect(effects.at(-1)).toEqual([{ kind: "discard" }])
    })

    it("lets a held key's release go by afterwards", () => {
      expect(play(press(0), { type: "cancel" }, release(2000)).state).toEqual(idle)
    })

    it("drops a transcription under way", () => {
      const { state, effects } = play(press(0), release(2000), { type: "cancel" })
      expect(state).toEqual(idle)
      expect(effects.at(-1)).toEqual([{ kind: "drop" }])
    })
  })

  context("when the recording runs as long as the backend takes", () => {
    it("stops and transcribes", () => {
      expect(play(press(0), { type: "limit" }).state.kind).toBe("transcribing")
    })

    it("does nothing after the clip has already ended", () => {
      expect(play({ type: "limit" }).state).toEqual(idle)
    })
  })

  context("when dictation can't start", () => {
    it("says why and stays idle", () => {
      const { state, effects } = play(press(0, { readiness: off }))
      expect(state).toEqual(idle)
      expect(effects).toEqual([
        [{ kind: "hint", text: off.ready ? "" : off.hint, target, setup: true }],
      ])
    })

    it("asks for a terminal when none is selected", () => {
      const { state, effects } = play(press(0, { target: undefined }))
      expect(state).toEqual(idle)
      expect(effects[0]).toEqual([{ kind: "hint", text: "Select a terminal to dictate into." }])
    })

    it("hints from the mic button too", () => {
      const { effects } = play({ type: "toggle", target, now: 0, readiness: off })
      expect(effects[0]).toMatchObject([{ kind: "hint" }])
    })
  })

  context("while a transcription runs", () => {
    it("takes no new recording until it settles", () => {
      const busy = play(press(0), release(1000))
      expect(stepDictation(busy.state, press(1500)).effects).toEqual([])
      expect(stepDictation(busy.state, press(1500)).state).toEqual(busy.state)
      expect(stepDictation(busy.state, { type: "settled" }).state).toEqual(idle)
    })
  })

  it("returns to idle when a recording fails to start", () => {
    expect(play(press(0), { type: "settled" }).state).toEqual(idle)
  })
})

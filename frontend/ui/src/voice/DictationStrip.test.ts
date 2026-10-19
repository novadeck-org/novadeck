import { createStore, type MutableStore } from "@novadeck/core/store"
import type { TerminalKey } from "@novadeck/core/types"
import type { VoiceState } from "@novadeck/core/voice"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { describe, expect, it } from "../test"
import { Shown } from "../ui-toolkit/shown"
import {
  dictationKey,
  type DictationController,
  type DictationView,
  type VoiceSetup,
} from "./dictation"
import { DictationStrip } from "./DictationStrip"

const terminal: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t1" }

const calls: string[] = []
const voiceState: VoiceState = {
  available: true,
  installed: [],
  enabled: false,
  wanted: true,
  model: "turbo",
  aim: "turbo",
  engineInstalled: false,
  language: "auto",
  sizes: { engine: 28 * 1024 * 1024, turbo: 574 * 1024 * 1024, small: 190 * 1024 * 1024 },
  installing: null,
  check: null,
  failure: null,
  refused: null,
}

const controller = (): DictationController => ({
  dictation: {
    recording: () => false,
    active: () => false,
    claims: () => true,
    press: () => {},
    release: () => {},
    blur: () => {},
    cancel: () => {},
    toggle: () => {},
  },
  view: createStore<DictationView>({
    phase: "idle",
    target: null,
    mode: null,
    startedAt: 0,
    notice: null,
  }),
  level: createStore(0),
  docks: createStore<ReadonlyMap<string, number>>(new Map()),
  voice: createStore<VoiceState>(voiceState),
  setup: createStore<VoiceSetup | null>(null),
  setupActions: {
    turnOn: () => void calls.push("turn on"),
    noThanks: () => void calls.push("no thanks"),
    cancel: () => void calls.push("cancel"),
    dismiss: () => {},
  },
  start: () => () => {},
})

const strip = (each: DictationController, shown: boolean) =>
  createElement(
    Shown,
    { value: shown },
    createElement(DictationStrip, {
      controller: each,
      terminalKey: terminal,
      edge: "bottom",
      stopKeys: ["Ctrl", "Shift", "M"],
      onSetup: () => {},
    }),
  )

const docked = (each: DictationController): number | undefined =>
  each.docks.getSnapshot().get(dictationKey(terminal))

describe("a terminal's dictation strip", () => {
  it("shows its terminal's dictation while the terminal is on screen", () => {
    const each = controller()
    const view = render(strip(each, true))
    expect(docked(each)).toBe(1)
    view.unmount()
    expect(docked(each)).toBeUndefined()
  })

  it("leaves it to the footer while a view keeps the terminal out of sight", () => {
    const each = controller()
    const view = render(strip(each, true))
    view.rerender(strip(each, false))
    expect(docked(each)).toBeUndefined()
    view.rerender(strip(each, true))
    expect(docked(each)).toBe(1)
    view.unmount()
  })
})

const setupOf = (each: DictationController, setup: VoiceSetup | null): void => {
  ;(each.setup as MutableStore<VoiceSetup | null>).update(() => setup)
}

describe("voice input's setup in a terminal's strip", () => {
  it("offers on the terminal reached from, with its size and two answers", () => {
    const each = controller()
    setupOf(each, { kind: "offer", target: terminal })
    const view = render(strip(each, true))
    const text = view.container.textContent ?? ""
    expect(text).toContain("Talk to your agents. Voice input runs on this computer")
    expect(text).toContain("602 MB once")
    expect(view.container.querySelector("[title*='Preferences']")).not.toBeNull()
    // The size stays in a part of its own, which a narrow tile does not hide.
    expect(view.container.querySelector(".dictation-fixed")?.textContent).toContain("602 MB once")
    expect(view.container.querySelector(".dictation-short")?.textContent).toBe("Voice input")
    const buttons = [...view.container.querySelectorAll("button")]
    expect(buttons.map((one) => one.textContent)).toEqual(["No thanks", "Turn on"])
    calls.length = 0
    act(() => buttons[1]!.click())
    act(() => buttons[0]!.click())
    expect(calls).toEqual(["turn on", "no thanks"])
    expect(view.container.querySelector("[role=status]")?.hasAttribute("hidden")).toBe(false)
    view.unmount()
  })

  it("says no size when nothing is left to download", () => {
    const each = controller()
    ;(each.voice as MutableStore<VoiceState>).update((state) => ({
      ...state,
      engineInstalled: true,
      installed: ["turbo"],
    }))
    setupOf(each, { kind: "offer", target: terminal })
    const view = render(strip(each, true))
    expect(view.container.textContent).toContain("runs on this computer")
    expect(view.container.textContent).not.toContain("MB")
    expect(view.container.querySelector(".dictation-fixed")).toBeNull()
    view.unmount()
  })

  it("stays hidden on another terminal's strip, and for no setup", () => {
    const each = controller()
    setupOf(each, { kind: "offer", target: { ...terminal, terminalId: "t2" } })
    const view = render(strip(each, true))
    expect(view.container.querySelector("[role=status]")?.hasAttribute("hidden")).toBe(true)
    view.unmount()
  })

  it("shows the install's step and size, a bar and Cancel, with the numbers out of the live region's reading", () => {
    const each = controller()
    ;(each.voice as MutableStore<VoiceState>).update((state) => ({
      ...state,
      installing: {
        origin: "person",
        model: "turbo",
        step: "model",
        received: 215 * 1024 * 1024,
        total: 574 * 1024 * 1024,
      },
    }))
    setupOf(each, { kind: "installing", target: terminal })
    const view = render(strip(each, true))
    expect(view.container.textContent).toContain("Setting up voice input")
    expect(view.container.textContent).toContain("215 MB of 574 MB")
    expect(
      view.container.querySelector("[aria-hidden=true] [role=progressbar], [role=progressbar]"),
    ).not.toBeNull()
    expect(
      [...view.container.querySelectorAll("[aria-hidden=true]")].some((one) =>
        one.textContent?.includes("215 MB"),
      ),
    ).toBe(true)
    expect([...view.container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Cancel",
    ])
    view.unmount()
  })

  it("shows the ready note with the shortcut as keycaps", () => {
    const each = controller()
    setupOf(each, { kind: "ready", target: terminal })
    const view = render(strip(each, true))
    expect(view.container.textContent).toContain("Voice input is ready.")
    expect(view.container.textContent).toContain("to talk.")
    expect(view.container.querySelectorAll("kbd").length).toBeGreaterThan(1)
    view.unmount()
  })

  it("keeps saying why an install failed once the refusal that told it is cleared", () => {
    const each = controller()
    ;(each.voice as MutableStore<VoiceState>).update((state) => ({
      ...state,
      refused: { call: "install", message: "Out of disk space." },
    }))
    setupOf(each, { kind: "failed", target: terminal })
    const view = render(strip(each, true))
    expect(view.container.textContent).toContain("Out of disk space.")
    act(() => {
      ;(each.voice as MutableStore<VoiceState>).update((state) => ({ ...state, refused: null }))
    })
    expect(view.container.textContent).toContain("Voice input didn't install: Out of disk space.")
    view.unmount()
  })

  it("shows a failure with Try again", () => {
    const each = controller()
    ;(each.voice as MutableStore<VoiceState>).update((state) => ({
      ...state,
      failure: "Out of disk space.",
    }))
    setupOf(each, { kind: "failed", target: terminal })
    const view = render(strip(each, true))
    expect(view.container.textContent).toContain("Voice input didn't install: Out of disk space.")
    // A failure that already names voice input is not prefixed again.
    act(() => {
      ;(each.voice as MutableStore<VoiceState>).update((state) => ({
        ...state,
        failure: "Couldn't install voice input: no network.",
      }))
    })
    expect(view.container.textContent).not.toContain("didn't install: Couldn't")
    calls.length = 0
    act(() =>
      [...view.container.querySelectorAll("button")]
        .find((b) => b.textContent === "Try again")
        ?.click(),
    )
    expect(calls).toEqual(["turn on"])
    view.unmount()
  })
})

import { createElement } from "react"

import { createStore } from "../model/store"
import type { TerminalKey } from "../model/types"
import { describe, expect, it } from "../test"
import { render } from "../test/render"
import { Shown } from "../ui-toolkit/shown"
import { dictationKey, type DictationController, type DictationView } from "./dictation"
import { DictationStrip } from "./DictationStrip"

const terminal: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t1" }

const controller = (): DictationController => ({
  dictation: {
    recording: () => false,
    active: () => false,
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
})

const strip = (each: DictationController, shown: boolean) =>
  createElement(
    Shown,
    { value: shown },
    createElement(DictationStrip, {
      controller: each,
      terminalKey: terminal,
      edge: "bottom",
      stopKeys: [],
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

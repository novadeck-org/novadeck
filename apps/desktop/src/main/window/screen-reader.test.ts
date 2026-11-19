import type { IpcMainEvent } from "electron"

import { screenReaderChannel, screenReaderRequestChannel, tellsScreenReader } from "../../bridge.js"
import { describe, expect, it } from "../../test"
import { registerScreenReaderIpc, screenReaderPollMs } from "./screen-reader"

type Told = { readonly page: string; readonly running: boolean }

const registered = ({ own = true, running = false }: { own?: boolean; running?: boolean }) => {
  const listeners = new Map<string, (event: IpcMainEvent) => void>()
  let changed: (() => void) | undefined
  let poll: (() => void) | undefined
  let pollMs = 0
  let enabled = running
  const told: Told[] = []
  const pageNamed = (name: string) => ({
    send: (channel: string, value: boolean) => {
      if (channel === screenReaderChannel) told.push({ page: name, running: value })
    },
  })
  registerScreenReaderIpc(
    { on: (channel, listener) => void listeners.set(channel, listener) },
    {
      isAccessibilitySupportEnabled: () => enabled,
      on: (_event, listener) => {
        changed = listener
      },
    },
    {
      page: () => (own ? pageNamed("asking") : undefined),
      pages: () => [pageNamed("first"), pageNamed("second")],
      every: (check, ms) => {
        poll = check
        pollMs = ms
        return () => {}
      },
    },
  )
  const ask = (): void => listeners.get(screenReaderRequestChannel)?.({} as IpcMainEvent)
  // Support turns on or off without Electron's event, as VoiceOver turned on does.
  const turn = (next: boolean): void => {
    enabled = next
  }
  return { ask, turn, told, event: () => changed?.(), poll: () => poll?.(), pollMs: () => pollMs }
}

describe("telling the app's pages whether a screen reader runs", () => {
  it("answers a page's request with whether one runs now", () => {
    const { ask, told } = registered({ running: true })
    ask()
    expect(told).toEqual([{ page: "asking", running: true }])
  })

  it("drops a request from any other sender", () => {
    const { ask, told } = registered({ own: false })
    ask()
    expect(told).toEqual([])
  })

  it("tells every page of a change it finds on its next look, with no event", () => {
    const { turn, poll, pollMs, told } = registered({})
    expect(pollMs()).toBe(screenReaderPollMs)
    turn(true)
    poll()
    poll()
    turn(false)
    poll()
    expect(told).toEqual([
      { page: "first", running: true },
      { page: "second", running: true },
      { page: "first", running: false },
      { page: "second", running: false },
    ])
  })

  it("looks again on Electron's event rather than trusting it, and tells only a change", () => {
    const { turn, event, told } = registered({})
    event()
    expect(told).toEqual([])
    turn(true)
    event()
    expect(told.map((each) => each.running)).toEqual([true, true])
  })
})

describe("tellsScreenReader", () => {
  it("is on macOS and Windows, where Electron reports assistive technology", () => {
    expect(tellsScreenReader("darwin")).toBe(true)
    expect(tellsScreenReader("win32")).toBe(true)
    expect(tellsScreenReader("linux")).toBe(false)
  })
})

import type { DesktopBadge } from "@novadeck/protocol/bridge"
import { vi } from "vitest"

import { describe, expect, it } from "../../test"
import { clickNotice, createVoice, noticeClickWaitMs, windowsToKeep } from "./voice"

const badge = (count: number): DesktopBadge => ({ count, image: null })

// Windows are names; the voice is whichever the test says.
const setup = (voice = "a") => {
  const state = { voice, gone: new Set<string>() }
  const applied: [string, number][] = []
  const closed: string[] = []
  const book = createVoice<string>({
    hasVoice: (window) => window === state.voice,
    applyBadge: (window, shown) => void applied.push([window, shown.count]),
    closeNotices: () => void closed.push("notices"),
    alive: (window) => !state.gone.has(window),
  })
  return { book, state, applied, closed }
}

describe("what only the voice window does", () => {
  it("raises notices for the voice and for no other window", () => {
    const { book } = setup("a")
    expect(book.mayRaise("a")).toBe(true)
    expect(book.mayRaise("b")).toBe(false)
  })

  it("shows the voice's count on the icon and keeps the others' for later", () => {
    const { book, applied } = setup("a")
    book.counted("a", badge(2))
    book.counted("b", badge(7))
    expect(applied).toEqual([["a", 2]])
  })

  it("moves the count with the voice: the one before clears, the next shows its last", () => {
    const { book, applied, state } = setup("a")
    book.counted("b", badge(7))
    state.voice = "b"
    book.moved("a", "b")
    expect(applied).toEqual([
      ["a", 0],
      ["b", 7],
    ])
  })

  it("shows nothing for a voice that went away before it took the voice", () => {
    const { book, applied, state } = setup("b")
    state.gone.add("b")
    book.moved("a", "b")
    expect(applied).toEqual([["a", 0]])
  })

  it("takes away what a closed voice raised, though others remain", () => {
    const { book, closed, applied } = setup("a")
    book.closed("a", true, 1)
    expect(closed).toEqual(["notices"])
    expect(applied).toEqual([])
  })

  it("leaves what the voice raised when a window that is not the voice closes", () => {
    const { book, closed } = setup("a")
    book.closed("b", false, 1)
    expect(closed).toEqual([])
  })

  it("clears everything when the last window closes", () => {
    const { book, closed, applied } = setup("a")
    book.closed("a", true, 0)
    expect(closed).toEqual(["notices"])
    expect(applied).toEqual([["a", 0]])
  })

  it("clears a page that loaded again only when its window is the voice", () => {
    const { book, closed, applied } = setup("a")
    book.reset("b")
    expect(closed).toEqual([])
    book.reset("a")
    expect(closed).toEqual(["notices"])
    expect(applied).toEqual([["a", 0]])
  })
})

describe("a click on a notification", () => {
  const setupClick = (alive = (_window: string) => true, alone = false) => {
    const events: string[] = []
    let forwarded = 0
    const timers: (() => void)[] = []
    const click = (raising: string, voice?: string) =>
      clickNotice({
        alone,
        raising,
        voice,
        alive,
        send: (window) => void events.push(`send ${window}`),
        forward: (window) => {
          forwarded += 1
          events.push(`forward ${window}`)
        },
        forwards: () => forwarded,
        later: (run, ms) => {
          expect(ms).toBe(noticeClickWaitMs)
          timers.push(run)
        },
      })
    return { events, timers, click, forwardElsewhere: () => void (forwarded += 1) }
  }

  it("brings the only window forward at once, and tells it", () => {
    const { events, click, timers } = setupClick(undefined, true)
    click("a")
    expect(events).toEqual(["forward a", "send a"])
    expect(timers).toHaveLength(0)
  })

  it("only tells the page among several windows, which brings the project's window forward", () => {
    const { events, click, timers, forwardElsewhere } = setupClick()
    click("a")
    forwardElsewhere()
    timers.forEach((run) => run())
    expect(events).toEqual(["send a"])
  })

  it("brings the raising window forward when no window did, as when the terminal is gone", () => {
    const { events, click, timers } = setupClick()
    click("a")
    timers.forEach((run) => run())
    expect(events).toEqual(["send a", "forward a"])
  })

  it("goes to the voice's window when the one that raised it is gone, and to none when none is", () => {
    const gone = setupClick((window) => window !== "a")
    gone.click("a", "b")
    gone.timers.forEach((run) => run())
    expect(gone.events).toEqual(["send b", "forward b"])
    const none = setupClick(() => false)
    none.click("a", "b")
    expect(none.events).toEqual([])
  })

  it("does not wait on a window that went away meanwhile", () => {
    const state = { alive: true }
    const forward = vi.fn<(window: string) => void>()
    const timers: (() => void)[] = []
    clickNotice({
      alone: false,
      raising: "a",
      voice: undefined,
      alive: () => state.alive,
      send: () => {},
      forward,
      forwards: () => 0,
      later: (run) => void timers.push(run),
    })
    state.alive = false
    timers.forEach((run) => run())
    expect(forward).not.toHaveBeenCalled()
  })
})

describe("the windows kept for the next launch", () => {
  it("are the open ones, while the app is not quitting", () => {
    expect(windowsToKeep(["a", "b"], false)).toEqual(["a", "b"])
  })

  it("change nothing once a quit is under way, whose closes leave no window", () => {
    expect(windowsToKeep(["a"], true)).toBeUndefined()
  })

  it("change nothing when the last window closed, so the list stays as it stood before", () => {
    expect(windowsToKeep([], false)).toBeUndefined()
  })
})

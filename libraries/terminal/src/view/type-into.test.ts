import { afterEach, describe, expect, it, vi } from "vitest"

import type { Exit } from "../contract.js"
import {
  closeViews,
  optionsOf,
  shell,
  shown,
  snapshot,
  streamOf,
  viewsOf,
} from "./fakes.test-support.js"
import { createStore, type ViewLink } from "./view-state.js"

// jsdom has no layout observers, media queries or canvas; xterm falls back without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

// A screen closes once its session has stayed off screen for its retention; it closes here
// instead, while the file's DOM is still there to take its listeners off.
afterEach(closeViews)

const key = "01"

describe("typing into a terminal's screen", () => {
  // A running shell whose first screen is `data`, or one that exited as `exit` says,
  // recording what is written to it. Each attachment draws that screen, then stays open
  // until closed, as a live shell's.
  const running = (data: string, exit: Exit | null = null) => {
    const connection = createStore<ViewLink>("connected")
    const written: string[] = []
    const attachments: ReturnType<typeof streamOf>[] = []
    const screens = viewsOf(
      optionsOf({
        connection,
        lifecycle: () => shell(),
        // The owner's rule: a shell that exits with a failure waits for Enter.
        waitsAfter: () => true,
        attach: async () => {
          const stream = streamOf([snapshot(data, exit)])
          attachments.push(stream)
          return { ...stream.attached, write: async (text) => void written.push(text) }
        },
      }),
    )
    const showAgain = () => shown(screens, key)
    const page = showAgain()
    // Its first draw, which a slow runner (Windows in CI) may take seconds over.
    const ready = () =>
      vi.waitFor(() => expect(page.element.textContent).toContain("$"), { timeout: 5_000 })
    // Out of sight long enough for its screen to stop following the shell.
    const park = () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        page.hold.release({ unmount: true })
        vi.advanceTimersByTime(4_000)
        expect(attachments[0]!.close).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1_000)
        expect(attachments[0]!.close).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    }
    return { screens, written, ready, park, showAgain, attachments, connection }
  }

  it("types nothing into a terminal out of sight long enough to stop following it", async () => {
    const { screens, written, ready, park } = running("$ ")
    await ready()
    park()
    expect(screens.typeInto(key, "run the tests")).toBe(false)
    expect(written).toEqual([])
  })

  it("types nothing into a shell that exited and waits for Enter", async () => {
    const { screens, written, ready } = running("$ exit 1", { code: 1, signal: null, ranMs: 5_000 })
    await ready()
    expect(screens.typeInto(key, "run the tests")).toBe(false)
    expect(written).toEqual([])
  })

  it("types nothing while the runner is out of reach", async () => {
    const { screens, written, ready, connection } = running("$ ")
    await ready()
    connection.update(() => "reconnecting")
    expect(screens.typeInto(key, "run the tests")).toBe(false)
    connection.update(() => "unavailable")
    expect(screens.typeInto(key, "run the tests")).toBe(false)
    expect(written).toEqual([])
  })

  it("types into it again once shown and its screen has arrived", async () => {
    const { screens, written, ready, park, showAgain, attachments } = running("$ ")
    await ready()
    park()
    showAgain()
    // Shown, but its screen isn't there yet.
    expect(screens.typeInto(key, "too soon")).toBe(false)
    await vi.waitFor(() => expect(attachments).toHaveLength(2))
    await vi.waitFor(() => expect(screens.typeInto(key, "run the tests")).toBe(true))
    expect(written).toEqual(["run the tests"])
  })

  it("pastes plain text as typed, without Enter", async () => {
    const { screens, written, ready } = running("$ ")
    await ready()
    screens.typeInto(key, "run the tests")
    expect(written).toEqual(["run the tests"])
  })

  it("puts a space between the text and a word the cursor follows", async () => {
    const { screens, written, ready } = running("$ git")
    await ready()
    screens.typeInto(key, "status of the branch")
    expect(written).toEqual([" status of the branch"])
  })

  it("brackets the paste once the program asked for that", async () => {
    const { screens, written, ready } = running("\u001b[?2004h$ ")
    await ready()
    screens.typeInto(key, "run the tests")
    expect(written).toEqual(["\u001b[200~run the tests\u001b[201~"])
  })

  it("does nothing for a terminal with no screen, and says so", async () => {
    const { screens, written, ready } = running("$ ")
    await ready()
    expect(screens.typeInto("02", "run the tests")).toBe(false)
    expect(screens.typeInto(key, "run the tests")).toBe(true)
    expect(written).toEqual(["run the tests"])
  })

  it("turns line breaks and control characters into single spaces, never Enter", async () => {
    const { screens, written, ready } = running("$ ")
    await ready()
    expect(screens.typeInto(key, "\n one\r\ntwo\u001b[31m\tthree \n")).toBe(true)
    expect(written).toEqual(["one two [31m three"])
    expect(screens.typeInto(key, " \r\n ")).toBe(false)
  })
})

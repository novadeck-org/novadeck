import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import type { AttachStream } from "../contract.js"
import {
  closeViews,
  fontChanges,
  inputOf,
  loading,
  openedTerminals,
  optionsOf,
  retainMs,
  running,
  settled,
  shell,
  shown,
  slot,
  snapshot,
  starting,
  streamOf,
  themed,
  viewsOf,
} from "./fakes.test-support.js"
import type { Lifecycle } from "./follow.js"
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

// A screen as the one holding it sees it: what it keeps while moved, what it tells, and what
// it refuses.
describe("a hold on a terminal's screen", () => {
  it("leaves no refocus waiting when it takes back a screen that never left its element", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const views = viewsOf(optionsOf())
      const { hold, element } = shown(views, "a")
      const input = inputOf(element)
      input.focus()
      expect(document.activeElement).toBe(input)

      // Out of sight, and staying mounted: not an unmount.
      hold.release()
      // Focus moved on while it was out of sight.
      input.blur()
      const back = views.acquire("a", running)
      back.place(element)
      // Nothing waited to refocus the screen: letting go of it out of sight is not an
      // unmount, so taking it again must not steal focus.
      expect(document.activeElement).not.toBe(input)
      // Only a release for an unmount leaves focus for the next hold to restore.
      input.focus()
      back.release({ unmount: true })
      const next = views.acquire("a", running)
      next.place(element)
      expect(document.activeElement).toBe(input)
    } finally {
      vi.useRealTimers()
    }
  })

  it("tells its state again when it is held again in a new phase", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const views = viewsOf(optionsOf({ lifecycle: () => starting() }))
      const { hold } = shown(views, "a", { phase: "starting" })
      const woken = vi.fn<() => void>()
      hold.state.subscribe(woken)
      expect(hold.state.getSnapshot().lock).toBe("starting")
      hold.release()
      woken.mockClear()
      views.acquire("a", { ...running, phase: "ended" })
      expect(hold.state.getSnapshot().lock).toBeNull()
      expect(woken).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("takes focus asked for into the screen opened again, after the cap closed the one before", () => {
    // The parked-screen cap closed its screen while it was away: the one it comes back to is
    // a new one, which the focus must reach.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const views = viewsOf(optionsOf({ park: { afterMs: 5_000, keep: 0 } }))
      const { hold, element } = shown(views, "a")
      const first = element.firstElementChild
      hold.release()
      vi.advanceTimersByTime(6_000)
      expect(element.firstElementChild).toBeNull()
      const back = views.acquire("a", running)
      back.place(element)
      expect(element.firstElementChild).not.toBe(first)
      expect(back.focus()).toBe(true)
      expect(document.activeElement).toBe(inputOf(element))
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps one live xterm and its output while the UI moves its element", async () => {
    const opened = openedTerminals()
    const { attached } = streamOf([snapshot("hello from the same shell\r\n")])
    const attach = vi.fn<() => Promise<AttachStream>>(async () => attached)
    const stages: string[] = []
    const views = viewsOf(
      optionsOf({ attach, on: { stage: (_key, stage) => void stages.push(stage) } }),
    )
    const { element } = shown(views, "01")
    await vi.waitFor(() =>
      expect(opened[0]?.buffer.active.getLine(0)?.translateToString()).toContain(
        "hello from the same shell",
      ),
    )
    const textarea = inputOf(element)
    const xterm = element.querySelector(".xterm")
    // A different program body gives the UI another place for the element.
    for (const body of ["claude", "codex", "terminal"]) {
      const place = document.createElement("section")
      place.dataset.body = body
      document.body.append(place)
      place.append(element)
      expect(element.querySelector(".xterm")).toBe(xterm)
      expect(inputOf(element)).toBe(textarea)
      place.remove()
    }
    document.body.append(element)
    expect(element.querySelectorAll(".xterm")).toHaveLength(1)
    expect(opened[0]?.buffer.active.getLine(0)?.translateToString()).toContain(
      "hello from the same shell",
    )
    expect(attach).toHaveBeenCalledTimes(1)
    expect(stages).toEqual(["mounted", "shown"])
  })

  context("when a view switch holds it in another place", () => {
    // A live stream that drew one line and then waits, and a hold over it; `shown` says
    // whether the terminal's session is on screen.
    const following = (onScreen: boolean) => {
      const opened = openedTerminals()
      const { attached, close } = streamOf([snapshot("still the same shell\r\n")])
      const attach = vi.fn<() => Promise<AttachStream>>(async () => attached)
      const stages: string[] = []
      let wanted = onScreen
      let terminalEnd: "open" | "closed" | "removed" = "open"
      const views = viewsOf(
        optionsOf({
          attach,
          lifecycle: () =>
            terminalEnd === "removed" ? undefined : shell({ closed: terminalEnd === "closed" }),
          retain: { afterMs: retainMs, shown: () => wanted },
          on: { stage: (_key, stage) => void stages.push(stage) },
        }),
      )
      // Each view places its terminals in an element of its own, so a switch holds them again.
      const inView = (view: string) => {
        const element = slot()
        element.dataset.view = view
        const hold = views.acquire("01", running)
        hold.place(element)
        return { element, unmount: () => hold.release({ unmount: true }) }
      }
      const putOnScreen = (value: boolean): void => {
        wanted = value
      }
      const end = (how: "closed" | "removed"): void => {
        terminalEnd = how
      }
      return { opened, attach, close, stages, inView, putOnScreen, end }
    }

    it("keeps its one xterm, attachment, output and focus", async () => {
      const { opened, attach, stages, inView } = following(true)
      const grid = inView("grid")
      await vi.waitFor(() =>
        expect(opened[0]?.buffer.active.getLine(0)?.translateToString()).toContain(
          "still the same shell",
        ),
      )
      const textarea = inputOf(grid.element)
      textarea.focus()

      // The next view's hold takes the screen as the last left it, and the focus with it.
      grid.unmount()
      const canvas = inView("canvas")
      canvas.unmount()
      const focus = inView("focus")

      expect(focus.element.dataset.view).toBe("focus")
      expect(focus.element.contains(textarea)).toBe(true)
      expect(focus.element.querySelectorAll(".xterm")).toHaveLength(1)
      expect(document.activeElement).toBe(textarea)
      expect(opened).toHaveLength(1)
      expect(attach).toHaveBeenCalledTimes(1)
      expect(stages).toEqual(["mounted", "shown"])
    })

    it("lets its screen go once its session has stayed off screen for a long while", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { stages, inView } = following(false)
      try {
        inView("grid").unmount()
        await vi.advanceTimersByTimeAsync(29 * 60 * 1000)
        expect(stages).not.toContain("gone")
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
        expect(stages).toContain("gone")
      } finally {
        vi.useRealTimers()
      }
    })

    it("hands the same screen back to a session left a few minutes ago", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { opened, attach, stages, inView } = following(false)
      try {
        const page = inView("grid")
        await vi.advanceTimersByTimeAsync(0)
        page.unmount()
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        inView("focus")
        expect(opened).toHaveLength(1)
        expect(attach).toHaveBeenCalledTimes(1)
        expect(stages).not.toContain("gone")
      } finally {
        vi.useRealTimers()
      }
    })

    it("counts the time away from the last moment its session was on screen", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { stages, inView, putOnScreen } = following(false)
      try {
        inView("grid").unmount()
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
        putOnScreen(true)
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
        putOnScreen(false)
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
        expect(stages).not.toContain("gone")
        await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
        expect(stages).toContain("gone")
      } finally {
        vi.useRealTimers()
      }
    })

    it("lets its screen go after the time away even when timers ran late", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { stages, inView } = following(false)
      try {
        inView("grid").unmount()
        await vi.advanceTimersByTimeAsync(1_000)
        vi.setSystemTime(Date.now() + 31 * 60 * 1000)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(stages).toContain("gone")
      } finally {
        vi.useRealTimers()
      }
    })

    it.each(["closed", "removed"] as const)(
      "lets its screen go at the next check once its terminal is %s, even on screen",
      async (how) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
        const { stages, close, inView, end } = following(true)
        try {
          const page = inView("grid")
          await vi.advanceTimersByTimeAsync(0)
          page.unmount()
          await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
          expect(stages).not.toContain("gone")
          end(how)
          await vi.advanceTimersByTimeAsync(1_000)
          expect(stages).toContain("gone")
          expect(close).toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      },
    )

    it("keeps its screen while its session stays on screen", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const { stages, inView } = following(true)
      try {
        inView("grid").unmount()
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
        expect(stages).not.toContain("gone")
      } finally {
        vi.useRealTimers()
      }
    })
  })

  context("while its shell has no stream yet", () => {
    it("refuses input where the person can see it", () => {
      const views = viewsOf(optionsOf({ lifecycle: () => starting() }))
      const { hold, element } = shown(views, "a", { phase: "starting" })
      expect(inputOf(element).getAttribute("aria-disabled")).toBe("true")
      expect(hold.state.getSnapshot().lock).toBe("starting")
    })
  })

  context("while a running shell's screen has not arrived", () => {
    it("says its output is loading, not that the shell is starting", () => {
      const views = viewsOf(optionsOf({ lifecycle: () => starting() }))
      const { hold } = shown(views, "a")
      expect(hold.state.getSnapshot().lock).toBe("loading")
    })
  })

  context("when the theme changes", () => {
    it("draws in the new theme's monospace font", () => {
      const opened = openedTerminals()
      const page = themed()
      page.apply("Old Mono")
      const views = viewsOf(optionsOf({ theme: page.theme }))
      shown(views, "a")
      expect(opened[0]?.options.fontFamily).toBe("Old Mono")

      page.apply("New Mono")

      expect(opened[0]?.options.fontFamily).toBe("New Mono")
    })
  })

  context("while its bundled monospace font is still loading", () => {
    it("measures again in the font once it arrives", async () => {
      const font = loading()
      const changes = fontChanges()
      const page = themed()
      page.apply("Bundled Mono")
      try {
        shown(viewsOf(optionsOf({ theme: page.theme })), "a")
        const before = changes.length

        font.arrive()
        await settled()

        // The family is unchanged, so xterm is told another one first: only a change
        // makes it measure its cells again.
        expect(changes.slice(before)).toEqual(["monospace", "Bundled Mono"])
      } finally {
        font.restore()
      }
    })

    it("keeps its font until a new theme's font arrives, then measures once", async () => {
      const opened = openedTerminals()
      const page = themed()
      page.apply("Old Mono")
      const changes = fontChanges((terminal) => opened.includes(terminal))
      let font: ReturnType<typeof loading> | undefined
      try {
        shown(viewsOf(optionsOf({ theme: page.theme })), "a")
        font = loading()
        const before = changes.length

        page.apply("New Mono")
        page.apply("New Mono")
        expect(changes.slice(before)).toEqual([])

        font.arrive()
        await settled()

        expect(changes.slice(before)).toEqual(["New Mono"])
      } finally {
        font?.restore()
      }
    })

    it("takes a new theme's font that fails to load, so the family falls back", async () => {
      const opened = openedTerminals()
      const page = themed()
      page.apply("Old Mono")
      const changes = fontChanges((terminal) => opened.includes(terminal))
      let font: ReturnType<typeof loading> | undefined
      try {
        shown(viewsOf(optionsOf({ theme: page.theme })), "a")
        font = loading()
        const before = changes.length

        page.apply("New Mono")
        font.fail()
        await settled()

        expect(changes.slice(before)).toEqual(["New Mono"])
      } finally {
        font?.restore()
      }
    })

    it("leaves a screen alone that closed before the font arrived", async () => {
      const font = loading()
      const changes = fontChanges()
      const page = themed()
      page.apply("Bundled Mono")
      try {
        const { hold } = shown(viewsOf(optionsOf({ theme: page.theme })), "a")
        // A screen closes once its session has stayed off screen for its retention.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
        try {
          hold.release({ unmount: true })
          vi.advanceTimersByTime(31 * 60 * 1000)
        } finally {
          vi.useRealTimers()
        }
        const before = changes.length

        font.arrive()
        await settled()

        expect(changes.slice(before)).toEqual([])
      } finally {
        font.restore()
      }
    })
  })

  context("while the runner reconnects", () => {
    it("locks its input, saying why", () => {
      const connection = createStore<ViewLink>("connected")
      const views = viewsOf(optionsOf({ lifecycle: () => starting(), connection }))
      const { hold, element } = shown(views, "a", { phase: "starting" })
      connection.update(() => "reconnecting")
      expect(hold.state.getSnapshot().lock).toBe("reconnecting")
      connection.update(() => "unavailable")
      expect(hold.state.getSnapshot().lock).toBe("offline")
      expect(inputOf(element).getAttribute("aria-disabled")).toBe("true")
    })
  })

  // A hold whose shell ended, recording the restarts it asks for.
  const ended = (lifecycle: () => Lifecycle = starting) => {
    const connection = createStore<ViewLink>("connected")
    const restarts: string[] = []
    const views = viewsOf(
      optionsOf({
        lifecycle,
        connection,
        restart: (key) => void restarts.push(key),
      }),
    )
    return { ...shown(views, "01", { phase: "ended" }), restarts, connection }
  }

  context("once its shell ended", () => {
    it("takes input, for Enter alone", () => {
      const { hold, element } = ended()
      expect(hold.state.getSnapshot().lock).toBeNull()
      expect(inputOf(element).getAttribute("aria-disabled")).toBe("false")
    })

    it("starts a fresh shell from restart()", () => {
      const { hold, element, restarts } = ended()
      hold.restart()
      expect(restarts).toEqual(["01"])
      expect(hold.state.getSnapshot().waits).toBe(false)
      expect(inputOf(element).getAttribute("aria-disabled")).toBe("false")
    })

    it("starts a fresh shell at Enter, and sends nothing else", () => {
      const opened = openedTerminals()
      const { restarts } = ended()
      opened[0]!.input("ls")
      expect(restarts).toEqual([])
      opened[0]!.input("\r")
      expect(restarts).toEqual(["01"])
    })

    it("locks again when its phase says a fresh shell is starting, until its screen arrives", () => {
      const { hold, element } = ended()
      hold.update({ phase: "starting" })
      expect(hold.state.getSnapshot().lock).toBe("starting")
      expect(inputOf(element).getAttribute("aria-disabled")).toBe("true")
    })
  })

  context("once its shell ended while the runner is away", () => {
    it("locks as the link does, and takes input again when it is back", () => {
      const { hold, connection } = ended()
      connection.update(() => "unavailable")
      expect(hold.state.getSnapshot().lock).toBe("offline")
      connection.update(() => "connected")
      expect(hold.state.getSnapshot().lock).toBeNull()
    })
  })
})

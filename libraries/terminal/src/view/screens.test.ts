import type { Terminal } from "@novadeck/emulator/browser"
import { describe, expect, it, vi } from "vitest"

import {
  closeViews,
  emulatorPrototype,
  inputOf,
  openedTerminals,
  optionsOf,
  retainMs,
  running,
  slot,
  themed,
  viewsOf,
} from "./fakes.test-support.js"
import type { ViewEvents } from "./follow.js"
import { parkMs, type Hold } from "./screens.js"
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

// Screens capped at `cap` over terminals whose shells are ready and whose streams never
// draw, recording what the owner is told and each attachment it is asked for. Each test's
// screens close before its clock goes back to real time, while the file's DOM is still there
// to take their listeners off: their terminals close, and the check that notices runs.
const capped = (cap: number) => {
  const told: string[] = []
  const attached: string[] = []
  const holds = new Map<string, Hold[]>()
  const elements = new Map<string, HTMLElement>()
  const connection = createStore<ViewLink>("connected")
  const resized = vi.fn<NonNullable<ViewEvents<string>["resized"]>>()
  const screens = viewsOf(
    optionsOf({
      attach: (key) => {
        attached.push(key)
        return new Promise(() => {})
      },
      connection,
      // The hosts are marked, so the test can give them a size.
      markup: { hostClass: "screen" },
      park: { afterMs: parkMs, keep: cap },
      on: { resized, stage: (key, stage) => void told.push(`${key} ${stage}`) },
    }),
  )
  // The element a terminal's screen is placed in, as a mount's is.
  const elementOf = (id: string): HTMLElement => {
    let element = elements.get(id)
    if (!element) {
      element = slot()
      elements.set(id, element)
    }
    return element
  }
  // Shown in an element, as a mount does.
  const show = (id: string) => {
    const hold = screens.acquire(id, running)
    holds.set(id, [...(holds.get(id) ?? []), hold])
    hold.place(elementOf(id))
    return hold
  }
  const hide = (id: string) => holds.get(id)?.pop()?.release()
  // The screen the terminal's element holds, while it is open.
  const hostOf = (id: string) => elementOf(id).firstElementChild
  const present = (id: string) => hostOf(id)?.isConnected === true
  return { screens, told, attached, show, hide, present, hostOf, elementOf, connection, resized }
}

describe("the cap on parked screens", () => {
  it("closes the screen parked longest when another parks past the cap", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { told, show, hide, present } = capped(2)
      for (const id of ["a", "b", "c"]) {
        show(id)
        hide(id)
        vi.advanceTimersByTime(parkMs)
      }
      expect(told).toContain("a gone")
      expect(told).not.toContain("b gone")
      expect(told).not.toContain("c gone")
      expect(present("a")).toBe(false)
      expect(present("b")).toBe(true)
      expect(present("c")).toBe(true)
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("never closes a screen that is shown or has not parked yet", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { told, show, hide } = capped(1)
      show("shown")
      for (const id of ["a", "b"]) {
        show(id)
        hide(id)
        vi.advanceTimersByTime(parkMs)
      }
      // `a` closed as `b` parked past the cap. Released a moment ago, `c` has not parked, so
      // it is not counted, and `shown` never is.
      show("c")
      hide("c")
      vi.advanceTimersByTime(parkMs - 1)
      expect(told.filter((entry) => entry.endsWith("gone"))).toEqual(["a gone"])
      vi.advanceTimersByTime(1)
      expect(told.filter((entry) => entry.endsWith("gone"))).toEqual(["a gone", "b gone"])
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("leaves the order when a screen is shown again, and parks last when it parks again", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { told, show, hide } = capped(2)
      for (const id of ["a", "b"]) {
        show(id)
        hide(id)
        vi.advanceTimersByTime(parkMs)
      }
      // `a` is shown and parked again, so `b` has been parked longest.
      show("a")
      hide("a")
      vi.advanceTimersByTime(parkMs)
      show("c")
      hide("c")
      vi.advanceTimersByTime(parkMs)
      expect(told.filter((entry) => entry.endsWith("gone"))).toEqual(["b gone"])
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("opens a screen it closed afresh when shown again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { told, attached, show, hide, hostOf } = capped(1)
      show("a")
      const first = hostOf("a")
      await vi.advanceTimersByTimeAsync(0)
      hide("a")
      vi.advanceTimersByTime(parkMs)
      show("b")
      hide("b")
      vi.advanceTimersByTime(parkMs)
      expect(told).toContain("a gone")
      const before = attached.filter((id) => id === "a").length
      show("a")
      await vi.advanceTimersByTimeAsync(0)
      expect(hostOf("a")).not.toBe(first)
      expect(told.filter((entry) => entry === "a mounted")).toHaveLength(2)
      expect(attached.filter((id) => id === "a").length).toBeGreaterThan(before)
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("closes a screen once, however it got there", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { told, show, hide } = capped(1)
      for (const id of ["a", "b"]) {
        show(id)
        hide(id)
        vi.advanceTimersByTime(parkMs)
      }
      vi.advanceTimersByTime(retainMs + 60_000)
      expect(told.filter((entry) => entry === "a gone")).toHaveLength(1)
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })
})

describe("a mount's hold on a screen", () => {
  it("lets go once, however often it is told to", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { told, show, hide } = capped(0)
      const first = show("a")
      const second = show("a")
      first.release()
      first.release()
      // The second still holds it: the screen does not park, so the cap never closes it.
      vi.advanceTimersByTime(parkMs)
      expect(told).not.toContain("a gone")
      second.release()
      hide("a")
      hide("a")
      vi.advanceTimersByTime(parkMs)
      expect(told).toContain("a gone")
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("tells the state of its screen, locked until the host is reachable", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { show, elementOf, connection } = capped(2)
      const hold = show("a")
      expect(hold.state.getSnapshot().lock).toBe("loading")
      const woken = vi.fn<() => void>()
      hold.state.subscribe(woken)
      connection.update(() => "reconnecting")
      expect(hold.state.getSnapshot().lock).toBe("reconnecting")
      connection.update(() => "unavailable")
      expect(hold.state.getSnapshot().lock).toBe("offline")
      expect(woken).toHaveBeenCalledTimes(2)
      // Input is refused where the person can see it.
      expect(inputOf(elementOf("a")).getAttribute("aria-disabled")).toBe("true")
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("does not hear the connection once nobody holds the screen", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { show, hide, connection } = capped(2)
      const hold = show("a")
      const woken = vi.fn<() => void>()
      hold.state.subscribe(woken)
      hide("a")
      connection.update(() => "unavailable")
      expect(woken).not.toHaveBeenCalled()
      // Held again, it reads the connection as it is.
      expect(show("a").state.getSnapshot().lock).toBe("offline")
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("opens screens in the font it was given and brings open ones to it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { screens, show } = capped(2)
      const opened = openedTerminals()
      screens.setFont({ size: 15 })
      show("a")
      expect(opened[0]?.options.fontSize).toBe(15)
      screens.setFont({ size: 12 })
      expect(opened[0]?.options.fontSize).toBe(12)
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("is not held by a screen that failed to open, which a later acquire opens afresh", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { screens, told, show, hide } = capped(0)
      const original = emulatorPrototype().open
      vi.spyOn(emulatorPrototype(), "open").mockImplementationOnce(() => {
        throw new Error("The emulator failed to open")
      })
      expect(() => screens.acquire("a", running)).toThrow("failed to open")
      vi.mocked(emulatorPrototype().open).mockImplementation(original)
      show("a")
      hide("a")
      // Held once, released once: it parks, and the cap of none closes it.
      vi.advanceTimersByTime(parkMs)
      expect(told).toContain("a gone")
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("says its focus did not land when its host is not in the page", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { screens, show } = capped(2)
      const unplaced = screens.acquire("loose", running)
      expect(unplaced.focus()).toBe(false)
      expect(show("a").focus()).toBe(true)
      unplaced.release()
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("writes its input's lock only when the lock changes", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { show, elementOf, connection } = capped(2)
      const hold = show("a")
      const input = inputOf(elementOf("a"))
      expect(input.getAttribute("aria-disabled")).toBe("true")
      const written = vi.spyOn(input, "setAttribute")
      // Locked for another reason: the words change, the lock holds.
      connection.update(() => "reconnecting")
      connection.update(() => "unavailable")
      hold.update({ phase: "running" })
      expect(written).not.toHaveBeenCalled()
      hold.update({ phase: "ended" })
      hold.update({ phase: "ended" })
      connection.update(() => "connected")
      expect(written.mock.calls).toEqual([["aria-disabled", "false"]])
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("fits the screens that are open again at a new font size, and only those that differ", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] })
    try {
      const { screens, show, resized } = capped(2)
      // The screens' hosts have a size, as laid out; nothing else in the page does.
      for (const [name, value] of [
        ["clientWidth", 800],
        ["clientHeight", 600],
      ] as const) {
        const original = Object.getOwnPropertyDescriptor(Element.prototype, name)!.get!
        vi.spyOn(Element.prototype, name, "get").mockImplementation(function (this: Element) {
          return this.classList.contains("screen") ? value : original.call(this)
        })
      }
      const prototype = emulatorPrototype()
      const loadAddon = prototype.loadAddon
      vi.spyOn(prototype, "loadAddon").mockImplementation(function (
        this: Terminal,
        addon: Parameters<Terminal["loadAddon"]>[0],
      ) {
        if ("proposeDimensions" in addon && typeof addon.proposeDimensions === "function")
          vi.spyOn(
            addon as { proposeDimensions: () => unknown },
            "proposeDimensions",
          ).mockReturnValue({ cols: 100, rows: 30 })
        return loadAddon.call(this, addon)
      })
      show("a")
      await vi.advanceTimersByTimeAsync(0)
      resized.mockClear()
      screens.setFont({ size: 13 })
      await vi.advanceTimersByTimeAsync(0)
      expect(resized).not.toHaveBeenCalled()
      screens.setFont({ size: 15 })
      await vi.advanceTimersByTimeAsync(0)
      expect(resized).toHaveBeenCalledTimes(1)
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })
})

describe("the views over options of their own", () => {
  // Views of string-keyed terminals that never get a stream, over a theme, stores and
  // timings the test chooses: nothing of the app's.
  const standalone = (marked: { markup?: boolean } = {}) => {
    const told: string[] = []
    const stores: unknown[] = []
    const { theme, listeners } = themed()
    const element = slot()
    const views = viewsOf(
      optionsOf({
        theme,
        store: <S>(initial: S) => {
          const own = createStore(initial)
          stores.push(own)
          return own
        },
        ...(marked.markup
          ? { markup: { input: { "data-input": "mine" }, hostClass: "my-screen" } }
          : {}),
        park: { afterMs: 50, keep: 1 },
        retain: { afterMs: 10_000, shown: () => false },
        on: { stage: (key, stage) => void told.push(`${key} ${stage}`) },
      }),
    )
    return { views, told, stores, listeners, element }
  }

  it("makes each screen's state with the store it is given, and marks the screen as asked", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { views, stores, element } = standalone({ markup: true })
      const hold = views.acquire("a", { label: "Input for a", phase: "running", webgl: false })
      hold.place(element)
      expect(stores).toHaveLength(1)
      expect(hold.state).toBe(stores[0])
      const host = element.firstElementChild!
      expect(host.getAttribute("class")).toBe("my-screen")
      const field = host.querySelector("textarea")!
      expect(field.getAttribute("data-input")).toBe("mine")
      expect(field.getAttribute("aria-label")).toBe("Input for a")
      hold.release()
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("marks nothing the options do not ask for", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { views, element } = standalone()
      const hold = views.acquire("a", { label: "Input for a", phase: "running", webgl: false })
      hold.place(element)
      const host = element.firstElementChild!
      expect(host.hasAttribute("class")).toBe(false)
      expect(host.querySelector("textarea")!.hasAttribute("data-terminal-input")).toBe(false)
      hold.release()
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })

  it("parks and closes on the options' timings, and stops listening for the theme once closed", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { views, told, listeners, element } = standalone()
      for (const key of ["a", "b"]) {
        const hold = views.acquire(key, { label: key, phase: "running", webgl: false })
        hold.place(element)
        expect(listeners.size).toBe(key === "a" ? 1 : 2)
        hold.release()
        vi.advanceTimersByTime(49)
        expect(told).not.toContain("a gone")
        vi.advanceTimersByTime(1)
      }
      // `b` parked past the cap of one, so `a`, parked longest, closed.
      expect(told).toEqual(["a mounted", "b mounted", "a gone"])
      expect(listeners.size).toBe(1)
    } finally {
      closeViews()
      vi.useRealTimers()
    }
  })
})

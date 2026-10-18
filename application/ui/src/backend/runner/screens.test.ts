import { createView, type Terminal as EmulatorTerminal } from "@novadeck/emulator/browser"
import { vi } from "vitest"

import { createStore } from "#core/store"

import { describe, expect, it } from "../../test"
import type { BackendConnectionState, TerminalKey } from "../port"
import type { SurfaceRuntime } from "./backend"
import { createScreens, parkMs, retainMs, type ScreenHandle } from "./screens"

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

// The emulator's terminal class is not exported; the tests spy on its prototype.
const emulatorPrototype = (): EmulatorTerminal => {
  const view = createView(document.createElement("div"), {
    fontSize: 13,
    fontFamily: "monospace",
    theme: {},
    scrollback: 0,
  })
  const prototype = Object.getPrototypeOf(view.terminal) as EmulatorTerminal
  view.dispose()
  return prototype
}

const keyOf = (terminalId: string): TerminalKey => ({
  projectId: "p",
  workspaceSessionId: "s",
  terminalId,
})
const options = { label: "Input for T", phase: "running", webgl: false } as const

// Each test's screens close before its clock goes back to real time, while the file's DOM
// is still there to take their listeners off: their terminals close, and the check that
// notices runs.
const closers: (() => void)[] = []
const closeScreens = (): void => {
  closers.splice(0).forEach((close) => close())
  vi.advanceTimersByTime(retainMs)
}

// Screens capped at `cap` over a runtime whose shells are ready and whose streams never
// draw, recording what the runtime is told and each attachment it is asked for.
const capped = (cap: number) => {
  const told: string[] = []
  const attached: string[] = []
  const holds = new Map<string, ScreenHandle[]>()
  const elements = new Map<string, HTMLElement>()
  let closed = false
  const connection = createStore<BackendConnectionState>("connected")
  const resized = vi.fn<SurfaceRuntime["resized"]>()
  const runtime: SurfaceRuntime = {
    entry: () => ({
      ready: Promise.resolve(true),
      revived: new Promise<void>(() => {}),
      closed,
      size: { cols: 80, rows: 24 },
    }),
    attach: (terminalId) => {
      attached.push(String(terminalId))
      return new Promise(() => {})
    },
    upload: () => new Promise(() => {}),
    resized,
    attached: () => () => {},
    connected: async () => {},
    lost: () => {},
    restart: () => {},
    exited: () => {},
    connection,
    track: (work) => work,
    screen: ({ terminalId }, state) => void told.push(`${terminalId} ${state}`),
    shown: () => false,
  }
  const screens = createScreens(runtime, undefined, cap)
  // The element a terminal's screen is placed in, as a mount's is.
  const elementOf = (terminalId: string): HTMLElement => {
    let element = elements.get(terminalId)
    if (!element) {
      element = document.createElement("div")
      document.body.append(element)
      elements.set(terminalId, element)
    }
    return element
  }
  // Shown in an element, as a mount does.
  const show = (terminalId: string) => {
    const hold = screens.acquire(keyOf(terminalId), options)
    holds.set(terminalId, [...(holds.get(terminalId) ?? []), hold])
    hold.place(elementOf(terminalId))
    return hold
  }
  const hide = (terminalId: string) => holds.get(terminalId)?.pop()?.release()
  closers.push(() => {
    closed = true
    for (const [terminalId, held] of holds) while (held.length > 0) hide(terminalId)
    elements.forEach((element) => element.remove())
  })
  // The screen the terminal's element holds, while it is open.
  const hostOf = (terminalId: string) => elementOf(terminalId).firstElementChild
  const present = (terminalId: string) => hostOf(terminalId)?.isConnected === true
  return { screens, told, attached, show, hide, present, hostOf, connection, resized }
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
      closeScreens()
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
      closeScreens()
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
      closeScreens()
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
      closeScreens()
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
      closeScreens()
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
      closeScreens()
      vi.useRealTimers()
    }
  })

  it("tells the state of its screen, locked until the runner is reachable", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { show, connection } = capped(2)
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
      expect(document.querySelector("[data-terminal-input]")?.getAttribute("aria-disabled")).toBe(
        "true",
      )
    } finally {
      closeScreens()
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
      closeScreens()
      vi.useRealTimers()
    }
  })

  it("opens screens in the font it was given and brings open ones to it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { screens, show } = capped(2)
      const probe = createView(document.createElement("div"), {
        fontSize: 13,
        fontFamily: "monospace",
        theme: {},
        scrollback: 0,
      })
      const prototype = Object.getPrototypeOf(probe.terminal) as EmulatorTerminal
      probe.dispose()
      const opened: EmulatorTerminal[] = []
      const open = prototype.open
      vi.spyOn(prototype, "open").mockImplementation(function (this: EmulatorTerminal, element) {
        opened.push(this)
        return open.call(this, element)
      })
      screens.setFont({ size: 15 })
      show("a")
      expect(opened[0]?.options.fontSize).toBe(15)
      screens.setFont({ size: 12 })
      expect(opened[0]?.options.fontSize).toBe(12)
    } finally {
      closeScreens()
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
      expect(() => screens.acquire(keyOf("a"), options)).toThrow("failed to open")
      vi.mocked(emulatorPrototype().open).mockImplementation(original)
      show("a")
      hide("a")
      // Held once, released once: it parks, and the cap of none closes it.
      vi.advanceTimersByTime(parkMs)
      expect(told).toContain("a gone")
    } finally {
      closeScreens()
      vi.useRealTimers()
    }
  })

  it("says its focus did not land when its host is not in the page", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { screens, show } = capped(2)
      const unplaced = screens.acquire(keyOf("loose"), options)
      expect(unplaced.focus()).toBe(false)
      expect(show("a").focus()).toBe(true)
      unplaced.release()
    } finally {
      closeScreens()
      vi.useRealTimers()
    }
  })

  it("writes its input's lock only when the lock changes", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const { show, connection } = capped(2)
      const hold = show("a")
      const input = document.querySelector<HTMLElement>("[data-terminal-input]")!
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
      closeScreens()
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
          return this.classList.contains("runner-screen") ? value : original.call(this)
        })
      }
      const prototype = emulatorPrototype()
      const loadAddon = prototype.loadAddon
      vi.spyOn(prototype, "loadAddon").mockImplementation(function (
        this: EmulatorTerminal,
        addon: Parameters<EmulatorTerminal["loadAddon"]>[0],
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
      closeScreens()
      vi.useRealTimers()
    }
  })
})

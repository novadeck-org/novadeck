import { afterEach, describe, expect, it, vi } from "vitest"

import type { AttachStream } from "../contract.js"
import {
  closeScreens,
  openedTerminals,
  optionsOf,
  screensOf,
  shown,
  snapshot,
  streamOf,
} from "./fakes.test-support.js"

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

afterEach(closeScreens)

// A stream that observes until a take lands.
const observed = () => {
  const base = streamOf([snapshot("$ ")])
  let mode: "control" | "observe" = "observe"
  const listeners = new Set<(mode: "control" | "observe") => void>()
  const attached: AttachStream = {
    ...base.attached,
    get mode() {
      return mode
    },
    onMode: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    take: async () => {
      mode = "control"
      listeners.forEach((listener) => listener(mode))
    },
  }
  return { ...base, attached }
}

describe("a screen of a terminal this client only observes", () => {
  it("shows the strip, draws at the pty's size and sends no size", async () => {
    const stream = observed()
    const screens = screensOf(optionsOf({ attach: async () => stream.attached }))
    const opened = openedTerminals()
    const { hold, element } = shown(screens, "a")
    await vi.waitFor(() => expect(hold.state.getSnapshot().live).toBe(true))
    expect(hold.state.getSnapshot().control).toBe("observing")
    expect(hold.state.getSnapshot().lock).toBeNull()
    expect(opened[0]!.cols).toBe(80)
    expect(opened[0]!.rows).toBe(24)
    expect(stream.resized).toEqual([])
    expect(element.isConnected).toBe(true)
  })

  it("takes control with the button, and the strip goes", async () => {
    const stream = observed()
    const screens = screensOf(optionsOf({ attach: async () => stream.attached }))
    const { hold } = shown(screens, "a")
    await vi.waitFor(() => expect(hold.state.getSnapshot().control).toBe("observing"))
    hold.take()
    await vi.waitFor(() => expect(hold.state.getSnapshot().control ?? null).toBeNull())
  })

  it("says it has the keyboard when a key took control without being delivered", async () => {
    const stream = observed()
    const screens = screensOf(
      optionsOf({ attach: async () => stream.attached, took: "You have the keyboard now" }),
    )
    const opened = openedTerminals()
    const { hold } = shown(screens, "a")
    await vi.waitFor(() => expect(hold.state.getSnapshot().live).toBe(true))
    opened[0]!.input("\r")
    await vi.waitFor(() =>
      expect(hold.state.getSnapshot().notice).toBe("You have the keyboard now"),
    )
    expect(stream.written).toEqual([])
    opened[0]!.input("l")
    await vi.waitFor(() => expect(stream.written).toEqual(["l"]))
  })

  it("does not take control for arrow keys the wheel made", async () => {
    const stream = observed()
    const screens = screensOf(optionsOf({ attach: async () => stream.attached }))
    const opened = openedTerminals()
    const { hold, element } = shown(screens, "a")
    await vi.waitFor(() => expect(hold.state.getSnapshot().live).toBe(true))
    element.firstElementChild!.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }))
    opened[0]!.input("\u001bOB")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(hold.state.getSnapshot().control).toBe("observing")
    expect(stream.written).toEqual([])
  })
})

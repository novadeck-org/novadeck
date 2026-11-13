import type { Terminal } from "@novadeck/emulator/browser"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  closeScreens,
  emulatorPrototype,
  optionsOf,
  output,
  screensOf,
  settled,
  shown,
  snapshot,
  streamOf,
} from "./fakes.test-support.js"

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

afterEach(closeScreens)

const paceMs = 40
const past = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// A terminal's screen over a stream the test feeds, recording what reaches the emulator's
// write; the write of `failing`, when given, fails as a buffer whose rows went missing does.
const paced = (failing?: string) => {
  const writes: string[] = []
  const prototype = emulatorPrototype()
  const write = prototype.write
  vi.spyOn(prototype, "write").mockImplementation(function (
    this: Terminal,
    data: string | Uint8Array,
    callback?: () => void,
  ) {
    const text = String(data)
    writes.push(text)
    if (text === failing) {
      ;(callback as ((error?: unknown) => void) | undefined)?.(new Error("rows went missing"))
      return
    }
    write.call(this, data, callback)
  })
  const streams = [streamOf([snapshot("$ ")]), streamOf([snapshot("$ again")])]
  let attaches = 0
  const screens = screensOf(
    optionsOf({ attach: () => Promise.resolve(streams[Math.min(attaches++, 1)]!.attached) }),
  )
  const { hold } = shown(screens, "T", { paceMs })
  return { writes, hold, stream: streams[0]!, attached: () => attaches }
}

// What the stream sent, as the emulator was given it: the CAN a reset writes left out.
const drawn = (writes: readonly string[]) => writes.filter((data) => data !== "\x18")

describe("a paced screen", () => {
  it("draws what arrives in one write, once its pace has passed", async () => {
    const { writes, stream } = paced()
    await past(paceMs * 2)
    writes.length = 0
    stream.push(output("one ", 2))
    stream.push(output("two", 3))
    await settled()
    expect(drawn(writes)).toEqual([])
    await past(paceMs * 2)
    expect(drawn(writes)).toEqual(["one two"])
  })

  it("draws what waits at once when its pace is lifted, as a selected one is", async () => {
    const { writes, stream, hold } = paced()
    await past(paceMs * 2)
    writes.length = 0
    stream.push(output("typed", 2))
    await settled()
    hold.update({ paceMs: 0 })
    expect(drawn(writes)).toEqual(["typed"])
    stream.push(output(" and more", 3))
    await settled()
    expect(drawn(writes)).toEqual(["typed", " and more"])
  })

  it("drops what waits when a fresh screen replaces it", async () => {
    const { writes, stream } = paced()
    await past(paceMs * 2)
    writes.length = 0
    stream.push(output("stale", 2))
    stream.push(snapshot("$ fresh"))
    await past(paceMs * 2)
    expect(drawn(writes)).toEqual(["$ fresh"])
  })

  it("draws its screen afresh after a write that failed, as an unpaced one does", async () => {
    const { stream, attached } = paced("broken")
    await past(paceMs * 2)
    stream.push(output("broken", 2))
    await past(paceMs * 2)
    stream.push(output("next", 3))
    await past(paceMs * 2)
    expect(stream.close).toHaveBeenCalled()
    // It attaches again after the first failure's wait (follow.ts' `redrawMs`).
    await expect.poll(attached, { timeout: 2000 }).toBe(2)
  })
})

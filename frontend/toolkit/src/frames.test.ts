import { afterEach, beforeEach, vi } from "vitest"

import { inNextFrame } from "./frames"
import { describe, expect, it } from "./test"

describe("work run in the next frame", () => {
  let frames: FrameRequestCallback[] = []
  beforeEach(() => {
    frames = []
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => frames.push(run))
  })
  const frame = (): void => {
    const now = frames
    frames = []
    for (const run of now) run(0)
  }
  // A frame left pending would hold the next case's work in its batch.
  afterEach(() => {
    frame()
    vi.unstubAllGlobals()
  })

  it("runs everything asked for before it, in one frame", () => {
    const ran: string[] = []
    inNextFrame(() => ran.push("one"))
    inNextFrame(() => ran.push("two"))
    expect(ran).toEqual([])
    expect(frames).toHaveLength(1)
    frame()
    expect(ran).toEqual(["one", "two"])
  })

  it("leaves what was asked for after it to the frame after", () => {
    const ran: string[] = []
    inNextFrame(() => ran.push("one"))
    frame()
    inNextFrame(() => ran.push("two"))
    expect(frames).toHaveLength(1)
    frame()
    expect(ran).toEqual(["one", "two"])
  })

  it("runs nothing cancelled", () => {
    const ran: string[] = []
    const cancel = inNextFrame(() => ran.push("one"))
    inNextFrame(() => ran.push("two"))
    cancel()
    frame()
    expect(ran).toEqual(["two"])
  })
})

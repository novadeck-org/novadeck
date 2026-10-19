import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { flushMilliseconds, startCapture, tailMilliseconds } from "./capture"

// A microphone, audio context and worklet node that record what happens to them in order.
const setup = () => {
  const events: string[] = []
  const ports: { message?: (event: { data: unknown }) => void } = {}
  const posted: unknown[] = []
  const node = {
    port: {
      addEventListener: (_: string, listener: (event: { data: unknown }) => void) =>
        void (ports.message = listener),
      start: () => {},
      postMessage: (message: unknown) => void posted.push(message),
    },
    connect: () => ({ connect: () => {} }),
    disconnect: () => void events.push("node disconnected"),
  }
  const track = { stop: () => void events.push("track stopped") }
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [track] }) },
  })
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 16_000
      state = "running"
      destination = {}
      audioWorklet = { addModule: () => Promise.resolve() }
      createMediaStreamSource = () => ({
        connect: () => {},
        disconnect: () => void events.push("source disconnected"),
      })
      createGain = () => ({ gain: { value: 1 }, connect: () => ({ connect: () => {} }) })
      close = () => {
        events.push("context closed")
        return Promise.resolve()
      }
    },
  )
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = node.port
      connect = node.connect
      disconnect = node.disconnect
    },
  )
  const arrive = (data: unknown): void => ports.message?.({ data })
  return { events, posted, arrive }
}

describe("startCapture", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  context("when drained", () => {
    it("keeps listening for a tail, asks the worklet to flush, and only then lets go", async () => {
      const app = setup()
      const received: number[] = []
      const capture = await startCapture({
        onSamples: (samples) => void received.push(samples.length),
        onLevel: () => {},
      })
      const drained = capture.drain()

      await vi.advanceTimersByTimeAsync(tailMilliseconds - 1)
      expect(app.posted).toEqual([])
      expect(app.events).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(app.posted).toEqual(["flush"])
      expect(app.events).toEqual([])
      // The partial block, then the marker that nothing else is in flight.
      app.arrive(new Float32Array(1600))
      app.arrive("flushed")
      await drained
      expect(received).toEqual([1600])
      expect(app.events).toEqual([
        "node disconnected",
        "source disconnected",
        "track stopped",
        "context closed",
      ])
    })

    it("lets go anyway when the worklet never answers", async () => {
      const app = setup()
      const capture = await startCapture({ onSamples: () => {}, onLevel: () => {} })
      const drained = capture.drain()
      await vi.advanceTimersByTimeAsync(tailMilliseconds + flushMilliseconds)
      await drained
      expect(app.events).toContain("track stopped")
      expect(app.events).toContain("context closed")
    })
  })

  context("when stopped", () => {
    it("releases the microphone at once and ends a drain without a second release", async () => {
      const app = setup()
      const capture = await startCapture({ onSamples: () => {}, onLevel: () => {} })
      const drained = capture.drain()
      capture.stop()
      expect(app.events).toContain("track stopped")
      expect(app.events).toContain("context closed")
      await vi.advanceTimersByTimeAsync(tailMilliseconds + flushMilliseconds)
      await drained
      expect(app.events.filter((event) => event === "track stopped")).toHaveLength(1)
      expect(app.posted).toEqual([])
    })
  })
})

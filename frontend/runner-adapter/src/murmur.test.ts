import type { MurmurState } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"
import { vi } from "vitest"

import { createRunnerMurmur, noMurmur, type MurmurCalls } from "./murmur"
import { context, describe, expect, it } from "./test"

// What the runner streams: the adapter's own `refused` is not on the wire.
const { refused: _none, ...wireNone } = noMurmur
const installed: MurmurState = {
  ...wireNone,
  installed: true,
  enabled: true,
  wanted: true,
  check: { device: "Intel Arc Graphics", integrated: true, milliseconds: 5200 },
}

// The runner's murmur calls, with the snapshots the test pushes streamed by `watch`.
const runner = (overrides: Partial<MurmurCalls> = {}) => {
  const queued: MurmurState[] = []
  let wake: (() => void) | undefined
  const mocks = {
    watch: vi.fn<MurmurCalls["watch"]>(() => {
      const iterator: AsyncIterableIterator<MurmurState, undefined> = {
        [Symbol.asyncIterator]: () => iterator,
        next: async () => {
          // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed snapshot.
          while (!queued.length) await new Promise<void>((resolve) => (wake = resolve))
          return { value: queued.shift()!, done: false }
        },
        return: async () => ({ value: undefined, done: true }),
      }
      return iterator
    }),
    install: vi.fn<MurmurCalls["install"]>(async () => {}),
    cancel: vi.fn<MurmurCalls["cancel"]>(async () => {}),
    uninstall: vi.fn<MurmurCalls["uninstall"]>(async () => {}),
    set: vi.fn<MurmurCalls["set"]>(async () => {}),
    gist: vi.fn<MurmurCalls["gist"]>(async () => {}),
    noteOffered: vi.fn<MurmurCalls["noteOffered"]>(async () => {}),
  }
  const calls = { ...mocks, ...overrides }
  const push = (state: MurmurState) => {
    queued.push(state)
    wake?.()
  }
  return { calls: mocks, push, ...createRunnerMurmur(calls) }
}

describe("the runner's murmur", () => {
  it("shows nothing installed until the runner's first snapshot, then each one", async () => {
    const { murmur, follow, push } = runner()
    expect(murmur.state.getSnapshot()).toEqual(noMurmur)
    follow()
    push(installed)
    await vi.waitFor(() =>
      expect(murmur.state.getSnapshot()).toEqual({ ...installed, refused: null }),
    )
    push({
      ...installed,
      check: null,
      failure: "Murmur installed but did not pass its check on this computer.",
    })
    await vi.waitFor(() => expect(murmur.state.getSnapshot().check).toBeNull())
  })

  it("follows once, and stops following", () => {
    const { follow, stop, calls } = runner()
    follow()
    follow()
    expect(calls.watch).toHaveBeenCalledOnce()
    stop()
    follow()
    expect(calls.watch).toHaveBeenCalledTimes(2)
  })

  context("when a call is refused", () => {
    it("shows why, until the next snapshot", async () => {
      const { murmur, follow, push } = runner({
        install: async () => {
          throw new WireError("CONFLICT", "Already installing.")
        },
      })
      follow()
      await murmur.install()
      // The adapter's word, apart from what the runner says of its install.
      expect(murmur.state.getSnapshot()).toMatchObject({
        failure: null,
        refused: { call: "install", message: "Already installing." },
      })
      push(installed)
      await vi.waitFor(() => expect(murmur.state.getSnapshot().refused).toBeNull())
    })
  })

  it("counts a session the offer was shown in, and lets a refused count go", async () => {
    const noteOffered = vi.fn<MurmurCalls["noteOffered"]>(async () => {
      throw new WireError("CONFLICT", "No.")
    })
    const { murmur } = runner({ noteOffered })
    murmur.noteOffered()
    await vi.waitFor(() => expect(noteOffered).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(murmur.state.getSnapshot().refused).toBeNull()
  })

  it("passes installs, settings, cancels and uninstalls to the runner", () => {
    const { murmur, calls } = runner()
    void murmur.install()
    murmur.set({ enabled: true })
    murmur.cancel()
    murmur.uninstall()
    expect(calls.install).toHaveBeenCalled()
    expect(calls.set).toHaveBeenCalledWith({ enabled: true })
    expect(calls.cancel).toHaveBeenCalled()
    expect(calls.uninstall).toHaveBeenCalled()
  })

  context("when asked for a reply's gist", () => {
    it("passes the terminal and the end to the runner", () => {
      const { murmur, calls } = runner()
      murmur.gist?.("t1", 42)
      expect(calls.gist).toHaveBeenCalledWith("t1", 42)
    })

    it("lets a refused call go, as murmur is extra", async () => {
      const gist = vi.fn<MurmurCalls["gist"]>(async () => {
        throw new WireError("CONFLICT", "No.")
      })
      const { murmur } = runner({ gist })
      murmur.gist?.("t1", 42)
      await vi.waitFor(() => expect(gist).toHaveBeenCalled())
      await Promise.resolve()
      expect(murmur.state.getSnapshot().failure).toBeNull()
    })
  })

  it("settles an uninstall once the runner answered, whether it worked or failed", async () => {
    const { murmur, calls } = runner()
    await expect(murmur.uninstall()).resolves.toBeUndefined()
    calls.uninstall.mockRejectedValueOnce(new Error("Disk busy."))
    await expect(murmur.uninstall()).resolves.toBeUndefined()
    expect(murmur.state.getSnapshot().refused).toEqual({
      call: "uninstall",
      message: "Disk busy.",
    })
  })
})

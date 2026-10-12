import type { MurmurState } from "@novadeck/protocol"
import { RunnerError } from "@novadeck/protocol/client"
import { vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { createRunnerMurmur, noMurmur, type MurmurCalls } from "./murmur"

const installed: MurmurState = {
  ...noMurmur,
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
    await vi.waitFor(() => expect(murmur.state.getSnapshot()).toEqual(installed))
    push({
      ...installed,
      check: null,
      failure: "Murmur needs a GPU on this computer.",
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
          throw new RunnerError("CONFLICT", "Already installing.")
        },
      })
      follow()
      murmur.install()
      await vi.waitFor(() =>
        expect(murmur.state.getSnapshot().failure).toBe("Couldn't install: Already installing."),
      )
      push(installed)
      await vi.waitFor(() => expect(murmur.state.getSnapshot().failure).toBeNull())
    })
  })

  it("passes installs, settings, cancels and uninstalls to the runner", () => {
    const { murmur, calls } = runner()
    murmur.install()
    murmur.set({ enabled: true })
    murmur.cancel()
    murmur.uninstall()
    expect(calls.install).toHaveBeenCalled()
    expect(calls.set).toHaveBeenCalledWith({ enabled: true })
    expect(calls.cancel).toHaveBeenCalled()
    expect(calls.uninstall).toHaveBeenCalled()
  })

  it("settles an uninstall once the runner answered, whether it worked or failed", async () => {
    const { murmur, calls } = runner()
    await expect(murmur.uninstall()).resolves.toBeUndefined()
    calls.uninstall.mockRejectedValueOnce(new Error("Disk busy."))
    await expect(murmur.uninstall()).resolves.toBeUndefined()
    expect(murmur.state.getSnapshot().failure).toBe("Couldn't uninstall: Disk busy.")
  })
})

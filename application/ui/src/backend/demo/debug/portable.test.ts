import { afterEach, vi } from "vitest"

import type { PortableState } from "../../../model/portable"
import { describe, expect, it } from "../../../test"
import { createDemoPortable, portableRun, portableVersion } from "./portable"

const phases = (heard: PortableState[]): string[] =>
  heard.map((state) => (state.portable ? state.install.phase : "installed copy"))

afterEach(() => {
  vi.useRealTimers()
})

describe("demo portable copy", () => {
  it("says it is portable, with the install idle until asked", async () => {
    const { portable } = createDemoPortable({ ends: { phase: "newer", version: "0.0.99" } })
    expect(await portable.state()).toEqual({
      portable: true,
      version: portableVersion,
      run: portableRun,
      install: { phase: "idle" },
    })
  })

  it("pushes the install, then how it ends, after its delay, or never ends", async () => {
    vi.useFakeTimers()
    const { portable } = createDemoPortable({
      ends: { phase: "newer", version: "0.0.99" },
      installAfterMs: 3000,
    })
    const heard: PortableState[] = []
    portable.onState((state) => heard.push(state))
    portable.install()
    expect(phases(heard)).toEqual(["installing"])
    await vi.advanceTimersByTimeAsync(2999)
    expect(phases(heard)).toEqual(["installing"])
    await vi.advanceTimersByTimeAsync(1)
    expect(heard.at(-1)).toMatchObject({ install: { phase: "newer", version: "0.0.99" } })
    expect(await portable.state()).toEqual(heard.at(-1))

    const never = createDemoPortable({ ends: "never" }).portable
    const stuck: PortableState[] = []
    never.onState((state) => stuck.push(state))
    never.install()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(phases(stuck)).toEqual(["installing"])
  })

  it("answers the click with installing, then reports a download and the install, where it is told to", async () => {
    vi.useFakeTimers()
    const { portable } = createDemoPortable({
      ends: { phase: "installed" },
      installAfterMs: 3000,
      progress: true,
    })
    const heard: PortableState[] = []
    const stop = portable.onState((state) => heard.push(state))
    portable.install()
    await vi.advanceTimersByTimeAsync(3000)
    stop()
    expect(phases(heard)).toEqual([
      "installing",
      ...Array<string>(6).fill("downloading"),
      "installing",
      "installed",
    ])
    expect(heard[6]).toMatchObject({ install: { phase: "downloading", percent: 100 } })
  })

  it("ignores an install while under way or once done, and starts over after a failure", async () => {
    vi.useFakeTimers()
    const done = createDemoPortable({ ends: { phase: "installed" }, installAfterMs: 1000 })
    const heard: PortableState[] = []
    done.portable.onState((state) => heard.push(state))
    done.portable.install()
    done.portable.install()
    await vi.advanceTimersByTimeAsync(1000)
    done.portable.install()
    await vi.advanceTimersByTimeAsync(1000)
    expect(phases(heard)).toEqual(["installing", "installed"])

    const failing = createDemoPortable({
      ends: { phase: "failed", reason: "No space." },
      installAfterMs: 1000,
    })
    const tries: PortableState[] = []
    failing.portable.onState((state) => tries.push(state))
    failing.portable.install()
    await vi.advanceTimersByTimeAsync(1000)
    failing.portable.install()
    await vi.advanceTimersByTimeAsync(1000)
    expect(phases(tries)).toEqual(["installing", "failed", "installing", "failed"])
  })

  it("opens as the window opened again after installing says, and answers late when slow", async () => {
    vi.useFakeTimers()
    const { portable } = createDemoPortable({
      ends: { phase: "installed" },
      opens: { phase: "installed" },
      answerAfterMs: 4000,
    })
    const answered = vi.fn<(state: PortableState) => void>()
    void portable.state().then(answered)
    await vi.advanceTimersByTimeAsync(3999)
    expect(answered).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(answered).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ install: { phase: "installed" } }),
    )
    const heard: PortableState[] = []
    portable.onState((state) => heard.push(state))
    portable.install()
    expect(heard).toEqual([])
  })
})

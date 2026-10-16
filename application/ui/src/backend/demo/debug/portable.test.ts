import { vi } from "vitest"

import type { InstallProgress, InstallResult } from "../../../model/portable"
import { describe, expect, it } from "../../../test"
import { createDemoPortable, portableRun, portableVersion } from "./portable"

describe("demo portable copy", () => {
  it("says it is portable, and ends every install as armed", async () => {
    const { portable } = createDemoPortable({
      install: { kind: "newer", version: "0.0.99" },
    })
    expect(await portable.state()).toEqual({
      portable: true,
      version: portableVersion,
      run: portableRun,
      installed: false,
    })
    expect(await portable.install()).toEqual({
      kind: "newer",
      version: "0.0.99",
    })
  })

  it("answers after its delay, or never", async () => {
    vi.useFakeTimers()
    try {
      const slow = createDemoPortable({ install: { kind: "installed" }, installAfterMs: 3000 })
      const answers = vi.fn<(result: InstallResult) => void>()
      void slow.portable.install().then(answers)
      await vi.advanceTimersByTimeAsync(2999)
      expect(answers).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(answers).toHaveBeenCalledExactlyOnceWith({ kind: "installed" })
      const never = vi.fn<(result: InstallResult) => void>()
      void createDemoPortable({ install: "never" }).portable.install().then(never)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(never).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a download, then the install, before it answers, where it is told to", async () => {
    vi.useFakeTimers()
    try {
      const { portable } = createDemoPortable({
        install: { kind: "installed" },
        installAfterMs: 3000,
        progress: true,
      })
      const heard: InstallProgress[] = []
      const stop = portable.onProgress!((progress) => heard.push(progress))
      void portable.install()
      await vi.advanceTimersByTimeAsync(3000)
      stop()
      expect(heard.map((progress) => progress.phase)).toEqual([
        ...Array<string>(5).fill("downloading"),
        "installing",
      ])
      expect(heard[4]).toEqual({ phase: "downloading", percent: 100 })
    } finally {
      vi.useRealTimers()
    }
  })
})

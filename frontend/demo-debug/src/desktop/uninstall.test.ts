import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import {
  createDemoUninstall,
  sampleLeftover,
  stoppedReason,
  trashReason,
  uninstallMs,
  uninstallScenarios,
} from "./uninstall"

afterEach(() => {
  vi.useRealTimers()
})

describe("demo uninstall", () => {
  it("says what it would do, and ends every run as armed", async () => {
    vi.useFakeTimers()
    const plan = { kind: "ready", dataFolders: ["/data"], handoff: "app" } as const
    const { uninstall, runs, quits } = createDemoUninstall({
      plan,
      result: { kind: "removed", leftover: sampleLeftover },
    })
    expect(await uninstall.plan()).toEqual(plan)
    const run = uninstall.run({ keepData: false })
    await vi.advanceTimersByTimeAsync(uninstallMs)
    expect(await run).toEqual({ kind: "removed", leftover: sampleLeftover })
    expect(runs()).toEqual([false])
    uninstall.quit()
    expect(quits()).toBe(1)
  })

  it("repeats a stopped failure on every retry, and lets a Trash refusal succeed on the second", async () => {
    vi.useFakeTimers()
    const run = async (name: "stopped" | "trash") => {
      const { uninstall } = createDemoUninstall(uninstallScenarios[name])
      const once = async () => {
        const ended = uninstall.run({ keepData: true })
        await vi.advanceTimersByTimeAsync(uninstallMs)
        return ended
      }
      const first = await once()
      return [first, await once()]
    }
    expect(await run("stopped")).toEqual([
      { kind: "failed", reason: stoppedReason },
      { kind: "failed", reason: stoppedReason },
    ])
    expect(stoppedReason.endsWith("quit it and open it again.")).toBe(true)
    expect(await run("trash")).toEqual([
      { kind: "failed", reason: trashReason },
      { kind: "removed" },
    ])
  })
})

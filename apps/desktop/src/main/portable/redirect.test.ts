import { describe, expect, it } from "../../test"
import type { InstalledCopy } from "../install/linux"
import { leaveForNewerInstalled, redirectMarker, type InstalledCopyCheck } from "./redirect"

const copy = (version: string | undefined, unchecked = false): InstalledCopy => ({
  image: "/n/novadeck.AppImage",
  version,
  unchecked,
})

describe("a launch of a portable copy", () => {
  const checking = (
    overrides: Partial<InstalledCopyCheck> = {},
    refuse = false,
    recent = false,
  ) => {
    const calls: string[] = []
    const check: InstalledCopyCheck = {
      portable: true,
      version: "1.0.0",
      find: async () => [copy("1.1.0")],
      start: async (image) => {
        calls.push(`start ${image}`)
        return !refuse
      },
      alert: async (image) => void calls.push(`alert ${image}`),
      recentRedirect: () => recent,
      markRedirect: () => void calls.push("mark"),
      quit: () => void calls.push("quit"),
      log: (message) => void calls.push(`log ${message}`),
      ...overrides,
    }
    return { check, calls }
  }

  it("starts a newer installed copy in place of the launch, without asking", async () => {
    const { check, calls } = checking()
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["start /n/novadeck.AppImage"])
  })

  it("starts an installed copy of the same version too", async () => {
    const { check, calls } = checking({ find: async () => [copy("1.0.0")] })
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["mark", "start /n/novadeck.AppImage"])
  })

  it("tells the person and quits when a newer installed copy will not start", async () => {
    const { check, calls } = checking({}, true)
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["start /n/novadeck.AppImage", "alert /n/novadeck.AppImage", "quit"])
  })

  it("carries on, with no alert, when a same-version copy will not start", async () => {
    const { check, calls } = checking({ find: async () => [copy("1.0.0")] }, true)
    expect(await leaveForNewerInstalled(check)).toBe(false)
    expect(calls).toEqual([
      "mark",
      "start /n/novadeck.AppImage",
      "log The installed copy did not start; carrying on in this one.",
    ])
  })

  it("carries on, starting nothing, when it redirected to a same-version copy moments ago", async () => {
    const { check, calls } = checking({ find: async () => [copy("1.0.0")] }, false, true)
    expect(await leaveForNewerInstalled(check)).toBe(false)
    expect(calls).toEqual([
      "log Redirected to the installed copy just now; carrying on in this one.",
    ])
  })

  it("still starts a newer copy soon after a redirect", async () => {
    const { check, calls } = checking({}, false, true)
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["start /n/novadeck.AppImage"])
  })

  it("carries on when the installed copy is older, unchecked or none, or this copy is not portable", async () => {
    const runs = [
      { find: async () => [copy("0.9.0"), copy(undefined)] },
      // One that could not be looked at: the runner's refusal of a newer workspace is the fallback.
      { find: async () => [copy(undefined, true)] },
      { find: async () => [] },
      { portable: false },
    ].map(async (overrides) => {
      const { check, calls } = checking(overrides)
      return { left: await leaveForNewerInstalled(check), calls }
    })
    for (const { left, calls } of await Promise.all(runs)) {
      expect(left).toBe(false)
      expect(calls).toEqual([])
    }
  })

  it("carries on, and logs, when the installed copies cannot be looked at", async () => {
    const logged: string[] = []
    const { check } = checking({
      find: () => Promise.reject(new Error("denied")),
      log: (message) => void logged.push(message),
    })
    expect(await leaveForNewerInstalled(check)).toBe(false)
    expect(logged).toHaveLength(1)
  })
})

describe("the note of a redirect", () => {
  const noting = () => {
    let at: number | undefined
    let clock = 1_000
    const marker = redirectMarker(
      "/data/redirected-at",
      30_000,
      {
        modified: () => {
          if (at === undefined) throw new Error("ENOENT")
          return at
        },
        write: () => void (at = clock),
        remove: () => void (at = undefined),
      },
      () => clock,
      () => {},
    )
    return { marker, tick: (ms: number) => void (clock += ms) }
  }

  it("is recent within the window after a redirect, and not before one", () => {
    const { marker, tick } = noting()
    expect(marker.recent()).toBe(false)
    marker.mark()
    tick(10_000)
    expect(marker.recent()).toBe(true)
    tick(25_000)
    expect(marker.recent()).toBe(false)
  })

  it("is cleared when the installed copy starts, so a relaunch of the portable redirects again", () => {
    const { marker } = noting()
    marker.mark()
    marker.clear()
    expect(marker.recent()).toBe(false)
  })

  it("does not fail when the files cannot be written or removed", () => {
    const marker = redirectMarker(
      "/x",
      30_000,
      {
        modified: () => 0,
        write: () => {
          throw new Error("EACCES")
        },
        remove: () => {
          throw new Error("EACCES")
        },
      },
      () => 1,
      () => {},
    )
    expect(() => (marker.mark(), marker.clear())).not.toThrow()
  })
})

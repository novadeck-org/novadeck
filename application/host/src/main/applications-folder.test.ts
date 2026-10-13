import { describe, expect, it } from "../test"
import {
  bundleVersionOf,
  findInstalledApps,
  isNewerVersion,
  moveToApplications,
  renamedMoveReason,
  relaunchIntoCopy,
  resolveMoveConflict,
} from "./applications-folder"

describe("a name taken in Applications", () => {
  const running = "0.5.0"

  it("lets the move replace a copy that is not running", () => {
    expect(
      resolveMoveConflict("exists", { existingVersion: "0.4.0", runningVersion: running }),
    ).toBe("replace")
    expect(
      resolveMoveConflict("exists", { existingVersion: running, runningVersion: running }),
    ).toBe("replace")
  })

  it("lets it replace a copy whose version cannot be read", () => {
    expect(
      resolveMoveConflict("exists", { existingVersion: undefined, runningVersion: running }),
    ).toBe("replace")
    expect(
      resolveMoveConflict("exists", { existingVersion: "garbage", runningVersion: running }),
    ).toBe("replace")
  })

  it("cancels the move rather than replace a newer copy", () => {
    expect(
      resolveMoveConflict("exists", { existingVersion: "0.5.1", runningVersion: running }),
    ).toBe("newer")
    expect(
      resolveMoveConflict("exists", { existingVersion: "1.0.0", runningVersion: running }),
    ).toBe("newer")
    expect(
      resolveMoveConflict("exists", { existingVersion: "0.5.0", runningVersion: "0.5.0-beta.1" }),
    ).toBe("newer")
  })

  it("leaves a copy that is running alone", () => {
    expect(
      resolveMoveConflict("existsAndRunning", {
        existingVersion: "0.1.0",
        runningVersion: running,
      }),
    ).toBe("running")
  })
})

describe("which version is newer", () => {
  it("compares numbers, not text", () => {
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true)
    expect(isNewerVersion("0.9.0", "0.10.0")).toBe(false)
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false)
  })

  it("puts a release above its prereleases", () => {
    expect(isNewerVersion("1.0.0", "1.0.0-beta.1")).toBe(true)
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false)
    expect(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true)
  })

  it("is false for what is not a release's version", () => {
    expect(isNewerVersion("x", "1.0.0")).toBe(false)
    expect(isNewerVersion("2.0.0", "x")).toBe(false)
  })
})

describe("the version of an app in Applications", () => {
  it("is the short version string of its Info.plist", () => {
    const plist =
      "<dict><key>CFBundleVersion</key><string>9</string>\n<key>CFBundleShortVersionString</key>\n\t<string>1.2.3</string></dict>"
    expect(bundleVersionOf(plist)).toBe("1.2.3")
  })

  it("is nothing without one", () => {
    expect(bundleVersionOf("<dict></dict>")).toBeUndefined()
    expect(bundleVersionOf("bplist00")).toBeUndefined()
  })
})

describe("moving the app to Applications", () => {
  type Conflict = "exists" | "existsAndRunning"
  // A move that finds `conflict` in Applications, if any, and then does as Electron does:
  // stops at a handler that says no, throws as told, else moves.
  const moving = (
    {
      conflict,
      throws,
      moved = true,
      existing = "0.4.0",
    }: { conflict?: Conflict; throws?: Error; moved?: boolean; existing?: string } = {},
    running = "0.5.0",
  ) => {
    const steps: string[] = []
    const outcome = moveToApplications({
      move: (handler) => {
        steps.push("move")
        if (throws) throw throws
        if (conflict && !handler(conflict)) return false
        return moved
      },
      existingVersion: () => existing,
      runningVersion: running,
      log: (message) => void steps.push(`log ${message}`),
    })
    return { outcome, steps }
  }

  it("moves, and leaves the quit to Electron", () => {
    expect(moving()).toEqual({ outcome: { kind: "moved" }, steps: ["move"] })
  })

  it("replaces an older copy that is not running", () => {
    expect(moving({ conflict: "exists", existing: "0.4.0" }).outcome).toEqual({ kind: "moved" })
    expect(moving({ conflict: "exists", existing: "0.5.0" }).outcome).toEqual({ kind: "moved" })
  })

  it("leaves a newer copy alone and says which version it is", () => {
    const { outcome, steps } = moving({ conflict: "exists", existing: "0.6.0" })
    expect(outcome).toEqual({ kind: "newer", version: "0.6.0" })
    expect(steps).toEqual(["move"])
  })

  it("leaves a running copy alone, whatever its version, with the reason", () => {
    for (const existing of ["0.4.0", "0.6.0"])
      expect(moving({ conflict: "existsAndRunning", existing }).outcome).toEqual({
        kind: "failed",
        reason: "Novadeck is already running from Applications.",
      })
  })

  it("fails with the reason Electron gave, one line, and logs", () => {
    const { outcome, steps } = moving({
      throws: new Error("Failed to copy current bundle\nto the applications folder"),
    })
    expect(outcome).toEqual({
      kind: "failed",
      reason: "Failed to copy current bundle to the applications folder",
    })
    expect(steps).toEqual(["move", "log Moving to Applications failed."])
  })

  it("fails when the person refused the authorization", () => {
    expect(
      moving({ throws: new Error("User rejected the authorization request") }).outcome,
    ).toEqual({ kind: "failed", reason: "User rejected the authorization request" })
  })

  it("fails when Electron would not move the app, without throwing", () => {
    expect(moving({ moved: false }).outcome).toEqual({
      kind: "failed",
      reason: "Moving to Applications was cancelled.",
    })
  })

  it("says something for a failure that has no message", () => {
    expect(moving({ throws: new Error("") }).outcome).toEqual({
      kind: "failed",
      reason: "Moving to Applications failed.",
    })
  })
})

describe("a renamed copy moving beside an installed one", () => {
  const reason = (running: string, installed: boolean) =>
    renamedMoveReason({ running, packaged: "novadeck.app", installed })

  it("is refused, with how to go on, when the packaged name is installed", () => {
    expect(reason("novadeck 2.app", true)).toBe(
      "This copy is named novadeck 2.app, and novadeck.app is already in Applications. " +
        "Rename this copy to novadeck.app, or remove the old one, and try again.",
    )
  })

  it("is allowed where the copy has the packaged name, or none is installed", () => {
    expect(reason("novadeck.app", true)).toBeUndefined()
    expect(reason("novadeck 2.app", false)).toBeUndefined()
  })
})

describe("the copies installed in Applications", () => {
  const plist = (version: string): string =>
    `<key>CFBundleShortVersionString</key><string>${version}</string>`
  const finding = (
    files: Record<string, string | Error>,
    { folders = ["/A", "/H"], names = ["n.app"] } = {},
  ) =>
    findInstalledApps({
      folders,
      names,
      exists: async (path) => Object.keys(files).some((file) => file.startsWith(`${path}/`)),
      readFile: async (path) => {
        const file = files[path]
        if (file === undefined || file instanceof Error) throw file ?? new Error("missing")
        return file
      },
    })

  it("lists the bundles that exist with the versions they report, in order", async () => {
    expect(
      await finding({
        "/H/n.app/Contents/Info.plist": plist("0.4.0"),
        "/A/n.app/Contents/Info.plist": plist("0.5.1"),
      }),
    ).toEqual([
      { image: "/A/n.app", version: "0.5.1", unchecked: false },
      { image: "/H/n.app", version: "0.4.0", unchecked: false },
    ])
  })

  it("finds the packaged name beside a renamed running copy, the running name first, once", async () => {
    const files = {
      "/A/n.app/Contents/Info.plist": plist("0.6.0"),
      "/A/n 2.app/Contents/Info.plist": plist("0.4.0"),
    }
    expect(await finding(files, { folders: ["/A"], names: ["n 2.app", "n.app"] })).toEqual([
      { image: "/A/n 2.app", version: "0.4.0", unchecked: false },
      { image: "/A/n.app", version: "0.6.0", unchecked: false },
    ])
    // The running copy has the packaged name: it is looked for once.
    expect(await finding(files, { folders: ["/A"], names: ["n.app", "n.app"] })).toHaveLength(1)
  })

  it("lists none where there is no bundle", async () => {
    expect(await finding({})).toEqual([])
  })

  it("has no version for a plist that names none a release has, and is not unchecked", async () => {
    expect(
      await finding({ "/A/n.app/Contents/Info.plist": plist("latest") }, { folders: ["/A"] }),
    ).toEqual([{ image: "/A/n.app", version: undefined, unchecked: false }])
  })

  it("marks a bundle whose plist cannot be read as unchecked", async () => {
    expect(await finding({ "/A/n.app/Contents/MacOS/n": "" }, { folders: ["/A"] })).toEqual([
      { image: "/A/n.app", version: undefined, unchecked: true },
    ])
  })
})

const starting = ({ present = true, throws = false } = {}) => {
  const steps: string[] = []
  const result = relaunchIntoCopy({
    executable: "/Applications/novadeck.app/Contents/MacOS/novadeck",
    exists: () => present,
    relaunch: (executable) => {
      steps.push(`relaunch ${executable}`)
      if (throws) throw new Error("no")
    },
    exit: () => void steps.push("exit"),
    log: (message) => void steps.push(`log ${message}`),
  })
  return { result, steps }
}

describe("starting the newer copy in Applications", () => {
  it("relaunches into the copy's executable and ends this process", () => {
    const { result, steps } = starting()
    expect(result).toBe(true)
    expect(steps).toEqual(["relaunch /Applications/novadeck.app/Contents/MacOS/novadeck", "exit"])
  })

  it("stays here, and says so, when the executable is not there", () => {
    const { result, steps } = starting({ present: false })
    expect(result).toBe(false)
    expect(steps).toEqual(["log The newer copy has no executable to start."])
  })

  it("stays here when the relaunch fails, ending nothing", () => {
    const { result, steps } = starting({ throws: true })
    expect(result).toBe(false)
    expect(steps).not.toContain("exit")
  })
})

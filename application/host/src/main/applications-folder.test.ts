import { describe, expect, it } from "../test"
import {
  bundleVersionOf,
  findInstalledApps,
  isNewerVersion,
  installBundle,
  recoverBundles,
  relaunchIntoCopy,
  type BundleInstallHost,
} from "./applications-folder"

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

describe("installing the app bundle", () => {
  const running = "/Volumes/Novadeck/novadeck.app"

  // A machine with the given paths present and writable; steps are recorded in order.
  const machine = (
    options: {
      present?: string[]
      unwritable?: string[]
      failAt?: string
      failCode?: string
      versions?: Record<string, string>
    } = {},
  ) => {
    const present = new Set(options.present ?? [])
    const steps: string[] = []
    const step = async (name: string): Promise<void> => {
      steps.push(name)
      if (options.failAt === name)
        throw Object.assign(new Error("it broke"), { code: options.failCode })
    }
    const host: BundleInstallHost = {
      running,
      version: "1.0.0",
      versionOf: (path) => Promise.resolve(options.versions?.[path]),
      packaged: "novadeck.app",
      applications: "/Applications",
      userApplications: "/Users/me/Applications",
      exists: (path) => Promise.resolve(present.has(path)),
      writable: (path) => Promise.resolve(!(options.unwritable ?? []).includes(path)),
      mkdir: (folder) => step(`mkdir ${folder}`),
      ditto: (from, to) => step(`ditto ${from} ${to}`),
      unquarantine: (path) => step(`xattr ${path}`),
      rename: async (from, to) => {
        await step(`rename ${from} ${to}`)
        present.delete(from)
        present.add(to)
      },
      remove: async (path) => {
        await step(`rm ${path}`)
        present.delete(path)
      },
      log: () => {},
    }
    return { host, steps }
  }
  // The steps that change the machine, without the clean-up of leftovers.
  const changes = (steps: string[]): string[] => steps.filter((each) => !each.startsWith("rm "))

  it("puts a new copy under the packaged name in Applications, copy then unquarantine then rename", async () => {
    const { host, steps } = machine()
    expect(await installBundle(undefined, host)).toEqual({
      kind: "installed",
      image: "/Applications/novadeck.app",
    })
    expect(changes(steps)).toEqual([
      `ditto ${running} /Applications/.novadeck.app.new`,
      "xattr /Applications/.novadeck.app.new",
      "rename /Applications/.novadeck.app.new /Applications/novadeck.app",
    ])
  })

  it("uses the person's own Applications folder when the system one cannot be written", async () => {
    const { host, steps } = machine({ unwritable: ["/Applications"] })
    expect(await installBundle(undefined, host)).toEqual({
      kind: "installed",
      image: "/Users/me/Applications/novadeck.app",
    })
    expect(steps[0]).toBe("mkdir /Users/me/Applications")
  })

  it("replaces the existing copy where it is, swapping it aside and removing it last", async () => {
    const existing = "/Users/me/Applications/novadeck.app"
    const { host, steps } = machine({ present: [existing] })
    expect(await installBundle(existing, host)).toEqual({ kind: "installed", image: existing })
    const dir = "/Users/me/Applications"
    expect(steps.slice(-4)).toEqual([
      `xattr ${dir}/.novadeck.app.new`,
      `rename ${existing} ${dir}/.novadeck.app.old`,
      `rename ${dir}/.novadeck.app.new ${existing}`,
      `rm ${dir}/.novadeck.app.old`,
    ])
  })

  it("puts the old copy back when the new one cannot be renamed into place", async () => {
    const existing = "/Applications/novadeck.app"
    const { host, steps } = machine({
      present: [existing],
      failAt: "rename /Applications/.novadeck.app.new /Applications/novadeck.app",
    })
    const result = await installBundle(existing, host)
    expect(result.kind).toBe("failed")
    expect(steps).toContain("rename /Applications/.novadeck.app.old /Applications/novadeck.app")
    expect(steps.at(-1)).toBe("rm /Applications/.novadeck.app.new")
  })

  it("restores a copy left renamed aside, before installing over it", async () => {
    const aside = "/Applications/.novadeck.app.old"
    const { host, steps } = machine({ present: [aside] })
    expect(await installBundle(undefined, host)).toEqual({
      kind: "installed",
      image: "/Applications/novadeck.app",
    })
    expect(steps[0]).toBe(`rename ${aside} /Applications/novadeck.app`)
    expect(steps).toContain("rename /Applications/novadeck.app /Applications/.novadeck.app.old")
  })

  it("clears a stale half-made copy and an aside beside a copy that is there", async () => {
    const present = [
      "/Applications/novadeck.app",
      "/Applications/.novadeck.app.old",
      "/Users/me/Applications/.novadeck.app.new",
    ]
    const { host, steps } = machine({ present })
    expect(await recoverBundles({ ...host, names: ["novadeck.app"] })).toBeUndefined()
    expect(steps).toEqual([
      "rm /Applications/.novadeck.app.old",
      "rm /Users/me/Applications/.novadeck.app.new",
    ])
  })

  it("restores the only copy when the person's own Applications folder holds it aside", async () => {
    const { host, steps } = machine({ present: ["/Users/me/Applications/.novadeck.app.old"] })
    expect(await recoverBundles({ ...host, names: ["novadeck.app"] })).toBe(
      "/Users/me/Applications/novadeck.app",
    )
    expect(steps).toEqual([
      "rename /Users/me/Applications/.novadeck.app.old /Users/me/Applications/novadeck.app",
    ])
  })

  it("restores a renamed installed copy left aside, by its own name", async () => {
    const aside = "/Applications/.novadeck 2.app.old"
    const { host, steps } = machine({ present: [aside] })
    expect(await recoverBundles({ ...host, names: ["novadeck.app", "novadeck 2.app"] })).toBe(
      "/Applications/novadeck 2.app",
    )
    expect(steps).toEqual([`rename ${aside} /Applications/novadeck 2.app`])
  })

  it("restores the aside of the renamed copy it is about to replace", async () => {
    const existing = "/Applications/novadeck 2.app"
    const aside = "/Applications/.novadeck 2.app.old"
    const { host, steps } = machine({ present: [aside, "/Applications/.novadeck 2.app.new"] })
    expect(await installBundle(existing, host)).toMatchObject({ kind: "installed" })
    expect(steps[0]).toBe(`rename ${aside} ${existing}`)
    expect(steps).toContain("rm /Applications/.novadeck 2.app.new")
  })

  it("says plainly that macOS did not allow replacing the installed copy on EPERM", async () => {
    const existing = "/Applications/novadeck.app"
    const { host, steps } = machine({
      present: [existing],
      failAt: `rename ${existing} /Applications/.novadeck.app.old`,
      failCode: "EPERM",
      versions: { [existing]: "0.9.0" },
    })
    expect(await installBundle(existing, host)).toEqual({
      kind: "failed",
      reason:
        "macOS didn't allow replacing the installed Novadeck. Remove it yourself and try again.",
    })
    expect(steps.at(-1)).toBe("rm /Applications/.novadeck.app.new")
  })

  it("replaces an older installed copy", async () => {
    const existing = "/Applications/novadeck.app"
    const { host } = machine({ present: [existing], versions: { [existing]: "0.9.0" } })
    expect(await installBundle(existing, host)).toEqual({ kind: "installed", image: existing })
  })

  it("leaves an installed copy of the same version alone, writing nothing", async () => {
    const existing = "/Applications/novadeck.app"
    const { host, steps } = machine({ present: [existing], versions: { [existing]: "1.0.0" } })
    expect(await installBundle(existing, host)).toEqual({ kind: "installed", image: existing })
    expect(steps).toEqual([])
  })

  it("never replaces the bundle it runs from", async () => {
    const { host, steps } = machine({ present: [running] })
    expect(await installBundle(running, host)).toEqual({ kind: "installed", image: running })
    expect(steps).toEqual([])
  })

  it("fails and writes nothing for an existing copy that belongs to another account", async () => {
    const existing = "/Applications/novadeck.app"
    const runs = [[existing], ["/Applications"]].map(async (unwritable) => {
      const { host, steps } = machine({ present: [existing], unwritable })
      return { result: await installBundle(existing, host), steps }
    })
    for (const { result, steps } of await Promise.all(runs)) {
      expect(result).toEqual({
        kind: "failed",
        reason:
          "Novadeck in Applications belongs to another account on this Mac. Remove it and try again.",
      })
      expect(steps).toEqual([])
    }
  })

  it("removes the half-made copy and changes nothing when copying or unquarantining fails", async () => {
    const failures = [
      `ditto ${running} /Applications/.novadeck.app.new`,
      "xattr /Applications/.novadeck.app.new",
    ].map(async (failAt) => {
      const { host, steps } = machine({ present: ["/Applications/novadeck.app"], failAt })
      return { result: await installBundle("/Applications/novadeck.app", host), steps }
    })
    for (const { result, steps } of await Promise.all(failures)) {
      expect(result.kind).toBe("failed")
      expect(steps.some((each) => each.startsWith("rename"))).toBe(false)
      expect(steps.at(-1)).toBe("rm /Applications/.novadeck.app.new")
    }
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

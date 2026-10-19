import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { copyFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test"
import {
  allowMacUpdates,
  installMacUpdate,
  macSwapMode,
  macUpdateHost,
  prepareMacUpdate,
  removeMacUpdates,
  updateRequirement,
  UpdateRejected,
  type MacUpdateHost,
} from "./mac-update"

const plist = (id: string, version: string): string =>
  `<dict><key>CFBundleIdentifier</key><string>${id}</string>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string></dict>`

const signed = (team: string | undefined): string =>
  `Identifier=dev.mzpk.novadeck\nFormat=app bundle\nTeamIdentifier=${team ?? "not set"}\n`

// A machine whose files are the given paths and contents (a folder is a path holding
// others); each effect is recorded, and `fail` may make one throw.
const machine = (
  options: {
    files?: Record<string, string>
    unwritable?: string[]
    fail?: (step: string) => (Error & { code?: string | undefined }) | undefined
    zipHolds?: string[]
    modified?: Record<string, number>
    versionOf?: string
    teams?: Record<string, string | undefined>
    verifyFails?: boolean | "stopped"
  } = {},
) => {
  const files = new Map(Object.entries(options.files ?? {}))
  const steps: string[] = []
  let made = 0
  const names = (folder: string): string[] => {
    const found = new Set<string>()
    for (const path of files.keys())
      if (path.startsWith(`${folder}/`))
        found.add(path.slice(folder.length + 1).split("/")[0] ?? "")
    return [...found]
  }
  const exists = (path: string): boolean =>
    files.has(path) || [...files.keys()].some((each) => each.startsWith(`${path}/`))
  const move = (from: string, to: string): void => {
    for (const [path, content] of Array.from(files)) {
      if (path === from || path.startsWith(`${from}/`)) {
        files.delete(path)
        files.set(to + path.slice(from.length), content)
      }
    }
  }
  const drop = (path: string): void => {
    for (const each of Array.from(files.keys()))
      if (each === path || each.startsWith(`${path}/`)) files.delete(each)
  }
  const requirements: (string | undefined)[] = []
  const step = async (name: string): Promise<void> => {
    steps.push(name)
    const error = options.fail?.(name)
    if (error) throw error
  }
  const host: MacUpdateHost = {
    folder: () => "/tmp",
    readdir: async (folder) => names(folder),
    readFile: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error("no such file")
      return content
    },
    mkdtemp: async (prefix) => {
      made += 1
      files.set(`${prefix}${made}/.keep`, "")
      return `${prefix}${made}`
    },
    exists: async (path) => exists(path),
    modified: async (path) => options.modified?.[path] ?? 0,
    writable: async (path) => !(options.unwritable ?? []).includes(path),
    rename: async (from, to) => {
      await step(`rename ${from} ${to}`)
      if (exists(to)) throw Object.assign(new Error("exists"), { code: "ENOTEMPTY" })
      move(from, to)
    },
    remove: async (path) => {
      await step(`remove ${path}`)
      drop(path)
    },
    unzip: async (zip, folder) => {
      await step(`unzip ${zip} ${folder}`)
      for (const name of options.zipHolds ?? ["novadeck.app"]) {
        files.set(
          `${folder}/${name}/Contents/Info.plist`,
          plist("dev.mzpk.novadeck", options.versionOf ?? "2.0.0"),
        )
        files.set(`${folder}/${name}/Contents/MacOS/novadeck`, "new")
      }
    },
    copy: async (source, destination) => {
      await step(`copy ${source} ${destination}`)
      for (const [path, content] of Array.from(files))
        if (path.startsWith(`${source}/`))
          files.set(destination + path.slice(source.length), content)
    },
    unquarantine: (path) => step(`xattr ${path}`),
    codesignVerify: async (bundle, requirement) => {
      await step(`verify ${bundle}`)
      requirements.push(requirement)
      if (options.verifyFails === "stopped")
        throw Object.assign(new Error("timed out"), { code: null, killed: true })
      if (options.verifyFails)
        throw Object.assign(new Error("a sealed resource is missing"), { code: 1 })
    },
    codesignDetails: async (bundle) => {
      const teams = options.teams ?? {}
      return signed(bundle in teams ? teams[bundle] : "TEAM123456")
    },
    osascript: (script) => step(`osascript ${script}`),
  }
  return { host, files, steps, requirements }
}

const running = "/Applications/novadeck.app"
const base = {
  [`${running}/Contents/Info.plist`]: plist("dev.mzpk.novadeck", "1.0.0"),
  [`${running}/Contents/MacOS/novadeck`]: "old",
}
const update = { zip: "/dl/novadeck-mac-universal.zip", version: "2.0.0", bundle: running }

const failing = (code: string | undefined, on: string) => (step: string) =>
  step.startsWith(on) ? Object.assign(new Error("it broke"), { code }) : undefined

describe("how the running bundle can be replaced", () => {
  it("is whole where the bundle and its folder can be written", async () => {
    expect(await macSwapMode(running, machine().host)).toBe("whole")
  })

  it("is the contents where only the bundle can be written", async () => {
    const { host } = machine({ unwritable: ["/Applications"] })
    expect(await macSwapMode(running, host)).toBe("contents")
  })

  it("is nothing where the bundle cannot be written, or its contents", async () => {
    expect(await macSwapMode(running, machine({ unwritable: [running] }).host)).toBeUndefined()
    const { host } = machine({ unwritable: ["/Applications", `${running}/Contents`] })
    expect(await macSwapMode(running, host)).toBeUndefined()
  })
})

describe("preparing a downloaded update", () => {
  it("unpacks, unquarantines and verifies it, and gives the app's path", async () => {
    const { host, steps } = machine({ files: base })
    const prepared = await prepareMacUpdate(update, host)
    expect(prepared).toBe("/tmp/dev.mzpk.novadeck.update-1/novadeck.app")
    expect(steps).toContain("unzip /dl/novadeck-mac-universal.zip /tmp/dev.mzpk.novadeck.update-1")
    expect(steps).toContain("xattr /tmp/dev.mzpk.novadeck.update-1")
    expect(steps).toContain(`verify ${prepared}`)
  })

  it("leaves earlier prepared folders, as one may be going into place", async () => {
    const earlier = "/tmp/dev.mzpk.novadeck.update-old/novadeck.app/Contents/Info.plist"
    const { host, files } = machine({ files: { ...base, [earlier]: "x" } })
    await prepareMacUpdate(update, host)
    expect(files.has(earlier)).toBe(true)
  })

  it("tells an update not to install apart from one that failed to unpack", async () => {
    const { host } = machine({ files: base, versionOf: "1.5.0" })
    await expect(prepareMacUpdate(update, host)).rejects.toBeInstanceOf(UpdateRejected)
    const unpacking = machine({ files: base, fail: failing(undefined, "unzip") })
    const error: unknown = await prepareMacUpdate(update, unpacking.host).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(UpdateRejected)
  })

  it("removes the prepared folders but the one kept, and nothing else", async () => {
    const { host, files } = machine({
      files: {
        "/tmp/dev.mzpk.novadeck.update-old/previous.app/x": "x",
        "/tmp/dev.mzpk.novadeck.update-new/novadeck.app/x": "x",
        "/tmp/other.app-folder/keep": "x",
      },
    })
    await removeMacUpdates({ keep: "/tmp/dev.mzpk.novadeck.update-new/novadeck.app" }, host)
    expect([...files.keys()].toSorted()).toEqual([
      "/tmp/dev.mzpk.novadeck.update-new/novadeck.app/x",
      "/tmp/other.app-folder/keep",
    ])
    await removeMacUpdates({}, host)
    expect([...files.keys()]).toEqual(["/tmp/other.app-folder/keep"])
  })

  it("leaves a folder changed recently, which another copy may be installing from", async () => {
    const { host, files } = machine({
      files: {
        "/tmp/dev.mzpk.novadeck.update-busy/previous.app/x": "x",
        "/tmp/dev.mzpk.novadeck.update-old/previous.app/x": "x",
      },
      modified: { "/tmp/dev.mzpk.novadeck.update-busy": Date.now() },
    })
    await removeMacUpdates({ olderThanMs: 10 * 60 * 1000 }, host)
    expect([...files.keys()]).toEqual(["/tmp/dev.mzpk.novadeck.update-busy/previous.app/x"])
  })

  const rejects = async (
    options: Parameters<typeof machine>[0],
    message: RegExp,
    check = update,
  ) => {
    const { host, files } = machine({ files: base, ...options })
    await expect(prepareMacUpdate(check, host)).rejects.toThrow(message)
    // Nothing of the failed preparation stays.
    expect([...files.keys()].some((path) => path.includes(".update-"))).toBe(false)
  }

  it("rejects an app with another identifier", () =>
    rejects(
      { files: { ...base, [`${running}/Contents/Info.plist`]: plist("com.other", "1.0.0") } },
      /not for this app/u,
    ))

  it("rejects another version than the announced one", () =>
    rejects({ versionOf: "1.5.0" }, /not the version that was announced/u))

  it("rejects a signature that does not verify", () =>
    rejects({ verifyFails: true }, /signature is not valid/u))

  it("does not reject an update whose signature could not be checked, as when codesign stopped", async () => {
    const { host } = machine({ files: base, verifyFails: "stopped" })
    const error: unknown = await prepareMacUpdate(update, host).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(UpdateRejected)
    expect(String(error)).toMatch(/could not be checked/u)
  })

  it("holds the signature to Apple's chain for the running app's team, not its named team", async () => {
    const { host, requirements } = machine({ files: base })
    await prepareMacUpdate(update, host)
    expect(requirements).toEqual([updateRequirement("TEAM123456")])
    expect(updateRequirement("TEAM123456")).toBe(
      '=anchor apple generic and certificate leaf[subject.OU] = "TEAM123456"',
    )
  })

  it("rejects an update without a team, and one from another", async () => {
    const prepared = "/tmp/dev.mzpk.novadeck.update-1/novadeck.app"
    await rejects({ teams: { [prepared]: undefined } }, /different team/u)
    await rejects({ teams: { [prepared]: "OTHER00000" } }, /different team/u)
  })

  it("rejects any update while the running app has no team to check it against", async () => {
    await rejects({ teams: { [running]: undefined } }, /not signed by a developer team/u)
    await rejects({ teams: { [running]: "not a team" } }, /not signed by a developer team/u)
  })

  it("rejects a zip with no app, or with two", async () => {
    await rejects({ zipHolds: [] }, /exactly one app/u)
    await rejects({ zipHolds: ["a.app", "b.app"] }, /exactly one app/u)
  })

  it("rejects a zip that cannot be unpacked", () =>
    rejects({ fail: failing(undefined, "unzip") }, /could not be unpacked/u))
})

describe("installing a prepared update", () => {
  const prepared = "/tmp/dev.mzpk.novadeck.update-1/novadeck.app"
  const withPrepared = (options: Parameters<typeof machine>[0] = {}) =>
    machine({
      ...options,
      files: {
        ...base,
        [`${prepared}/Contents/Info.plist`]: plist("dev.mzpk.novadeck", "2.0.0"),
        [`${prepared}/Contents/MacOS/novadeck`]: "new",
        ...options.files,
      },
    })

  const folder = "/tmp/dev.mzpk.novadeck.update-1"
  const staged = "/Applications/.novadeck.app.new"
  const aside = "/Applications/.novadeck.app.previous"
  const renames = (steps: string[]) => steps.filter((step) => step.startsWith("rename"))

  it("stages the new app beside the old, then swaps them in two renames there", async () => {
    const { host, files, steps } = withPrepared()
    await installMacUpdate({ prepared, bundle: running, mode: "whole" }, host)
    expect(files.get(`${running}/Contents/MacOS/novadeck`)).toBe("new")
    expect(renames(steps)).toEqual([
      `rename ${prepared} ${staged}`,
      `rename ${running} ${aside}`,
      `rename ${staged} ${running}`,
      `rename ${aside} ${folder}/previous.app`,
    ])
    // The old app waits in the prepared folder for the next launch to remove it.
    expect(files.get(`${folder}/previous.app/Contents/MacOS/novadeck`)).toBe("old")
  })

  it("swaps only the contents, inside the bundle, leaving the bundle folder", async () => {
    const { host, files, steps } = withPrepared({ files: { [`${running}/Keep`]: "me" } })
    await installMacUpdate({ prepared, bundle: running, mode: "contents" }, host)
    expect(files.get(`${running}/Contents/MacOS/novadeck`)).toBe("new")
    expect(files.get(`${running}/Keep`)).toBe("me")
    expect(renames(steps)).toEqual([
      `rename ${prepared}/Contents ${running}/.Contents.new`,
      `rename ${running}/Contents ${running}/.Contents.previous`,
      `rename ${running}/.Contents.new ${running}/Contents`,
      `rename ${running}/.Contents.previous ${folder}/previous`,
    ])
  })

  it("checks the prepared app again before it goes in, leaving the old app whole if it fails", async () => {
    const { host, files, requirements } = withPrepared({ verifyFails: true })
    await expect(
      installMacUpdate({ prepared, bundle: running, mode: "whole" }, host),
    ).rejects.toThrow(/no longer passes its signature check/u)
    expect(requirements).toEqual([updateRequirement("TEAM123456")])
    expect(files.get(`${running}/Contents/MacOS/novadeck`)).toBe("old")
  })

  it("removes old contents it could not move out of the bundle", async () => {
    const { host, files } = withPrepared({
      fail: (step) =>
        step.startsWith(`rename ${running}/.Contents.previous `)
          ? Object.assign(new Error("cross"), { code: "EXDEV" })
          : undefined,
    })
    await installMacUpdate({ prepared, bundle: running, mode: "contents" }, host)
    expect(files.get(`${running}/Contents/MacOS/novadeck`)).toBe("new")
    expect([...files.keys()].some((path) => path.includes(".Contents.previous"))).toBe(false)
  })

  it("leaves the old app whole when moving it aside fails", async () => {
    const { host, files } = withPrepared({ fail: failing("EIO", `rename ${running} `) })
    await expect(
      installMacUpdate({ prepared, bundle: running, mode: "whole" }, host),
    ).rejects.toThrow(/could not be installed/u)
    expect(files.get(`${running}/Contents/MacOS/novadeck`)).toBe("old")
    expect([...files.keys()].some((path) => path.startsWith(staged))).toBe(false)
  })

  it("puts the old app back when moving the new one in fails", async () => {
    const { host, files } = withPrepared({ fail: failing("EIO", `rename ${staged} `) })
    await expect(
      installMacUpdate({ prepared, bundle: running, mode: "whole" }, host),
    ).rejects.toThrow(/could not be installed/u)
    expect(files.get(`${running}/Contents/MacOS/novadeck`)).toBe("old")
    expect([...files.keys()].some((path) => path.startsWith(staged))).toBe(false)
  })

  it("puts the old contents back when the new ones fail to go in", async () => {
    const { host, files } = withPrepared({
      fail: failing("EIO", `rename ${running}/.Contents.new `),
    })
    await expect(
      installMacUpdate({ prepared, bundle: running, mode: "contents" }, host),
    ).rejects.toThrow(/could not be installed/u)
    expect(files.get(`${running}/Contents/MacOS/novadeck`)).toBe("old")
  })

  it("says why when macOS does not allow it", async () => {
    const { host } = withPrepared({ fail: failing("EPERM", `rename ${running} `) })
    await expect(
      installMacUpdate({ prepared, bundle: running, mode: "whole" }, host),
    ).rejects.toThrow(/App Management/u)
  })

  it("copies the new app beside the old one from another volume before touching it", async () => {
    const { host, files, steps } = withPrepared({
      fail: (step) =>
        step.startsWith(`rename ${prepared} `) || step.startsWith(`rename ${aside} `)
          ? Object.assign(new Error("cross"), { code: "EXDEV" })
          : undefined,
    })
    await installMacUpdate({ prepared, bundle: running, mode: "whole" }, host)
    expect(files.get(`${running}/Contents/MacOS/novadeck`)).toBe("new")
    const copied = steps.indexOf(`copy ${prepared} ${staged}`)
    expect(copied).toBeGreaterThanOrEqual(0)
    expect(copied).toBeLessThan(steps.indexOf(`rename ${running} ${aside}`))
    // The old app could not cross either, so it stays beside, for the next launch.
    expect(files.get(`${aside}/Contents/MacOS/novadeck`)).toBe("old")
  })

  it("leaves the old app whole when copying the new one across fails", async () => {
    const { host, files } = withPrepared({
      fail: (step) =>
        step.startsWith(`rename ${prepared} `)
          ? Object.assign(new Error("cross"), { code: "EXDEV" })
          : step.startsWith("copy")
            ? Object.assign(new Error("full"), { code: "ENOSPC" })
            : undefined,
    })
    await expect(
      installMacUpdate({ prepared, bundle: running, mode: "whole" }, host),
    ).rejects.toThrow(/no space left/u)
    expect(files.get(`${running}/Contents/MacOS/novadeck`)).toBe("old")
    expect([...files.keys()].some((path) => path.startsWith(staged))).toBe(false)
  })

  it("says so when the old app cannot be put back either", async () => {
    const { host } = withPrepared({
      fail: (step) =>
        step.startsWith(`rename ${staged} `) || step.startsWith(`rename ${aside} ${running}`)
          ? new Error("it broke")
          : undefined,
    })
    await expect(
      installMacUpdate({ prepared, bundle: running, mode: "whole" }, host),
    ).rejects.toThrow(/could not be put back/u)
  })
})

describe("clearing what updates left", () => {
  it("removes what an install left beside the bundle and its contents", async () => {
    const { host, files } = machine({
      files: {
        ...base,
        "/Applications/.novadeck.app.previous/x": "x",
        [`${running}/.Contents.previous/x`]: "x",
      },
    })
    await removeMacUpdates({ bundle: running }, host)
    expect([...files.keys()].toSorted()).toEqual(Object.keys(base).toSorted())
  })
})

describe("allowing updates with an administrator prompt", () => {
  const allow = { bundle: `/Applications/it's "a" back\\slash.app`, uid: 501, gid: 20 }

  it("quotes the path for AppleScript and for sh", async () => {
    const { host, steps } = machine()
    expect(await allowMacUpdates(allow, host)).toBe(true)
    const script = steps[0]?.replace("osascript ", "") ?? ""
    expect(script).toBe(
      `do shell script "/usr/sbin/chown -R 501:20 '/Applications/it'\\\\''s \\"a\\" back\\\\slash.app'" with administrator privileges`,
    )
  })

  it("is false when the person cancels", async () => {
    const { host } = machine({
      fail: () => new Error("execution error: User canceled. (-128)"),
    })
    expect(await allowMacUpdates(allow, host)).toBe(false)
  })

  it("rejects on any other failure, and on ids that are not numbers", async () => {
    const { host } = machine({ fail: () => new Error("boom") })
    await expect(allowMacUpdates(allow, host)).rejects.toThrow(/could not be allowed/u)
    await expect(allowMacUpdates({ ...allow, uid: Number.NaN }, host)).rejects.toThrow()
  })
})

// The real commands, on a tiny ad-hoc-signed bundle. Ad-hoc signatures carry no team, so
// the check for one is given a made-up team here; production requires a real one.
describe.runIf(process.platform === "darwin")("updating a real bundle", () => {
  const makeApp = (parent: string, version: string, marker: string): string => {
    const app = join(parent, "novadeck.app")
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true })
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true })
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>novadeck</string><key>CFBundleIdentifier</key><string>dev.mzpk.novadeck.test</string><key>CFBundleName</key><string>novadeck</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
    )
    copyFileSync("/usr/bin/true", join(app, "Contents", "MacOS", "novadeck"))
    chmodSync(join(app, "Contents", "MacOS", "novadeck"), 0o755)
    writeFileSync(join(app, "Contents", "Resources", "marker.txt"), marker)
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app])
    return app
  }

  it("prepares a zip and installs it in both modes", async () => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-mac-update-test-"))
    try {
      const host: MacUpdateHost = {
        ...macUpdateHost,
        folder: () => join(root, "tmp"),
        // Ad-hoc signatures carry no team and no Apple chain, which the checks require: a
        // team is put in its place, and the signature is checked without the chain.
        codesignVerify: (bundle) => macUpdateHost.codesignVerify(bundle),
        codesignDetails: async (bundle) => {
          const details = await macUpdateHost.codesignDetails(bundle)
          return /^TeamIdentifier=/mu.test(details)
            ? details.replace(/^TeamIdentifier=.*$/mu, "TeamIdentifier=TESTTEAM00")
            : `${details}\nTeamIdentifier=TESTTEAM00\n`
        },
      }
      mkdirSync(join(root, "tmp"))
      const downloaded = makeApp(join(root, "new"), "2.0.0", "new")
      const zip = join(root, "novadeck-mac-universal.zip")
      execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", downloaded, zip])
      const trial = async (mode: "whole" | "contents"): Promise<void> => {
        const folder = join(root, mode)
        mkdirSync(folder)
        const bundle = makeApp(folder, "1.0.0", "old")
        const prepared = await prepareMacUpdate({ zip, version: "2.0.0", bundle }, host)
        expect(existsSync(prepared)).toBe(true)
        await installMacUpdate({ prepared, bundle, mode }, host)
        expect(readFileSync(join(bundle, "Contents", "Resources", "marker.txt"), "utf8")).toBe(
          "new",
        )
        expect(readFileSync(join(bundle, "Contents", "Info.plist"), "utf8")).toContain("2.0.0")
        execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle])
      }
      await trial("whole")
      await trial("contents")
      expect(await macSwapMode(join(root, "whole", "novadeck.app"), host)).toBe("whole")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // About ten codesign and ditto runs, which a busy runner may take a while over.
  }, 120_000)
})

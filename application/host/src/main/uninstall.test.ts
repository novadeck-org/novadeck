import { EventEmitter } from "node:events"

import type { UninstallResult } from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { afterEach, vi } from "vitest"

import { quitAppChannel, uninstallAppChannel, uninstallPlanChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import {
  brewUninstallCommand,
  isRemovable,
  registerUninstallIpc,
  removalScript,
  startRemovalAfterExit,
  uninstaller,
  uninstallPlan,
  type UninstallHost,
} from "./uninstall"

const home = "/home/me"
const image = `${home}/.local/share/novadeck/novadeck.AppImage`

// A Linux AppImage installed where the installer puts it, with everything it writes there,
// and a host that records what it was asked, in order. `files` is what exists.
const hosting = (
  overrides: Partial<UninstallHost> = {},
  files: readonly string[] = [
    image,
    `${home}/.local/bin/novadeck`,
    `${home}/.local/share/applications/dev.mzpk.novadeck.desktop`,
    `${home}/.local/share/icons/hicolor/512x512/apps/novadeck.png`,
    `${home}/.config/novadeck`,
  ],
) => {
  const calls: string[] = []
  const present = new Set(files)
  // Whether the shutdown ran, which is what makes the app report that it is quitting.
  let stopped = false
  const host: UninstallHost = {
    platform: "linux",
    packaged: true,
    portable: false,
    env: { APPIMAGE: image },
    home,
    execPath: "/tmp/.mount_nova/novadeck",
    userData: `${home}/.config/novadeck`,
    defaultUserData: `${home}/.config/novadeck`,
    uid: 1000,
    realpath: (path) => path,
    exists: (path) => present.has(path),
    linkTarget: async (path) => (path === `${home}/.local/bin/novadeck` ? image : undefined),
    remove: async (path, { recursive }) => {
      calls.push(`${recursive ? "remove folder" : "remove"} ${path}`)
      present.delete(path)
    },
    removeEmptyFolder: async (path) => void calls.push(`remove if empty ${path}`),
    trash: async (path) => void calls.push(`trash ${path}`),
    privileged: async (args) => {
      calls.push(`privileged ${args.at(-1)}`)
      present.delete(args.at(-1)!)
      return true
    },
    startUninstaller: async (file) => {
      calls.push(`start ${file}`)
      return true
    },
    removeAfterExit: async (folders, file) => {
      calls.push(`remove after exit ${folders.join(",")} once ${file} is gone`)
      return true
    },
    shutdown: async () => {
      calls.push("shutdown")
      stopped = true
    },
    stopping: () => stopped,
    quit: () => void calls.push("quit"),
    log: () => {},
    ...overrides,
  }
  return { host, calls, present }
}

const profile = "/etc/apparmor.d/novadeck-appimage-1000"

const mac = (overrides: Partial<UninstallHost> = {}, files: readonly string[] = []) =>
  hosting(
    {
      platform: "darwin",
      env: {},
      execPath: "/Applications/Novadeck.app/Contents/MacOS/novadeck",
      userData: `${home}/Library/Application Support/novadeck`,
      defaultUserData: `${home}/Library/Application Support/novadeck`,
      ...overrides,
    },
    files,
  )

const windows = (overrides: Partial<UninstallHost> = {}) =>
  hosting(
    {
      platform: "win32",
      env: {},
      home: "C:\\Users\\me",
      execPath: "C:\\Users\\me\\AppData\\Local\\Programs\\novadeck\\novadeck.exe",
      userData: "C:\\Users\\me\\AppData\\Roaming\\novadeck",
      defaultUserData: "C:\\Users\\me\\AppData\\Roaming\\novadeck",
      ...overrides,
    },
    ["C:\\Users\\me\\AppData\\Local\\Programs\\novadeck\\Uninstall novadeck.exe"],
  )

afterEach(() => void vi.useRealTimers())

describe("what uninstalling a copy would do", () => {
  context("on Linux", () => {
    it("is ready for an AppImage at the installer's path, with the data folder", () => {
      expect(uninstallPlan(hosting().host)).toEqual({
        kind: "ready",
        dataFolders: [`${home}/.config/novadeck`],
        handoff: "app",
      })
    })

    it("follows XDG_DATA_HOME for the installer's path", () => {
      const moved = "/data/novadeck/novadeck.AppImage"
      const { host } = hosting({ env: { APPIMAGE: moved, XDG_DATA_HOME: "/data" } })
      expect(uninstallPlan(host).kind).toBe("ready")
    })

    it("is manual for an AppImage Homebrew's cask linked in", () => {
      const { host } = hosting({
        env: { APPIMAGE: `${home}/Applications/novadeck.AppImage` },
        realpath: () => "/home/linuxbrew/.linuxbrew/Caskroom/novadeck/1.0.0/novadeck.AppImage",
      })
      expect(uninstallPlan(host)).toEqual({ kind: "manual", command: brewUninstallCommand })
    })

    it("is unavailable for an AppImage anywhere else, or when it is not an AppImage", () => {
      expect(uninstallPlan(hosting({ env: { APPIMAGE: "/dl/novadeck.AppImage" } }).host)).toEqual({
        kind: "unavailable",
      })
      expect(uninstallPlan(hosting({ env: {} }).host)).toEqual({ kind: "unavailable" })
      expect(uninstallPlan(hosting({ realpath: () => undefined }).host)).toEqual({
        kind: "unavailable",
      })
    })
  })

  context("on macOS", () => {
    it("is ready for the app in Applications, and hands the removal to the app", () => {
      expect(uninstallPlan(mac().host)).toEqual({
        kind: "ready",
        dataFolders: [`${home}/Library/Application Support/novadeck`],
        handoff: "app",
      })
    })

    it("is ready for the app in the user's Applications folder", () => {
      const { host } = mac({
        execPath: `${home}/Applications/Novadeck.app/Contents/MacOS/novadeck`,
      })
      expect(uninstallPlan(host).kind).toBe("ready")
    })

    it("is manual for a cask's app, found through its link or its Caskroom", () => {
      const linked = mac({ realpath: () => "/opt/homebrew/Caskroom/novadeck/1.0.0/Novadeck.app" })
      expect(uninstallPlan(linked.host)).toEqual({
        kind: "manual",
        command: brewUninstallCommand,
      })
      const moved = mac({}, ["/opt/homebrew/Caskroom/novadeck"])
      expect(uninstallPlan(moved.host)).toEqual({ kind: "manual", command: brewUninstallCommand })
    })

    it("is unavailable for an app outside Applications, such as one on a disk image", () => {
      const { host } = mac({ execPath: "/Volumes/Novadeck/Novadeck.app/Contents/MacOS/novadeck" })
      expect(uninstallPlan(host)).toEqual({ kind: "unavailable" })
    })
  })

  context("on Windows", () => {
    it("is ready, through the uninstaller, for a copy the installer made", () => {
      expect(uninstallPlan(windows().host)).toEqual({
        kind: "ready",
        dataFolders: ["C:\\Users\\me\\AppData\\Roaming\\novadeck"],
        handoff: "uninstaller",
      })
    })

    it("is unavailable for the unpacked ZIP, which has no uninstaller", () => {
      const { host } = windows({ exists: () => false })
      expect(uninstallPlan(host)).toEqual({ kind: "unavailable" })
    })
  })

  it("is unavailable for a portable copy, a development run and an unknown system", () => {
    expect(uninstallPlan(hosting({ portable: true }).host)).toEqual({ kind: "unavailable" })
    expect(uninstallPlan(hosting({ packaged: false }).host)).toEqual({ kind: "unavailable" })
    expect(uninstallPlan(hosting({ platform: "freebsd" }).host)).toEqual({ kind: "unavailable" })
  })
})

describe("uninstalling on Linux", () => {
  it("shuts down, then removes the AppImage, its command, menu entry and icon, keeping the data", async () => {
    const { host, calls } = hosting()
    expect(await uninstaller(host).uninstall({ keepData: true })).toEqual({ kind: "removed" })
    expect(calls).toEqual([
      "shutdown",
      `remove ${image}`,
      `remove ${home}/.local/bin/novadeck`,
      `remove ${home}/.local/share/applications/dev.mzpk.novadeck.desktop`,
      `remove ${home}/.local/share/icons/hicolor/512x512/apps/novadeck.png`,
      `remove if empty ${home}/.local/share/novadeck`,
    ])
  })

  it("removes the data folder as well, before the AppImage, when asked", async () => {
    const { host, calls } = hosting()
    await uninstaller(host).uninstall({ keepData: false })
    expect(calls.slice(0, 3)).toEqual([
      "shutdown",
      `remove folder ${home}/.config/novadeck`,
      `remove ${image}`,
    ])
  })

  it("leaves a command that is another install's alone", async () => {
    const { host, calls } = hosting({ linkTarget: async () => "/opt/other/novadeck" })
    await uninstaller(host).uninstall({ keepData: true })
    expect(calls).not.toContain(`remove ${home}/.local/bin/novadeck`)
  })

  it("follows XDG_DATA_HOME for the files it removes", async () => {
    const moved = "/data/novadeck/novadeck.AppImage"
    const { host, calls } = hosting({ env: { APPIMAGE: moved, XDG_DATA_HOME: "/data" } })
    await uninstaller(host).uninstall({ keepData: true })
    expect(calls).toContain(`remove ${moved}`)
    expect(calls).toContain("remove /data/applications/dev.mzpk.novadeck.desktop")
    expect(calls).toContain("remove /data/icons/hicolor/512x512/apps/novadeck.png")
  })

  context("with an AppArmor profile", () => {
    it("removes it through the system's prompt", async () => {
      const { host, calls } = hosting({}, [image, profile])
      expect(await uninstaller(host).uninstall({ keepData: true })).toEqual({ kind: "removed" })
      expect(calls.at(-1)).toBe(`privileged ${profile}`)
    })

    it("answers removed with the command to run when the prompt is declined", async () => {
      const { host } = hosting({ privileged: async () => false }, [image, profile])
      expect(await uninstaller(host).uninstall({ keepData: true })).toEqual({
        kind: "removed",
        leftover: `sudo apparmor_parser -R ${profile}; sudo rm -f ${profile}`,
      })
    })

    it("answers with the command too when the prompt said yes but the file is still there", async () => {
      const { host } = hosting({ privileged: async () => true }, [image, profile])
      expect(await uninstaller(host).uninstall({ keepData: true })).toMatchObject({
        kind: "removed",
        leftover: expect.stringContaining(profile) as string,
      })
    })

    it("asks nothing when there is no profile", async () => {
      const privileged = vi.fn<UninstallHost["privileged"]>(async () => true)
      const { host } = hosting({ privileged }, [image])
      await uninstaller(host).uninstall({ keepData: true })
      expect(privileged).not.toHaveBeenCalled()
    })
  })

  it("fails with the reason, and leaves the rest, when the AppImage cannot be removed", async () => {
    const { host, calls } = hosting({
      remove: async (path) => {
        calls.push(`remove ${path}`)
        throw new Error("EACCES: permission denied")
      },
    })
    expect(await uninstaller(host).uninstall({ keepData: true })).toEqual({
      kind: "failed",
      reason:
        "EACCES: permission denied. Novadeck has stopped your terminals; quit it and open it again.",
    })
    expect(calls).toEqual(["shutdown", `remove ${image}`])
  })

  it("keeps the AppImage when the data cannot be removed", async () => {
    const { host, calls } = hosting({
      remove: async (path) => {
        calls.push(`remove ${path}`)
        throw new Error("EBUSY")
      },
    })
    await uninstaller(host).uninstall({ keepData: false })
    expect(calls).toEqual(["shutdown", `remove ${home}/.config/novadeck`])
  })
})

describe("uninstalling on macOS", () => {
  it("shuts down, then moves the app to the Trash, keeping the data", async () => {
    const { host, calls } = mac()
    expect(await uninstaller(host).uninstall({ keepData: true })).toEqual({ kind: "removed" })
    expect(calls).toEqual(["trash /Applications/Novadeck.app", "shutdown"])
  })

  it("deletes the data after the app is in the Trash when asked", async () => {
    const { host, calls } = mac()
    await uninstaller(host).uninstall({ keepData: false })
    expect(calls).toEqual([
      "trash /Applications/Novadeck.app",
      "shutdown",
      `remove folder ${home}/Library/Application Support/novadeck`,
    ])
  })

  it("fails before the shutdown, naming App Management, when the Trash refuses, and can be tried again", async () => {
    let refuse = true
    const { host, calls } = mac({
      trash: async (path) => {
        if (refuse) throw new Error("not permitted")
        calls.push(`trash ${path}`)
      },
    })
    const one = uninstaller(host)
    const result = await one.uninstall({ keepData: false })
    expect(result).toMatchObject({ kind: "failed" })
    expect((result as { reason: string }).reason).toContain("App Management")
    expect((result as { reason: string }).reason).not.toContain("quit it")
    expect(calls).toEqual([])
    refuse = false
    expect(await one.uninstall({ keepData: false })).toEqual({ kind: "removed" })
    expect(calls).toEqual([
      "trash /Applications/Novadeck.app",
      "shutdown",
      `remove folder ${home}/Library/Application Support/novadeck`,
    ])
  })

  it("moves the app to the Trash before the shutdown", async () => {
    const { host, calls } = mac()
    await uninstaller(host).uninstall({ keepData: true })
    expect(calls).toEqual(["trash /Applications/Novadeck.app", "shutdown"])
  })

  it("tells the person to reopen the app when the data cannot be removed afterwards", async () => {
    const { host } = mac({
      remove: async () => {
        throw new Error("EBUSY")
      },
    })
    expect(await uninstaller(host).uninstall({ keepData: false })).toEqual({
      kind: "failed",
      reason: "EBUSY. Novadeck has stopped your terminals; quit it and open it again.",
    })
  })
})

describe("uninstalling on Windows", () => {
  const uninstallerFile =
    "C:\\Users\\me\\AppData\\Local\\Programs\\novadeck\\Uninstall novadeck.exe"

  it("shuts down, starts the uninstaller, and quits once it has answered", async () => {
    vi.useFakeTimers()
    const { host, calls } = windows()
    expect(await uninstaller(host).uninstall({ keepData: true })).toEqual({ kind: "uninstalling" })
    expect(calls).toEqual(["shutdown", `start ${uninstallerFile}`])
    await vi.advanceTimersByTimeAsync(300)
    expect(calls.at(-1)).toBe("quit")
  })

  it("also has the data deleted after the app ended when asked", async () => {
    const { host, calls } = windows()
    await uninstaller(host).uninstall({ keepData: false })
    expect(calls).toEqual([
      "shutdown",
      `start ${uninstallerFile}`,
      `remove after exit C:\\Users\\me\\AppData\\Roaming\\novadeck once ${uninstallerFile} is gone`,
    ])
  })

  it("fails and starts no data removal when the uninstaller does not start", async () => {
    const { host, calls } = windows({ startUninstaller: async () => false })
    expect(await uninstaller(host).uninstall({ keepData: false })).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("quit it and open it again") as string,
    })
    expect(calls).toEqual(["shutdown"])
  })
})

describe("what uninstalling refuses", () => {
  it("does nothing, not even a shutdown, for a copy that is not ready", async () => {
    const { host, calls } = hosting({ portable: true })
    expect(await uninstaller(host).uninstall({ keepData: false })).toMatchObject({
      kind: "failed",
    })
    expect(calls).toEqual([])
  })

  it("does nothing for a manual install", async () => {
    const { host, calls } = mac({ realpath: () => "/usr/local/Caskroom/novadeck/1/Novadeck.app" })
    expect(await uninstaller(host).uninstall({ keepData: false })).toMatchObject({
      kind: "failed",
    })
    expect(calls).toEqual([])
  })

  it("does nothing while the app is already quitting", async () => {
    const { host, calls } = hosting({ stopping: () => true })
    expect(await uninstaller(host).uninstall({ keepData: false })).toEqual({
      kind: "failed",
      reason: "Novadeck is quitting.",
    })
    expect(calls).toEqual([])
  })

  it("does nothing when a path to delete is not the expected one", async () => {
    const folders = [home, "/", `${home}/../other`, "/home", "relative/novadeck"]
    const attempts = folders.map((userData) => {
      const { host, calls } = hosting({ userData, defaultUserData: userData })
      return uninstaller(host)
        .uninstall({ keepData: false })
        .then((result) => ({ result, calls }))
    })
    for (const { result, calls } of await Promise.all(attempts)) {
      expect(result).toMatchObject({ kind: "failed" })
      expect(calls).toEqual([])
    }
  })

  it("does not look at the data folder when the data is kept", async () => {
    const { host } = hosting({ userData: home, defaultUserData: home })
    expect(await uninstaller(host).uninstall({ keepData: true })).toEqual({ kind: "removed" })
  })
})

describe("a failure after the shutdown", () => {
  it("says the app has stopped, and answers every later request with the same failure", async () => {
    const { host, calls } = hosting({
      remove: async () => {
        throw new Error("EACCES: permission denied")
      },
    })
    const one = uninstaller(host)
    const failure = {
      kind: "failed",
      reason:
        "EACCES: permission denied. Novadeck has stopped your terminals; quit it and open it again.",
    }
    expect(await one.uninstall({ keepData: true })).toEqual(failure)
    expect(await one.uninstall({ keepData: true })).toEqual(failure)
    expect(calls).toEqual(["shutdown"])
  })

  it("is still told the app is quitting when it began quitting for another reason", async () => {
    const { host } = hosting({ stopping: () => true })
    expect(await uninstaller(host).uninstall({ keepData: true })).toEqual({
      kind: "failed",
      reason: "Novadeck is quitting.",
    })
  })
})

describe("which data folders are the app's own to delete", () => {
  it("has none when --user-data-dir moved the data folder", async () => {
    const { host, calls } = hosting({ userData: `${home}/Documents/my-notes` })
    expect(uninstallPlan(host)).toEqual({ kind: "ready", dataFolders: [], handoff: "app" })
    await uninstaller(host).uninstall({ keepData: false })
    expect(calls.some((call) => call.startsWith("remove folder"))).toBe(false)
  })

  it("is the default folder otherwise", () => {
    expect(uninstallPlan(hosting().host)).toMatchObject({
      dataFolders: [`${home}/.config/novadeck`],
    })
  })
})

describe("asking twice", () => {
  it("runs once, and gives a second request the answer of the first", async () => {
    const { host, calls } = hosting()
    const one = uninstaller(host)
    const [first, second] = await Promise.all([
      one.uninstall({ keepData: true }),
      one.uninstall({ keepData: false }),
    ])
    expect(second).toBe(first)
    expect(await one.uninstall({ keepData: false })).toEqual(first)
    expect(calls.filter((call) => call === "shutdown")).toHaveLength(1)
    expect(calls.some((call) => call.startsWith("remove folder"))).toBe(false)
  })
})

describe("which paths may be deleted", () => {
  const linux = { platform: "linux", home } as const

  it("accepts an absolute, normalized path inside the home folder", () => {
    expect(isRemovable(`${home}/.config/novadeck`, linux)).toBe(true)
    expect(isRemovable("/data/novadeck", linux)).toBe(true)
  })

  it("refuses roots, the home folder, the folders that hold it, and relative or untidy paths", () => {
    for (const path of [
      "/",
      home,
      "/home",
      `${home}/`,
      `${home}/.config/../x`,
      `${home}//x`,
      "novadeck",
      "",
      `${home}/x\ny`,
    ])
      expect(isRemovable(path, linux), path).toBe(false)
  })

  it("compares Windows paths without regard to case", () => {
    const win = { platform: "win32", home: "C:\\Users\\me" } as const
    expect(isRemovable("C:\\Users\\me\\AppData\\Roaming\\novadeck", win)).toBe(true)
    expect(isRemovable("c:\\users\\ME", win)).toBe(false)
    expect(isRemovable("C:\\", win)).toBe(false)
    expect(isRemovable("C:\\Users", win)).toBe(false)
    expect(isRemovable("C:/Users/me/x", win)).toBe(false)
  })
})

describe("the Windows helper that deletes the data after the app ended", () => {
  it("waits for this process, then deletes each folder, quoting its name", () => {
    const script = removalScript(
      4321,
      ["C:\\Users\\me\\AppData\\Roaming\\novadeck", "C:\\it's"],
      "C:\\n\\Uninstall novadeck.exe",
    )
    expect(script).toContain("Wait-Process -Id 4321")
    expect(script).toContain("@('C:\\Users\\me\\AppData\\Roaming\\novadeck','C:\\it''s')")
    expect(script).toContain("Remove-Item -LiteralPath $folder -Recurse -Force")
  })

  it("deletes nothing while the uninstaller is still there after ten minutes", () => {
    const script = removalScript(1, ["C:\\a"], "C:\\n\\Uninstall novadeck.exe")
    const test = "Test-Path -LiteralPath 'C:\\n\\Uninstall novadeck.exe'"
    expect(script).toContain("AddMinutes(10)")
    expect(script).toContain(`while ((${test}) -and (Get-Date) -lt $end)`)
    expect(script.indexOf(`if (${test}) { exit }`)).toBeGreaterThan(script.indexOf("Wait-Process"))
    expect(script.indexOf(`if (${test}) { exit }`)).toBeLessThan(script.indexOf("Remove-Item"))
  })

  it("doubles the typographic single quotes PowerShell takes as quotes", () => {
    const script = removalScript(
      1,
      ["C:\\Users\\O\u2019Brien", "C:\\a\u2018b\u201ac\u201bd"],
      "C:\\u.exe",
    )
    expect(script).toContain("'C:\\Users\\O\u2019\u2019Brien'")
    expect(script).toContain("'C:\\a\u2018\u2018b\u201a\u201ac\u201b\u201bd'")
  })

  it("starts detached and hidden, and says whether it started", async () => {
    const spawned: unknown[][] = []
    const child = (event: "spawn" | "error") => {
      const emitter = new EventEmitter()
      setImmediate(() => emitter.emit(event, new Error("ENOENT")))
      return Object.assign(emitter, { unref: () => {} })
    }
    const start = (event: "spawn" | "error") =>
      startRemovalAfterExit({
        pid: 1,
        folders: ["C:\\a"],
        setup: "C:\\u.exe",
        spawn: (...args) => {
          spawned.push(args as unknown[])
          return child(event)
        },
        log: () => {},
      })
    expect(await start("spawn")).toBe(true)
    expect(await start("error")).toBe(false)
    expect(spawned[0]).toMatchObject([
      "powershell.exe",
      expect.arrayContaining(["-NoProfile"]) as string[],
      { detached: true, stdio: "ignore", windowsHide: true },
    ])
  })
})

describe("the app's pages asking to uninstall", () => {
  type Handler = (event: IpcMainEvent & IpcMainInvokeEvent, options?: unknown) => unknown

  const registered = (known: boolean) => {
    const handlers = new Map<string, Handler>()
    const { host, calls } = hosting()
    registerUninstallIpc(
      {
        handle: (channel, listener) => void handlers.set(channel, listener as Handler),
        on: (channel, listener) => void handlers.set(channel, listener as Handler),
      },
      { window: () => (known ? "window" : undefined), uninstaller: uninstaller(host) },
    )
    const ask = (channel: string, options?: unknown): unknown =>
      handlers.get(channel)!({} as IpcMainEvent & IpcMainInvokeEvent, options)
    return { ask, calls }
  }

  it("tells the app's own page the plan, uninstalls for it and quits for it", async () => {
    const { ask, calls } = registered(true)
    expect(ask(uninstallPlanChannel)).toMatchObject({ kind: "ready" })
    expect(
      await (ask(uninstallAppChannel, { keepData: true }) as Promise<UninstallResult>),
    ).toEqual({
      kind: "removed",
    })
    ask(quitAppChannel)
    expect(calls[0]).toBe("shutdown")
    expect(calls.at(-1)).toBe("quit")
  })

  it("deletes data only for a keepData of exactly false", async () => {
    const others = [undefined, null, {}, { keepData: "false" }, { keepData: 0 }]
    const attempts = others.map(async (options) => {
      const { ask, calls } = registered(true)
      await (ask(uninstallAppChannel, options) as Promise<UninstallResult>)
      return calls
    })
    for (const calls of await Promise.all(attempts))
      expect(calls.some((call) => call.startsWith("remove folder"))).toBe(false)
    const { ask, calls } = registered(true)
    await (ask(uninstallAppChannel, { keepData: false }) as Promise<UninstallResult>)
    expect(calls).toContain(`remove folder ${home}/.config/novadeck`)
  })

  it("tells any other sender nothing is available, refuses it, and ignores its quit", async () => {
    const { ask, calls } = registered(false)
    expect(ask(uninstallPlanChannel)).toEqual({ kind: "unavailable" })
    expect(ask(uninstallAppChannel, { keepData: false })).toMatchObject({ kind: "failed" })
    ask(quitAppChannel)
    expect(calls).toEqual([])
  })
})

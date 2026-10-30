import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { describe, expect, it } from "../../test"
import { newerCopy } from "./linux"
import {
  findInstalledWindows,
  insideInstallFolder,
  installedAtLeast,
  installedByInstaller,
  installerGuid,
  latestVersionOf,
  legacyPrefixFolder,
  readLegacyUninstaller,
  runningCheckValue,
  powershellChecks,
  powershellUsable,
  prepareSetup,
  readInstallRecord,
  registryValue,
  runSetup,
  setupArguments,
  setupInUseExitCode,
  SetupBusyError,
  setupResult,
  setupRunningReason,
  setupName,
  sha512Of,
  sizeOf,
  startDetached,
  uuidV5,
  type InstallRecord,
  type SetupHost,
} from "./windows"

const sha = (text: string): string => createHash("sha512").update(text).digest("base64")

const latest = (hash: string, version = "1.2.0"): string =>
  [
    `version: ${version}`,
    "files:",
    "  - url: novadeck-win-x64-setup.exe",
    `    sha512: ${hash}`,
    "    size: 100",
    "path: novadeck-win-x64-setup.exe",
    `sha512: ${hash}`,
    "releaseDate: '2026-10-13T10:00:00.000Z'",
    "",
  ].join("\n")

describe("the installer's GUID", () => {
  it("is the name-based UUID of RFC 9562", () => {
    expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    )
  })

  it("is what electron-builder derives from the app id", () => {
    expect(installerGuid("dev.mzpk.novadeck")).toBe("80f5a1b9-dd37-5021-b93b-6e1b8d742f0d")
  })
})

describe("the installer's registry record", () => {
  const output = (name: string, data: string) =>
    `\r\nHKEY_CURRENT_USER\\Software\\x\r\n    ${name}    REG_SZ    ${data}\r\n\r\n`

  it("reads a string value, with spaces in it", () => {
    expect(
      registryValue(output("InstallLocation", "C:\\Users\\A B\\novadeck"), "InstallLocation"),
    ).toBe("C:\\Users\\A B\\novadeck")
  })

  it("finds nothing where the value is another or absent", () => {
    expect(registryValue(output("DisplayVersion", "1.0.0"), "InstallLocation")).toBeUndefined()
    expect(registryValue("", "DisplayVersion")).toBeUndefined()
  })

  it("asks the two keys the installer writes", async () => {
    const asked: string[] = []
    const record = await readInstallRecord("dev.mzpk.novadeck", async (key, name) => {
      asked.push(`${key} ${name}`)
      return name === "DisplayVersion" ? output(name, "1.2.0") : ""
    })
    expect(record).toEqual({ location: undefined, version: "1.2.0" })
    expect(asked).toEqual([
      "HKCU\\Software\\80f5a1b9-dd37-5021-b93b-6e1b8d742f0d InstallLocation",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\80f5a1b9-dd37-5021-b93b-6e1b8d742f0d DisplayVersion",
    ])
  })
})

describe("telling an installed Windows copy from the unpacked ZIP", () => {
  const installed = "C:\\Users\\me\\AppData\\Local\\Programs\\novadeck"
  const base = {
    execPath: `${installed}\\novadeck.exe`,
    recorded: undefined,
    defaultFolder: installed,
    exists: () => false,
  }

  it("is installed when the installer's uninstaller sits beside the executable", () => {
    const seen: string[] = []
    const found = installedByInstaller({
      ...base,
      execPath: "D:\\anywhere\\novadeck.exe",
      exists: (path) => (seen.push(path), true),
    })
    expect(found).toBe(true)
    expect(seen).toEqual(["D:\\anywhere\\Uninstall novadeck.exe"])
  })

  it("is portable for a ZIP unpacked elsewhere, with no uninstaller", () => {
    expect(
      installedByInstaller({
        ...base,
        execPath: "C:\\Users\\me\\Downloads\\novadeck\\novadeck.exe",
      }),
    ).toBe(false)
  })

  it("is installed in the default folder though the uninstaller is gone", () => {
    expect(installedByInstaller(base)).toBe(true)
    expect(
      installedByInstaller({ ...base, execPath: installed.toUpperCase() + "\\NOVADECK.EXE" }),
    ).toBe(true)
  })

  it("is installed in the folder the installer recorded", () => {
    expect(
      installedByInstaller({
        ...base,
        execPath: "E:\\Apps\\novadeck\\novadeck.exe",
        recorded: "e:\\apps\\novadeck\\",
      }),
    ).toBe(true)
  })

  it("is not fooled by a folder that only starts like the installed one", () => {
    expect(installedByInstaller({ ...base, execPath: `${installed}-zip\\novadeck.exe` })).toBe(
      false,
    )
  })
})

describe("finding the installed Windows copies", () => {
  const folder = "C:\\Users\\me\\AppData\\Local\\Programs\\novadeck"
  const find = (record: () => Promise<InstallRecord>, present = true, defaultFolder = folder) =>
    findInstalledWindows({
      defaultFolder,
      executable: "novadeck.exe",
      record,
      exists: async () => present,
    })

  it("reads the version the installer recorded", async () => {
    expect(await find(async () => ({ location: folder, version: "1.1.0" }))).toEqual([
      { image: `${folder}\\novadeck.exe`, version: "1.1.0", unchecked: false },
    ])
  })

  it("lists a folder once however it is spelled, recorded or default", async () => {
    const copies = await find(async () => ({
      location: folder.toLowerCase() + "\\",
      version: "1.1.0",
    }))
    expect(copies).toHaveLength(1)
  })

  it("finds nothing when no executable is there", async () => {
    expect(await find(async () => ({ location: folder, version: "1.1.0" }), false)).toEqual([])
  })

  it("cannot check a copy whose record is missing, unreadable or has no version", async () => {
    const results = await Promise.all([
      find(async () => ({ location: undefined, version: undefined })),
      find(async () => {
        throw new Error("reg.exe timed out")
      }),
      find(async () => ({ location: folder, version: "not a version" })),
    ])
    for (const copies of results)
      expect(copies).toEqual([
        { image: `${folder}\\novadeck.exe`, version: undefined, unchecked: true },
      ])
  })

  it("trusts the recorded version for the default folder when the recorded path is garbled", async () => {
    // reg.exe writes the OEM code page, which UTF-8 decoding turns into replacement
    // characters; the recorded folder is then not there, while the default one is.
    const garbled = "C:\\Users\\Zo\uFFFD\\AppData\\Local\\Programs\\novadeck"
    const copies = await findInstalledWindows({
      defaultFolder: folder,
      executable: "novadeck.exe",
      record: async () => ({ location: garbled, version: "1.1.0" }),
      exists: async (path) => path.startsWith(folder),
    })
    expect(copies).toEqual([
      { image: `${folder}\\novadeck.exe`, version: "1.1.0", unchecked: false },
    ])
  })

  it("does not trust the record for the default folder while the recorded one exists", async () => {
    const copies = await findInstalledWindows({
      defaultFolder: folder,
      executable: "novadeck.exe",
      record: async () => ({ location: "E:\\Apps\\novadeck", version: "2.0.0" }),
      exists: async () => true,
    })
    expect(copies[1]).toMatchObject({ unchecked: true })
  })

  it("finds a copy in a recorded folder that is not the default", async () => {
    const copies = await find(async () => ({ location: "E:\\Apps\\novadeck", version: "2.0.0" }))
    expect(copies.map((copy) => copy.image)).toEqual([
      "E:\\Apps\\novadeck\\novadeck.exe",
      `${folder}\\novadeck.exe`,
    ])
    expect(copies[0]?.version).toBe("2.0.0")
    expect(copies[1]?.unchecked).toBe(true)
  })

  it("is the newer copy a launch leaves for, and an unchecked one is not", async () => {
    expect(
      newerCopy(await find(async () => ({ location: folder, version: "1.1.0" })), "1.0.0")?.version,
    ).toBe("1.1.0")
    expect(
      newerCopy(await find(async () => ({ location: folder, version: undefined })), "1.0.0"),
    ).toBeUndefined()
  })
})

describe("what latest.yml says", () => {
  it("gives the hash listed for the setup, from its files entry", () => {
    const yaml = [
      "version: 1.2.0",
      "files:",
      "  - url: other.zip",
      "    sha512: AAA",
      "  - url: novadeck-win-x64-setup.exe",
      "    sha512: BBB",
      "    size: 1",
      "path: other.zip",
      "sha512: AAA",
    ].join("\n")
    expect(sha512Of(yaml, setupName)).toBe("BBB")
  })

  it("falls back to the top-level path and hash", () => {
    expect(
      sha512Of("version: 1.2.0\npath: novadeck-win-x64-setup.exe\nsha512: CCC\n", setupName),
    ).toBe("CCC")
  })

  it("finds nothing for a file that is not listed or has no hash", () => {
    expect(
      sha512Of("version: 1.2.0\nfiles:\n  - url: other.zip\n    sha512: AAA\n", setupName),
    ).toBeUndefined()
    expect(
      sha512Of("files:\n  - url: novadeck-win-x64-setup.exe\n    size: 1\n", setupName),
    ).toBeUndefined()
    expect(sha512Of("", setupName)).toBeUndefined()
  })

  it("names the release's version", () => {
    expect(latestVersionOf(latest("x", "1.2.0"))).toBe("1.2.0")
    expect(latestVersionOf("version: nonsense\n")).toBeUndefined()
  })
})

describe("getting the setup ready", () => {
  const setup = (
    overrides: Partial<SetupHost> = {},
    yaml = latest(sha("setup")),
    body = "setup",
  ) => {
    const calls: string[] = []
    const host: SetupHost = {
      downloads: {
        latest: "https://github.com/o/r/releases/latest/download/",
        own: "https://github.com/o/r/releases/download/v1.0.0/",
      },
      version: "1.0.0",
      text: async (url) => {
        calls.push(`text ${url}`)
        return yaml
      },
      download: async (url) => {
        calls.push(`download ${url}`)
        return { file: "C:\\Temp\\novadeck-setup\\setup.exe", sha512: sha(body) }
      },
      remove: async (file) => void calls.push(`remove ${file}`),
      progress: () => {},
      log: () => {},
      ...overrides,
    }
    return { host, calls }
  }

  it("downloads the setup from the latest release once latest.yml lists it and the hash matches", async () => {
    const { host, calls } = setup()
    expect(await prepareSetup(host)).toEqual({
      kind: "ready",
      setup: "C:\\Temp\\novadeck-setup\\setup.exe",
      version: "1.2.0",
    })
    expect(calls).toEqual([
      "text https://github.com/o/r/releases/latest/download/latest.yml",
      "download https://github.com/o/r/releases/latest/download/novadeck-win-x64-setup.exe",
    ])
  })

  it("fails and discards the file when the hash does not match", async () => {
    const { host, calls } = setup({}, latest(sha("setup")), "tampered")
    expect(await prepareSetup(host)).toMatchObject({ kind: "failed" })
    expect(calls).toContain("remove C:\\Temp\\novadeck-setup\\setup.exe")
  })

  it("fails without downloading when latest.yml lists no entry for the setup", async () => {
    const { host, calls } = setup(
      {},
      "version: 1.2.0\nfiles:\n  - url: other.zip\n    sha512: AAA\n",
    )
    expect(await prepareSetup(host)).toMatchObject({ kind: "failed" })
    expect(calls.some((call) => call.startsWith("download"))).toBe(false)
  })

  it("fails offline, at latest.yml or at the download, with a short reason", async () => {
    const offline = async (): Promise<never> => {
      throw new Error("getaddrinfo ENOTFOUND")
    }
    const first = await prepareSetup(setup({ text: offline }).host)
    const second = await prepareSetup(setup({ download: offline }).host)
    for (const result of [first, second]) {
      expect(result).toMatchObject({ kind: "failed" })
      expect(result.kind === "failed" && result.reason).toContain("online")
    }
  })

  it("falls back to this copy's own release when latest is a 404, from the same base", async () => {
    const own = "https://github.com/o/r/releases/download/v1.0.0/"
    const { host, calls } = setup({
      version: "1.3.0",
      text: async (url) => {
        calls.push(`text ${url}`)
        // Its listed version is not compared: the own release is never older than this copy.
        return url.startsWith(own) ? latest(sha("setup"), "1.3.0") : undefined
      },
    })
    expect(await prepareSetup(host)).toMatchObject({ kind: "ready" })
    expect(calls).toEqual([
      "text https://github.com/o/r/releases/latest/download/latest.yml",
      `text ${own}latest.yml`,
      `download ${own}novadeck-win-x64-setup.exe`,
    ])
  })

  it("still checks the hash of the setup from the own release", async () => {
    const { host } = setup({
      text: async (url) => (url.includes("/latest/") ? undefined : latest(sha("other"))),
    })
    expect(await prepareSetup(host)).toMatchObject({ kind: "failed" })
  })

  it("fails with a short reason when the own release is a 404 too", async () => {
    const { host, calls } = setup({ text: async () => undefined })
    const result = await prepareSetup(host)
    expect(result).toMatchObject({ kind: "failed" })
    expect(result.kind === "failed" && result.reason.length).toBeLessThan(80)
    expect(calls.some((call) => call.startsWith("download"))).toBe(false)
  })

  it("does not fall back on a network error at latest", async () => {
    const asked: string[] = []
    const { host } = setup({
      text: async (url) => {
        asked.push(url)
        throw new Error("getaddrinfo ENOTFOUND")
      },
    })
    expect(await prepareSetup(host)).toMatchObject({ kind: "failed" })
    expect(asked).toEqual(["https://github.com/o/r/releases/latest/download/latest.yml"])
  })

  it("falls back to the own release when latest answers but is older than this copy", async () => {
    const own = "https://github.com/o/r/releases/download/v1.0.0/"
    const { host, calls } = setup({
      version: "1.3.0",
      text: async (url) => {
        calls.push(`text ${url}`)
        return latest(sha("setup"), url.startsWith(own) ? "1.3.0" : "1.2.0")
      },
    })
    expect(await prepareSetup(host)).toMatchObject({ kind: "ready" })
    expect(calls).toEqual([
      "text https://github.com/o/r/releases/latest/download/latest.yml",
      `text ${own}latest.yml`,
      `download ${own}novadeck-win-x64-setup.exe`,
    ])
  })

  it("fails when latest is older and the own release is a 404", async () => {
    const { host, calls } = setup({
      version: "1.3.0",
      text: async (url) => (url.includes("/latest/") ? latest(sha("setup"), "1.2.0") : undefined),
    })
    expect(await prepareSetup(host)).toMatchObject({ kind: "failed" })
    expect(calls.some((call) => call.startsWith("download"))).toBe(false)
  })

  it("fails where the repository is unknown", async () => {
    expect(
      await prepareSetup(setup({ downloads: { latest: undefined, own: undefined } }).host),
    ).toMatchObject({
      kind: "failed",
    })
  })
})

describe("starting a program in place of this one", () => {
  const starting = (event: "spawn" | "error" | "throw", present = true, reclaimed = true) => {
    const calls: string[] = []
    const spawned: { file: string; args: readonly string[]; options: unknown }[] = []
    const result = startDetached({
      file: "C:\\Temp\\setup.exe",
      args: ["--updated"],
      spawn: (file, args, options) => {
        spawned.push({ file, args, options })
        if (event === "throw") throw new Error("EACCES")
        const child = new EventEmitter() as EventEmitter & { unref: () => void }
        child.unref = () => void calls.push("unref")
        queueMicrotask(() => child.emit(event, new Error("blocked")))
        return child
      },
      exists: () => present,
      releaseLock: () => void calls.push("release"),
      reclaimLock: () => (calls.push("reclaim"), reclaimed),
      exit: () => void calls.push("exit"),
      log: (message) => void calls.push(`log ${message}`),
    })
    return { result, calls, spawned }
  }

  it("lets go of the lock, spawns detached with the arguments, then exits", async () => {
    const { result, calls, spawned } = starting("spawn")
    expect(await result).toBe(true)
    expect(calls).toEqual(["release", "unref", "exit"])
    expect(spawned).toEqual([
      {
        file: "C:\\Temp\\setup.exe",
        args: ["--updated"],
        options: { detached: true, stdio: "ignore" },
      },
    ])
  })

  it("does not exit, and takes the lock back, when the system refuses to start it", async () => {
    const { result, calls } = starting("error")
    expect(await result).toBe(false)
    expect(calls).toEqual(["release", "log The program did not start.", "reclaim"])
    const thrown = starting("throw")
    expect(await thrown.result).toBe(false)
    expect(thrown.calls).toEqual(["release", "log The program did not start.", "reclaim"])
  })

  it("ends this process when the lock cannot be taken back, as another copy has it", async () => {
    const { result, calls } = starting("error", true, false)
    expect(await result).toBe(false)
    expect(calls).toContain("exit")
  })

  it("spawns nothing and lets go of nothing for a missing file", async () => {
    const { result, calls, spawned } = starting("spawn", false)
    expect(await result).toBe(false)
    expect(spawned).toEqual([])
    expect(calls).toEqual(["log There is no program to start."])
  })
})

describe("the setup's arguments", () => {
  it("run it silently and start nothing after", () => {
    expect([...setupArguments]).toEqual(["/S"])
  })
})

describe("running the setup", () => {
  const running = (
    event: "exit" | "in-use" | "none" | "error" | "throw",
    options: { present?: boolean; timeoutMs?: number } = {},
  ) => {
    const calls: string[] = []
    const spawned: { args: readonly string[]; options: unknown }[] = []
    const result = runSetup({
      file: "C:\\Temp\\setup.exe",
      spawn: (_file, args, spawnOptions) => {
        spawned.push({ args, options: spawnOptions })
        if (event === "throw") throw new Error("EACCES")
        const child = new EventEmitter() as EventEmitter & { unref: () => void }
        child.unref = () => void calls.push("unref")
        queueMicrotask(() => {
          if (event === "error") return void child.emit("error", new Error("blocked"))
          child.emit("spawn")
          if (event === "exit") child.emit("exit", 0)
          if (event === "in-use") child.emit("exit", setupInUseExitCode)
        })
        return child
      },
      exists: () => options.present ?? true,
      timeoutMs: options.timeoutMs ?? 5,
      log: (message) => void calls.push(`log ${message}`),
    })
    return { result, calls, spawned }
  }

  it("spawns detached with /S, and resolves when the setup exits, touching no lock and not exiting", async () => {
    const { result, calls, spawned } = running("exit")
    expect(await result).toBe("exited")
    expect(calls).toEqual(["unref"])
    expect(spawned).toEqual([
      { args: ["/S"], options: { detached: true, stdio: "ignore", windowsHide: true } },
    ])
  })

  it("tells a setup that found Novadeck running from the install folder by its exit code", async () => {
    expect(await running("in-use").result).toBe("in-use")
  })

  it("resolves at the timeout without killing a setup that still runs", async () => {
    const { result, calls } = running("none")
    expect(await result).toBe("timeout")
    expect(calls).toEqual(["unref", "log The setup is still running."])
  })

  it("fails for a missing file, a refused start or a throw, without spawning for the first", async () => {
    const missing = running("exit", { present: false })
    expect(await missing.result).toBe("failed")
    expect(missing.spawned).toEqual([])
    expect(await running("error").result).toBe("failed")
    expect(await running("throw").result).toBe("failed")
  })
})

describe("what proves the setup did its work", () => {
  const copy = (version: string | undefined) => ({
    image: "C:\\novadeck\\novadeck.exe",
    version,
    unchecked: version === undefined,
  })

  it("is an installed copy of the expected version or a newer one", () => {
    expect(installedAtLeast([copy("1.2.0")], "1.2.0")).toBeDefined()
    expect(installedAtLeast([copy("1.3.0")], "1.2.0")).toBeDefined()
  })

  it("is not an older copy, one that cannot be checked, or none", () => {
    expect(installedAtLeast([copy("1.1.0")], "1.2.0")).toBeUndefined()
    expect(installedAtLeast([copy(undefined)], "1.2.0")).toBeUndefined()
    expect(installedAtLeast([], "1.2.0")).toBeUndefined()
  })
})

describe("the size latest.yml lists", () => {
  it("is the bytes of the setup's files entry", () => {
    const yaml = [
      "files:",
      "  - url: other.zip",
      "    size: 5",
      "  - url: novadeck-win-x64-setup.exe",
      "    sha512: B",
      "    size: 104857600",
    ].join("\n")
    expect(sizeOf(yaml, setupName)).toBe(104857600)
    expect(sizeOf(yaml, "other.zip")).toBe(5)
  })

  it("is nothing when unlisted, absent, zero or not a number", () => {
    expect(sizeOf("files:\n  - url: x.zip\n    size: 1\n", setupName)).toBeUndefined()
    expect(sizeOf("files:\n  - url: novadeck-win-x64-setup.exe\n", setupName)).toBeUndefined()
    expect(
      sizeOf("files:\n  - url: novadeck-win-x64-setup.exe\n    size: 0\n", setupName),
    ).toBeUndefined()
    expect(
      sizeOf("files:\n  - url: novadeck-win-x64-setup.exe\n    size: big\n", setupName),
    ).toBeUndefined()
  })
})

describe("the installer's running-app check", () => {
  // electron-builder only uses `customCheckAppRunning` where its template says so, and
  // otherwise stops every novadeck.exe by name, a portable copy included. Pinned so an
  // upgrade that drops the hook, or stops reaching it, is noticed. The templates are those
  // of the app-builder-lib that electron-builder itself resolves.
  const templates = join(
    dirname(
      createRequire(
        createRequire(import.meta.url).resolve("electron-builder/package.json"),
      ).resolve("app-builder-lib/package.json"),
    ),
    "templates",
    "nsis",
  )
  const template = (file: string): string => readFileSync(join(templates, file), "utf8")

  it("is replaced by our macro, which never stops a process by name", () => {
    expect(template("include/allowOnlyOneInstallerInstance.nsh")).toMatch(
      /!macro CHECK_APP_RUNNING[\s\S]*!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning/u,
    )
    const macro = readFileSync(join(process.cwd(), "resources", "installer.nsh"), "utf8")
    expect(macro).toContain("!macro customCheckAppRunning")
    expect(macro).not.toMatch(/^[^#\n]*(taskkill|\/IM\b|KILL_PROCESS)/mu)
  })

  it("leaves the marker the app reads in the key the uninstaller deletes whole", () => {
    const macro = readFileSync(join(process.cwd(), "resources", "installer.nsh"), "utf8")
    expect(macro).toContain(`"\${INSTALL_REGISTRY_KEY}" ${runningCheckValue} 1`)
    expect(template("uninstaller.nsh")).toContain(
      'DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"',
    )
  })

  it("is still included by name from the build resources, and its install hook still runs", () => {
    const target = readFileSync(
      join(templates, "..", "..", "out/targets/nsis/NsisTarget.js"),
      "utf8",
    )
    expect(target).toContain('getResource(this.options.include, "installer.nsh")')
    expect(target).toContain("addIncludeDir(packager.info.buildResourcesDir)")
    // Read as LF, as a Windows checkout has CRLF.
    const config = readFileSync(join(process.cwd(), "electron-builder.yml"), "utf8").replaceAll(
      "\r\n",
      "\n",
    )
    // `buildResources` sits under the top-level `directories:` and is exactly `resources`.
    expect(config).toMatch(/^directories:\n(?: {2}.*\n)*? {2}buildResources: resources$/mu)
    // No explicit `nsis.include`, which would replace the include by name.
    // The `nsis:` block runs to the next top-level key; comments don't end it.
    const nsis = /^nsis:[^\n]*\n((?:(?: .*|#.*|)\n)*)/mu.exec(config)?.[1]
    expect(nsis).toContain("artifactName")
    expect(nsis).not.toMatch(/^ {2}include:/mu)
    expect(template("installSection.nsh")).toContain("!insertmacro customInstall")
  })

  it("keeps a self-update silent and starts the app only on a reopen", () => {
    const macro = readFileSync(join(process.cwd(), "resources", "installer.nsh"), "utf8")
    // Silent, so builder's `/SD` message boxes answer themselves, and no banner, which in a
    // silent run would reach for other programs' dialogs.
    expect(macro).not.toContain("SetSilent")
    expect(macro).not.toContain("SpiderBanner")
    // With the default runAfterFinish, builder starts the app after a silent run only on
    // `--force-run`, which `customInstall` leaves to it.
    const section = template("installSection.nsh")
    expect(section).toMatch(
      /!ifdef RUN_AFTER_FINISH\s+\$\{ifNot\} \$\{Silent\}\s+\$\{orIf\} \$\{isForceRun\}\s+!insertmacro doStartApp/u,
    )
    expect(section).toContain("!insertmacro customInstall")
    expect(macro).toMatch(
      /\$\{IfNot\} \$\{isForceRun\}\s+\$\{AndIf\} \$\{Silent\}\s+\$\{AndIf\} \$\{isUpdated\}/u,
    )
  })

  it("is still reached by the installer and the uninstaller", () => {
    expect(template("installSection.nsh")).toContain("!insertmacro CHECK_APP_RUNNING")
    expect(template("uninstaller.nsh")).toContain("!insertmacro CHECK_APP_RUNNING")
  })
})

describe("a copy running inside the install folder", () => {
  const install = "C:\\Users\\me\\AppData\\Local\\Programs\\novadeck"
  const folders = [install, undefined]
  const exe = (folder: string): string => `${folder}\\novadeck.exe`

  it("is inside in the folder or under it, whatever the case or trailing separator", () => {
    expect(insideInstallFolder(exe(install.toUpperCase()), folders)).toBe(install)
    expect(insideInstallFolder(exe(`${install}\\resources`), folders)).toBe(install)
    expect(insideInstallFolder(exe(install), [`${install}\\`])).toBe(`${install}\\`)
  })

  it("is not inside for a sibling that merely starts with the same letters, or elsewhere", () => {
    expect(insideInstallFolder(exe(`${install}-portable`), folders)).toBeUndefined()
    expect(insideInstallFolder(exe("D:\\Downloads\\novadeck"), folders)).toBeUndefined()
    expect(insideInstallFolder(exe("D:\\Downloads"), [undefined, ""])).toBeUndefined()
  })
})

describe("the guard for installed copies with the old uninstaller", () => {
  const install = "C:\\Users\\me\\AppData\\Local\\Programs\\novadeck"
  const guid = installerGuid("dev.mzpk.novadeck")
  // What `reg query` answers for the values the installer left; "" where there is none.
  const registry = (values: Record<string, string>) => async (key: string, name: string) => {
    if (!key.includes(guid)) throw new Error("other key")
    const data = values[name]
    return data === undefined ? "" : `\r\n${key}\r\n    ${name}    REG_SZ    ${data}\r\n`
  }

  it("applies to a recorded install without the marker, even when its executable is gone", async () => {
    expect(
      await readLegacyUninstaller(
        "dev.mzpk.novadeck",
        registry({ UninstallString: '"C:\\u.exe"' }),
      ),
    ).toBe(true)
    expect(
      await readLegacyUninstaller("dev.mzpk.novadeck", registry({ InstallLocation: install })),
    ).toBe(true)
  })

  it("does not apply to an install the new installer made, or to no install", async () => {
    expect(
      await readLegacyUninstaller(
        "dev.mzpk.novadeck",
        registry({ UninstallString: "x", InstallLocation: install, [runningCheckValue]: "1" }),
      ),
    ).toBe(false)
    expect(await readLegacyUninstaller("dev.mzpk.novadeck", registry({}))).toBe(false)
  })

  it("applies when the registry cannot be read", async () => {
    expect(
      await readLegacyUninstaller("dev.mzpk.novadeck", async () => {
        throw new Error("reg.exe failed")
      }),
    ).toBe(true)
  })

  it("refuses a sibling folder by plain prefix, as the old uninstaller would stop it", () => {
    const exe = `${install}-portable\\novadeck.exe`
    expect(legacyPrefixFolder(exe, [install])).toBe(install)
    expect(legacyPrefixFolder("D:\\Downloads\\novadeck.exe", [install, undefined])).toBeUndefined()
  })

  it("needs both PowerShell tests to pass, asking each in turn", async () => {
    const asked: string[] = []
    const answering = (answers: boolean[]) => async (command: string) => {
      asked.push(command)
      return answers[asked.length - 1] ?? false
    }
    expect(await powershellUsable(answering([true, true]))).toBe(true)
    expect(asked).toEqual([...powershellChecks])
    asked.length = 0
    expect(await powershellUsable(answering([true, false]))).toBe(false)
    asked.length = 0
    expect(await powershellUsable(answering([false]))).toBe(false)
    expect(asked).toHaveLength(1)
  })
})

describe("what the install answers once the setup has run", () => {
  const found = { image: "C:\\novadeck\\novadeck.exe", version: "1.2.0", unchecked: false }

  it("is the copy it left, whatever way the setup ended", () => {
    for (const ran of ["exited", "timeout"] as const)
      expect(setupResult(ran, found)).toEqual({ kind: "installed", image: found.image })
  })

  it("says the installer is still running when the wait ended with no copy", () => {
    expect(setupResult("timeout", undefined)).toEqual({
      kind: "failed",
      reason: setupRunningReason,
    })
    expect(setupRunningReason).toContain("still running")
  })

  it("says Novadeck runs from the install folder when the setup found it so", () => {
    expect(setupResult("in-use", undefined)).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("install folder"),
    })
  })

  it("says it did not finish when it exited with no copy, and that it did not run when it never started", () => {
    expect(setupResult("exited", undefined)).toMatchObject({
      reason: "The installer did not finish installing Novadeck.",
    })
    expect(setupResult("failed", found)).toMatchObject({ kind: "failed" })
    expect((setupResult("failed", found) as { reason: string }).reason).toContain("did not run")
  })
})

describe("a retry while the earlier setup still runs", () => {
  it("answers that it is still running, not that the person is offline", async () => {
    const downloads = {
      latest: "https://github.com/o/r/releases/latest/download/",
      own: undefined,
    }
    const outcome = await prepareSetup({
      downloads,
      version: "1.0.0",
      text: async () => latest(sha("setup")),
      download: async () => {
        throw new SetupBusyError("in use")
      },
      remove: async () => {},
      progress: () => {},
      log: () => {},
    })
    expect(outcome).toEqual({ kind: "failed", reason: setupRunningReason })
  })
})

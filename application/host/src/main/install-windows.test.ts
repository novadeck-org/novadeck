import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "../test"
import { newerCopy } from "./install-linux"
import {
  findInstalledWindows,
  hashBody,
  insideInstallFolder,
  installedAtLeast,
  installedByInstaller,
  installerGuid,
  latestVersionOf,
  powershellChecks,
  powershellUsable,
  prepareSetup,
  readInstallRecord,
  registryValue,
  reportPercents,
  runSetup,
  setupArguments,
  SetupBusyError,
  setupResult,
  setupRunningReason,
  setupName,
  sha512Of,
  sizeOf,
  wholePercent,
  startDetached,
  uuidV5,
  type InstallRecord,
  type SetupHost,
} from "./install-windows"

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

describe("hashing a download", () => {
  const response = (chunks: string[], ok = true) => ({
    ok,
    status: ok ? 200 : 404,
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk)
    })(),
  })

  it("writes every chunk and gives the SHA-512 of the whole", async () => {
    const written: string[] = []
    const hash = await hashBody(
      response(["ab", "cd"]),
      async (chunk) => void written.push(Buffer.from(chunk).toString()),
      100,
    )
    expect(written).toEqual(["ab", "cd"])
    expect(hash).toBe(sha("abcd"))
  })

  it("refuses an answer that is not a success or is too large", async () => {
    await expect(hashBody(response([], false), async () => {}, 100)).rejects.toThrow("404")
    await expect(hashBody(response(["abcd"]), async () => {}, 3)).rejects.toThrow("larger")
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
    event: "exit" | "none" | "error" | "throw",
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

describe("a copy running inside the install folder", () => {
  const folders = ["C:\\Users\\me\\AppData\\Local\\Programs\\novadeck", undefined]
  const exe = (folder: string): string => `${folder}\\novadeck.exe`

  it("is inside when its path starts with the folder, whatever the case or trailing separator", () => {
    expect(
      insideInstallFolder(
        "c:\\users\\ME\\appdata\\local\\programs\\NOVADECK\\novadeck.exe",
        folders,
      ),
    ).toBe(folders[0])
    expect(insideInstallFolder(exe(`${folders[0]}\\resources`), folders)).toBe(folders[0])
    expect(insideInstallFolder(exe(folders[0] ?? ""), [`${folders[0]}\\`])).toBe(`${folders[0]}\\`)
  })

  it("is inside for a sibling that merely starts with the same letters, as the installer's plain prefix check would stop it", () => {
    expect(insideInstallFolder(exe(`${folders[0]}-portable`), folders)).toBe(folders[0])
  })

  it("is not inside elsewhere, or with no folder to compare", () => {
    expect(insideInstallFolder(exe("D:\\Downloads\\novadeck"), folders)).toBeUndefined()
    expect(insideInstallFolder(exe("D:\\Downloads"), [undefined, ""])).toBeUndefined()
  })
})

describe("whether the installer can check for a running app by PowerShell", () => {
  it("asks the installer's two questions and needs yes to both", async () => {
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

describe("download progress", () => {
  it("is whole percents, clamped, and nothing without a total", () => {
    expect(wholePercent(1, 3)).toBe(33)
    expect(wholePercent(5, 3)).toBe(100)
    expect(wholePercent(0, 10)).toBe(0)
    expect(wholePercent(5, undefined)).toBeUndefined()
    expect(wholePercent(5, 0)).toBeUndefined()
  })

  it("is reported once per percent, as the body's chunks arrive", async () => {
    const seen: number[] = []
    const report = reportPercents(10, (percent) => seen.push(percent))
    const hash = await hashBody(
      {
        ok: true,
        status: 200,
        body: (async function* () {
          for (const chunk of ["a", "bb", "c", "dddd", "e", "f"]) yield Buffer.from(chunk)
        })(),
      },
      async () => {},
      100,
      report,
    )
    expect(hash).toBe(sha("abbcddddef"))
    expect(seen).toEqual([10, 30, 40, 80, 90, 100])
  })

  it("reports nothing with no total", () => {
    const seen: number[] = []
    reportPercents(undefined, (percent) => seen.push(percent))(5)
    expect(seen).toEqual([])
  })
})

describe("the installer's PowerShell checks", () => {
  // The commands are electron-builder's, from IS_POWERSHELL_AVAILABLE in
  // app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh (the two
  // `nsExec::Exec ... -C "<command>"` lines). They are pinned here so an upgrade that
  // changes them is noticed.
  it("are the exact commands of the template, and the path check is the prefix one mirrored", () => {
    expect(powershellChecks).toEqual([
      "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }",
      "if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }",
    ])
    const store = join(process.cwd(), "..", "..", "node_modules", ".pnpm")
    const found = existsSync(store)
      ? readdirSync(store).find((name) => name.startsWith("app-builder-lib@"))
      : undefined
    // A missing template fails: the pin is worth nothing if it silently stops running.
    if (found === undefined) throw new Error(`app-builder-lib is not installed under ${store}`)
    const template = readFileSync(
      join(
        store,
        found,
        "node_modules/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh",
      ),
      "utf8",
    )
    for (const command of powershellChecks) expect(template).toContain(`-C "${command}"`)
    // `insideInstallFolder` mirrors this plain case-insensitive prefix check of a process's
    // path against the install folder.
    expect(template).toContain("StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')")
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

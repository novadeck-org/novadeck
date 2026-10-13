import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"

import { describe, expect, it } from "../test"
import { newerCopy } from "./install-linux"
import {
  findInstalledWindows,
  hashBody,
  installedByInstaller,
  installerGuid,
  latestVersionOf,
  prepareSetup,
  readInstallRecord,
  registryValue,
  setupName,
  sha512Of,
  startDetached,
  uuidV5,
  type InstallRecord,
  type SetupHost,
} from "./install-windows"
import { leaveForNewerInstalled } from "./portable"

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
    const asked: string[] = []
    const check = (version: string | undefined, unchecked: boolean) => ({
      portable: true,
      version: "1.0.0",
      find: async () => [{ image: `${folder}\\novadeck.exe`, version, unchecked }],
      ask: async (v: string) => (asked.push(`ask ${v}`), true),
      start: async (image: string) => (asked.push(`start ${image}`), true),
      alert: async () => {},
      quit: () => void asked.push("quit"),
      log: () => {},
    })
    expect(
      newerCopy(await find(async () => ({ location: folder, version: "1.1.0" })), "1.0.0")?.version,
    ).toBe("1.1.0")
    expect(await leaveForNewerInstalled(check("1.1.0", false))).toBe(true)
    expect(asked).toEqual(["ask 1.1.0", `start ${folder}\\novadeck.exe`])
    asked.length = 0
    expect(await leaveForNewerInstalled(check(undefined, true))).toBe(false)
    expect(asked).toEqual([])
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
  const starting = (event: "spawn" | "error" | "throw", present = true) => {
    const calls: string[] = []
    const spawned: { file: string; args: readonly string[]; options: unknown }[] = []
    const result = startDetached({
      file: "C:\\Temp\\setup.exe",
      args: ["/S", "--force-run"],
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
        args: ["/S", "--force-run"],
        options: { detached: true, stdio: "ignore" },
      },
    ])
  })

  it("does not exit when the system refuses to start it", async () => {
    const { result, calls } = starting("error")
    expect(await result).toBe(false)
    expect(calls).not.toContain("exit")
    expect(await starting("throw").result).toBe(false)
  })

  it("spawns nothing and lets go of nothing for a missing file", async () => {
    const { result, calls, spawned } = starting("spawn", false)
    expect(await result).toBe(false)
    expect(spawned).toEqual([])
    expect(calls).toEqual(["log There is no program to start."])
  })
})

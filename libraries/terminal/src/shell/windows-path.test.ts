import { describe, expect, it } from "vitest"

import {
  forgetPath,
  mergePath,
  pathKey,
  readRegistry,
  refreshPath,
  registryFolders,
} from "./windows-path.js"

const windows = process.platform === "win32"
// The lookup's answer: a line for each of a key's values as the registry holds it,
// unexpanded, its name and value in base64.
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")
const answer = (machine: Record<string, string>, user: Record<string, string>) =>
  [
    ...Object.entries(machine).map(([name, value]) => `machine ${b64(name)} ${b64(value)}`),
    ...Object.entries(user).map(([name, value]) => `user ${b64(name)} ${b64(value)}`),
  ].join("\r\n")

describe("PATH merged with the registry's", () => {
  it("keeps the folders the app started with first, and adds the ones it lacks", () => {
    expect(
      mergePath("C:\\Browser;C:\\Windows\\system32", [
        "C:\\Windows\\system32",
        "C:\\Users\\me\\.local\\bin",
      ]),
    ).toBe("C:\\Browser;C:\\Windows\\system32;C:\\Users\\me\\.local\\bin")
  })

  it("names each folder once, whatever its case, trailing slash or quotes", () => {
    expect(mergePath("C:\\Program Files\\nodejs\\;;", ["c:\\program files\\NodeJS", ""])).toBe(
      "C:\\Program Files\\nodejs\\",
    )
    expect(mergePath('"C:\\Tools"', ["C:\\Tools"])).toBe('"C:\\Tools"')
  })

  it("keeps a drive's root apart from its current folder", () => {
    expect(mergePath("C:\\", ["C:", "c:\\\\"])).toBe("C:\\;C:")
  })
})

describe("the registry's PATH folders", () => {
  it("are the machine's and then the user's, names beyond ASCII and all", () => {
    expect(
      registryFolders(
        `${answer({ Path: "C:\\Windows;C:\\Git" }, { Path: "C:\\Users\\Łukasz\\bin" })}\r\n`,
      ),
    ).toEqual(["C:\\Windows", "C:\\Git", "C:\\Users\\Łukasz\\bin"])
  })

  it("expand the registry's own variables, not the stale ones the app started with", () => {
    // nvm-windows adds both a variable and a PATH entry naming it, as an install the app
    // started before.
    const folders = registryFolders(
      answer(
        { Path: "%SystemRoot%\\system32;%NVM_SYMLINK%", NVM_SYMLINK: "C:\\nvm4w\\nodejs" },
        { PATH: "%NVM_HOME%;%JAVA_HOME%\\bin;%NOT_SET%", NVM_HOME: "%LOCALAPPDATA%\\nvm" },
      ),
      {
        SystemRoot: "C:\\Windows",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        NVM_HOME: "stale",
      },
    )
    expect(folders).toEqual([
      "C:\\Windows\\system32",
      "C:\\nvm4w\\nodejs",
      "C:\\Users\\me\\AppData\\Local\\nvm",
      "%JAVA_HOME%\\bin",
      "%NOT_SET%",
    ])
  })

  it("take a value set to nothing, and a key's unnamed default value", () => {
    // As the lookup prints them: an empty name or value is empty in base64 too.
    const printed = [
      `machine ${b64("Path")} ${b64("C:\\Windows")}`,
      `machine  ${b64("default")}`,
      `user ${b64("EMPTY")} `,
      `user ${b64("Path")} ${b64("C:\\Tools;%EMPTY%x")}`,
    ].join("\r\n")
    expect(registryFolders(printed)).toEqual(["C:\\Windows", "C:\\Tools", "x"])
  })

  it("are unknown for an answer that isn't the lookup's", () => {
    expect(registryFolders("")).toBeUndefined()
    expect(registryFolders("not the lookup's")).toBeUndefined()
    expect(registryFolders(`machine ${b64("Path")}`)).toBeUndefined()
    expect(registryFolders(`machine ${b64("Path")} not*base64`)).toBeUndefined()
  })
})

// Waits `ms` of real time.
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("refreshing PATH", () => {
  it("leaves the environment as it is off Windows", async () => {
    const env = { PATH: "/usr/bin" }
    await expect(refreshPath(env, { platform: "linux" })).resolves.toBe(env)
  })

  it("keeps the environment's own spelling of PATH", () => {
    expect(pathKey({ Path: "C:\\Windows" })).toBe("Path")
    expect(pathKey({})).toBe("PATH")
  })

  it("reads the registry once at a time, and again once its answer is old", async () => {
    forgetPath()
    let reads = 0
    let answering = ["C:\\First"]
    const read = () => {
      reads += 1
      return Promise.resolve(answering)
    }
    const options = { platform: "win32" as const, maxAgeMs: 50, read }
    const env = { Path: "C:\\Here" }
    // Terminals opened together share one read.
    const together = await Promise.all([refreshPath(env, options), refreshPath(env, options)])
    expect(together.map((one) => one.Path)).toEqual(["C:\\Here;C:\\First", "C:\\Here;C:\\First"])
    expect(reads).toBe(1)
    // Fresh enough: no read at all.
    await refreshPath(env, options)
    expect(reads).toBe(1)
    // Once old, as after an install, the very next terminal waits for the new answer.
    answering = ["C:\\Second"]
    await new Promise((resolve) => setTimeout(resolve, 60))
    const after = await Promise.all([refreshPath(env, options), refreshPath(env, options)])
    expect(after.map((one) => one.Path)).toEqual(["C:\\Here;C:\\Second", "C:\\Here;C:\\Second"])
    expect(reads).toBe(2)
    forgetPath()
  })

  it("tries no read for a while after one failed, keeping what it read before", async () => {
    forgetPath()
    let reads = 0
    let answering: readonly string[] | undefined = ["C:\\First"]
    const read = () => {
      reads += 1
      return Promise.resolve(answering)
    }
    const options = { platform: "win32" as const, maxAgeMs: 0, retryMs: 60_000, read }
    const env = { Path: "C:\\Here" }
    expect((await refreshPath(env, options)).Path).toBe("C:\\Here;C:\\First")
    // As where PowerShell is blocked: the read fails, and the last answer still serves.
    answering = undefined
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await refreshPath(env, options)).Path).toBe("C:\\Here;C:\\First")
    expect(reads).toBe(2)
    // Nobody waits on another read until `retryMs` has passed.
    expect((await refreshPath(env, options)).Path).toBe("C:\\Here;C:\\First")
    expect(reads).toBe(2)
    // Where none ever succeeded, the environment stays as it is, again without a read.
    forgetPath()
    expect(await refreshPath(env, options)).toBe(env)
    expect(await refreshPath(env, options)).toBe(env)
    expect(reads).toBe(3)
    forgetPath()
  })

  it("tries again soon after a read that only ran long, as on a cold boot", async () => {
    forgetPath()
    let reads = 0
    let answering: readonly string[] | "timeout" = "timeout"
    const read = () => {
      reads += 1
      return Promise.resolve(answering)
    }
    const options = {
      platform: "win32" as const,
      maxAgeMs: 60_000,
      retryMs: 60_000,
      timeoutRetryMs: 20,
      read,
    }
    const env = { Path: "C:\\Here" }
    expect(await refreshPath(env, options)).toBe(env)
    // Within its short wait, no read.
    expect(await refreshPath(env, options)).toBe(env)
    expect(reads).toBe(1)
    answering = ["C:\\Installed"]
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await refreshPath(env, options)).Path).toBe("C:\\Here;C:\\Installed")
    expect(reads).toBe(2)
    forgetPath()
  })

  it("waits twice as long after each read in a row that ran long", async () => {
    forgetPath()
    let reads = 0
    const read = () => {
      reads += 1
      return Promise.resolve("timeout" as const)
    }
    // Waits wide enough apart that a slow timer or a pause of the process tells nothing.
    const options = { platform: "win32" as const, retryMs: 60_000, timeoutRetryMs: 200, read }
    const env = { Path: "C:\\Here" }
    await refreshPath(env, options)
    await pause(300)
    // Past the first wait of 200 ms: read again, and timed out again.
    await refreshPath(env, options)
    expect(reads).toBe(2)
    await pause(100)
    // Well within the second wait, of 400 ms: no read.
    await refreshPath(env, options)
    expect(reads).toBe(2)
    await pause(500)
    await refreshPath(env, options)
    expect(reads).toBe(3)
    forgetPath()
  })

  it.runIf(windows)("reads it through PowerShell where the relay can't run", async () => {
    const missing = await readRegistry(process.env, 30_000, "C:\\Nowhere\\relay.exe")
    expect(missing).toEqual(await readRegistry(process.env, 30_000))
  })
})
